// =========================================================
// poll-push-receipts — Expo-Push-Receipts abholen und verbuchen (F2)
// =========================================================
// Getrennt vom Versandpfad: dispatch-notifications speichert bei einem
// ok-Ticket die Ticket-ID (+ SHA-256 des Tokens) und setzt receipt_status =
// 'pending'. Diese Function wird per pg_cron (kick_receipt_poller, alle
// 5 min) aufgerufen, claimt fällige Prüfungen (claim_receipt_checks, Lease +
// FOR UPDATE SKIP LOCKED), fragt Expo in EINEM getReceipts-Aufruf (max. 1000
// IDs) und verbucht jedes Ergebnis einzeln (complete_receipt_check).
//
// Klassifikation (siehe classifyReceipts):
//   * Receipt status ok                 → 'ok'
//   * Receipt status error              → 'error' (details.error ?? message);
//                                         terminal, KEIN erneuter Versand —
//                                         auch nicht bei MessageRateExceeded.
//                                         DeviceNotRegistered ⇒ bedingte
//                                         Token-Bereinigung in der RPC.
//   * ID fehlt in der Antwort           → 'missing' (Receipt noch nicht da)
//   * Netz/HTTP ≠ 200 (5xx, 429, 4xx)/
//     unlesbare Antwort                 → 'infra' (+5 min, zählt nicht als Fehlen)
//
// Authentifizierung: ausschließlich x-sweeper-secret (DISPATCH_SWEEPER_SECRET,
// constant-time), dieselbe wie der Server-Modus von dispatch-notifications.
// verify_jwt = false (config.toml). Kein Client-Modus.
// =========================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const EXPO_RECEIPTS_ENDPOINT = "https://exp.host/--/api/v2/push/getReceipts";
export const MAX_IDS_PER_REQUEST = 1000; // Expo-Limit (PUSH_TOO_MANY_RECEIPTS darüber)
const LEASE_SECONDS = 120;

export type ClaimedReceiptCheck = {
  delivery_id: string;
  expo_ticket_id: string;
  receipt_attempts: number;
  sent_at: string;
};

export type ReceiptOutcome = {
  outcome: "ok" | "error" | "missing" | "infra";
  error: string | null;
};

type ExpoReceipt = {
  status?: unknown;
  message?: unknown;
  details?: { error?: unknown } | null;
};

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// Ein einzelnes Receipt-Objekt → Ergebnis. undefined = ID fehlt in data.
export function classifyReceipt(receipt: unknown): ReceiptOutcome {
  if (receipt === undefined || receipt === null) {
    return { outcome: "missing", error: null };
  }
  if (typeof receipt !== "object") {
    return { outcome: "error", error: "malformed_receipt" };
  }
  const r = receipt as ExpoReceipt;
  if (r.status === "ok") {
    return { outcome: "ok", error: null };
  }
  if (r.status === "error") {
    const detail = typeof r.details?.error === "string" ? r.details.error : null;
    const message = typeof r.message === "string" ? r.message : null;
    return { outcome: "error", error: detail ?? message ?? "unknown" };
  }
  return { outcome: "error", error: "unknown_receipt_status" };
}

// Gesamte getReceipts-Antwort → Ergebnis je Ticket-ID. `null` = Antwort nicht
// verwertbar (Infrastruktur), dann gilt für alle Zeilen 'infra'.
export function classifyReceipts(
  ticketIds: string[],
  body: unknown,
): Map<string, ReceiptOutcome> | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const receipts = data as Record<string, unknown>;
  const result = new Map<string, ReceiptOutcome>();
  for (const id of ticketIds) {
    result.set(id, classifyReceipt(Object.prototype.hasOwnProperty.call(receipts, id) ? receipts[id] : undefined));
  }
  return result;
}

async function completeCheck(
  adminClient: SupabaseClient,
  deliveryId: string,
  outcome: ReceiptOutcome,
): Promise<string | null> {
  try {
    const { data, error } = await adminClient.rpc("complete_receipt_check", {
      p_delivery_id: deliveryId,
      p_outcome: outcome.outcome,
      p_error: outcome.error,
    });
    if (error) {
      console.error("[receipts] complete_receipt_check failed", deliveryId, error.message);
      return null;
    }
    return (data as string) ?? null;
  } catch (err) {
    console.error("[receipts] complete_receipt_check threw", deliveryId, err);
    return null;
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const sweeperSecret = Deno.env.get("DISPATCH_SWEEPER_SECRET");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    const header = req.headers.get("x-sweeper-secret");
    if (!sweeperSecret || !header || !timingSafeEqual(sweeperSecret, header)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: claimedData, error: claimError } = await adminClient.rpc("claim_receipt_checks", {
      max_rows: MAX_IDS_PER_REQUEST,
      lease_seconds: LEASE_SECONDS,
    });
    if (claimError) {
      throw new Error(`claim failed: ${claimError.message}`);
    }

    const claimed = ((claimedData ?? []) as ClaimedReceiptCheck[]).filter((c) => !!c.expo_ticket_id);
    const counts: Record<string, number> = { ok: 0, error: 0, missing: 0, infra: 0, unavailable: 0 };

    if (claimed.length === 0) {
      return Response.json({ mode: "receipts", claimed: 0, ...counts });
    }

    const ticketIds = claimed.map((c) => c.expo_ticket_id);
    let outcomes: Map<string, ReceiptOutcome> | null = null;
    let infraReason = "unknown";

    try {
      const response = await fetch(EXPO_RECEIPTS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ids: ticketIds }),
      });
      if (!response.ok) {
        infraReason = `Expo getReceipts HTTP ${response.status}`;
      } else {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        outcomes = classifyReceipts(ticketIds, body);
        if (!outcomes) infraReason = "malformed getReceipts response";
      }
    } catch (err) {
      infraReason = `Expo getReceipts network error: ${err instanceof Error ? err.message : String(err)}`;
    }

    for (const c of claimed) {
      const outcome = outcomes?.get(c.expo_ticket_id) ?? { outcome: "infra" as const, error: infraReason };
      const result = await completeCheck(adminClient, c.delivery_id, outcome);
      counts[outcome.outcome]++;
      if (result === "unavailable") counts.unavailable++;
    }

    return Response.json({ mode: "receipts", claimed: claimed.length, ...counts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    console.error("[receipts] fatal", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
