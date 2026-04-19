import { Job } from "@/types/job";
import { PendingJobAction } from "./jobs.queue";

/**
 * Wendet eine einzelne Pending Action lokal auf einen Job an.
 */
function applyPendingActionToJob(job: Job, action: PendingJobAction): Job {
  switch (action.type) {
    case "start_job":
      return {
        ...job,
        status: "in_progress" as const,
        startedAt: action.timestamp,
      };

    case "complete_job":
      return {
        ...job,
        status: "completed" as const,
        completedAt: action.timestamp,
      };

    default:
      return job;
  }
}

/**
 * Sortiert Actions sauber nach Zeit, damit sie in richtiger Reihenfolge angewendet werden.
 */
function sortPendingActions(actions: PendingJobAction[]): PendingJobAction[] {
  return [...actions].sort((a, b) => {
    const aTime = new Date(a.timestamp).getTime();
    const bTime = new Date(b.timestamp).getTime();

    return aTime - bTime;
  });
}

/**
 * Wendet alle Pending Actions auf die Jobliste an.
 * Wichtig:
 * - Serverdaten bleiben Basis
 * - lokale Offline-Aktionen überschreiben den sichtbaren Stand
 */
export function applyPendingActionsToJobs(
  jobs: Job[],
  pendingActions: PendingJobAction[],
): Job[] {
  if (!pendingActions.length) {
    return jobs;
  }

  const sortedActions = sortPendingActions(pendingActions);

  return jobs.map((job) => {
    const actionsForJob = sortedActions.filter(
      (action) => action.jobId === job.id,
    );

    if (!actionsForJob.length) {
      return job;
    }

    return actionsForJob.reduce((currentJob, action) => {
      return applyPendingActionToJob(currentJob, action);
    }, job);
  });
}

/**
 * Wendet genau eine Pending Action auf die aktuelle Jobliste an.
 * Das ist praktisch für direkte lokale UI-Updates.
 */
export function applySinglePendingActionToJobs(
  jobs: Job[],
  action: PendingJobAction,
): Job[] {
  return jobs.map((job) => {
    if (job.id !== action.jobId) {
      return job;
    }

    return applyPendingActionToJob(job, action);
  });
}

/**
 * Hilfsfunktion:
 * Prüft, ob ein Job lokale ausstehende Änderungen hat.
 */
export function hasPendingActionForJob(
  jobId: string,
  pendingActions: PendingJobAction[],
): boolean {
  return pendingActions.some((action) => action.jobId === jobId);
}