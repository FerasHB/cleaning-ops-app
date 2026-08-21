import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// =========================================================
// Edge Function: dispatch-notifications
// =========================================================
// Versendet den Push bei Job-Statuswechsel (an Admins) UND bei neuer
// Job-Zuweisung (an den/die zugewiesenen Mitarbeiter, seit
// 20260820000000_job_assigned_notifications.sql). Vollständig serverseitig:
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
//   * SERVER  (pg_cron-Sweeper): Header x-sweeper-secret = DISPATCH_SWEEPER_SECRET
//     (dediziertes Secret, entkoppelt vom Service-Role-Key/JWT — funktioniert auch
//     bei neuen sb_secret_-Keys). Alternativ rückwärtskompat Authorization =
//     Bearer <service_role>. -> verarbeitet ALLE Firmen (company_id_filter = null),
//     ohne eingeloggten Nutzer. Verlässlicher, geräteunabhängiger Pfad.
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
  // Seit 20260821000000 (Abwesenheits-Events). Bei Job-Events NULL.
  entity_type: string | null;
  entity_id: string | null;
  absence_start_date: string | null;
  absence_end_date: string | null;
};

// Welche Rolle MUSS der Empfänger eines Events haben? Statt einer wachsenden
// if/else-Kette eine Tabelle — jedes neue Event trägt seine Empfängerrolle
// hier ein, die Partitionierung unten bleibt unverändert.
//   Job-Lifecycle -> Admin, Job-Zuweisung -> Mitarbeiter,
//   Abwesenheit gemeldet/beantragt -> Admin, Review-Ergebnis -> Mitarbeiter.
// "any" = beide Rollen zulässig. Das braucht genau ein Event: comment_added
// geht je nach Autor an zugewiesene Mitarbeiter UND/ODER Admins. Die konkrete
// Empfängermenge wurde dabei bereits serverseitig im Trigger abgeleitet
// (firmengescopt, Autor ausgeschlossen) — hier bleibt deshalb nur zu prüfen,
// dass der Empfänger noch aktiv ist.
const EVENT_RECIPIENT_ROLE: Record<string, "admin" | "employee" | "any"> = {
  job_started: "admin",
  job_completed: "admin",
  job_assigned: "employee",
  vacation_requested: "admin",
  sickness_reported: "admin",
  sickness_updated: "admin",
  vacation_approved: "employee",
  vacation_rejected: "employee",
  comment_added: "any",
};

// Unbekanntes Event -> "admin" als konservativer Rückfall (entspricht dem
// Verhalten vor dieser Änderung, als alles an Admins ging).
function expectedRoleFor(eventType: string): "admin" | "employee" | "any" {
  return EVENT_RECIPIENT_ROLE[eventType] ?? "admin";
}

// Empfänger zustellbar? Immer: Konto aktiv. Zusätzlich muss die Rolle zum
// Event passen — außer bei "any"-Events, deren Empfängermenge serverseitig
// bereits exakt bestimmt wurde.
function isEligible(row: ClaimedDelivery): boolean {
  if (row.recipient_active !== true) return false;
  const expected = expectedRoleFor(row.event_type);
  if (expected === "any") {
    return row.recipient_role === "admin" || row.recipient_role === "employee";
  }
  return row.recipient_role === expected;
}

// "2026-08-25" -> "25.08.2026". Der Dispatcher bekommt reine Datumsstrings
// (date-Spalten), niemals Zeitstempel — deshalb kein Zeitzonen-Handling.
function formatDate(value: string | null): string | null {
  if (!value) return null;
  const [y, m, d] = value.slice(0, 10).split("-");
  if (!y || !m || !d) return null;
  return `${d}.${m}.${y}`;
}

type ExpoTicket =
  | { status: "ok"; id?: string }
  | { status: "error"; message?: string; details?: { error?: string } };

// Konstantzeit-Vergleich zweier Secrets (kein Timing-Orakel). Der Längen-Early-Out
// verrät nur die Länge, was für ein zufälliges Sweeper-Secret unkritisch ist.
function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function jobTitle(row: ClaimedDelivery): string {
  return row.service_name?.trim() || row.customer_name?.trim() || "Auftrag";
}

// Der Admin soll am Text erkennen, WELCHER Auftrag gemeint ist, ohne die App
// zu öffnen: wer, was, bei wem. Mehr steht hier nicht zur Verfügung —
// claim_notification_deliveries liefert bewusst nur employee_name /
// customer_name / service_name (keine Adresse, keine Terminierung). Eine
// Erweiterung bräuchte eine Migration und gehört nicht in diesen Änderungsschritt.
// job_assigned geht an den/die neu zugewiesenen MITARBEITER, nicht an
// Admins — eigener, kurzer Text ohne "wer hat gestartet/abgeschlossen"-Form.
// Wie bei job_started/job_completed stehen hier nur customer_name/
// service_name zur Verfügung (keine Adresse, keine Terminierung) — dieselbe
// Einschränkung wie bei den bestehenden zwei Events, siehe Kommentar oben.
function buildAssignedContent(row: ClaimedDelivery): { title: string; body: string } {
  const service = row.service_name?.trim();
  const customer = row.customer_name?.trim();
  const what = jobTitle(row);
  const at = service && customer ? ` bei ${customer}` : "";

  return {
    title: "Neuer Auftrag",
    body: `Dir wurde „${what}“${at} zugewiesen.`,
  };
}

// Abwesenheits-Texte. Zeitraum kommt aus den Schnappschuss-Spalten der Outbox,
// nicht aus employee_absences — der Text bleibt damit auch dann korrekt, wenn
// die Abwesenheit später geändert wird.
//
// Offenes Ende (end_date IS NULL) ist bei Krankheit ein REGULÄRER Zustand
// ("bis auf Weiteres"), kein Fehler — der Text darf dann kein leeres oder
// kaputtes Datum zeigen.
function buildAbsenceContent(row: ClaimedDelivery): { title: string; body: string } {
  const who = row.employee_name?.trim() || "Ein Mitarbeiter";
  const from = formatDate(row.absence_start_date);
  const to = formatDate(row.absence_end_date);

  // "vom 10.08. bis 14.08." | "ab 10.08." (offenes Ende) | "" (kein Datum)
  const range = from && to ? `vom ${from} bis ${to}` : from ? `ab ${from}` : "";
  const rangeSuffix = range ? ` ${range}` : "";

  switch (row.event_type) {
    case "vacation_requested":
      return {
        title: "Neuer Urlaubsantrag",
        body: range
          ? `${who} hat Urlaub ${range} beantragt.`
          : `${who} hat Urlaub beantragt.`,
      };
    case "sickness_reported":
      return {
        title: "Neue Krankmeldung",
        body: range
          ? `${who} hat sich krankgemeldet (${range}).`
          : `${who} hat sich krankgemeldet.`,
      };
    case "sickness_updated":
      return {
        title: "Krankmeldung aktualisiert",
        body: to
          ? `${who} hat den Zeitraum der Krankmeldung geändert (neues Ende: ${to}).`
          : `${who} hat die Krankmeldung auf unbestimmte Zeit verlängert.`,
      };
    case "vacation_approved":
      return {
        title: "Urlaub genehmigt",
        body: `Dein Urlaubsantrag${rangeSuffix} wurde genehmigt.`,
      };
    case "vacation_rejected":
      return {
        title: "Urlaub abgelehnt",
        body: `Dein Urlaubsantrag${rangeSuffix} wurde abgelehnt.`,
      };
    default:
      return { title: "Abwesenheit", body: `${who}: Abwesenheit aktualisiert.` };
  }
}

// Kommentar-Push. Der Kommentartext selbst steht BEWUSST NICHT drin:
// Datenschutz (Push landet auf dem Sperrbildschirm), unbekannte Länge und
// unnötiges Rauschen. Der Nutzer öffnet den Auftrag und liest dort.
function buildCommentContent(row: ClaimedDelivery): { title: string; body: string } {
  const who = row.employee_name?.trim() || "Jemand";
  const service = row.service_name?.trim();
  const customer = row.customer_name?.trim();

  // Gleiche Fallback-Kette wie bei den Job-Events: fehlt die Leistung, rückt
  // der Kunde nach und darf dann nicht zusätzlich als "bei …" erscheinen.
  const what = jobTitle(row);
  const at = service && customer ? ` bei ${customer}` : "";

  return {
    title: "Neuer Kommentar",
    body: `${who} hat einen Kommentar zu „${what}“${at} geschrieben.`,
  };
}

function buildContent(row: ClaimedDelivery): { title: string; body: string } {
  if (row.entity_type === "comment") {
    return buildCommentContent(row);
  }

  if (row.entity_type === "absence") {
    return buildAbsenceContent(row);
  }

  if (row.event_type === "job_assigned") {
    return buildAssignedContent(row);
  }

  const who = row.employee_name?.trim() || "Ein Mitarbeiter";
  const service = row.service_name?.trim();
  const customer = row.customer_name?.trim();

  // `what` ist die in Anführungszeichen gesetzte Leistung. Fehlt sie, rückt
  // der Kunde nach (jobTitle) — dann darf er NICHT zusätzlich als "bei …"
  // erscheinen, sonst steht er doppelt in der Zeile.
  const what = jobTitle(row);
  const at = service && customer ? ` bei ${customer}` : "";

  const done = row.event_type === "job_completed";
  const verb = done ? "abgeschlossen" : "gestartet";

  return {
    title: done ? "Auftrag abgeschlossen" : "Auftrag gestartet",
    body: `${who} hat „${what}“${at} ${verb}.`,
  };
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
    // Dediziertes Sweeper-Secret (pg_cron -> pg_net). Entkoppelt den Server-Sweep
    // vom Service-Role-Key/JWT: funktioniert auch dann, wenn das Projekt neue
    // sb_secret_-Keys nutzt und der Legacy-JWT nicht dem injizierten
    // SUPABASE_SERVICE_ROLE_KEY entspricht. Der Header wird konstantzeit-verglichen.
    const sweeperSecret = Deno.env.get("DISPATCH_SWEEPER_SECRET");
    const sweeperHeader = req.headers.get("x-sweeper-secret");
    const isSweeperCall =
      !!sweeperSecret && !!sweeperHeader && timingSafeEqual(sweeperSecret, sweeperHeader);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // ── Modus bestimmen ──────────────────────────────────────────────
    // SERVER: dedizierter Sweeper-Secret-Header (pg_cron) ODER — rückwärtskompat —
    //         Aufruf mit dem Service-Role-Key -> ALLE Firmen, KEIN eingeloggter Nutzer.
    // CLIENT: normales User-JWT -> nur die Firma des aktiven Aufrufers.
    let companyFilter: string | null = null;

    if (isSweeperCall || (authHeader && authHeader === `Bearer ${serviceRoleKey}`)) {
      companyFilter = null; // Server-Sweep über alle Firmen
    } else {
      if (!authHeader) {
        return Response.json({ error: "Nicht eingeloggt." }, { status: 401, headers: corsHeaders });
      }
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
      //  - inaktiv / falsche Rolle für dieses Event -> endgültig nicht
      //    zustellbar (permanent_fail). job_started/job_completed gehen an
      //    Admins (Fan-out über fanout_notification_events), job_assigned
      //    geht an genau den Mitarbeiter, der in set_job_assignments direkt
      //    als Empfänger eingetragen wurde (siehe
      //    supabase/migrations/20260820000000_job_assigned_notifications.sql)
      //    — auch hier wird die Rolle hier trotzdem defensiv geprüft, falls
      //    sich die Rolle des Empfängers seit dem Schreiben geändert hat.
      //  - aktiver, passender Empfänger OHNE Token -> NICHT failen,
      //    zurückstellen (missing_token); nach Token-Registrierung wird die
      //    Delivery später normal zustellbar
      //  - aktiver, passender Empfänger MIT Token -> senden
      const sendable: ClaimedDelivery[] = [];
      for (const d of claimed) {
        if (!isEligible(d)) {
          await markDelivery(adminClient, d.delivery_id, "permanent_fail", `recipient not eligible (inactive/not ${expectedRoleFor(d.event_type)})`);
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
          // jobId bleibt der Schlüssel für Job-Events (useNotificationNavigation
          // öffnet damit den Auftrag); absenceId ist das Gegenstück für
          // Abwesenheiten. Beide sind bei der jeweils anderen Sorte null.
          data: {
            type: d.event_type,
            jobId: d.job_id,
            companyId: d.company_id,
            employeeId: d.employee_id,
            status: d.job_status,
            entityType: d.entity_type,
            absenceId: d.entity_type === "absence" ? d.entity_id : null,
            // Kommentar-Events tragen zusätzlich job_id — der Tap öffnet
            // deshalb über den bestehenden jobId-Pfad den Auftrag. commentId
            // wird für ein späteres Anspringen des Kommentars mitgeführt.
            commentId: d.entity_type === "comment" ? d.entity_id : null,
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
