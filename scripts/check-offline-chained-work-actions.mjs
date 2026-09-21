import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createWorkJournal, resolveWorkRoute } from "../services/offline/workJournal.core.ts";

const source = readFileSync(new URL("../utils/assignmentWorkUi.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const ui = {};
const own = (job, userId) => job.assignees.find((item) => item.employeeId === userId) ?? null;
vm.runInNewContext(code, { exports: ui, Date, Math, Set, String,
  require: (name) => {
    if (name !== "@/utils/jobAssignees") throw Error(`Unexpected import ${name}`);
    return {
      getOwnAssignee: own,
      canRunJobActions: (job, role, userId) => role === "employee" &&
        job.jobType === "single" && !!own(job, userId),
      canStartOwnAssignment: (job, role, userId) => role === "employee" &&
        !!own(job, userId) && !own(job, userId).employeeStartedAt,
      canCompleteOwnAssignment: () => false,
    };
  },
});

const times = [
  "2026-09-21T08:00:00.000Z", "2026-09-21T08:01:00.000Z",
  "2026-09-21T08:02:00.000Z", "2026-09-21T08:03:00.000Z",
];
const base = (assignmentId) => ({ assignmentId, trackingMode: "legacy", workRevision: 0,
  assignmentState: "not_started", activeSessionId: null, activeSince: null,
  latestSessionEnd: null, closedSeconds: 0, reviewRequired: false,
  employeeCompletedAt: null });
const job = (id = "job-a", assignmentId = "a", employeeId = "u1") => ({
  id, companyId: "c", jobType: "single", status: "open", isActive: true,
  parentJobId: null, employeeId, assignees: [{ assignmentId, employeeId,
    trackingMode: "legacy", employeeStartedAt: null, employeeCompletedAt: null }],
});

function fixture() {
  const rows = new Map();
  const calls = [];
  let userId = "u1";
  let now = times[0];
  let nextId = 0;
  let execute = async (op) => ({
    ...base(op.assignmentId), operationId: op.operationId, sessionId: op.sessionId,
    workRevision: op.expectedRevision + 1,
    assignmentState: op.action === "pause" ? "paused" : op.action === "complete" ? "completed" : "active",
    activeSessionId: op.action === "start" || op.action === "resume" ? op.sessionId : null,
    activeSince: op.action === "start" || op.action === "resume" ? op.actionTimestamp : null,
    latestSessionEnd: op.action === "pause" || op.action === "complete" ? op.actionTimestamp : null,
    employeeStartedAt: times[0], employeeCompletedAt: op.action === "complete" ? op.actionTimestamp : null,
    jobStatus: "in_progress", recordedAt: op.actionTimestamp,
  });
  const journal = createWorkJournal({
    storage: { getItem: async (key) => rows.get(key) ?? null,
      setItem: async (key, value) => { rows.set(key, value); } },
    currentUserId: async () => userId,
    uuid: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    now: () => now,
    classify: (error) => ({ kind: error.kind ?? "transport", message: error.message ?? "failed" }),
    execute: async (op) => { calls.push({ ...op }); return execute(op); },
  });
  const enqueue = (action, assignmentId = "a", jobId = "job-a") => journal.enqueue({
    userId, companyId: "c", jobId, assignmentId, action,
  });
  return { journal, rows, calls, enqueue, setTime: (value) => { now = value; },
    setUser: (value) => { userId = value; }, setExecute: (fn) => { execute = fn; } };
}

async function effective(f, currentJob = job(), userId = "u1") {
  const snapshot = await f.journal.getUiSnapshot(userId);
  const assignmentId = own(currentJob, userId)?.assignmentId;
  const workUi = ui.deriveAssignmentWorkUi({ job: currentJob, role: "employee", userId,
    capability: true, summary: snapshot.summaries[assignmentId],
    operations: snapshot.operations.filter((op) => op.status !== "acknowledged") });
  return { snapshot, workUi };
}

test("offline chain exposes next controls, retains IDs, and projects paused time", async () => {
  const f = fixture();
  const currentJob = job();
  await f.journal.rememberSummary("u1", base("a"));
  const start = await f.enqueue("start");
  let view = await effective(f, currentJob);
  assert.equal(view.snapshot.summaries.a.assignmentState, "active");
  assert.equal(view.snapshot.active.sessionId, start.sessionId);
  assert.equal(view.workUi.pending.action, "start");
  assert.equal(view.workUi.canStart, false);
  assert.equal(view.workUi.canPause, true);
  assert.equal(resolveWorkRoute(view.snapshot.summaries.a, "pause", true), "sessions");

  f.setTime(times[1]);
  const pause = await f.enqueue("pause");
  view = await effective(f, currentJob);
  assert.equal(view.snapshot.summaries.a.assignmentState, "paused");
  assert.equal(view.snapshot.summaries.a.closedSeconds, 60);
  assert.equal(view.snapshot.active, null);
  assert.equal(view.workUi.pending.action, "pause");
  assert.equal(view.workUi.canResume, true);
  assert.equal(view.workUi.canComplete, true);
  assert.equal(view.workUi.canPause, false);
  assert.equal(ui.displayedWorkSeconds({ summary: view.snapshot.summaries.a,
    recorded: view.snapshot.recordedSummaries.a, pending: view.workUi.pending,
    now: Date.parse(times[3]) }), 60);

  f.setTime(times[2]);
  const resume = await f.enqueue("resume");
  view = await effective(f, currentJob);
  assert.equal(view.snapshot.summaries.a.assignmentState, "active");
  assert.equal(view.snapshot.active.sessionId, resume.sessionId);
  assert.equal(view.workUi.canPause, true);
  assert.equal(view.workUi.canComplete, true);
  assert.equal(view.workUi.canResume, false);

  f.setTime(times[3]);
  const complete = await f.enqueue("complete");
  view = await effective(f, currentJob);
  assert.equal(view.snapshot.summaries.a.assignmentState, "completed");
  assert.equal(view.snapshot.summaries.a.closedSeconds, 120);
  assert.equal(view.snapshot.active, null);
  assert.equal(view.workUi.pending.action, "complete");
  assert.equal(view.workUi.canStart || view.workUi.canPause || view.workUi.canResume ||
    view.workUi.canComplete, false);
  assert.equal(currentJob.status, "open");

  const operations = await f.journal.list("u1");
  assert.deepEqual(operations.map((op) => op.action), ["start", "pause", "resume", "complete"]);
  assert.deepEqual(operations.map((op) => op.localSequence), [1, 2, 3, 4]);
  assert.deepEqual(operations.map((op) => op.expectedRevision), [0, 1, 2, 3]);
  assert.deepEqual(operations.slice(1).map((op) => op.predecessorOperationId),
    operations.slice(0, -1).map((op) => op.operationId));
  assert.equal(pause.sessionId, start.sessionId);
  assert.notEqual(resume.sessionId, start.sessionId);
  assert.equal(complete.sessionId, resume.sessionId);
  assert.deepEqual(operations.map((op) => op.operationId),
    [start, pause, resume, complete].map((op) => op.operationId));
  assert.deepEqual(operations.map((op) => op.sessionId),
    [start, pause, resume, complete].map((op) => op.sessionId));
  assert.equal(f.rows.has("offline_work_journal_v1:u1"), true);
  assert.equal(f.calls.length, 0);
});

test("invalid duplicate and out-of-order offline actions remain blocked", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", base("a"));
  await f.enqueue("start");
  await assert.rejects(f.enqueue("start"), /Action does not match/);
  await assert.rejects(f.enqueue("resume"), /Action does not match/);
  await f.enqueue("pause");
  await assert.rejects(f.enqueue("pause"), /Action does not match/);
  const paused = await effective(f);
  assert.equal(paused.workUi.canComplete, true);
  await f.enqueue("resume");
  await assert.rejects(f.enqueue("resume"), /Action does not match/);
  await f.enqueue("complete");
  for (const action of ["start", "pause", "resume", "complete"]) {
    await assert.rejects(f.enqueue(action), /Action does not match/);
  }
  assert.equal((await f.journal.list("u1")).length, 4);
});

test("offline completion while paused keeps the last session end and worked time", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", base("a"));
  await f.enqueue("start");
  f.setTime(times[1]);
  await f.enqueue("pause");
  assert.equal((await effective(f)).workUi.canComplete, true);
  f.setTime(times[2]);
  const complete = await f.enqueue("complete");
  const view = await effective(f);
  assert.equal(complete.sessionId, null);
  assert.equal(view.snapshot.summaries.a.closedSeconds, 60);
  assert.equal(view.snapshot.summaries.a.latestSessionEnd, times[1]);
  assert.equal(view.snapshot.summaries.a.assignmentState, "completed");
});

test("pending Start blocks another job; pending Pause releases local active work", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", base("a"));
  await f.journal.rememberSummary("u1", base("b"));
  await f.enqueue("start");
  assert.equal(ui.otherActiveJob(await f.journal.getActive("u1"), "job-b"), "job-a");
  await assert.rejects(f.enqueue("start", "b", "job-b"), /Another assignment/);
  f.setTime(times[1]);
  await f.enqueue("pause");
  assert.equal(await f.journal.getActive("u1"), null);
  const startB = await f.enqueue("start", "b", "job-b");
  assert.equal(startB.predecessorOperationId, (await f.journal.list("u1"))[1].operationId);
  assert.equal((await effective(f, job("job-b", "b"))).workUi.canPause, true);
});

test("reconnect sends the exact saved chain in order, including IDs and dependencies", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", base("a"));
  const saved = [];
  for (const [index, action] of ["start", "pause", "resume", "complete"].entries()) {
    f.setTime(times[index]);
    saved.push(await f.enqueue(action));
  }
  f.setExecute(async (op) => {
    const persisted = JSON.parse(f.rows.get("offline_work_journal_v1:u1"));
    assert.equal(persisted.operations.find((item) => item.operationId === op.operationId).status, "syncing");
    return {
      ...base(op.assignmentId), operationId: op.operationId, sessionId: op.sessionId,
      workRevision: op.expectedRevision + 1,
      assignmentState: op.action === "pause" ? "paused" : op.action === "complete" ? "completed" : "active",
      activeSessionId: op.action === "start" || op.action === "resume" ? op.sessionId : null,
      activeSince: op.action === "start" || op.action === "resume" ? op.actionTimestamp : null,
      employeeStartedAt: times[0], employeeCompletedAt: op.action === "complete" ? op.actionTimestamp : null,
      jobStatus: "in_progress", recordedAt: op.actionTimestamp,
    };
  });
  assert.equal((await f.journal.sync("u1")).acknowledged, 4);
  assert.deepEqual(f.calls.map((op) => op.action), saved.map((op) => op.action));
  assert.deepEqual(f.calls.map((op) => op.operationId), saved.map((op) => op.operationId));
  assert.deepEqual(f.calls.map((op) => op.sessionId), saved.map((op) => op.sessionId));
  assert.deepEqual(f.calls.map((op) => op.predecessorOperationId),
    saved.map((op) => op.predecessorOperationId));
  assert.deepEqual((await f.journal.list("u1")).map((op) => op.status),
    ["acknowledged", "acknowledged", "acknowledged", "acknowledged"]);
  assert.equal((await effective(f)).workUi.pending, null);
});

test("server rejection blocks descendants and requires reconciliation", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", base("a"));
  await f.enqueue("start");
  await f.enqueue("pause");
  await f.enqueue("resume");
  f.setExecute(async (op) => {
    if (op.action === "pause") throw { kind: "business_conflict", message: "server rejected pause" };
    return {
      ...base("a"), operationId: op.operationId, sessionId: op.sessionId,
      workRevision: op.expectedRevision + 1, assignmentState: "active",
      activeSessionId: op.sessionId, activeSince: op.actionTimestamp,
      employeeStartedAt: op.actionTimestamp, jobStatus: "in_progress", recordedAt: op.actionTimestamp,
    };
  });
  assert.equal((await f.journal.sync("u1")).stopped, "business_conflict");
  assert.deepEqual((await f.journal.list("u1")).map((op) => op.status),
    ["acknowledged", "rejected_permanent", "blocked"]);
  assert.deepEqual(f.calls.map((op) => op.action), ["start", "pause"]);
  assert.equal((await effective(f)).workUi.canPause, false);
  await assert.rejects(f.enqueue("complete"), /requires reconciliation/);
  assert.equal((await f.journal.sync("u1")).acknowledged, 0);
});

test("account switching isolates pending work; online acknowledgement still exposes next action", async () => {
  const f = fixture();
  await f.journal.rememberSummary("u1", base("a"));
  await f.enqueue("start");
  f.setUser("u2");
  assert.equal((await f.journal.getUiSnapshot("u2")).operations.length, 0);
  assert.equal((await f.journal.sync("u1")).stopped, "auth_expired");
  assert.equal(f.calls.length, 0);
  f.setUser("u1");
  assert.equal((await f.journal.sync("u1")).acknowledged, 1);
  const view = await effective(f);
  assert.equal(view.workUi.pending, null);
  assert.equal(view.workUi.canPause, true);
});

test("other employee's operation never controls own multi-assignment UI", () => {
  const multi = { ...job(), assignees: [
    { ...job().assignees[0], trackingMode: "sessions", employeeStartedAt: times[0] },
    { ...job().assignees[0], assignmentId: "b", employeeId: "u2", trackingMode: "sessions" },
  ] };
  const other = { operationId: "other", action: "pause", userId: "u2", companyId: "c",
    jobId: "job-a", assignmentId: "b", actionTimestamp: times[1], sessionId: "session-b",
    expectedRevision: 1, localSequence: 1, predecessorOperationId: null,
    status: "pending", createdAt: times[1], updatedAt: times[1] };
  const workUi = ui.deriveAssignmentWorkUi({ job: multi, role: "employee", userId: "u1",
    capability: true, summary: { ...base("a"), trackingMode: "sessions", workRevision: 1,
      assignmentState: "active", activeSessionId: "session-a", activeSince: times[0] },
    operations: [other] });
  assert.equal(workUi.pending, null);
  assert.equal(workUi.canPause, true);
  assert.equal(multi.status, "open");
});
