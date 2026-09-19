import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { classifyWorkFailure, createWorkJournal, refreshActiveSnapshot, resolveWorkRoute } from "../services/offline/workJournal.core.ts";
import { applyPendingActionsToJobs, applyPendingWorkOperationsToJobs } from "../services/offline/jobs.merge.ts";

const summary = (assignmentId, trackingMode = "sessions") => ({
  assignmentId, trackingMode, workRevision: 0, assignmentState: "not_started",
  activeSessionId: null, activeSince: null, latestSessionEnd: null,
  closedSeconds: 0, reviewRequired: false, employeeCompletedAt: null,
});
const receipt = (op) => ({
  ...summary(op.assignmentId), operationId: op.operationId, sessionId: op.sessionId,
  workRevision: op.expectedRevision + 1,
  assignmentState: op.action === "pause" ? "paused" : op.action === "complete" ? "completed" : "active",
  activeSessionId: op.action === "start" || op.action === "resume" ? op.sessionId : null,
  activeSince: op.action === "start" || op.action === "resume" ? op.actionTimestamp : null,
  employeeCompletedAt: op.action === "complete" ? op.actionTimestamp : null,
  employeeStartedAt: op.actionTimestamp, jobStatus: "in_progress", recordedAt: op.actionTimestamp,
});
function fixture() {
  const rows = new Map();
  const calls = [];
  let user = "u1";
  let serial = 0;
  let execute = async (op) => receipt(op);
  const storage = {
    getItem: async (key) => rows.get(key) ?? null,
    setItem: async (key, value) => { rows.set(key, value); },
  };
  const deps = {
    storage, currentUserId: async () => user,
    uuid: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
    now: () => "2026-09-19T12:00:00.000Z",
    classify: (error) => ({ kind: error.kind ?? "transport", message: error.message ?? "failed" }),
    execute: async (op) => { calls.push(op); return execute(op); },
  };
  const journal = createWorkJournal(deps);
  const enqueue = (action, assignmentId = "a", jobId = "j") => journal.enqueue({
    userId: user, companyId: "c", jobId, assignmentId, action,
  });
  return { journal, rows, calls, enqueue, setUser: (value) => { user = value; }, setExecute: (fn) => { execute = fn; }, deps };
}

test("persist before send, acknowledge online, and advance authoritative revision", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  f.setExecute(async (op) => {
    assert.equal(JSON.parse(f.rows.get("offline_work_journal_v1:u1")).operations[0].operationId, op.operationId);
    assert.equal(JSON.parse(f.rows.get("offline_work_journal_v1:u1")).operations[0].status, "syncing");
    return receipt(op);
  });
  const op = await f.enqueue("start");
  assert.equal(op.status, "pending");
  assert.equal((await f.journal.sync("u1")).acknowledged, 1);
  assert.equal((await f.journal.list("u1"))[0].status, "acknowledged");
  assert.equal((await f.journal.getSummary("u1", "a")).workRevision, 1);
});

test("lost response retries identical operation and session UUID; crash-time syncing recovers", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  const op = await f.enqueue("start");
  let committed = false;
  f.setExecute(async (attempt) => {
    if (!committed) { committed = true; throw { kind: "transport", message: "lost response" }; }
    return receipt(attempt);
  });
  assert.equal((await f.journal.sync("u1")).stopped, "transport");
  assert.equal((await f.journal.list("u1"))[0].status, "pending");
  assert.equal((await f.journal.sync("u1")).acknowledged, 1);
  assert.deepEqual(f.calls.map((x) => x.operationId), [op.operationId, op.operationId]);
  assert.deepEqual(f.calls.map((x) => x.sessionId), [op.sessionId, op.sessionId]);
  const raw = JSON.parse(f.rows.get("offline_work_journal_v1:u1"));
  raw.operations[0].status = "syncing";
  f.rows.set("offline_work_journal_v1:u1", JSON.stringify(raw));
  const restarted = createWorkJournal(f.deps);
  assert.equal((await restarted.list("u1"))[0].status, "syncing");
  assert.equal((await restarted.sync("u1")).acknowledged, 1);
});

test("strict order and predecessor chain across two jobs", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  await f.journal.rememberSummary("u1", summary("b"));
  const ops = [await f.enqueue("start"), await f.enqueue("pause"),
    await f.enqueue("start", "b", "jb"), await f.enqueue("complete", "b", "jb"),
    await f.enqueue("resume"), await f.enqueue("complete")];
  assert.deepEqual(ops.map((x) => x.expectedRevision), [0, 1, 0, 1, 2, 3]);
  assert.deepEqual(ops.map((x) => x.localSequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ops.slice(1).map((x) => x.predecessorOperationId), ops.slice(0, -1).map((x) => x.operationId));
  assert.equal(ops[1].sessionId, ops[0].sessionId);
  assert.equal(ops[3].sessionId, ops[2].sessionId);
  assert.notEqual(ops[4].sessionId, ops[0].sessionId);
  assert.equal(ops[5].sessionId, ops[4].sessionId);
  assert.equal((await f.journal.sync("u1")).acknowledged, 6);
  assert.deepEqual(f.calls.map((x) => x.operationId), ops.map((x) => x.operationId));
});

test("failed Pause stops later Start and permanently blocks descendants", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  await f.journal.rememberSummary("u1", summary("b"));
  await f.enqueue("start");
  await f.enqueue("pause");
  await f.enqueue("start", "b", "jb");
  f.setExecute(async (op) => {
    if (op.action === "pause") throw { kind: "business_conflict", message: "server rejected pause" };
    return receipt(op);
  });
  assert.equal((await f.journal.sync("u1")).stopped, "business_conflict");
  assert.deepEqual((await f.journal.list("u1")).map((x) => x.status), ["acknowledged", "rejected_permanent", "blocked"]);
  assert.deepEqual(f.calls.map((x) => x.action), ["start", "pause"]);
  assert.equal((await f.journal.sync("u1")).acknowledged, 0);
});

test("revision conflict stays rejected and is never rebased", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  const op = await f.enqueue("start");
  f.setExecute(async () => { throw { kind: "revision_conflict", message: "Stale work revision" }; });
  assert.equal((await f.journal.sync("u1")).stopped, "revision_conflict");
  await f.journal.rememberSummary("u1", { ...summary("a"), workRevision: 4 });
  const saved = (await f.journal.list("u1"))[0];
  assert.equal(saved.expectedRevision, op.expectedRevision);
  assert.equal(saved.status, "rejected_permanent");
});

test("stale server summary cannot erase newer pending projection", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  await f.enqueue("start");
  await f.journal.rememberSummary("u1", summary("a"));
  assert.equal((await f.journal.getSummary("u1", "a")).assignmentState, "active");
  assert.equal((await f.journal.getSummary("u1", "a")).workRevision, 1);
  const active = await f.journal.getActive("u1");
  assert.equal(active.assignmentId, "a");
  await f.journal.rememberActive("u1", null);
  assert.equal((await f.journal.getActive("u1")).assignmentId, "a");
});

test("account switch preserves A journal and cannot replay it as B", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  await f.enqueue("start");
  f.setUser("u2");
  assert.equal((await f.journal.sync("u1")).stopped, "auth_expired");
  assert.equal(f.calls.length, 0);
  assert.equal((await f.journal.list("u2")).length, 0);
  assert.equal((await f.journal.list("u1")).length, 1);
  f.setUser("u1");
  assert.equal((await f.journal.sync("u1")).acknowledged, 1);
});

test("reconnect resumes order; duplicate worker sends each operation once", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  await f.enqueue("start"); await f.enqueue("pause");
  let release;
  f.setExecute(async (op) => {
    if (op.action === "start") await new Promise((resolve) => { release = resolve; });
    return receipt(op);
  });
  const first = f.journal.sync("u1");
  const second = f.journal.sync("u1");
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await first).acknowledged, 2);
  assert.equal((await second).stopped, null);
  assert.deepEqual(f.calls.map((x) => x.action), ["start", "pause"]);
});

test("serialized concurrent enqueue never loses an operation", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  const [start, pause] = await Promise.all([f.enqueue("start"), f.enqueue("pause")]);
  assert.equal(pause.predecessorOperationId, start.operationId);
  assert.equal((await f.journal.list("u1")).length, 2);
});

test("global active lookup persists and guards a second job", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  await f.journal.rememberSummary("u1", summary("b"));
  const active = { sessionId: "s", assignmentId: "a", jobId: "j", companyId: "c", startedAt: "2026-09-19T10:00:00Z" };
  await f.journal.rememberActive("u1", active);
  assert.deepEqual(await f.journal.getActive("u1"), active);
  await assert.rejects(f.enqueue("start", "b", "jb"), /Another assignment/);
});

test("global active refresh stores server lookup and assignment summary", async () => {
  const f = fixture();
  const active = { sessionId: "s", assignmentId: "a", jobId: "j", companyId: "c", startedAt: "2026-09-19T10:00:00Z" };
  const read = await refreshActiveSnapshot(f.journal, "u1", async (userId) => {
    assert.equal(userId, "u1");
    return active;
  }, async (assignmentId) => {
    assert.equal(assignmentId, "a");
    return { ...summary("a"), assignmentState: "active", activeSessionId: "s", activeSince: active.startedAt };
  });
  assert.deepEqual(read, active);
  assert.deepEqual(await f.journal.getActive("u1"), active);
  assert.equal((await f.journal.getSummary("u1", "a")).activeSessionId, "s");
});

test("late active lookup cannot replace a newer acknowledged session", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", summary("a"));
  let resolveLookup;
  const refreshing = refreshActiveSnapshot(f.journal, "u1",
    () => new Promise((resolve) => { resolveLookup = resolve; }),
    async () => summary("a"));
  while (!resolveLookup) await new Promise((resolve) => setImmediate(resolve));
  await f.enqueue("start");
  await f.journal.sync("u1");
  resolveLookup(null);
  const current = await refreshing;
  assert.equal(current.assignmentId, "a");
  assert.equal((await f.journal.getActive("u1")).assignmentId, "a");
});

test("routing keeps legacy on old RPC path and sessions on V2", () => {
  assert.equal(resolveWorkRoute(summary("a", "legacy"), "start", false), "legacy");
  assert.equal(resolveWorkRoute(summary("a", "legacy"), "start", true), "sessions");
  assert.equal(resolveWorkRoute({ ...summary("a", "legacy"), assignmentState: "active" }, "complete", true), "legacy");
  assert.equal(resolveWorkRoute(summary("a"), "complete", false), "sessions");
  assert.throws(() => resolveWorkRoute(summary("a", "legacy"), "pause", true));
});

test("parent job never becomes optimistically completed", () => {
  const job = { id: "j", status: "in_progress", assignees: [{ assignmentId: "a", workRevision: 0 }] };
  const legacy = applyPendingActionsToJobs([job], [{ id: "x", type: "complete_job", jobId: "j", userId: "u1", timestamp: "now", status: "pending" }]);
  assert.equal(legacy[0].status, "in_progress");
  const session = applyPendingWorkOperationsToJobs([job], [{ assignmentId: "a", jobId: "j", action: "complete", status: "pending", expectedRevision: 0, localSequence: 1 }]);
  assert.equal(session[0].status, "in_progress");
  assert.equal(session[0].assignees[0].pendingWorkAction, "complete");
});

test("acknowledged receipt defeats an older assignment snapshot while later pending action remains visible", () => {
  const job = { id: "j", status: "in_progress", assignees: [{ assignmentId: "a", workRevision: 0, employeeStartedAt: null, employeeCompletedAt: null }] };
  const accepted = { ...receipt({ operationId: "one", assignmentId: "a", action: "start", sessionId: "s", expectedRevision: 0, actionTimestamp: "t" }), workRevision: 1 };
  const merged = applyPendingWorkOperationsToJobs([job], [
    { jobId: "j", assignmentId: "a", status: "acknowledged", localSequence: 1, receipt: accepted },
    { jobId: "j", assignmentId: "a", status: "pending", localSequence: 2, expectedRevision: 1, action: "pause" },
  ]);
  assert.equal(merged[0].assignees[0].workRevision, 1);
  assert.equal(merged[0].assignees[0].pendingWorkAction, "pause");
  assert.equal(merged[0].status, "in_progress");
});

test("failure classes distinguish retry, auth, upgrade, revision and business rejection", () => {
  assert.equal(classifyWorkFailure({ message: "network timeout" }).kind, "transport");
  assert.equal(classifyWorkFailure({ code: "PGRST301", message: "expired" }).kind, "auth_expired");
  assert.equal(classifyWorkFailure({ code: "42501", message: "Pause/Resume is not enabled" }).kind, "unsupported");
  assert.equal(classifyWorkFailure({ code: "22023", message: "Stale work revision" }).kind, "revision_conflict");
  assert.equal(classifyWorkFailure({ code: "22023", message: "Another session is active" }).kind, "business_conflict");
  assert.equal(classifyWorkFailure({ code: "42501", message: "Assignment not accessible" }).kind, "permanent_rejection");
});

test("legacy v2 queue remains migratable and account-scoped", async () => {
  const source = readFileSync(new URL("../services/offline/jobs.queue.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const rows = new Map();
  const storage = {
    getItem: async (key) => rows.get(key) ?? null,
    setItem: async (key, value) => { rows.set(key, value); },
    removeItem: async (key) => { rows.delete(key); },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, require: () => ({ __esModule: true, default: storage }),
    __DEV__: false, console, Date, Math, JSON,
  });
  rows.set("offline_jobs_queue", JSON.stringify({ version: 2, actions: [
    { id: "old-a", userId: "u1", type: "start_job", jobId: "j", timestamp: "t" },
    { id: "old-b", userId: "u2", type: "complete_job", jobId: "j", timestamp: "t" },
  ] }));
  assert.equal((await exports.getPendingJobActions("u1"))[0].status, "pending");
  await exports.addPendingJobAction({ userId: "u1", type: "complete_job", jobId: "j" });
  const saved = JSON.parse(rows.get("offline_jobs_queue"));
  assert.equal(saved.version, 3);
  assert.equal(saved.actions.length, 3);
  assert.equal((await exports.getPendingJobActions("u2")).length, 1);
  rows.set("offline_jobs_queue", JSON.stringify([{ id: "unowned", type: "start_job" }]));
  assert.equal((await exports.getPendingJobActions("u1")).length, 0);
});
