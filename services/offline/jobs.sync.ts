import NetInfo from "@react-native-community/netinfo";
import {
    getPendingJobActions,
    PendingJobAction,
    removePendingJobAction,
} from "./jobs.queue";

import {
    completeJob as completeJobService,
    startJob as startJobService,
} from "@/services/jobs/jobs.service";
import { dispatchAdminNotifications } from "@/services/notifications/adminNotifications";

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
 * - verarbeitet die Queue
 * - führt alle Actions nacheinander aus
 * - entfernt erfolgreiche Actions aus der Queue
 */
export async function syncPendingJobActions(): Promise<{
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

  const actions = await getPendingJobActions();

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
    try {
      await executeAction(action);

      // Nur entfernen wenn erfolgreich!
      await removePendingJobAction(action.id);

      success++;
    } catch (error) {
      console.error("Failed to sync action:", action, error);

      // Wichtig: NICHT löschen → später nochmal versuchen
      failed++;
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