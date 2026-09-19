import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createWorkJournal } from "../services/offline/workJournal.core.ts";
import { isRTLLocale } from "../i18n/config.ts";

const source = readFileSync(new URL("../utils/assignmentWorkUi.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const ui = {};
const own = (job, user) => job.assignees.find((assignee) => assignee.employeeId === user) ?? null;
vm.runInNewContext(code, { exports: ui, Date, Math, String, Set,
  require: (name) => {
    if (name !== "@/utils/jobAssignees") throw Error(`Unexpected import ${name}`);
    return {
      getOwnAssignee: own,
      canRunJobActions: (job, role, user) => role === "employee" && job.jobType === "single" && !!own(job, user),
      canStartOwnAssignment: (job, role, user) => role === "employee" && !!own(job, user) &&
        job.status !== "completed" && !own(job, user).employeeStartedAt,
      canCompleteOwnAssignment: (job, role, user) => role === "employee" && !!own(job, user) &&
        job.status === "in_progress" && !!own(job, user).employeeStartedAt && !own(job, user).employeeCompletedAt,
    };
  },
});

const job = (id = "job-a", mode = "legacy", started = null, completed = null) => ({
  id, jobType: "single", status: completed ? "in_progress" : started ? "in_progress" : "open",
  isActive: true, parentJobId: null, employeeId: "u1", customerName: id,
  assignees: [{ assignmentId: `assignment-${id}`, employeeId: "u1", trackingMode: mode,
    employeeStartedAt: started, employeeCompletedAt: completed, workReviewRequired: false }],
});
const summary = (state, overrides = {}) => ({
  assignmentId: "assignment-job-a", trackingMode: "sessions", workRevision: 1,
  assignmentState: state, activeSessionId: state === "active" ? "session-a" : null,
  activeSince: state === "active" ? "2026-09-19T08:00:00Z" : null,
  latestSessionEnd: "2026-09-19T09:00:00Z", closedSeconds: 3600,
  reviewRequired: false, employeeCompletedAt: state === "completed" ? "2026-09-19T10:00:00Z" : null,
  ...overrides,
});
const derive = (j, capability, state, operations = []) => ui.deriveAssignmentWorkUi({
  job: j, role: "employee", userId: "u1", capability, summary: state, operations,
});
const operation = (action, status = "pending", overrides = {}) => ({
  operationId: `op-${action}`, action, userId: "u1", companyId: "c", jobId: "job-a",
  assignmentId: "assignment-job-a", actionTimestamp: "2026-09-19T09:30:00Z",
  sessionId: "session-a", expectedRevision: 1, localSequence: 1,
  predecessorOperationId: null, status, createdAt: "2026-09-19T09:30:00Z",
  updatedAt: "2026-09-19T09:30:00Z", ...overrides,
});

test("flag false and already-started legacy assignments keep legacy controls", () => {
  const fresh = derive(job(), false, null);
  assert.equal(fresh.mode, "legacy");
  assert.equal(fresh.canStart, true);
  assert.equal(fresh.canPause, false);
  const started = derive(job("job-a", "legacy", "2026-09-19T08:00:00Z"), true, null);
  assert.equal(started.mode, "legacy");
  assert.equal(started.canComplete, true);
  assert.equal(started.canPause, false);
  const gatedSession = derive(job("job-a", "sessions", "2026-09-19T08:00:00Z"), false, summary("active"));
  assert.equal(gatedSession.canPause || gatedSession.canResume || gatedSession.canComplete, false);
});

test("session controls derive from the employee assignment, not parent status", () => {
  const fresh = derive(job(), true, summary("not_started"));
  assert.equal(fresh.mode, "sessions");
  assert.equal(fresh.canStart, true);
  const active = derive(job("job-a", "sessions", "2026-09-19T08:00:00Z"), true, summary("active"));
  assert.equal(active.canPause, true);
  assert.equal(active.canComplete, true);
  const paused = derive(job("job-a", "sessions", "2026-09-19T08:00:00Z"), true, summary("paused"));
  assert.equal(paused.canResume, true);
  assert.equal(paused.canComplete, true);
  const completed = derive(job("job-a", "sessions", "2026-09-19T08:00:00Z", "2026-09-19T10:00:00Z"), true,
    summary("completed"));
  assert.equal(completed.canStart || completed.canPause || completed.canResume || completed.canComplete, false);
});

test("active timer runs from active session; paused and pending Pause timers stop", () => {
  const active = summary("active");
  assert.equal(ui.displayedWorkSeconds({ summary: active, now: Date.parse("2026-09-19T08:30:00Z") }), 5400);
  assert.equal(ui.displayedWorkSeconds({ summary: summary("paused"), now: Date.parse("2026-09-19T12:00:00Z") }), 3600);
  const pendingPause = operation("pause");
  const projected = summary("paused");
  assert.equal(ui.displayedWorkSeconds({ summary: projected, recorded: active, pending: pendingPause,
    now: Date.parse("2026-09-19T12:00:00Z") }), 9000);
});

test("pending Start, Pause, Resume and Complete disable duplicate controls", () => {
  for (const action of ["start", "pause", "resume", "complete"]) {
    const state = action === "start" ? "active" : action === "resume" ? "active" : action === "pause" ? "paused" : "completed";
    const result = derive(job("job-a", "sessions", "2026-09-19T08:00:00Z"), true,
      summary(state), [operation(action)]);
    assert.equal(result.pending.action, action);
    assert.equal(result.canStart || result.canPause || result.canResume || result.canComplete, false);
  }
});

test("rapid double tap executes one assignment action", async () => {
  const busy = new Set(); let calls = 0;
  let release;
  const first = ui.runAssignmentActionOnce(busy, "assignment-job-a", async () => {
    calls++;
    await new Promise((resolve) => { release = resolve; });
  });
  const second = ui.runAssignmentActionOnce(busy, "assignment-job-a", async () => { calls++; });
  await second;
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(busy.size, 0);
});

test("global active job lookup selects real session and blocks Start/Resume elsewhere", () => {
  const parentInProgress = { ...job("job-a"), status: "in_progress" };
  const actual = { ...job("job-b", "sessions", "2026-09-19T08:00:00Z"), status: "in_progress" };
  const active = { sessionId: "s", assignmentId: "assignment-job-b", jobId: "job-b", companyId: "c",
    startedAt: "2026-09-19T08:00:00Z" };
  assert.equal(ui.selectActiveEmployeeJob([parentInProgress, actual], active, true, "employee", "u1").id, "job-b");
  assert.equal(ui.selectActiveEmployeeJob([parentInProgress, actual], null, true, "employee", "u1"), undefined);
  assert.equal(ui.otherActiveJob(active, "job-a"), "job-b");
  assert.equal(ui.otherActiveJob(active, "job-b"), null);
  assert.equal(`/jobs/${ui.otherActiveJob(active, "job-a")}`, "/jobs/job-b");
});

test("reconciliation offers Retry only for transport, Refresh for conflicts, and safe discard only for leaves", () => {
  const pending = operation("pause", "pending", { failureKind: "transport" });
  assert.equal(ui.reconciliationOptions(pending, [pending], true).canRetry, true);
  assert.equal(ui.reconciliationOptions(pending, [pending], false).canRetry, false);
  const rejected = operation("pause", "rejected_permanent", { failureKind: "revision_conflict" });
  const dependent = operation("start", "blocked", { operationId: "op-start-b", jobId: "job-b",
    predecessorOperationId: rejected.operationId });
  assert.equal(ui.reconciliationOptions(rejected, [rejected, dependent], true).canRefresh, true);
  assert.equal(ui.reconciliationOptions(rejected, [rejected, dependent], true).canDiscard, false);
  assert.equal(ui.reconciliationOptions(dependent, [rejected, dependent], true).canDiscard, true);
});

test("journal refuses to discard a failed action while dependent actions remain", async () => {
  const values = new Map(); let user = "u1"; let serial = 0;
  const journal = createWorkJournal({
    storage: { getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); } },
    currentUserId: async () => user,
    uuid: () => `id-${++serial}`, now: () => "2026-09-19T09:00:00Z",
    classify: () => ({ kind: "revision_conflict", message: "changed" }),
    execute: async () => { throw Error("changed"); },
  });
  await journal.rememberSummary("u1", summary("active"));
  const first = await journal.enqueue({ userId: "u1", companyId: "c", jobId: "job-a",
    assignmentId: "assignment-job-a", action: "pause" });
  await journal.enqueue({ userId: "u1", companyId: "c", jobId: "job-b",
    assignmentId: "assignment-job-a", action: "resume" });
  await journal.sync("u1");
  await assert.rejects(journal.discardFailedLeaf("u1", first.operationId), /Dependent local actions/);
  const ops = await journal.list("u1");
  assert.equal(ops.length, 2);
  user = "u2";
  await assert.rejects(journal.discardFailedLeaf("u1", ops[1].operationId), /Authenticated user changed/);
  assert.equal((await journal.list("u2")).length, 0);
  user = "u1";
  await journal.discardFailedLeaf("u1", ops[1].operationId);
  await journal.discardFailedLeaf("u1", first.operationId);
  assert.equal((await journal.list("u1")).length, 0);
});

test("admin distinction, review flag, translations, Arabic RTL, and default capability", () => {
  const summaries = { a: summary("active", { assignmentId: "a", activeSessionId: "s" }),
    b: summary("paused", { assignmentId: "b", activeSessionId: null }),
    c: summary("completed", { assignmentId: "c", activeSessionId: null }) };
  const multi = { ...job(), assignees: [
    { ...job().assignees[0], assignmentId: "a", trackingMode: "sessions" },
    { ...job().assignees[0], assignmentId: "b", trackingMode: "sessions" },
    { ...job().assignees[0], assignmentId: "c", trackingMode: "sessions" },
  ] };
  assert.equal(ui.hasActiveAssignmentSession(summaries, multi), true);
  assert.equal(ui.hasActiveAssignmentSession({ ...summaries, a: summary("paused", { activeSessionId: null }) }, multi), false);
  assert.equal(derive(job("job-a", "sessions", "2026-09-19T08:00:00Z"), true,
    summary("paused", { reviewRequired: true })).reviewRequired, true);
  for (const locale of ["de", "en", "ar", "tr"]) {
    const jobs = JSON.parse(readFileSync(new URL(`../i18n/locales/${locale}/jobs.json`, import.meta.url)));
    const timesheets = JSON.parse(readFileSync(new URL(`../i18n/locales/${locale}/timesheets.json`, import.meta.url)));
    for (const key of ["pause", "resume", "reviewRequired", "completePausedMessage", "openActiveJob", "discardMessage", "forceStateUnavailable"])
      assert.ok(jobs.work[key]);
    for (const key of ["start", "pause", "resume", "complete"]) assert.ok(jobs.work.pending[key]);
    for (const key of ["missing", "invalid", "review"]) assert.ok(timesheets.sessionGap[key]);
  }
  assert.equal(isRTLLocale("ar"), true);
  assert.equal(isRTLLocale("de"), false);
  const config = readFileSync(new URL("../services/appConfig.service.ts", import.meta.url), "utf8");
  assert.match(config, /pauseResumeEnabled: false/);
});
