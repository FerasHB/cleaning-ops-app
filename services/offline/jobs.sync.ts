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
      await startJobService(action.jobId);
      break;

    case "complete_job":
      await completeJobService(action.jobId);
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
    console.log("Skip sync: offline");
    return { success: 0, failed: 0 };
  }

  const actions = await getPendingJobActions();

  if (!actions.length) {
    console.log("No pending actions to sync");
    return { success: 0, failed: 0 };
  }

  console.log("Start syncing actions:", actions.length);

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

  console.log("Sync finished:", { success, failed });

  return { success, failed };
}