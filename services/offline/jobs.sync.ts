import NetInfo from "@react-native-community/netinfo";
import {
    getPendingJobActions,
    markPendingJobActionFailed,
    PendingJobAction,
    removePendingJobAction,
} from "./jobs.queue";

import {
    completeJob as completeJobService,
    startJob as startJobService,
} from "@/services/jobs/jobs.service";
import { dispatchAdminNotifications } from "@/services/notifications/adminNotifications";
import { isNetworkError } from "@/utils/networkError";
import { toUserMessage } from "@/utils/userMessages";

/**
 * Retryable vs. dauerhaft — Client-Compatibility-Fundament (20260916120000).
 *
 * RETRYABLE (Queue bleibt "pending", nächster Sync versucht es erneut):
 *   - isNetworkError(): die Anfrage kam nie beim Server an.
 *   - 57014 (query_canceled/Timeout).
 *   - 5xx / "server unavailable"-Muster: der Server hat geantwortet, aber
 *     mit einem vorübergehenden Fehler.
 *   - PGRST301 (Session abgelaufen) — nach erneuter Anmeldung kann derselbe
 *     Aufruf gelingen, die Daten sind nicht ungültig geworden.
 *
 * ALLES ANDERE ist dauerhaft/serverautoritativ: die Anfrage kam an, der
 * Server hat sie inhaltlich geprüft und bewusst abgelehnt (falsche
 * App-Version, Abschluss ohne eigenen Start, Auftrag nicht mehr im
 * passenden Status, …). Ein erneuter Versuch mit denselben, bereits
 * erfassten Daten würde IMMER wieder dasselbe Ergebnis liefern — insbe-
 * sondere Phase 16s eigene Geschäftsregeln, die durchgängig errcode 22023
 * verwenden (siehe supabase/migrations/20260917000000).
 */
function isRetryableFailure(error: unknown): boolean {
  if (isNetworkError(error)) return true;

  const code =
    typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : typeof (error as { code?: unknown })?.code === "number"
        ? String((error as { code: number }).code)
        : "";

  if (code === "57014" || code === "PGRST301") return true;

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return /^5\d{2}\b|internal server error|service unavailable|bad gateway|upstream/i.test(
    message,
  );
}

/**
 * Prüft ob Internet vorhanden ist
 */
async function isOnline(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return !!state.isConnected;
}

/**
 * Führt eine einzelne Action gegen Supabase aus
 */
async function executeAction(action: PendingJobAction): Promise<void> {
  switch (action.type) {
    case "start_job":
      // Echten Offline-Zeitpunkt aus der Queue übergeben (nicht "jetzt")
      await startJobService(action.jobId, action.timestamp);
      break;

    case "complete_job":
      // Echten Offline-Zeitpunkt aus der Queue übergeben (nicht "jetzt")
      await completeJobService(action.jobId, action.timestamp);
      break;

    default:
      console.warn("Unknown action type:", action);
  }
}

/**
 * Hauptfunktion:
 * - verarbeitet die Queue DES ÜBERGEBENEN NUTZERS
 * - führt dessen Actions nacheinander aus
 * - entfernt erfolgreiche Actions aus der Queue
 *
 * NUTZER-BINDUNG (geteilte Geräte): Es werden ausschließlich Aktionen
 * ausgeführt, deren `userId` mit der aktiven Sitzung übereinstimmt. Aktionen
 * eines ANDEREN Nutzers werden übersprungen und bleiben unangetastet
 * gespeichert — sie gehören ihm und synchronisieren, sobald er sich wieder
 * anmeldet. Sie werden ausdrücklich NICHT gelöscht (kein Verlust echter,
 * noch nicht übertragener Arbeitszeit) und NICHT unter fremder Sitzung
 * ausgeführt (keine Falschzuschreibung).
 */
export async function syncPendingJobActions(userId: string): Promise<{
  success: number;
  failed: number;
}> {
  const online = await isOnline();

  if (!online) {
    if (__DEV__) {
      console.log("Skip sync: offline");
    }
    return { success: 0, failed: 0 };
  }

  // Nur die eigenen Aktionen — fremde bleiben liegen (siehe oben). Bereits
  // dauerhaft fehlgeschlagene Aktionen NICHT erneut versuchen (sonst würde
  // jeder Sync-Lauf dieselbe Ablehnung wiederholen) — sie bleiben sichtbar,
  // bis der Nutzer sie ausdrücklich bestätigt (dismissFailedJobAction).
  const actions = await getPendingJobActions(userId);

  if (!actions.length) {
    if (__DEV__) {
      console.log("No pending actions to sync");
    }
    return { success: 0, failed: 0 };
  }

  if (__DEV__) {
    console.log("Start syncing actions:", actions.length);
  }

  let success = 0;
  let failed = 0;

  for (const action of actions) {
    // A rejected predecessor stays in storage until explicitly dismissed.
    // Do not allow a later pending action to overtake it on the next reconnect.
    if (action.status === "failed_permanent") break;
    try {
      await executeAction(action);

      // Nur entfernen wenn erfolgreich!
      await removePendingJobAction(action.id);

      success++;
    } catch (error) {
      console.error("Failed to sync action:", action, error);

      if (isRetryableFailure(error)) {
        // Wichtig: NICHT löschen → später nochmal versuchen
      } else {
        // Server hat inhaltlich/autoritativ abgelehnt — ein erneuter
        // Versuch würde dasselbe Ergebnis liefern. Dauerhaft markieren
        // statt endlos zu wiederholen; nicht löschen (kein stiller Verlust).
        await markPendingJobActionFailed(
          action.id,
          toUserMessage(error, "Die Aktion konnte nicht ausgeführt werden."),
        );
      }

      failed++;
      // The following legacy action may depend on this one. Preserve queue
      // order instead of letting a later Start/Complete overtake the failure.
      break;
    }
  }

  // Nach dem Abarbeiten der Queue den serverseitigen Admin-Push BESCHLEUNIGEN.
  // Die RPCs haben beim echten Statusübergang (open->in_progress bzw.
  // in_progress->completed) bereits Outbox-Events geschrieben; der serverseitige
  // Dispatcher (Webhook/Cron) liefert diese ohnehin aus. Dieser Kick verkürzt nur
  // die Latenz für den Offline->Reconnect->Sync-Fall. Doppelte Auslieferung ist
  // ausgeschlossen (pro-Empfänger-Delivery-Status, siehe Edge Function).
  if (success > 0) {
    await dispatchAdminNotifications();
  }

  if (__DEV__) {
    console.log("Sync finished:", { success, failed });
  }

  return { success, failed };
}
