import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createWorkJournal, classifyWorkFailure, refreshActiveSnapshot } from "../services/offline/workJournal.core.ts";
import { applyAcknowledgedWorkOperationToJobs, applyPendingWorkOperationsToJobs,
  preserveNewerWorkJobs } from "../services/offline/jobs.merge.ts";
import { createCoalescedRefresh } from "../utils/coalescedRefresh.ts";

const summary = (id, state = "not_started", revision = 0) => ({
  assignmentId: id, trackingMode: state === "not_started" ? "legacy" : "sessions",
  workRevision: revision, assignmentState: state, activeSessionId: null,
  activeSince: null, latestSessionEnd: null, closedSeconds: 0,
  reviewRequired: false, employeeCompletedAt: null,
});
const job = (id, assignmentId = id, revision = 0) => ({
  id, status: "in_progress", startedAt: "start", completedAt: null, completedBy: null,
  assignees: [{ assignmentId, employeeId: "u1", trackingMode: revision ? "sessions" : "legacy",
    workRevision: revision, employeeStartedAt: "start", employeeCompletedAt: null }],
});
const receipt = (op, jobStatus = "completed") => ({
  ...summary(op.assignmentId, "completed", op.expectedRevision + 1),
  operationId: op.operationId, sessionId: op.sessionId,
  employeeStartedAt: "start", employeeCompletedAt: "end",
  jobStatus, recordedAt: "end",
});

function fixture() {
  const rows = new Map();
  const io = { reads: 0, writes: 0 };
  let user = "u1", serial = 0;
  const storage = {
    getItem: async (key) => { io.reads++; return rows.get(key) ?? null; },
    setItem: async (key, value) => { io.writes++; rows.set(key, value); },
  };
  const journal = createWorkJournal({ storage, classify: classifyWorkFailure,
    currentUserId: async () => user, uuid: () => `id-${++serial}`,
    now: () => "2026-09-19T10:00:00Z", execute: async (op) => receipt(op),
  });
  return { journal, storage, rows, io, setUser: (next) => { user = next; } };
}

function loadService(stubs) {
  const source = readFileSync(new URL("../services/jobs/workSessions.service.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: (name) => {
    const dependency = stubs[name];
    if (!dependency) throw Error(`Unexpected import ${name}`);
    return dependency;
  }, Map, Promise, String, Number, Boolean, Date, console }, { filename: "workSessions.service.ts" });
  return exports;
}

test("500 unchanged legacy summaries use one journal read and zero writes", async () => {
  const f = fixture();
  const all = Array.from({ length: 500 }, (_, index) => summary(`a-${index}`));
  await f.journal.rememberSummaries("u1", all);
  assert.deepEqual(f.io, { reads: 1, writes: 1 });
  f.io.reads = 0; f.io.writes = 0;
  await f.journal.rememberSummaries("u1", all);
  assert.deepEqual(f.io, { reads: 1, writes: 0 });
  f.io.reads = 0; f.io.writes = 0;
  const snapshot = await f.journal.getUiSnapshot("u1");
  assert.equal(Object.keys(snapshot.summaries).length, 500);
  assert.deepEqual(f.io, { reads: 1, writes: 0 });
  f.io.reads = 0; f.io.writes = 0;
  await f.journal.rememberSummary("u1", all[0]);
  assert.deepEqual(f.io, { reads: 1, writes: 0 });
});

test("service batches 500 legacy jobs and online flushes persisted IDs immediately", async () => {
  const rows = new Map();
  const io = { reads: 0, writes: 0, rpc: 0, activeLookups: 0 };
  let online = true, serial = 0;
  const storage = { getItem: async (key) => { io.reads++; return rows.get(key) ?? null; },
    setItem: async (key, value) => { io.writes++; rows.set(key, value); } };
  const service = loadService({
    "@react-native-async-storage/async-storage": { default: storage },
    "@react-native-community/netinfo": { default: { fetch: async () => ({ isConnected: online }) } },
    "expo-crypto": { randomUUID: () => `id-${++serial}` },
    "@/lib/supabase": { supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
      from: (table) => {
        assert.equal(table, "work_sessions");
        io.activeLookups++;
        const query = { select: () => query, eq: () => query, is: () => query,
          maybeSingle: async () => ({ data: null, error: null }) };
        return query;
      },
      rpc: async (name, args) => {
        io.rpc++;
        assert.ok(["start_own_job_v2", "pause_own_job"].includes(name));
        const saved = JSON.parse(rows.get("offline_work_journal_v1:u1")).operations.at(-1);
        assert.equal(saved.status, "syncing");
        assert.equal(saved.operationId, args.operation_id_input);
        assert.equal(saved.sessionId, args.session_id_input);
        return { data: { operation_id: args.operation_id_input, assignment_id: args.assignment_id_input,
          tracking_mode: "sessions", work_revision: args.expected_revision_input + 1,
          assignment_state: name === "pause_own_job" ? "paused" : "active",
          active_session_id: name === "pause_own_job" ? null : args.session_id_input,
          active_since: name === "pause_own_job" ? null : "2026-09-19T10:00:00Z",
          latest_session_end: name === "pause_own_job" ? "2026-09-19T10:00:00Z" : null,
          closed_seconds: 0, review_required: false, employee_completed_at: null,
          session_id: args.session_id_input, employee_started_at: "2026-09-19T10:00:00Z",
          job_status: "in_progress", recorded_at: "2026-09-19T10:00:00Z" }, error: null };
      } } },
    "@/services/appConfig.service": { fetchAppConfig: async () => ({ pauseResumeEnabled: true }) },
    "@/services/offline/appConfig.storage": { getCachedAppConfig: async () => ({ pauseResumeEnabled: true }) },
    "@/services/jobs/jobs.service": { startJob: async () => { throw Error("legacy route"); },
      completeJob: async () => { throw Error("legacy route"); } },
    "@/services/offline/workJournal.core": { createWorkJournal, classifyWorkFailure,
      resolveWorkRoute: (s, action, enabled) => s.trackingMode === "sessions" || action === "start" && enabled
        ? "sessions" : "legacy", refreshActiveSnapshot },
    "@/utils/workTiming": { beginWorkTiming: () => {}, markWorkTiming: () => {} },
  });
  const allJobs = Array.from({ length: 500 }, (_, index) => ({
    assignees: [{ assignmentId: `a-${index}`, employeeId: "u1", trackingMode: "legacy",
      employeeStartedAt: null, employeeCompletedAt: null, workRevision: 0 }],
  }));
  await service.cacheWorkSummariesFromJobs("u1", allJobs);
  assert.deepEqual({ reads: io.reads, writes: io.writes }, { reads: 1, writes: 1 });
  io.reads = 0; io.writes = 0;
  await service.cacheWorkSummariesFromJobs("u1", allJobs);
  assert.deepEqual({ reads: io.reads, writes: io.writes }, { reads: 1, writes: 0 });
  await Promise.all([service.refreshActiveWorkSession("u1"), service.refreshActiveWorkSession("u1")]);
  assert.equal(io.activeLookups, 1);
  const result = await service.executeAssignmentAction({ userId: "u1", companyId: "c",
    jobId: "j", assignmentId: "a-0", action: "start", capability: true });
  assert.equal(result.route, "sessions");
  assert.equal(result.operation.status, "acknowledged");
  assert.equal(io.rpc, 1);
  const acknowledgedUi = await service.workJournal.getUiSnapshot("u1");
  assert.equal(acknowledgedUi.summaries["a-0"].assignmentState, "active");
  assert.equal(acknowledgedUi.operations.filter((operation) => operation.status !== "acknowledged").length, 0);
  online = false;
  const offline = await service.executeAssignmentAction({ userId: "u1", companyId: "c",
    jobId: "j", assignmentId: "a-0", action: "pause", capability: true });
  assert.equal(offline.operation.status, "pending");
  assert.equal(io.rpc, 1);
  // Offline replay remains on the same journal worker and uses the stored IDs.
  // The mock RPC above validates the persisted operation before each send.
  online = true;
  assert.equal((await service.workJournal.sync("u1")).acknowledged, 1);
  assert.equal(io.rpc, 2);
});

test("acknowledged parent status uses receipt, and stale fetch cannot overwrite it", () => {
  const base = job("j", "a", 2);
  const op = { operationId: "op", action: "complete", userId: "u1", jobId: "j", assignmentId: "a",
    actionTimestamp: "end", expectedRevision: 2, localSequence: 1, status: "acknowledged",
    receipt: { ...summary("a", "completed", 3), employeeStartedAt: "start", employeeCompletedAt: "end",
      jobStatus: "completed" } };
  const completed = applyAcknowledgedWorkOperationToJobs([base], op)[0];
  assert.equal(completed.status, "completed");
  assert.equal(completed.assignees[0].workRevision, 3);
  assert.equal(completed.assignees[0].pendingWorkAction, undefined);
  assert.equal(preserveNewerWorkJobs([base], [completed])[0].status, "completed");
  assert.equal(applyPendingWorkOperationsToJobs([base], [op])[0].status, "completed");
  const multi = { ...base, assignees: [...base.assignees, { ...base.assignees[0], assignmentId: "b" }] };
  const openReceipt = { ...op, receipt: { ...op.receipt, jobStatus: "in_progress" } };
  assert.equal(applyAcknowledgedWorkOperationToJobs([multi], openReceipt)[0].status, "in_progress");
  assert.equal(applyPendingWorkOperationsToJobs([multi], [openReceipt])[0].status, "in_progress");
  assert.equal(applyAcknowledgedWorkOperationToJobs([completed], { ...op, receipt: {
    ...op.receipt, workRevision: 1, jobStatus: "in_progress" } })[0].status, "completed");
});

test("overlapping refresh requests coalesce into one trailing pass", async () => {
  let release; let runs = 0;
  const refresh = createCoalescedRefresh(async () => {
    runs++;
    if (runs === 1) await new Promise((resolve) => { release = resolve; });
  });
  const pending = refresh();
  const same = Array.from({ length: 100 }, () => refresh());
  release();
  await Promise.all([pending, ...same]);
  assert.equal(runs, 2);
  await refresh();
  assert.equal(runs, 3);
});

test("a failed first refresh still runs its queued trailing refresh once", async () => {
  let release; let runs = 0;
  const refresh = createCoalescedRefresh(async () => {
    runs++;
    if (runs === 1) {
      await new Promise((resolve) => { release = resolve; });
      throw Error("first fetch failed");
    }
  });
  const first = refresh();
  const overlapping = refresh();
  release();
  await assert.rejects(first, /first fetch failed/);
  await assert.rejects(overlapping, /first fetch failed/);
  assert.equal(runs, 2);
});

test("journal snapshot remains account scoped", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  await f.journal.enqueue({ userId: "u1", companyId: "c", jobId: "j", assignmentId: "a", action: "start" });
  f.io.reads = 0; f.io.writes = 0;
  const projected = await f.journal.getUiSnapshot("u1");
  assert.equal(projected.summaries.a.assignmentState, "active");
  assert.equal(projected.recordedSummaries.a.assignmentState, "not_started");
  assert.deepEqual(f.io, { reads: 1, writes: 0 });
  f.setUser("u2");
  assert.equal(Object.keys((await f.journal.getUiSnapshot("u2")).summaries).length, 0);
  assert.equal(Object.keys((await f.journal.getUiSnapshot("u1")).summaries).length, 1);
});
