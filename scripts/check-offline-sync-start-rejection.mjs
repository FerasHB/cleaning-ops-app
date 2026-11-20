// Regression: offline queued Complete behind a permanently rejected Start
// (PR #145 follow-up, legacy queue services/offline/jobs.queue.ts).
//
// Bug before the fix: the server rejected the queued start_job (22023, e.g.
// job already completed). jobs.sync.ts marked only the Start as
// failed_permanent. The queued complete_job of the same employee and job
// stayed "pending" forever (sync stopped at the failed Start and returned
// failed=0 on every later run), the UI showed "Abschluss ausstehend", and
// once the user dismissed the failed Start the doomed Complete was sent and
// failed a second time.
//
// Only REAL application code is exercised: jobs.sync.ts, jobs.queue.ts,
// jobs.merge.ts, utils/networkError.ts and utils/userMessages.ts are
// transpiled and loaded. Stubbed are only the I/O edges: AsyncStorage
// (in-memory), NetInfo (online), the two job RPC services (scripted
// results), the admin-push kick, and "@/i18n" (JSON locales/react-i18next
// cannot be loaded outside Metro).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const i18nMock = {
  i18next: { t: (key, opts) => (opts && opts.defaultValue) || key, language: "de" },
  INTL_LOCALE_TAGS: { de: "de-DE", en: "en-GB", ar: "ar", tr: "tr-TR" },
};

function transpile(relPath) {
  const source = readFileSync(join(root, relPath), "utf8");
  return ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
}

/** Fresh module graph per test: own storage, own service script. */
function createHarness() {
  const rows = new Map();
  const storage = {
    getItem: async (key) => rows.get(key) ?? null,
    setItem: async (key, value) => { rows.set(key, value); },
    removeItem: async (key) => { rows.delete(key); },
  };
  const executed = [];
  // jobId+type -> error to throw (undefined = success)
  const script = new Map();
  const service = {
    startJob: async (jobId, timestamp) => {
      executed.push({ type: "start_job", jobId, timestamp });
      const err = script.get(`${jobId}:start_job`);
      if (err) throw err;
      return timestamp;
    },
    completeJob: async (jobId, timestamp) => {
      executed.push({ type: "complete_job", jobId, timestamp });
      const err = script.get(`${jobId}:complete_job`);
      if (err) throw err;
      return { completedAt: timestamp, jobStatus: "in_progress", job: null };
    },
  };

  const cache = new Map();
  const external = {
    "@react-native-async-storage/async-storage": { __esModule: true, default: storage },
    "@react-native-community/netinfo": { __esModule: true, default: { fetch: async () => ({ isConnected: true }) } },
    "@/services/jobs/jobs.service": service,
    "@/services/notifications/adminNotifications": { dispatchAdminNotifications: async () => {} },
    "@/i18n": i18nMock,
  };

  function load(relPath) {
    if (cache.has(relPath)) return cache.get(relPath);
    const exports = {};
    cache.set(relPath, exports);
    vm.runInNewContext(transpile(relPath), {
      exports, __DEV__: false, Date, Math, Set, Map, String, Number, Array, Object, JSON, Intl, Error, Promise,
      console: { ...console, error: () => {}, warn: () => {}, log: () => {} },
      require: (name) => {
        if (name in external) return external[name];
        if (name.startsWith("@/")) return load(`${name.slice(2)}.ts`);
        if (name.startsWith("./")) return load(join(dirname(relPath), `${name.slice(2)}.ts`));
        throw new Error(`Unexpected import ${name} in ${relPath}`);
      },
    });
    return exports;
  }

  return {
    queue: load("services/offline/jobs.queue.ts"),
    sync: load("services/offline/jobs.sync.ts"),
    merge: load("services/offline/jobs.merge.ts"),
    executed,
    reject: (jobId, type, err) => script.set(`${jobId}:${type}`, err),
  };
}

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const JOB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function serverRejection() {
  // Shape of a PostgREST/RPC business-rule rejection (start_own_job, 22023).
  return Object.assign(
    new Error("Dieser Auftrag ist bereits abgeschlossen und kann nicht mehr gestartet werden."),
    { code: "22023" },
  );
}

async function enqueue(queue, userId, jobId, type, timestamp) {
  await queue.addPendingJobAction({ userId, jobId, type, timestamp });
}

function legacyJob(jobId) {
  return {
    id: jobId, status: "in_progress", jobType: "single", isActive: true,
    employeeId: ME, parentJobId: null,
    assignees: [{ employeeId: ME, employeeName: "Ich", employeeStartedAt: null, employeeCompletedAt: null }],
  };
}

test("rejected offline Start: dependent Complete is marked failed too, never sent, both kept", async () => {
  const h = createHarness();
  await enqueue(h.queue, ME, JOB_A, "start_job", "2026-11-20T08:00:00.000Z");
  await enqueue(h.queue, ME, JOB_A, "complete_job", "2026-11-20T10:00:00.000Z");
  h.reject(JOB_A, "start_job", serverRejection());

  const result = await h.sync.syncPendingJobActions(ME);

  // Only the Start reached the server.
  assert.deepEqual(h.executed.map((e) => e.type), ["start_job"]);
  // The run reports the failures (drives syncFailed / the banner title).
  assert.equal(result.success, 0);
  assert.equal(result.failed, 2);

  const all = await h.queue.getPendingJobActions(ME);
  // Evidence preserved: nothing deleted, original timestamps and order intact.
  assert.deepEqual(all.map((a) => [a.type, a.status, a.timestamp]), [
    ["start_job", "failed_permanent", "2026-11-20T08:00:00.000Z"],
    ["complete_job", "failed_permanent", "2026-11-20T10:00:00.000Z"],
  ]);
  const [start, complete] = all;
  assert.ok(start.failureMessage, "server rejection message kept on the Start");
  assert.equal(start.failureReason, undefined);
  assert.equal(complete.failureReason, "predecessor_rejected");
  assert.ok(complete.failureMessage, "fallback text kept on the Complete");
});

test("UI: after the cascade nothing for the job stays pending ('Abschluss ausstehend' gone)", async () => {
  const h = createHarness();
  await enqueue(h.queue, ME, JOB_A, "start_job", "2026-11-20T08:00:00.000Z");
  await enqueue(h.queue, ME, JOB_A, "complete_job", "2026-11-20T10:00:00.000Z");
  h.reject(JOB_A, "start_job", serverRejection());
  await h.sync.syncPendingJobActions(ME);

  const all = await h.queue.getPendingJobActions(ME);
  // JobContext.refreshPendingState splits exactly like this.
  const pending = all.filter((a) => a.status === "pending");
  const failed = all.filter((a) => a.status === "failed_permanent");
  assert.equal(pending.length, 0, "pendingCount must not stay at 1");
  assert.equal(failed.length, 2, "both failures shown in the OfflineBanner");

  const [job] = h.merge.applyPendingActionsToJobs([legacyJob(JOB_A)], pending);
  const own = job.assignees[0];
  assert.equal(own.pendingStartAt, undefined);
  assert.equal(own.pendingCompleteAt, undefined, "no stuck pending-complete marker");
  // Server fields never written from device time.
  assert.equal(own.employeeStartedAt, null);
  assert.equal(own.employeeCompletedAt, null);
});

test("dismissing the failed Start never sends the dependent Complete afterwards", async () => {
  const h = createHarness();
  await enqueue(h.queue, ME, JOB_A, "start_job", "2026-11-20T08:00:00.000Z");
  await enqueue(h.queue, ME, JOB_A, "complete_job", "2026-11-20T10:00:00.000Z");
  h.reject(JOB_A, "start_job", serverRejection());
  await h.sync.syncPendingJobActions(ME);

  const [start] = await h.queue.getPendingJobActions(ME);
  await h.queue.dismissFailedJobAction(start.id);
  h.executed.length = 0;

  await h.sync.syncPendingJobActions(ME);
  assert.deepEqual(h.executed, [], "the doomed Complete is not sent");
  const left = await h.queue.getPendingJobActions(ME);
  assert.deepEqual(left.map((a) => [a.type, a.status]), [["complete_job", "failed_permanent"]]);
});

test("repair: a queue already stuck by an older build is resolved on the next sync", async () => {
  const h = createHarness();
  await enqueue(h.queue, ME, JOB_A, "start_job", "2026-11-20T08:00:00.000Z");
  await enqueue(h.queue, ME, JOB_A, "complete_job", "2026-11-20T10:00:00.000Z");
  const [start] = await h.queue.getPendingJobActions(ME);
  // State left behind by the pre-fix sync: only the Start was marked.
  await h.queue.markPendingJobActionFailed(start.id, "Abgelehnt");

  const result = await h.sync.syncPendingJobActions(ME);
  assert.deepEqual(h.executed, []);
  assert.equal(result.failed, 1, "the newly failed Complete is reported");
  const all = await h.queue.getPendingJobActions(ME);
  assert.deepEqual(all.map((a) => a.status), ["failed_permanent", "failed_permanent"]);
  assert.equal(all[0].failureMessage, "Abgelehnt", "original Start failure untouched");
});

test("isolation: other jobs and other employees are not marked failed; queue order preserved", async () => {
  const h = createHarness();
  await enqueue(h.queue, ME, JOB_A, "start_job", "2026-11-20T08:00:00.000Z");
  await enqueue(h.queue, OTHER, JOB_A, "complete_job", "2026-11-20T08:30:00.000Z");
  await enqueue(h.queue, ME, JOB_B, "start_job", "2026-11-20T09:00:00.000Z");
  await enqueue(h.queue, ME, JOB_A, "complete_job", "2026-11-20T10:00:00.000Z");
  await enqueue(h.queue, ME, JOB_B, "complete_job", "2026-11-20T11:00:00.000Z");
  h.reject(JOB_A, "start_job", serverRejection());

  await h.sync.syncPendingJobActions(ME);

  const mine = await h.queue.getPendingJobActions(ME);
  assert.deepEqual(mine.map((a) => [a.jobId === JOB_A ? "A" : "B", a.type, a.status]), [
    ["A", "start_job", "failed_permanent"],
    ["B", "start_job", "pending"],
    ["A", "complete_job", "failed_permanent"],
    ["B", "complete_job", "pending"],
  ]);
  const theirs = await h.queue.getPendingJobActions(OTHER);
  assert.deepEqual(theirs.map((a) => a.status), ["pending"], "other employee untouched");
  // Unchanged stop-on-failure semantics (FE-4 is a separate track): job B is
  // not sent in this run, but stays pending, not failed.
  assert.deepEqual(h.executed.map((e) => e.type), ["start_job"]);
});

test("only a Complete queued AFTER the rejected Start is cascaded", async () => {
  const h = createHarness();
  // A Complete that precedes the Start in the queue (own start was already
  // server-confirmed earlier) does not depend on the later Start.
  await enqueue(h.queue, ME, JOB_A, "complete_job", "2026-11-20T07:00:00.000Z");
  h.reject(JOB_A, "complete_job", serverRejection());
  await h.sync.syncPendingJobActions(ME);
  const [first] = await h.queue.getPendingJobActions(ME);
  assert.equal(first.status, "failed_permanent");
  assert.equal(first.failureReason, undefined, "server failure, not a cascade");
});

test("retryable failure of the Start cascades nothing", async () => {
  const h = createHarness();
  await enqueue(h.queue, ME, JOB_A, "start_job", "2026-11-20T08:00:00.000Z");
  await enqueue(h.queue, ME, JOB_A, "complete_job", "2026-11-20T10:00:00.000Z");
  h.reject(JOB_A, "start_job", Object.assign(new Error("timeout"), { code: "57014" }));

  await h.sync.syncPendingJobActions(ME);
  const all = await h.queue.getPendingJobActions(ME);
  assert.deepEqual(all.map((a) => a.status), ["pending", "pending"]);
});
