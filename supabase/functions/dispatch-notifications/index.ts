import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// =========================================================
// Edge Function: dispatch-notifications
// =========================================================
// Versendet den Admin-Push bei Job-Statuswechsel. Vollständig serverseitig:
// Empfänger und Inhalt kommen ausschließlich aus notification_outbox /
// notification_deliveries (per Service Role), NICHT vom aufrufenden Client.
//
// Ablauf pro Aufruf:
//   1. fanout_notification_events()  — offene Events -> Deliveries pro Admin
//   2. Schleife:
//      a. claim_notification_deliveries() — fällige Deliveries atomar (processing)
//      b. je Delivery genau EINEN Expo-Push senden (ein Token pro Message)
//      c. JEDES Ticket einzeln auswerten und complete_notification_delivery()
//         mit sent | permanent_fail | retry aufrufen (Backoff/max serverseitig)
//      bis kein fälliger Batch mehr übrig ist (oder MAX_BATCHES erreicht).
//
// Aufrufmodi:
//   * SERVER  (Database Webhook / pg_cron): Authorization = Bearer <service_role>
//     -> verarbeitet ALLE Firmen (company_id_filter = null). Das ist der
//        verlässliche, geräteunabhängige Pfad. Einrichtung: siehe DEPLOY.md.
//   * CLIENT  (optionaler Kick zur Beschleunigung): normales User-JWT
//     -> verarbeitet nur die Firma des aktiven Aufrufers (company-gescopt).
//
// sent_at wird NIE hier direkt gesetzt — ausschließlich die RPC
// complete_notification_delivery('sent') setzt es nach echtem Erfolg.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const MAX_ROWS_PER_BATCH = 50;
const MAX_BATCHES = 20; // Sicherheitskappe: max. 1000 Deliveries pro Aufruf
const PROCESSING_TIMEOUT_SECONDS = 120;
const MAX_ATTEMPTS = 5;

type ClaimedDelivery = {
  delivery_id: string;
  outbox_id: string;
  recipient_id: string;
  attempts: number;
  event_type: string;
  job_id: string;
  company_id: string;
  job_status: string;
  employee_id: string | null;
  employee_name: string | null;
  customer_name: string | null;
  service_name: string | null;
  expo_push_token: string | null;
  recipient_active: boolean | null;
  recipient_role: string | null;
};

type ExpoTicket =
  | { status: "ok"; id?: string }
  | { status: "error"; message?: string; details?: { error?: string } };

function jobTitle(row: ClaimedDelivery): string {
  return row.service_name?.trim() || row.customer_name?.trim() || "Auftrag";
}

function buildContent(row: ClaimedDelivery): { title: string; body: string } {
  const who = row.employee_name?.trim() || "Ein Mitarbeiter";
  const what = jobTitle(row);
  if (row.event_type === "job_completed") {
    return { title: "Job abgeschlossen", body: `${who} hat „${what}" abgeschlossen.` };
  }
  return { title: "Job gestartet", body: `${who} hat „${what}" gestartet.` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return Response.json({ error: "Nicht eingeloggt." }, { status: 401, headers: corsHeaders });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // ── Modus bestimmen ──────────────────────────────────────────────
    // SERVER: aufgerufen mit dem Service-Role-Key (Webhook/Cron) -> alle Firmen.
    // CLIENT: normales User-JWT -> nur die Firma des aktiven Aufrufers.
    let companyFilter: string | null = null;

    if (authHeader === `Bearer ${serviceRoleKey}`) {
      companyFilter = null; // Server-Sweep über alle Firmen
    } else {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const {
        data: { user },
        error: userError,
      } = await userClient.auth.getUser();

      if (userError || !user) {
        return Response.json({ error: "Ungültige Session." }, { status: 401, headers: corsHeaders });
      }

      const { data: callerProfile, error: callerError } = await adminClient
        .from("profiles")
        .select("company_id, is_active")
        .eq("id", user.id)
        .single();

      if (callerError || !callerProfile) {
        return Response.json({ error: "Profil konnte nicht geladen werden." }, { status: 403, headers: corsHeaders });
      }
      if (!callerProfile.is_active || !callerProfile.company_id) {
        return Response.json({ error: "Kein aktives Profil mit Firma." }, { status: 403, headers: corsHeaders });
      }
      companyFilter = callerProfile.company_id as string;
    }

    // ── 1. Fan-out: offene Events -> Deliveries pro Admin-Empfänger ──
    const { error: fanoutError } = await adminClient.rpc("fanout_notification_events", {
      company_id_filter: companyFilter,
      max_events: 200,
    });
    if (fanoutError) {
      throw new Error(`fanout failed: ${fanoutError.message}`);
    }

    let sent = 0;
    let retried = 0;
    let failed = 0;
    let deferred = 0;
    let claimedTotal = 0;

    // ── 2. Deliveries in Batches abarbeiten ──
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const { data: claimedData, error: claimError } = await adminClient.rpc(
        "claim_notification_deliveries",
        {
          company_id_filter: companyFilter,
          max_rows: MAX_ROWS_PER_BATCH,
          processing_timeout_seconds: PROCESSING_TIMEOUT_SECONDS,
        },
      );
      if (claimError) {
        throw new Error(`claim failed: ${claimError.message}`);
      }

      const claimed = (claimedData ?? []) as ClaimedDelivery[];
      if (claimed.length === 0) {
        break;
      }
      claimedTotal += claimed.length;

      // Empfänger einordnen:
      //  - inaktiv / kein Admin mehr  -> endgültig nicht zustellbar (permanent_fail)
      //  - aktiver Admin OHNE Token   -> NICHT failen, zurückstellen (missing_token);
      //    nach Token-Registrierung wird die Delivery später normal zustellbar
      //  - aktiver Admin MIT Token    -> senden
      const sendable: ClaimedDelivery[] = [];
      for (const d of claimed) {
        const isActiveAdmin = d.recipient_active === true && d.recipient_role === "admin";
        if (!isActiveAdmin) {
          await markDelivery(adminClient, d.delivery_id, "permanent_fail", "recipient not eligible (inactive/not admin)");
          failed++;
        } else if (!d.expo_push_token) {
          await markDelivery(adminClient, d.delivery_id, "missing_token", "missing_push_token");
          deferred++;
        } else {
          sendable.push(d);
        }
      }

      if (sendable.length === 0) {
        continue;
      }

      // Ein Token pro Message -> Ticket[i] gehört eindeutig zu sendable[i].
      const messages = sendable.map((d) => {
        const { title, body } = buildContent(d);
        return {
          to: d.expo_push_token,
          sound: "default",
          title,
          body,
          data: {
            type: d.event_type,
            jobId: d.job_id,
            companyId: d.company_id,
            employeeId: d.employee_id,
            status: d.job_status,
          },
          channelId: "default",
          priority: "high",
        };
      });

      let tickets: ExpoTicket[] | null = null;
      try {
        const pushResponse = await fetch(EXPO_PUSH_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(messages),
        });
        if (!pushResponse.ok) {
          const text = await pushResponse.text();
          throw new Error(`Expo push HTTP ${pushResponse.status}: ${text}`);
        }
        const pushResult = (await pushResponse.json()) as { data?: ExpoTicket[] };
        tickets = pushResult.data ?? [];
      } catch (httpErr) {
        // Harter Transport-Fehler für den GESAMTEN Batch -> alle erneut versuchen.
        const message = httpErr instanceof Error ? httpErr.message : String(httpErr);
        for (const d of sendable) {
          const outcome = await markDelivery(adminClient, d.delivery_id, "retry", message);
          if (outcome === "failed") failed++; else retried++;
        }
        continue;
      }

      // Jedes Ticket EINZELN auswerten.
      for (let i = 0; i < sendable.length; i++) {
        const d = sendable[i];
        const ticket = tickets[i];

        if (!ticket) {
          const outcome = await markDelivery(adminClient, d.delivery_id, "retry", "missing ticket in Expo response");
          if (outcome === "failed") failed++; else retried++;
          continue;
        }

        if (ticket.status === "ok") {
          await markDelivery(adminClient, d.delivery_id, "sent");
          sent++;
          continue;
        }

        // status === 'error'
        const reason = ticket.details?.error ?? ticket.message ?? "unknown";
        if (ticket.details?.error === "DeviceNotRegistered") {
          // Token säubern (kein erneuter Versuch an dieses Gerät).
          try {
            await adminClient.from("profiles").update({ expo_push_token: null }).eq("id", d.recipient_id);
          } catch {
            // best effort
          }
          await markDelivery(adminClient, d.delivery_id, "permanent_fail", reason);
          failed++;
        } else {
          // Temporärer Expo-Fehler (z. B. MessageRateExceeded) -> Retry/Backoff.
          const outcome = await markDelivery(adminClient, d.delivery_id, "retry", reason);
          if (outcome === "failed") failed++; else retried++;
        }
      }
    }

    return Response.json(
      { mode: companyFilter ? "client" : "server", claimed: claimedTotal, sent, retried, failed, deferred },
      { headers: corsHeaders },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
    console.error("[dispatch] fatal", message);
    return Response.json({ error: message }, { status: 500, headers: corsHeaders });
  }
});

// Ruft die Zustands-RPC auf und gibt den resultierenden Status zurück
// ('sent' | 'failed' | 'pending'). Fehler hier dürfen den Lauf nicht abbrechen.
async function markDelivery(
  adminClient: ReturnType<typeof createClient>,
  deliveryId: string,
  outcome: "sent" | "retry" | "permanent_fail" | "missing_token",
  error?: string,
): Promise<string | null> {
  try {
    const { data, error: rpcError } = await adminClient.rpc("complete_notification_delivery", {
      delivery_id_input: deliveryId,
      outcome,
      error_input: error ?? null,
      max_attempts: MAX_ATTEMPTS,
    });
    if (rpcError) {
      console.error("[dispatch] complete_notification_delivery failed", deliveryId, rpcError.message);
      return null;
    }
    return (data as string) ?? null;
  } catch (err) {
    console.error("[dispatch] complete_notification_delivery threw", deliveryId, err);
    return null;
  }
}
