import type { Job } from "@/types/job";
import type { ActiveWorkSession, WorkOperation, WorkSummary } from "@/services/offline/workJournal.core";
import { canCompleteOwnAssignment, canRunJobActions, canStartOwnAssignment, getOwnAssignee } from "@/utils/jobAssignees";

export type AssignmentWorkUi = {
  mode: "legacy" | "sessions";
  state: "not_started" | "active" | "paused" | "completed" | "loading";
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canComplete: boolean;
  pending: WorkOperation | null;
  reviewRequired: boolean;
  blockReason: "capability_off" | "legacy" | "authorization" | "reconciliation" | "projection" | null;
};

export function deriveAssignmentWorkUi(input: {
  job: Job; role: string | null | undefined; userId: string | null | undefined;
  capability: boolean; summary?: WorkSummary | null; operations?: WorkOperation[];
}): AssignmentWorkUi {
  const { job, role, userId, capability, summary, operations = [] } = input;
  const own = getOwnAssignee(job, userId);
  const ownOperations = operations.filter((op) => op.userId === userId && op.assignmentId === own?.assignmentId);
  const pending = ownOperations.filter((op) => op.status === "pending" || op.status === "syncing")
    .sort((a, b) => a.localSequence - b.localSequence).at(-1) ?? null;
  const needsReconciliation = operations.some((op) => op.userId === userId &&
    (op.status === "blocked" || op.status === "rejected_permanent"));
  const hasSessionWork = own?.trackingMode === "sessions" || summary?.trackingMode === "sessions" ||
    ownOperations.length > 0;
  const sessionMode = capability && !!own &&
    (hasSessionWork || !own.employeeStartedAt && !own.employeeCompletedAt);
  if (hasSessionWork && !capability) {
    return { mode: "sessions", state: summary?.assignmentState ?? "loading",
      canStart: false, canPause: false, canResume: false, canComplete: false,
      pending, reviewRequired: !!(summary?.reviewRequired ?? own?.workReviewRequired),
      blockReason: "capability_off" };
  }
  if (!sessionMode) {
    const state = own?.employeeCompletedAt ? "completed" : own?.employeeStartedAt ? "active" : "not_started";
    return { mode: "legacy", state,
      canStart: canStartOwnAssignment(job, role, userId), canPause: false, canResume: false,
      canComplete: canCompleteOwnAssignment(job, role, userId), pending: null,
      reviewRequired: false, blockReason: "legacy" };
  }
  const state = summary?.assignmentState ??
    (own?.employeeCompletedAt ? "completed" : own?.employeeStartedAt ? "loading" : "not_started");
  // Pending work changes the effective state. Require its projected revision;
  // a stale or missing projection must not expose an old action again.
  const pendingState = pending?.action === "pause" ? "paused" :
    pending?.action === "complete" ? "completed" : "active";
  const pendingSession = pending?.action === "start" || pending?.action === "resume"
    ? pending.sessionId : null;
  const hasEffectiveState = !pending || !!summary && summary.trackingMode === "sessions" &&
    summary.assignmentId === pending.assignmentId && summary.workRevision === pending.expectedRevision + 1 &&
    summary.assignmentState === pendingState && summary.activeSessionId === pendingSession;
  const allowed = canRunJobActions(job, role, userId) && !needsReconciliation && hasEffectiveState;
  const blockReason = !canRunJobActions(job, role, userId) ? "authorization"
    : needsReconciliation ? "reconciliation" : !hasEffectiveState ? "projection" : null;
  return { mode: "sessions", state,
    canStart: allowed && state === "not_started" && job.status !== "completed",
    canPause: allowed && state === "active",
    canResume: allowed && state === "paused",
    canComplete: allowed && (state === "active" || state === "paused"),
    pending, reviewRequired: !!(summary?.reviewRequired ?? own?.workReviewRequired), blockReason };
}

export function displayedWorkSeconds(input: {
  summary: WorkSummary | null | undefined; recorded?: WorkSummary | null;
  pending?: WorkOperation | null; now: number;
}): number {
  const { summary, recorded, pending, now } = input;
  if (!summary) return 0;
  const elapsed = (since: string | null, until: number) => since && Number.isFinite(Date.parse(since))
    ? Math.max(0, Math.floor((until - Date.parse(since)) / 1000)) : 0;
  if (summary.assignmentState === "active") return summary.closedSeconds + elapsed(summary.activeSince, now);
  if (pending && (pending.action === "pause" || pending.action === "complete") && recorded?.activeSince) {
    return recorded.closedSeconds + elapsed(recorded.activeSince, Date.parse(pending.actionTimestamp));
  }
  return summary.closedSeconds;
}

export function formatWorkedSeconds(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export function selectActiveEmployeeJob(jobs: Job[], active: ActiveWorkSession | null,
  capability: boolean, role: string | null | undefined, userId: string | null | undefined): Job | undefined {
  return capability ? jobs.find((job) => job.id === active?.jobId)
    : jobs.find((job) => job.status === "in_progress" && canRunJobActions(job, role, userId));
}

export function otherActiveJob(active: ActiveWorkSession | null, jobId: string): string | null {
  return active && active.jobId !== jobId ? active.jobId : null;
}

export function reconciliationOptions(operation: WorkOperation, operations: WorkOperation[], online: boolean) {
  const hasDependents = operations.some((item) => item.predecessorOperationId === operation.operationId);
  const retryable = operation.status === "pending" &&
    (operation.failureKind === "transport" || operation.failureKind === "auth_expired");
  return { hasDependents, canRetry: retryable && online,
    canRefresh: !retryable, canDiscard: !retryable && !hasDependents &&
      (operation.status === "blocked" || operation.status === "rejected_permanent") };
}

export function hasActiveAssignmentSession(summaries: Record<string, WorkSummary>, job: Job): boolean {
  return job.assignees.some((assignee) => assignee.trackingMode === "sessions" &&
    !!summaries[assignee.assignmentId]?.activeSessionId);
}

/** Synchronous guard across every entry point for the same assignment. */
export async function runAssignmentActionOnce<T>(busy: Set<string>, assignmentId: string,
  action: () => Promise<T>): Promise<T | undefined> {
  if (busy.has(assignmentId)) return undefined;
  busy.add(assignmentId);
  try { return await action(); }
  finally { busy.delete(assignmentId); }
}
