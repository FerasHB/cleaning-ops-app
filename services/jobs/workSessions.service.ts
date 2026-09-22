import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import * as Crypto from "expo-crypto";
import { supabase } from "@/lib/supabase";
import { fetchAppConfig } from "@/services/appConfig.service";
import { getCachedAppConfig } from "@/services/offline/appConfig.storage";
import { completeJob, startJob } from "@/services/jobs/jobs.service";
import type { Job } from "@/types/job";
import { beginWorkTiming, markWorkTiming } from "@/utils/workTiming";
import {
  classifyWorkFailure,
  createWorkJournal,
  refreshActiveSnapshot,
  resolveWorkRoute,
  type ActiveWorkSession,
  type WorkAction,
  type WorkOperation,
  type WorkReceipt,
  type WorkSummary,
} from "@/services/offline/workJournal.core";

function canonicalSummary(value: Record<string, unknown>): WorkSummary {
  return {
    assignmentId: String(value.assignment_id),
    trackingMode: value.tracking_mode === "sessions" ? "sessions" : "legacy",
    workRevision: Number(value.work_revision),
    assignmentState: value.assignment_state as WorkSummary["assignmentState"],
    activeSessionId: value.active_session_id as string | null,
    activeSince: value.active_since as string | null,
    latestSessionEnd: value.latest_session_end as string | null,
    closedSeconds: Number(value.closed_seconds),
    reviewRequired: Boolean(value.review_required),
    // Neutraler Marker: es existiert mindestens eine Korrektur zu dieser
    // Zuweisung. Traegt bewusst KEINEN Grund und KEINEN Akteur.
    reviewed: Boolean(value.reviewed),
    employeeCompletedAt: value.employee_completed_at as string | null,
  };
}

function canonicalReceipt(value: Record<string, unknown>): WorkReceipt {
  return {
    ...canonicalSummary(value),
    operationId: String(value.operation_id),
    sessionId: value.session_id as string | null,
    employeeStartedAt: value.employee_started_at as string | null,
    jobStatus: value.job_status as WorkReceipt["jobStatus"],
    recordedAt: String(value.recorded_at),
  };
}

/** The RPC gets the persisted IDs and timestamp verbatim on every attempt. */
export async function sendWorkOperation(operation: WorkOperation): Promise<WorkReceipt> {
  const rpc = {
    start: ["start_own_job_v2", "started_at_input"],
    pause: ["pause_own_job", "paused_at_input"],
    resume: ["resume_own_job", "resumed_at_input"],
    complete: ["complete_own_job_v2", "completed_at_input"],
  } as const;
  const [name, timestampKey] = rpc[operation.action];
  // Replayed offline operations reach this path without executeAssignmentAction.
  markWorkTiming(operation.operationId, "sync begin");
  markWorkTiming(operation.operationId, "RPC begin");
  try {
    const { data, error } = await supabase.rpc(name, {
      operation_id_input: operation.operationId,
      assignment_id_input: operation.assignmentId,
      expected_revision_input: operation.expectedRevision,
      session_id_input: operation.sessionId,
      [timestampKey]: operation.actionTimestamp,
    });
    if (error) throw error;
    markWorkTiming(operation.operationId, "RPC acknowledged");
    return canonicalReceipt(data as Record<string, unknown>);
  } catch (error) {
    markWorkTiming(operation.operationId, "RPC error");
    throw error;
  }
}

export const workJournal = createWorkJournal({
  storage: AsyncStorage,
  execute: sendWorkOperation,
  classify: classifyWorkFailure,
  currentUserId: async () => (await supabase.auth.getSession()).data.session?.user.id ?? null,
  uuid: () => Crypto.randomUUID(),
  now: () => new Date().toISOString(),
});

export async function fetchAssignmentWorkSummary(assignmentId: string): Promise<WorkSummary> {
  const { data, error } = await supabase.rpc("get_assignment_work_summary", { p_assignment_id: assignmentId });
  if (error) throw error;
  return canonicalSummary(data as Record<string, unknown>);
}

export async function getAssignmentWorkSummary(userId: string, assignmentId: string): Promise<WorkSummary> {
  const summary = await fetchAssignmentWorkSummary(assignmentId);
  await workJournal.rememberSummary(userId, summary);
  return summary;
}

/** Global lookup, independent of the date-scoped jobs list. RLS limits employee reads. */
export async function getEmployeeActiveWorkSession(userId: string): Promise<ActiveWorkSession | null> {
  const { data: session, error } = await supabase.from("work_sessions")
    .select("id,job_assignment_id,started_at")
    .eq("employee_id", userId).is("ended_at", null).maybeSingle();
  if (error) throw error;
  if (!session) return null;
  const { data: assignment, error: assignmentError } = await supabase.from("job_assignments")
    .select("job_id").eq("id", session.job_assignment_id).single();
  if (assignmentError) throw assignmentError;
  const { data: job, error: jobError } = await supabase.from("jobs")
    .select("company_id").eq("id", assignment.job_id).single();
  if (jobError) throw jobError;
  return {
    sessionId: session.id, assignmentId: session.job_assignment_id,
    jobId: assignment.job_id, companyId: job.company_id, startedAt: session.started_at,
  };
}

export async function refreshActiveWorkSession(userId: string): Promise<ActiveWorkSession | null> {
  const epoch = await workJournal.getEpoch(userId);
  const key = `${userId}:${epoch}`;
  const existing = activeLookups.get(key);
  if (existing) return existing;
  const lookup = refreshActiveSnapshot(workJournal, userId, getEmployeeActiveWorkSession,
    fetchAssignmentWorkSummary, epoch).finally(() => activeLookups.delete(key));
  activeLookups.set(key, lookup);
  return lookup;
}

const activeLookups = new Map<string, Promise<ActiveWorkSession | null>>();

/** Cache actionable assignment revisions without relying on a visible day. */
export async function cacheWorkSummariesFromJobs(userId: string, jobs: Job[]): Promise<void> {
  const sessionAssignments: string[] = [];
  const legacySummaries: WorkSummary[] = [];
  for (const job of jobs) for (const assignee of job.assignees) {
    if (assignee.employeeId !== userId || assignee.employeeCompletedAt) continue;
    if (assignee.trackingMode === "sessions") sessionAssignments.push(assignee.assignmentId);
    else if (!assignee.employeeStartedAt && assignee.workRevision != null) {
      legacySummaries.push({
        assignmentId: assignee.assignmentId, trackingMode: "legacy", workRevision: assignee.workRevision,
        assignmentState: "not_started", activeSessionId: null, activeSince: null,
        latestSessionEnd: null, closedSeconds: 0, reviewRequired: assignee.workReviewRequired ?? false,
        employeeCompletedAt: null,
      });
    }
  }
  const fetched = await Promise.allSettled(sessionAssignments.map(fetchAssignmentWorkSummary));
  await workJournal.rememberSummaries(userId, [
    ...legacySummaries,
    ...fetched.filter((result): result is PromiseFulfilledResult<WorkSummary> => result.status === "fulfilled")
      .map((result) => result.value),
  ]);
}

/** One entry point for online and offline execution; start/complete preserve legacy routing. */
export async function executeAssignmentAction(input: {
  userId: string; companyId: string; jobId: string; assignmentId: string;
  action: WorkAction; actionTimestamp?: string; capability?: boolean;
  tapStartedAt?: number;
}): Promise<{ route: "legacy"; result: unknown } | { route: "sessions"; operation: WorkOperation }> {
  let summary = await workJournal.getSummary(input.userId, input.assignmentId);
  if (!summary) summary = await getAssignmentWorkSummary(input.userId, input.assignmentId);
  const cachedCapability = await getCachedAppConfig();
  let pauseResumeEnabled = input.capability ?? cachedCapability?.pauseResumeEnabled ?? false;
  if (input.capability === undefined && !cachedCapability && (await NetInfo.fetch()).isConnected) {
    pauseResumeEnabled = (await fetchAppConfig()).pauseResumeEnabled;
  }
  if (resolveWorkRoute(summary, input.action, pauseResumeEnabled) === "legacy") {
    if (input.action === "start") return { route: "legacy", result: await startJob(input.jobId, input.actionTimestamp) };
    if (input.action === "complete") return { route: "legacy", result: await completeJob(input.jobId, input.actionTimestamp) };
    throw new Error("Unsupported legacy action");
  }
  const operation = await workJournal.enqueue(input);
  beginWorkTiming(operation.operationId, input.action, input.tapStartedAt, input.jobId);
  // Even when online, durable journal transmission is the sole V2 path.
  if ((await NetInfo.fetch()).isConnected) {
    markWorkTiming(operation.operationId, "sync begin");
    await workJournal.sync(input.userId);
  }
  // The acknowledged receipt already updates the journal's global active session.
  // A network snapshot here would hold the button and pending UI after the RPC.
  const saved = (await workJournal.list(input.userId)).find((item) => item.operationId === operation.operationId);
  if (!saved) throw new Error("Work operation disappeared from journal");
  if (saved.status === "rejected_permanent" || saved.status === "blocked") {
    throw Object.assign(new Error(saved.failureMessage ?? "Work operation requires reconciliation"), {
      kind: saved.failureKind ?? "permanent_rejection", operationId: saved.operationId,
    });
  }
  if (saved.status === "acknowledged") markWorkTiming(saved.operationId, "receipt applied");
  return { route: "sessions", operation: saved };
}

export const startSessionAwareAssignment = (input: Omit<Parameters<typeof executeAssignmentAction>[0], "action">) => executeAssignmentAction({ ...input, action: "start" });
export const pauseSessionAwareAssignment = (input: Omit<Parameters<typeof executeAssignmentAction>[0], "action">) => executeAssignmentAction({ ...input, action: "pause" });
export const resumeSessionAwareAssignment = (input: Omit<Parameters<typeof executeAssignmentAction>[0], "action">) => executeAssignmentAction({ ...input, action: "resume" });
export const completeSessionAwareAssignment = (input: Omit<Parameters<typeof executeAssignmentAction>[0], "action">) => executeAssignmentAction({ ...input, action: "complete" });
