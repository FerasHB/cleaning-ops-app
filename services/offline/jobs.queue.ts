import AsyncStorage from "@react-native-async-storage/async-storage";

export type PendingJobActionType = "start_job" | "complete_job";

export type PendingJobAction =
  | {
      id: string;
      type: "start_job";
      jobId: string;
      timestamp: string;
    }
  | {
      id: string;
      type: "complete_job";
      jobId: string;
      timestamp: string;
    };

const JOBS_QUEUE_STORAGE_KEY = "offline_jobs_queue";

function generateActionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function getPendingJobActions(): Promise<PendingJobAction[]> {
  try {
    const raw = await AsyncStorage.getItem(JOBS_QUEUE_STORAGE_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed as PendingJobAction[];
  } catch (error) {
    console.error("Failed to read offline jobs queue:", error);
    return [];
  }
}

export async function savePendingJobActions(
  actions: PendingJobAction[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(JOBS_QUEUE_STORAGE_KEY, JSON.stringify(actions));
  } catch (error) {
    console.error("Failed to save offline jobs queue:", error);
    throw error;
  }
}

export async function addPendingJobAction(input: {
  type: PendingJobActionType;
  jobId: string;
  timestamp?: string;
}): Promise<PendingJobAction[]> {
  const actions = await getPendingJobActions();

  const nextAction: PendingJobAction =
    input.type === "start_job"
      ? {
          id: generateActionId(),
          type: "start_job",
          jobId: input.jobId,
          timestamp: input.timestamp ?? new Date().toISOString(),
        }
      : {
          id: generateActionId(),
          type: "complete_job",
          jobId: input.jobId,
          timestamp: input.timestamp ?? new Date().toISOString(),
        };

  const nextActions = [...actions, nextAction];
  await savePendingJobActions(nextActions);

  return nextActions;
}

export async function removePendingJobAction(
  actionId: string,
): Promise<PendingJobAction[]> {
  const actions = await getPendingJobActions();
  const nextActions = actions.filter((action) => action.id !== actionId);

  await savePendingJobActions(nextActions);

  return nextActions;
}

export async function clearPendingJobActions(): Promise<void> {
  try {
    await AsyncStorage.removeItem(JOBS_QUEUE_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to clear offline jobs queue:", error);
    throw error;
  }
}

/**
 * Optional hilfreich:
 * Gibt alle Actions für einen bestimmten Job zurück.
 */
export async function getPendingActionsForJob(
  jobId: string,
): Promise<PendingJobAction[]> {
  const actions = await getPendingJobActions();
  return actions.filter((action) => action.jobId === jobId);
}