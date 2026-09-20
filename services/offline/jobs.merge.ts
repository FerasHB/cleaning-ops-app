import type { Job } from "@/types/job";
import type { PendingJobAction } from "./jobs.queue";
import type { WorkOperation } from "./workJournal.core";

/**
 * Wendet eine einzelne Pending Action lokal auf einen Job an.
 */
function applyPendingActionToJob(job: Job, action: PendingJobAction): Job {
  switch (action.type) {
    // Der Akteur ist eindeutig der Besitzer der Aktion: die Warteschlange
    // liefert ausschließlich Aktionen des angemeldeten Nutzers (siehe
    // getPendingJobActions), und beim Sync setzt der Server genau denselben
    // Wert (auth.uid()). Ohne diese Spiegelung zeigte ein offline gestarteter
    // Job aus dem Cache "läuft, ohne Akteur".
    case "start_job":
      return {
        ...job,
        status: "in_progress" as const,
        startedAt: action.timestamp,
        startedBy: action.userId,
        completedBy: null,
      };

    case "complete_job":
      // An employee finishing their assignment does not necessarily finish
      // the shared job. Keep the parent lifecycle server-authoritative.
      return job;

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

function applyReceiptToParent(job: Job, operation: WorkOperation): Job {
  const receipt = operation.receipt!;
  // The receipt reports parent status, but not parent lifecycle timestamps.
  // Own assignment timestamps must never be substituted for parent timestamps.
  if (receipt.jobStatus === "completed") return { ...job, status: "completed" };
  if (receipt.jobStatus === "in_progress" && job.status === "open") return { ...job, status: "in_progress" };
  return job;
}

/** Apply only an acknowledged server result, never a pending local guess. */
export function applyAcknowledgedWorkOperationToJobs(jobs: Job[], operation: WorkOperation): Job[] {
  if (operation.status !== "acknowledged" || !operation.receipt) return jobs;
  return jobs.map((job) => {
    if (job.id !== operation.jobId) return job;
    const assignee = job.assignees.find((item) => item.assignmentId === operation.assignmentId);
    if (assignee && (assignee.workRevision ?? 0) > operation.receipt!.workRevision) return job;
    const updated = { ...job, assignees: job.assignees.map((item) =>
      item.assignmentId === operation.assignmentId ? {
        ...item, trackingMode: "sessions" as const, workRevision: operation.receipt!.workRevision,
        workReviewRequired: operation.receipt!.reviewRequired,
        employeeStartedAt: operation.receipt!.employeeStartedAt,
        employeeCompletedAt: operation.receipt!.employeeCompletedAt,
        pendingWorkAction: undefined,
      } : item) };
    return applyReceiptToParent(updated, operation);
  });
}

/** A fetch started before an acknowledgement must not roll that acknowledgement back. */
export function preserveNewerWorkJobs(incoming: Job[], current: Job[]): Job[] {
  const currentById = new Map(current.map((job) => [job.id, job]));
  return incoming.map((job) => {
    const existing = currentById.get(job.id);
    if (!existing) return job;
    const revisions = new Map(existing.assignees.map((assignee) => [assignee.assignmentId, assignee.workRevision ?? 0]));
    return job.assignees.some((assignee) => (revisions.get(assignee.assignmentId) ?? 0) > (assignee.workRevision ?? 0))
      ? existing : job;
  });
}

/** Overlay receipts only when the server list snapshot predates their revision. */
export function applyPendingWorkOperationsToJobs(jobs: Job[], operations: WorkOperation[]): Job[] {
  if (operations.length === 0) return jobs;
  const ordered = [...operations].sort((a, b) => a.localSequence - b.localSequence);
  const byAssignment = new Map<string, WorkOperation[]>();
  for (const operation of ordered) {
    const own = byAssignment.get(operation.assignmentId) ?? [];
    own.push(operation);
    byAssignment.set(operation.assignmentId, own);
  }
  return jobs.map((job) => {
    if (!job.assignees.some((assignee) => byAssignment.has(assignee.assignmentId))) return job;
    let parentReceipt: WorkOperation | null = null;
    const assignees = job.assignees.map((assignee) => {
      const own = (byAssignment.get(assignee.assignmentId) ?? []).filter((op) => op.jobId === job.id);
      const acknowledged = own.filter((op) => op.status === "acknowledged" && op.receipt).at(-1);
      const receipt = acknowledged?.receipt;
      const newer = !!receipt && receipt.workRevision > (assignee.workRevision ?? 0);
      if (newer && acknowledged && (!parentReceipt || acknowledged.localSequence > parentReceipt.localSequence)) {
        parentReceipt = acknowledged;
      }
      const canonical = newer && receipt
        ? { ...assignee, trackingMode: "sessions" as const, workRevision: receipt.workRevision,
          workReviewRequired: receipt.reviewRequired,
          employeeStartedAt: receipt.employeeStartedAt,
          employeeCompletedAt: receipt.employeeCompletedAt }
        : assignee;
      const latest = own.filter((op) => (op.status === "pending" || op.status === "syncing") &&
        op.expectedRevision >= (canonical.workRevision ?? 0)).at(-1);
      return { ...canonical, pendingWorkAction: latest?.action };
    });
    const updated = { ...job, assignees };
    return parentReceipt ? applyReceiptToParent(updated, parentReceipt) : updated;
  });
}
