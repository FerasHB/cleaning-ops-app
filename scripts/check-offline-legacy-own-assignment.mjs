// Regression FE-1 / FE-2: offline gestarteter/abgeschlossener LEGACY-Auftrag
// (pauseResumeEnabled=false → Warteschlange services/offline/jobs.queue.ts).
//
// Fehlerbild vor dem Fix: nach einem Offline-Start blieb „Starten" antippbar
// und „Abschließen" erschien nie, weil die Spiegelung in jobs.merge.ts nur
// den Auftrag, nie die EIGENE Zuweisungszeile kannte. Die Gates
// canStartOwnAssignment/canCompleteOwnAssignment lesen aber genau diese
// Zeile.
//
// Geprüft wird ausschließlich ECHTER Anwendungscode: jobs.merge.ts,
// utils/jobAssignees.ts, utils/assignmentWorkUi.ts samt ihrer echten
// Abhängigkeiten (jobSchedule/date/recurrence) werden transpiliert und
// geladen. Ersetzt wird nur "@/i18n" (JSON-Locales/react-i18next lassen sich
// außerhalb von Metro nicht laden) — keine der geprüften Entscheidungen
// hängt an einem Text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const i18nMock = {
  i18next: { t: (key) => key, language: "de" },
  INTL_LOCALE_TAGS: { de: "de-DE", en: "en-GB", ar: "ar", tr: "tr-TR" },
};
const cache = new Map();

function load(relPath) {
  if (cache.has(relPath)) return cache.get(relPath);
  const source = readFileSync(join(root, relPath), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  cache.set(relPath, exports);
  vm.runInNewContext(code, {
    exports, Date, Math, Set, Map, String, Number, Array, Object, JSON, Intl,
    console,
    require: (name) => {
      if (name === "@/i18n") return i18nMock;
      if (name.startsWith("@/")) return load(`${name.slice(2)}.ts`);
      if (name.startsWith("./")) return load(join(dirname(relPath), `${name.slice(2)}.ts`));
      throw new Error(`Unerwarteter Import ${name} in ${relPath}`);
    },
  });
  return exports;
}

const merge = load("services/offline/jobs.merge.ts");

// Echte Warteschlange; nur AsyncStorage wird durch einen In-Memory-Speicher
// ersetzt (gleiches Muster wie scripts/check-work-journal.mjs).
function loadQueue() {
  const source = readFileSync(join(root, "services/offline/jobs.queue.ts"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const rows = new Map();
  const storage = {
    getItem: async (key) => rows.get(key) ?? null,
    setItem: async (key, value) => { rows.set(key, value); },
    removeItem: async (key) => { rows.delete(key); },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, __DEV__: false, console, Date, Math, JSON,
    require: (name) => {
      if (name !== "@react-native-async-storage/async-storage") throw new Error(`Unerwarteter Import ${name}`);
      return { __esModule: true, default: storage };
    },
  });
  return exports;
}
const gates = load("utils/jobAssignees.ts");
const workUi = load("utils/assignmentWorkUi.ts");

const ME = "11111111-1111-4111-8111-111111111111";
const COLLEAGUE = "22222222-2222-4222-8222-222222222222";
const T_COLLEAGUE = "2026-11-15T07:00:00.000Z";
const T_START = "2026-11-15T08:00:00.000Z";
const T_COMPLETE = "2026-11-15T09:30:00.000Z";

const assignee = (employeeId, assignmentId, extra = {}) => ({
  assignmentId, employeeId, fullName: employeeId === ME ? "Ich" : "Kollegin",
  isDeleted: false, trackingMode: "legacy", workRevision: 0,
  employeeStartedAt: null, employeeCompletedAt: null, ...extra,
});

function serverJob(extra = {}) {
  return {
    id: "job-1", companyId: "c-1", customerName: "Kunde", location: "Ort",
    time: "", service: "Reinigung", status: "open", jobType: "single",
    date: "2026-11-15", startTime: "08:00", recurringDays: [], isActive: true,
    parentJobId: null, employeeId: ME, employeeName: "Ich",
    startedAt: null, startedBy: null, completedAt: null, completedBy: null,
    assignees: [assignee(ME, "a-me")],
    ...extra,
  };
}

let seq = 0;
const action = (type, timestamp, extra = {}) => ({
  id: `act-${++seq}`, userId: ME, jobId: "job-1", type, timestamp,
  status: "pending", ...extra,
});

const view = (job) => ({
  canStart: gates.canStartOwnAssignment(job, "employee", ME),
  canComplete: gates.canCompleteOwnAssignment(job, "employee", ME),
  ui: workUi.deriveAssignmentWorkUi({ job, role: "employee", userId: ME,
    capability: false, summary: null, operations: [] }),
});

test("FE-1: nach Offline-Start ist Start gesperrt und Abschließen (in Warteschlange) möglich", () => {
  const [merged] = merge.applyPendingActionsToJobs([serverJob()], [action("start_job", T_START)]);
  const v = view(merged);
  assert.equal(v.canStart, false, "Start darf nach einem eingereihten Start nicht erneut erscheinen");
  assert.equal(v.canComplete, true, "Abschließen muss nach eingereihtem Start möglich sein");
  assert.equal(v.ui.mode, "legacy");
  assert.equal(v.ui.canStart, false);
  assert.equal(v.ui.canComplete, true);
  assert.equal(v.ui.state, "active");

  const own = gates.getOwnAssignee(merged, ME);
  // Ehrlich: kein erfundener Server-Wert, nur der eigene, als ausstehend
  // markierte Gerätezeitpunkt der Aktion.
  assert.equal(own.employeeStartedAt, null, "employeeStartedAt bleibt Server-Feld");
  assert.equal(own.pendingStartAt, T_START);
  assert.equal(gates.getOwnPendingLegacyAction(merged, ME), "start");
});

test("FE-1: nach Offline-Abschluss ist Abschließen gesperrt und als ausstehend markiert", () => {
  const [merged] = merge.applyPendingActionsToJobs([serverJob()], [
    action("start_job", T_START), action("complete_job", T_COMPLETE),
  ]);
  const v = view(merged);
  assert.equal(v.canStart, false);
  assert.equal(v.canComplete, false, "kein zweiter Abschluss während einer aussteht");
  assert.equal(v.ui.canStart, false);
  assert.equal(v.ui.canComplete, false);
  const own = gates.getOwnAssignee(merged, ME);
  assert.equal(own.employeeCompletedAt, null, "employeeCompletedAt bleibt Server-Feld");
  assert.equal(own.pendingCompleteAt, T_COMPLETE);
  assert.equal(gates.getOwnPendingLegacyAction(merged, ME), "complete");
  assert.equal(gates.hasCompletedOwnAssignment(merged, ME), false,
    "ein ausstehender Abschluss ist kein bestätigter Abschluss");
  // Der Auftrags-Lebenszyklus bleibt serverautoritativ.
  assert.equal(merged.status, "in_progress");
  assert.equal(merged.completedAt, null);
});

test("FE-1: Offline-Abschluss nach SERVER-bestätigtem eigenen Start", () => {
  const started = serverJob({ status: "in_progress", startedAt: T_START, startedBy: ME,
    assignees: [assignee(ME, "a-me", { employeeStartedAt: T_START })] });
  assert.equal(view(started).canComplete, true);
  const [merged] = merge.applyPendingActionsToJobs([started], [action("complete_job", T_COMPLETE)]);
  assert.equal(view(merged).canComplete, false);
  assert.equal(view(merged).canStart, false);
  assert.equal(gates.getOwnAssignee(merged, ME).employeeStartedAt, T_START, "Serverwert bleibt erhalten");
});

test("Nachzügler offline: Auftrags-Uhr der Kollegin wird nicht überschrieben", () => {
  const running = serverJob({ status: "in_progress", startedAt: T_COLLEAGUE, startedBy: COLLEAGUE,
    assignees: [assignee(COLLEAGUE, "a-col", { employeeStartedAt: T_COLLEAGUE }), assignee(ME, "a-me")] });
  assert.equal(view(running).canStart, true, "Nachzügler darf vorher starten");
  const [merged] = merge.applyPendingActionsToJobs([running], [action("start_job", T_START)]);
  assert.equal(merged.startedAt, T_COLLEAGUE);
  assert.equal(merged.startedBy, COLLEAGUE);
  assert.equal(view(merged).canStart, false);
  assert.equal(view(merged).canComplete, true);
  const colleague = merged.assignees.find((a) => a.employeeId === COLLEAGUE);
  assert.equal(colleague.pendingStartAt, undefined, "fremde Zeilen bleiben unberührt");
});

test("Abgelehnte/abgeschlossene Aktionen: Server-Daten ersetzen die lokale Spiegelung", () => {
  const [mirrored] = merge.applyPendingActionsToJobs([serverJob()], [action("start_job", T_START)]);
  // z. B. Cache-Eintrag, der die Spiegelung schon trägt, aber die Aktion ist
  // nicht mehr "pending" (synchronisiert oder dauerhaft abgelehnt → refreshJobs
  // filtert auf status==="pending").
  const [cleared] = merge.applyPendingActionsToJobs([mirrored], []);
  assert.equal(gates.getOwnAssignee(cleared, ME).pendingStartAt, undefined);
  assert.equal(gates.getOwnPendingLegacyAction(cleared, ME), null);

  // Server hat den Start bestätigt: echte Felder, keine Marker.
  const confirmed = serverJob({ status: "in_progress", startedAt: T_START, startedBy: ME,
    assignees: [assignee(ME, "a-me", { employeeStartedAt: T_START })] });
  const [after] = merge.applyPendingActionsToJobs([confirmed], []);
  assert.equal(gates.getOwnAssignee(after, ME).employeeStartedAt, T_START);
  assert.equal(gates.getOwnAssignee(after, ME).pendingStartAt, undefined);
  assert.equal(view(after).canComplete, true);
});

test("Doppelte Aktionen: gleiche Aktion für denselben Auftrag/Nutzer wird erkannt", () => {
  const queue = loadQueue();
  const actions = [action("start_job", T_START)];
  assert.equal(queue.findPendingOwnJobAction(actions, ME, "job-1", "start_job")?.id, actions[0].id);
  assert.equal(queue.findPendingOwnJobAction(actions, ME, "job-1", "complete_job"), null);
  assert.equal(queue.findPendingOwnJobAction(actions, COLLEAGUE, "job-1", "start_job"), null);
  assert.equal(queue.findPendingOwnJobAction(actions, ME, "job-2", "start_job"), null);
  const failed = [action("start_job", T_START, { status: "failed_permanent" })];
  assert.equal(queue.findPendingOwnJobAction(failed, ME, "job-1", "start_job"), null,
    "ein abgelehnter Eintrag sperrt keinen neuen Versuch nach dem Bestätigen");
});

test("Doppelte Aktionen: addPendingJobAction reiht Start/Abschluss je Auftrag nur einmal ein, Reihenfolge bleibt", async () => {
  const queue = loadQueue();
  await queue.addPendingJobAction({ userId: ME, type: "start_job", jobId: "job-1", timestamp: T_START });
  await queue.addPendingJobAction({ userId: ME, type: "start_job", jobId: "job-1", timestamp: T_COMPLETE });
  await queue.addPendingJobAction({ userId: ME, type: "complete_job", jobId: "job-1", timestamp: T_COMPLETE });
  const mine = await queue.addPendingJobAction({ userId: ME, type: "complete_job", jobId: "job-1" });
  assert.deepEqual(mine.map((a) => [a.type, a.timestamp]),
    [["start_job", T_START], ["complete_job", T_COMPLETE]]);
  // Andere Nutzer/Aufträge sind nicht betroffen.
  await queue.addPendingJobAction({ userId: COLLEAGUE, type: "start_job", jobId: "job-1", timestamp: T_START });
  await queue.addPendingJobAction({ userId: ME, type: "start_job", jobId: "job-2", timestamp: T_START });
  assert.equal((await queue.getPendingJobActions(ME)).length, 3);
  assert.equal((await queue.getPendingJobActions(COLLEAGUE)).length, 1);

  // Abgelehnter Start: die Spiegelung verschwindet (refreshJobs reicht nur
  // status==="pending" an den Merge weiter) — keine angezeigte Erfolgs-Lüge.
  const [startAction] = await queue.getPendingJobActions(ME);
  await queue.markPendingJobActionFailed(startAction.id, "abgelehnt");
  const stillPending = (await queue.getPendingJobActions(ME))
    .filter((a) => a.status === "pending" && a.jobId === "job-1");
  const [merged] = merge.applyPendingActionsToJobs([serverJob()], stillPending);
  const own = gates.getOwnAssignee(merged, ME);
  assert.equal(own.pendingStartAt, undefined);
  assert.equal(merged.status, "open", "kein Start ohne wartenden/bestätigten Start");
  assert.equal(view(merged).canComplete, false);
});

test("Reihenfolge: Abschluss wird nach dem Start gespiegelt, auch bei vertauschter Eingabe", () => {
  const [merged] = merge.applyPendingActionsToJobs([serverJob()], [
    action("complete_job", T_COMPLETE), action("start_job", T_START),
  ]);
  const own = gates.getOwnAssignee(merged, ME);
  assert.equal(own.pendingStartAt, T_START);
  assert.equal(own.pendingCompleteAt, T_COMPLETE);
});

test("FE-2: frischer Server-Job ersetzt den Listeneintrag, Ungelesen-Flag bleibt", () => {
  const stale = serverJob({ status: "in_progress", startedAt: T_COLLEAGUE, hasUnreadComments: true,
    assignees: [assignee(COLLEAGUE, "a-col", { employeeStartedAt: T_COLLEAGUE }), assignee(ME, "a-me")] });
  const fresh = { ...stale, hasUnreadComments: undefined,
    assignees: [stale.assignees[0], assignee(ME, "a-me", { employeeStartedAt: T_START })] };
  const other = { ...serverJob(), id: "job-2" };
  const next = merge.replaceJobWithServerCopy([stale, other], fresh, []);
  assert.equal(next[1], other);
  assert.equal(next[0].hasUnreadComments, true);
  assert.equal(gates.getOwnAssignee(next[0], ME).employeeStartedAt, T_START);
  assert.equal(view(next[0]).canStart, false);
  assert.equal(view(next[0]).canComplete, true);
});
