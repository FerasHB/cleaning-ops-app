import type { WorkAction } from "@/services/offline/workJournal.core";
import Constants from "expo-constants";
import { deriveBackendEnvironmentLabel } from "@/utils/backendEnvironment";
import { shouldEnableWorkTiming } from "@/utils/workTimingGate";

type Stage = "persisted" | "sync begin" | "RPC begin" | "RPC acknowledged" |
  "RPC error" | "receipt applied" | "targeted local update" |
  "work snapshot begin" | "work snapshot end" |
  "full refresh begin" | "full refresh end" | "full refresh error";

const enabled = shouldEnableWorkTiming(
  typeof __DEV__ !== "undefined" && __DEV__,
  deriveBackendEnvironmentLabel(process.env.EXPO_PUBLIC_SUPABASE_URL),
  Constants.expoConfig?.name,
);
type Trace = { operationId: string; jobId: string; action: WorkAction; tapAt: number;
  lines: string[]; lastVisible?: string; lastFooter?: string };
export type WorkUiDiagnostic = {
  jobId: string; state: string; parent: string; pending: string;
  canStart: boolean; canPause: boolean; canResume: boolean; canComplete: boolean;
  blockReason: string; online: boolean; isMutating: boolean; isSyncing: boolean;
  capability: boolean; role: string; summaryMode: string; ownMode: string;
  revision: number | null; expectedRevision: number | null;
  summaryAssignmentMatches: boolean; sessionMatches: boolean;
  footerShown?: boolean; footerCanStart?: boolean; footerCanPause?: boolean;
  footerCanResume?: boolean; footerCanComplete?: boolean; footerEnabled?: boolean;
};
const traces: Trace[] = [];
const listeners = new Set<() => void>();
let snapshot = "No work action recorded yet.";
let workUiDiagnostic: WorkUiDiagnostic | null = null;
let footerDiagnostic: Pick<WorkUiDiagnostic, "jobId" | "footerShown" | "footerCanStart" |
  "footerCanPause" | "footerCanResume" | "footerCanComplete" | "footerEnabled"> | null = null;

function emit(): void {
  snapshot = traces.slice().reverse().map((trace) =>
    `${trace.action.toUpperCase()} · ${new Date(trace.tapAt).toISOString()}\n${trace.lines.join("\n")}`,
  ).join("\n\n") || "No work action recorded yet.";
  listeners.forEach((listener) => listener());
}

function append(trace: Trace, label: string): void {
  trace.lines.push(`+${Math.max(0, Date.now() - trace.tapAt)}ms ${label}`);
  if (trace.lines.length > 30) trace.lines.shift();
  console.log(`[WorkTiming] ${trace.action} ${trace.operationId.slice(-8)} ${trace.lines.at(-1)}`);
  emit();
}

export function getWorkTimingTrace(): string { return enabled ? snapshot : ""; }
export function getWorkUiDiagnostic(): WorkUiDiagnostic | null {
  return enabled ? workUiDiagnostic : null;
}
export function subscribeWorkTiming(listener: () => void): () => void {
  if (!enabled) return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Development/Staging timing only; IDs are abbreviated and payloads are never logged. */
export function beginWorkTiming(operationId: string, action: WorkAction, tapAt?: number, jobId = ""): void {
  if (!enabled) return;
  const trace: Trace = { operationId, jobId, action, tapAt: tapAt ?? Date.now(), lines: ["+0ms tap"] };
  traces.push(trace);
  if (traces.length > 4) traces.shift();
  emit();
  markWorkTiming(operationId, "persisted");
}

export function markWorkTiming(operationId: string, stage: Stage): void {
  if (!enabled) return;
  const trace = traces.find((item) => item.operationId === operationId);
  if (!trace || trace.lines.some((line) => line.endsWith(` ${stage}`))) return;
  append(trace, stage);
}

export function markVisibleWorkTiming(input: {
  jobId: string; state: string; parent: string; pending: string;
  start: boolean; pause: boolean; resume: boolean; complete: boolean;
  reason: string; online: boolean; submitting: boolean;
  syncing: boolean;
  capability: boolean; role: string; summaryMode: string; ownMode: string;
  revision: number | null; expectedRevision: number | null;
  summaryAssignmentMatches: boolean; sessionMatches: boolean;
}): void {
  if (!enabled) return;
  const currentFooter = footerDiagnostic?.jobId === input.jobId ? footerDiagnostic : null;
  workUiDiagnostic = {
    jobId: input.jobId, state: input.state, parent: input.parent, pending: input.pending,
    canStart: input.start, canPause: input.pause, canResume: input.resume,
    canComplete: input.complete, blockReason: input.reason, online: input.online,
    isMutating: input.submitting, isSyncing: input.syncing,
    capability: input.capability, role: input.role, summaryMode: input.summaryMode,
    ownMode: input.ownMode, revision: input.revision,
    expectedRevision: input.expectedRevision,
    summaryAssignmentMatches: input.summaryAssignmentMatches,
    sessionMatches: input.sessionMatches,
    ...(currentFooter ?? {}),
  };
  emit();
  const trace = traces.at(-1);
  if (!trace || trace.jobId !== input.jobId) return;
  const line = `visible state=${input.state} parent=${input.parent} pending=${input.pending}` +
    ` start=${Number(input.start)} pause=${Number(input.pause)}` +
    ` resume=${Number(input.resume)} complete=${Number(input.complete)}` +
    ` reason=${input.reason} online=${Number(input.online)}` +
    ` mutating=${Number(input.submitting)} syncing=${Number(input.syncing)}` +
    `\n  cap=${Number(input.capability)} role=${input.role} summary=${input.summaryMode}` +
    ` own=${input.ownMode} rev=${input.revision ?? "none"}/${input.expectedRevision ?? "none"}` +
    ` assignmentMatch=${Number(input.summaryAssignmentMatches)}` +
    ` sessionMatch=${Number(input.sessionMatches)}`;
  if (trace.lastVisible === line) return;
  trace.lastVisible = line;
  append(trace, line);
}

export function markFooterWorkTiming(input: {
  jobId: string; shown: boolean; start: boolean; pause: boolean; resume: boolean;
  complete: boolean; submitting: boolean;
}): void {
  if (!enabled) return;
  footerDiagnostic = { jobId: input.jobId, footerShown: input.shown,
    footerCanStart: input.start, footerCanPause: input.pause,
    footerCanResume: input.resume, footerCanComplete: input.complete,
    footerEnabled: !input.submitting };
  if (workUiDiagnostic?.jobId === input.jobId) {
    workUiDiagnostic = { ...workUiDiagnostic, ...footerDiagnostic };
    emit();
  }
  const trace = traces.at(-1);
  if (!trace || trace.jobId !== input.jobId) return;
  const line = `footer shown=${Number(input.shown)} start=${Number(input.start)}` +
    ` pause=${Number(input.pause)}` +
    ` resume=${Number(input.resume)} complete=${Number(input.complete)}` +
    ` enabled=${Number(!input.submitting)}`;
  if (trace.lastFooter === line) return;
  trace.lastFooter = line;
  append(trace, line);
}
