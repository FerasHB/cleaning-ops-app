/** Durable, account-scoped session operation journal. No React Native dependencies. */
export type WorkAction = "start" | "pause" | "resume" | "complete";
export type WorkOperationStatus = "pending" | "syncing" | "acknowledged" | "blocked" | "rejected_permanent";
export type WorkAssignmentState = "not_started" | "active" | "paused" | "completed";
export type WorkSummary = {
  assignmentId: string;
  trackingMode: "legacy" | "sessions";
  workRevision: number;
  assignmentState: WorkAssignmentState;
  activeSessionId: string | null;
  activeSince: string | null;
  latestSessionEnd: string | null;
  closedSeconds: number;
  reviewRequired: boolean;
  employeeCompletedAt: string | null;
};
export type WorkReceipt = Omit<WorkSummary, "trackingMode"> & {
  operationId: string;
  sessionId: string | null;
  employeeStartedAt: string | null;
  jobStatus: "open" | "in_progress" | "completed";
  recordedAt: string;
};
export type ActiveWorkSession = {
  sessionId: string;
  assignmentId: string;
  jobId: string;
  companyId: string;
  startedAt: string;
};
export type WorkOperation = {
  operationId: string;
  action: WorkAction;
  userId: string;
  companyId: string;
  jobId: string;
  assignmentId: string;
  actionTimestamp: string;
  sessionId: string | null;
  expectedRevision: number;
  localSequence: number;
  predecessorOperationId: string | null;
  status: WorkOperationStatus;
  createdAt: string;
  updatedAt: string;
  failureKind?: WorkFailureKind;
  failureMessage?: string;
  receipt?: WorkReceipt;
};
export type WorkJournalSnapshot = {
  operations: WorkOperation[];
  active: ActiveWorkSession | null;
  summaries: Record<string, WorkSummary>;
  recordedSummaries: Record<string, WorkSummary>;
};
export type WorkFailureKind = "transport" | "auth_expired" | "unsupported" | "revision_conflict" | "business_conflict" | "permanent_rejection";
export type WorkFailure = { kind: WorkFailureKind; message: string };

export function classifyWorkFailure(error: unknown): WorkFailure {
  const item = error as { code?: string; message?: string; status?: number } | null;
  const code = item?.code ?? "";
  const message = item?.message ?? (error instanceof Error ? error.message : String(error));
  if (code === "PGRST301" || code === "28000" || item?.status === 401 || /jwt expired|not authenticated/i.test(message)) return { kind: "auth_expired", message };
  if (/pause\/resume is not enabled|requires (the )?new execution rpc|upgrade|client build|unsupported/i.test(message)) return { kind: "unsupported", message };
  if (/stale work revision/i.test(message)) return { kind: "revision_conflict", message };
  if (code === "57014" || (item?.status ?? 0) >= 500 || /network|fetch|timeout|timed out|service unavailable|connection/i.test(message)) return { kind: "transport", message };
  if (code === "22023" || code === "23505") return { kind: "business_conflict", message };
  return { kind: "permanent_rejection", message };
}
export type JournalStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};
export type WorkJournalDependencies = {
  storage: JournalStorage;
  execute(operation: WorkOperation): Promise<WorkReceipt>;
  classify(error: unknown): WorkFailure;
  currentUserId(): Promise<string | null>;
  uuid(): string;
  now(): string;
};

export function resolveWorkRoute(summary: WorkSummary, action: WorkAction, pauseResumeEnabled: boolean): "legacy" | "sessions" {
  if (summary.trackingMode === "sessions") return "sessions";
  if (action === "start" && summary.assignmentState === "not_started" && pauseResumeEnabled) return "sessions";
  if (action === "pause" || action === "resume") throw new Error("Pause and Resume require a session-aware assignment");
  return "legacy";
}

export async function refreshActiveSnapshot(
  journal: {
    getEpoch(userId: string): Promise<number>;
    getActive(userId: string): Promise<ActiveWorkSession | null>;
    rememberActive(userId: string, active: ActiveWorkSession | null, expectedEpoch: number): Promise<boolean>;
    rememberSummary(userId: string, summary: WorkSummary): Promise<unknown>;
  },
  userId: string,
  lookupActive: (userId: string) => Promise<ActiveWorkSession | null>,
  lookupSummary: (assignmentId: string) => Promise<WorkSummary>,
  knownEpoch?: number,
): Promise<ActiveWorkSession | null> {
  const epoch = knownEpoch ?? await journal.getEpoch(userId);
  const active = await lookupActive(userId);
  if (!await journal.rememberActive(userId, active, epoch)) return journal.getActive(userId);
  if (active) await journal.rememberSummary(userId, await lookupSummary(active.assignmentId));
  return active;
}
type JournalData = {
  version: 1;
  userId: string;
  epoch: number;
  nextSequence: number;
  operations: WorkOperation[];
  summaries: Record<string, WorkSummary>;
  active: ActiveWorkSession | null;
};

function sameSummary(a: WorkSummary, b: WorkSummary): boolean {
  return a.assignmentId === b.assignmentId && a.trackingMode === b.trackingMode &&
    a.workRevision === b.workRevision && a.assignmentState === b.assignmentState &&
    a.activeSessionId === b.activeSessionId && a.activeSince === b.activeSince &&
    a.latestSessionEnd === b.latestSessionEnd && a.closedSeconds === b.closedSeconds &&
    a.reviewRequired === b.reviewRequired && a.employeeCompletedAt === b.employeeCompletedAt;
}

function storeSummary(data: JournalData, summary: WorkSummary): boolean {
  const previous = data.summaries[summary.assignmentId];
  if (previous && (summary.workRevision < previous.workRevision || sameSummary(previous, summary))) return false;
  data.summaries[summary.assignmentId] = summary;
  return true;
}

function sameActive(a: ActiveWorkSession | null, b: ActiveWorkSession | null): boolean {
  return a === b || !!a && !!b && a.sessionId === b.sessionId &&
    a.assignmentId === b.assignmentId && a.jobId === b.jobId &&
    a.companyId === b.companyId && a.startedAt === b.startedAt;
}

function empty(userId: string): JournalData {
  return { version: 1, userId, epoch: 0, nextSequence: 1, operations: [], summaries: {}, active: null };
}

function key(userId: string): string {
  return `offline_work_journal_v1:${userId}`;
}

function project(base: WorkSummary, operations: WorkOperation[]): WorkSummary {
  let result = { ...base };
  for (const op of [...operations].sort((a, b) => a.localSequence - b.localSequence)) {
    if (op.assignmentId !== base.assignmentId || op.status === "acknowledged" || op.status === "rejected_permanent" || op.status === "blocked") continue;
    if (op.expectedRevision < result.workRevision) throw new Error("Work revision requires reconciliation");
    if (op.expectedRevision !== result.workRevision) throw new Error("Work revision requires reconciliation");
    const sessionStart = result.activeSince ? Date.parse(result.activeSince) : NaN;
    const sessionEnd = Date.parse(op.actionTimestamp);
    const closedSeconds = (op.action === "pause" || op.action === "complete") &&
      Number.isFinite(sessionStart) && Number.isFinite(sessionEnd)
      ? result.closedSeconds + Math.max(0, (sessionEnd - sessionStart) / 1000)
      : result.closedSeconds;
    result = {
      ...result,
      trackingMode: "sessions",
      workRevision: result.workRevision + 1,
      assignmentState: op.action === "pause" ? "paused" : op.action === "complete" ? "completed" : "active",
      activeSessionId: op.action === "start" || op.action === "resume" ? op.sessionId : null,
      activeSince: op.action === "start" || op.action === "resume" ? op.actionTimestamp : null,
      latestSessionEnd: (op.action === "pause" || op.action === "complete") && Number.isFinite(sessionStart)
        ? op.actionTimestamp : result.latestSessionEnd,
      closedSeconds,
      employeeCompletedAt: op.action === "complete" ? op.actionTimestamp : result.employeeCompletedAt,
    };
  }
  return result;
}

function projectActive(active: ActiveWorkSession | null, operations: WorkOperation[]): ActiveWorkSession | null {
  let result = active;
  for (const op of operations) {
    if (op.status === "acknowledged" || op.status === "blocked" || op.status === "rejected_permanent") continue;
    if ((op.action === "start" || op.action === "resume") && op.sessionId) result = {
      sessionId: op.sessionId, assignmentId: op.assignmentId, jobId: op.jobId,
      companyId: op.companyId, startedAt: op.actionTimestamp,
    };
    if ((op.action === "pause" || op.action === "complete") && result?.assignmentId === op.assignmentId) result = null;
  }
  return result;
}

export function createWorkJournal(deps: WorkJournalDependencies) {
  // One mutex covers every read-modify-write cycle, including status changes.
  let lock: Promise<unknown> = Promise.resolve();
  const workers = new Map<string, Promise<{ acknowledged: number; stopped: WorkFailureKind | null }>>();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = lock.then(fn, fn);
    lock = result.catch(() => undefined);
    return result;
  };
  const read = async (userId: string): Promise<JournalData> => {
    const raw = await deps.storage.getItem(key(userId));
    if (!raw) return empty(userId);
    const value = JSON.parse(raw) as JournalData;
    if (value.version !== 1 || value.userId !== userId || !Array.isArray(value.operations) ||
      value.operations.some((op) => op.userId !== userId)) {
      throw new Error("Unsupported work journal version; retained for recovery");
    }
    value.epoch ??= 0;
    // A process may die after transmission but before saving the receipt.
    // `syncing` is replayable with the same IDs after restart; a live worker
    // is deduplicated by the per-user worker map below.
    return value;
  };
  const write = (userId: string, data: JournalData) => {
    data.epoch++;
    return deps.storage.setItem(key(userId), JSON.stringify(data));
  };

  const list = (userId: string) => serialized(async () => (await read(userId)).operations);
  const getEpoch = (userId: string) => serialized(async () => (await read(userId)).epoch);
  const getSummary = (userId: string, assignmentId: string) => serialized(async () => {
    const data = await read(userId);
    const base = data.summaries[assignmentId];
    return base ? project(base, data.operations) : null;
  });
  const getRecordedSummary = (userId: string, assignmentId: string) => serialized(async () =>
    (await read(userId)).summaries[assignmentId] ?? null);
  /** One account-scoped storage read supplies every visible assignment. */
  const getUiSnapshot = (userId: string): Promise<WorkJournalSnapshot> => serialized(async () => {
    const data = await read(userId);
    const byAssignment = new Map<string, WorkOperation[]>();
    for (const operation of data.operations) {
      if (operation.status === "acknowledged" || operation.status === "blocked" ||
        operation.status === "rejected_permanent") continue;
      const own = byAssignment.get(operation.assignmentId) ?? [];
      own.push(operation);
      byAssignment.set(operation.assignmentId, own);
    }
    const summaries: Record<string, WorkSummary> = {};
    for (const [assignmentId, summary] of Object.entries(data.summaries)) {
      try {
        summaries[assignmentId] = project(summary, byAssignment.get(assignmentId) ?? []);
      } catch {
        // A conflicted assignment must not hide every other job's work state.
      }
    }
    return {
      operations: data.operations,
      active: projectActive(data.active, data.operations),
      summaries,
      recordedSummaries: data.summaries,
    };
  });
  const getActive = (userId: string) => serialized(async () => {
    const data = await read(userId);
    return projectActive(data.active, data.operations);
  });
  const rememberSummary = (userId: string, summary: WorkSummary) => serialized(async () => {
    const data = await read(userId);
    if (storeSummary(data, summary)) await write(userId, data);
    return project(data.summaries[summary.assignmentId], data.operations);
  });
  const rememberSummaries = (userId: string, summaries: WorkSummary[]) => serialized(async () => {
    if (summaries.length === 0) return;
    const data = await read(userId);
    let changed = false;
    for (const summary of summaries) changed = storeSummary(data, summary) || changed;
    if (changed) await write(userId, data);
  });
  const rememberActive = (userId: string, active: ActiveWorkSession | null, expectedEpoch?: number) => serialized(async () => {
    const data = await read(userId);
    if (expectedEpoch != null && data.epoch !== expectedEpoch) return false;
    if (sameActive(data.active, active)) return true;
    data.active = active;
    await write(userId, data);
    return true;
  });
  /** Only a terminal failed leaf may be removed; descendants remain untouched. */
  const discardFailedLeaf = (userId: string, operationId: string) => serialized(async () => {
    if (await deps.currentUserId() !== userId) throw new Error("Authenticated user changed");
    const data = await read(userId);
    const index = data.operations.findIndex((op) => op.operationId === operationId);
    const operation = data.operations[index];
    if (!operation || !["blocked", "rejected_permanent"].includes(operation.status)) {
      throw new Error("Only a failed work action can be discarded");
    }
    if (data.operations.some((op) => op.predecessorOperationId === operationId)) {
      throw new Error("Dependent local actions must be resolved first");
    }
    data.operations.splice(index, 1);
    await write(userId, data);
  });
  const enqueue = (input: { userId: string; companyId: string; jobId: string; assignmentId: string; action: WorkAction; actionTimestamp?: string }) => serialized(async () => {
    if (!input.userId || await deps.currentUserId() !== input.userId) throw new Error("Authenticated user changed");
    const data = await read(input.userId);
    if (data.operations.some((op) => op.status === "blocked" || op.status === "rejected_permanent")) {
      throw new Error("Earlier work operation requires reconciliation");
    }
    const base = data.summaries[input.assignmentId];
    if (!base) throw new Error("Assignment summary unavailable; refresh online before working offline");
    const state = project(base, data.operations);
    const active = projectActive(data.active, data.operations);
    if ((input.action === "start" || input.action === "resume") && active && active.assignmentId !== input.assignmentId) {
      throw new Error("Another assignment already has an active session");
    }
    if (state.trackingMode !== "sessions" && !(input.action === "start" && state.assignmentState === "not_started")) {
      throw new Error("Legacy assignment requires legacy execution");
    }
    if ((input.action === "start" && state.assignmentState !== "not_started") ||
      (input.action === "resume" && state.assignmentState !== "paused") ||
      (input.action === "pause" && state.assignmentState !== "active") ||
      (input.action === "complete" && !["active", "paused"].includes(state.assignmentState))) {
      throw new Error("Action does not match assignment state");
    }
    if ((input.action === "pause" || input.action === "complete") && state.assignmentState === "active" && !state.activeSessionId) {
      throw new Error("Exact active session is unavailable");
    }
    const previous = data.operations.at(-1);
    const now = deps.now();
    const operation: WorkOperation = {
      operationId: deps.uuid(), action: input.action, userId: input.userId,
      companyId: input.companyId, jobId: input.jobId, assignmentId: input.assignmentId,
      actionTimestamp: input.actionTimestamp ?? now,
      sessionId: input.action === "start" || input.action === "resume" ? deps.uuid() : state.activeSessionId,
      expectedRevision: state.workRevision, localSequence: data.nextSequence++,
      predecessorOperationId: previous?.operationId ?? null,
      status: "pending", createdAt: now, updatedAt: now,
    };
    data.operations.push(operation);
    await write(input.userId, data); // must finish before caller may transmit
    return operation;
  });
  const update = (userId: string, operationId: string, fn: (op: WorkOperation, data: JournalData) => void) => serialized(async () => {
    const data = await read(userId);
    const op = data.operations.find((item) => item.operationId === operationId);
    if (!op) throw new Error("Work operation disappeared from journal");
    fn(op, data);
    op.updatedAt = deps.now();
    await write(userId, data);
  });
  const run = async (userId: string) => {
    let acknowledged = 0;
    while (true) {
      if (await deps.currentUserId() !== userId) return { acknowledged, stopped: "auth_expired" as const };
      const data = await serialized(() => read(userId));
      const next = data.operations.find((op) => op.status !== "acknowledged");
      if (!next) return { acknowledged, stopped: null };
      if (next.status === "blocked" || next.status === "rejected_permanent") return { acknowledged, stopped: next.failureKind ?? "permanent_rejection" };
      if (next.predecessorOperationId && data.operations.find((op) => op.operationId === next.predecessorOperationId)?.status !== "acknowledged") {
        return { acknowledged, stopped: "business_conflict" as const };
      }
      await update(userId, next.operationId, (op) => { op.status = "syncing"; });
      try {
        if (await deps.currentUserId() !== userId) {
          await update(userId, next.operationId, (op) => { op.status = "pending"; });
          return { acknowledged, stopped: "auth_expired" as const };
        }
        const receipt = await deps.execute(next);
        if (receipt.operationId !== next.operationId || receipt.assignmentId !== next.assignmentId || receipt.workRevision !== next.expectedRevision + 1) {
          throw { kind: "permanent_rejection", message: "Invalid work operation receipt" };
        }
        await update(userId, next.operationId, (op, journal) => {
          op.status = "acknowledged";
          op.receipt = receipt;
          journal.summaries[op.assignmentId] = {
            ...receipt, trackingMode: "sessions",
            latestSessionEnd: receipt.latestSessionEnd,
            closedSeconds: receipt.closedSeconds,
            reviewRequired: receipt.reviewRequired,
          };
          // A response after account switching is retained in its original user's journal.
          // Other users cannot see or replay it.
          if (receipt.activeSessionId && receipt.activeSince) journal.active = {
            sessionId: receipt.activeSessionId, assignmentId: op.assignmentId,
            jobId: op.jobId, companyId: op.companyId, startedAt: receipt.activeSince,
          };
          else if (journal.active?.assignmentId === op.assignmentId) journal.active = null;
        });
        acknowledged++;
      } catch (error) {
        const failure = await deps.currentUserId() !== userId
          ? { kind: "auth_expired" as const, message: "Authenticated user changed during transmission" }
          : typeof error === "object" && error !== null && "kind" in error
            ? error as WorkFailure : deps.classify(error);
        if (failure.kind === "transport" || failure.kind === "auth_expired") {
          await update(userId, next.operationId, (op) => { op.status = "pending"; op.failureKind = failure.kind; op.failureMessage = failure.message; });
        } else if (failure.kind === "unsupported") {
          await serialized(async () => {
            const journal = await read(userId);
            for (const op of journal.operations) {
              if (op.localSequence < next.localSequence || op.status === "acknowledged") continue;
              op.status = "blocked";
              op.failureKind = failure.kind;
              op.failureMessage = failure.message;
              op.updatedAt = deps.now();
            }
            await write(userId, journal);
          });
        } else {
          await serialized(async () => {
            const journal = await read(userId);
            for (const op of journal.operations) {
              if (op.localSequence < next.localSequence || op.status === "acknowledged") continue;
              op.status = op.operationId === next.operationId ? "rejected_permanent" : "blocked";
              op.failureKind = failure.kind;
              op.failureMessage = failure.message;
              op.updatedAt = deps.now();
            }
            await write(userId, journal);
          });
        }
        return { acknowledged, stopped: failure.kind };
      }
    }
  };
  const sync = (userId: string): Promise<{ acknowledged: number; stopped: WorkFailureKind | null }> => {
    const existing = workers.get(userId);
    if (existing) return existing.then(async (result) => {
      if (result.stopped) return result;
      // An enqueue may have landed after the worker's final empty read but
      // before its promise settled. The caller must not mistake that for an ack.
      const remaining = await serialized(async () => (await read(userId)).operations
        .some((op) => op.status !== "acknowledged"));
      return remaining ? sync(userId) : result;
    });
    const worker = run(userId).finally(() => { workers.delete(userId); });
    workers.set(userId, worker);
    return worker;
  };
  return { enqueue, sync, list, getEpoch, getSummary, getRecordedSummary, getUiSnapshot, getActive,
    rememberSummary, rememberSummaries, rememberActive, discardFailedLeaf };
}
