import type { Job, JobAssignee } from "@/types/job";
import type { PendingJobAction } from "./jobs.queue";
import type { WorkOperation } from "./workJournal.core";

/**
 * Setzt den lokalen Warteschlangen-Marker (pendingStartAt/pendingCompleteAt)
 * auf der EIGENEN Zuweisungszeile des Aktions-Besitzers. Fremde Zeilen und
 * die Server-Felder employeeStartedAt/employeeCompletedAt bleiben unberührt.
 */
function markOwnAssignee(
  job: Job,
  userId: string,
  patch: (assignee: JobAssignee) => JobAssignee,
): Job {
  if (!job.assignees?.some((a) => a.employeeId === userId)) return job;
  return {
    ...job,
    assignees: job.assignees.map((a) => (a.employeeId === userId ? patch(a) : a)),
  };
}

/**
 * Wendet eine einzelne Pending Action lokal auf einen Job an.
 *
 * FE-1: die Gates canStartOwnAssignment/canCompleteOwnAssignment lesen die
 * EIGENE Zuweisungszeile. Ohne Marker dort blieb nach einem Offline-Start
 * „Starten" antippbar und „Abschließen" erschien nie. Der Marker ist bewusst
 * KEIN employeeStartedAt — ein eingereihter Start ist kein vom Server
 * bestätigter Start (types/job.ts).
 */
function applyPendingActionToJob(job: Job, action: PendingJobAction): Job {
  switch (action.type) {
    case "start_job": {
      // Der Akteur ist eindeutig der Besitzer der Aktion: die Warteschlange
      // liefert ausschließlich Aktionen des angemeldeten Nutzers (siehe
      // getPendingJobActions), und beim Sync setzt der Server genau denselben
      // Wert (auth.uid()). Ohne diese Spiegelung zeigte ein offline gestarteter
      // Job aus dem Cache "läuft, ohne Akteur".
      //
      // Nur der echte Übergang open → in_progress spiegelt die Auftrags-Uhr.
      // Läuft der Auftrag bereits (Nachzügler), ändert start_own_job
      // serverseitig nur die eigene Zuweisung — die Startzeit/der Akteur der
      // Kollegin dürfen lokal nicht überschrieben werden.
      const parent: Job = job.status === "open"
        ? {
          ...job,
          status: "in_progress" as const,
          startedAt: action.timestamp,
          startedBy: action.userId,
          completedBy: null,
        }
        : job;
      return markOwnAssignee(parent, action.userId, (a) =>
        a.employeeStartedAt ? a : { ...a, pendingStartAt: action.timestamp });
    }

    case "complete_job":
      // An employee finishing their assignment does not necessarily finish
      // the shared job. Keep the parent lifecycle server-authoritative —
      // only the own row carries a local "Abschluss ausstehend" marker.
      return markOwnAssignee(job, action.userId, (a) =>
        a.employeeCompletedAt ? a : { ...a, pendingCompleteAt: action.timestamp });

    default:
      return job;
  }
}

/**
 * Entfernt lokale Warteschlangen-Marker. Sie werden bei JEDEM Merge aus der
 * aktuellen Warteschlange neu abgeleitet — ein Marker, der z. B. über einen
 * aus dem State geschriebenen Cache-Eintrag hereinkommt, überlebt dadurch
 * nie die synchronisierte oder abgelehnte Aktion.
 */
function stripLocalAssigneeMarkers(job: Job): Job {
  if (!job.assignees?.some((a) => a.pendingStartAt || a.pendingCompleteAt)) return job;
  return {
    ...job,
    assignees: job.assignees.map((a) => {
      if (!a.pendingStartAt && !a.pendingCompleteAt) return a;
      const { pendingStartAt: _s, pendingCompleteAt: _c, ...rest } = a;
      return rest;
    }),
  };
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
  if (!pendingActions.length && !jobs.some((job) =>
    job.assignees?.some((a) => a.pendingStartAt || a.pendingCompleteAt))) {
    return jobs;
  }

  const sortedActions = sortPendingActions(pendingActions);

  return jobs.map((input) => {
    const job = stripLocalAssigneeMarkers(input);
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

/**
 * FE-2: ersetzt einen Listeneintrag durch die frisch gelesene Server-Kopie
 * (getJobById nach start_own_job/complete_own_job). Nötig, weil diese RPCs im
 * Nachzügler-/Teilabschluss-Fall nur job_assignments ändern — die
 * jobs-Realtime-Subscription feuert dann nicht. Das Ungelesen-Flag stammt
 * nicht aus mapJob und bleibt erhalten; noch wartende eigene Aktionen werden
 * wie bei jedem Merge erneut darübergelegt.
 */
export function replaceJobWithServerCopy(
  jobs: Job[],
  fresh: Job,
  pendingActions: PendingJobAction[],
): Job[] {
  return jobs.map((job) => {
    if (job.id !== fresh.id) return job;
    const [merged] = applyPendingActionsToJobs(
      [{ ...fresh, hasUnreadComments: job.hasUnreadComments }],
      pendingActions.filter((a) => a.status === "pending"),
    );
    return merged;
  });
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
