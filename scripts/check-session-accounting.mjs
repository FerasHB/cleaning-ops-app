import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  accountSessionAssignment,
  companyDateKey,
  companyMonthBounds,
  companyTimeLabel,
  validCompanyTimeZone,
} from "../services/timesheets/sessionAccounting.ts";
import { buildTimesheetHtml } from "../services/timesheets/timesheetHtml.ts";

const assignment = (overrides = {}) => ({
  id: "assignment-a", jobId: "job-a", customerName: "Kunde A", remark: "Reinigung",
  employeeStartedAt: "2026-01-15T07:00:00Z", employeeCompletedAt: "2026-01-15T11:30:00Z",
  reviewRequired: false, ...overrides,
});
const session = (start, end, id = "session-1", assignmentId = "assignment-a") => ({
  id, job_assignment_id: assignmentId, started_at: start, ended_at: end,
});
const account = (a, sessions, year = 2026, month = 1, zone = "Europe/Berlin") =>
  accountSessionAssignment(a, sessions, year, month, zone);

test("one closed session uses actual interval", () => {
  const result = account(assignment(), [session("2026-01-15T07:00:00Z", "2026-01-15T09:00:00Z")]);
  assert.equal(result.entries[0].durationMinutes, 120);
  assert.equal(result.entries[0].beginLabel, "08:00");
  assert.equal(result.entries[0].endLabel, "10:00");
  assert.equal(result.entries[0].interruptionMinutes, 0);
});

test("multiple intervals sum exactly and paused gaps become interruptions", () => {
  const a = assignment({ employeeCompletedAt: "2026-01-15T14:15:00Z" });
  const result = account(a, [
    session("2026-01-15T07:00:00Z", "2026-01-15T09:00:00Z", "s1"),
    session("2026-01-15T10:00:00Z", "2026-01-15T11:30:00Z", "s2"),
    session("2026-01-15T13:00:00Z", "2026-01-15T14:00:00Z", "s3"),
  ]);
  assert.equal(result.entries[0].durationMinutes, 270);
  assert.equal(result.entries[0].interruptionMinutes, 150);
  assert.equal(result.entries[0].durationLabel, "4:30");
  assert.equal(result.entries[0].interruptionLabel, "2:30");
});

test("completion while paused adds neither work nor a fake trailing interruption", () => {
  const result = account(assignment({ employeeCompletedAt: "2026-01-15T10:30:00Z" }),
    [session("2026-01-15T07:00:00Z", "2026-01-15T09:00:00Z")]);
  assert.equal(result.entries[0].durationMinutes, 120);
  assert.equal(result.entries[0].interruptionMinutes, 0);
  assert.equal(result.entries[0].endLabel, "10:00");
});

test("unfinished assignment is not finalized; review-required time is visibly flagged", () => {
  const work = [session("2026-01-15T07:00:00Z", "2026-01-15T09:00:00Z")];
  assert.deepEqual(account(assignment({ employeeCompletedAt: null }), work).entries, []);
  const pendingReview = account(assignment({ employeeCompletedAt: null, reviewRequired: true }), work);
  assert.equal(pendingReview.gap, "session_review");
  assert.equal(pendingReview.entries.length, 0);
  const finalizedReview = account(assignment({ reviewRequired: true }), work);
  assert.equal(finalizedReview.entries[0].reviewRequired, true);
  assert.equal(finalizedReview.gap, "session_review");
  assert.equal(finalizedReview.knownDurationMinutes, 120);
});

test("missing and inconsistent sessions create gaps, never lifecycle fallback", () => {
  assert.equal(account(assignment(), []).gap, "session_missing");
  assert.equal(account(assignment(), []).entries.length, 0);
  const overlap = account(assignment(), [
    session("2026-01-15T07:00:00Z", "2026-01-15T09:00:00Z", "s1"),
    session("2026-01-15T08:30:00Z", "2026-01-15T10:00:00Z", "s2"),
  ]);
  assert.equal(overlap.gap, "session_invalid");
  assert.equal(overlap.entries.length, 0);
  assert.equal(account(assignment(), [session("2026-01-15T07:00:00Z", null)]).gap, "session_invalid");
});

test("company-local midnight and reporting month boundary split real elapsed work", () => {
  const a = assignment({ employeeStartedAt: "2026-06-30T21:00:00Z", employeeCompletedAt: "2026-06-30T23:00:00Z" });
  const work = [session("2026-06-30T21:00:00Z", "2026-06-30T23:00:00Z")];
  const june = account(a, work, 2026, 6);
  const july = account(a, work, 2026, 7);
  assert.deepEqual(june.entries.map((e) => [e.date, e.durationMinutes, e.endLabel]), [["2026-06-30", 60, "24:00"]]);
  assert.deepEqual(july.entries.map((e) => [e.date, e.durationMinutes, e.beginLabel]), [["2026-07-01", 60, "00:00"]]);
  assert.equal(new Date(companyMonthBounds(2026, 7, "Europe/Berlin").start).toISOString(), "2026-06-30T22:00:00.000Z");
});

test("company timezone, rather than device timezone, determines the work date", () => {
  const a = assignment({ employeeStartedAt: "2026-09-15T21:30:00Z", employeeCompletedAt: "2026-09-15T22:30:00Z" });
  const work = [session("2026-09-15T21:30:00Z", "2026-09-15T22:30:00Z")];
  assert.deepEqual(account(a, work, 2026, 9, "Asia/Dubai").entries.map((e) => [e.date, e.durationMinutes]),
    [["2026-09-16", 60]]);
  assert.deepEqual(account(a, work, 2026, 9, "Europe/Berlin").entries.map((e) => [e.date, e.durationMinutes]),
    [["2026-09-15", 30], ["2026-09-16", 30]]);
});

test("DST spring and fall use UTC elapsed time", () => {
  const spring = account(assignment({ employeeStartedAt: "2026-03-29T00:30:00Z", employeeCompletedAt: "2026-03-29T02:30:00Z" }),
    [session("2026-03-29T00:30:00Z", "2026-03-29T02:30:00Z")], 2026, 3);
  const fall = account(assignment({ employeeStartedAt: "2026-10-25T00:30:00Z", employeeCompletedAt: "2026-10-25T02:30:00Z" }),
    [session("2026-10-25T00:30:00Z", "2026-10-25T02:30:00Z")], 2026, 10);
  assert.equal(spring.entries[0].durationMinutes, 120);
  assert.equal(fall.entries[0].durationMinutes, 120);
  assert.equal(spring.entries[0].beginLabel, "01:30");
  assert.equal(spring.entries[0].endLabel, "04:30");
});

test("round after exact session sum, not each interval", () => {
  const a = assignment({ employeeCompletedAt: "2026-01-15T07:02:00Z" });
  const work = [
    session("2026-01-15T07:00:00Z", "2026-01-15T07:00:20Z", "s1"),
    session("2026-01-15T07:00:40Z", "2026-01-15T07:01:00Z", "s2"),
    session("2026-01-15T07:01:20Z", "2026-01-15T07:01:40Z", "s3"),
  ];
  assert.equal(account(a, work).entries[0].durationMinutes, 1);
});

test("daily midnight slices preserve the rounded assignment total", () => {
  const a = assignment({ employeeStartedAt: "2026-06-30T21:59:30Z", employeeCompletedAt: "2026-06-30T22:00:30Z" });
  const work = [session("2026-06-30T21:59:30Z", "2026-06-30T22:00:30Z")];
  const june = account(a, work, 2026, 6);
  const july = account(a, work, 2026, 7);
  assert.equal(june.entries[0].durationMinutes, 1);
  // Der 0-Minuten-Anteil im Folgemonat erzeugt KEINE Zeile mehr (D2).
  assert.equal(july.entries.length, 0);
});

test("a full paused calendar day creates no zero-work timesheet row", () => {
  const a = assignment({ employeeStartedAt: "2026-09-15T06:00:00Z", employeeCompletedAt: "2026-09-17T10:00:00Z" });
  const work = [
    session("2026-09-15T06:00:00Z", "2026-09-15T08:00:00Z", "s1"),
    session("2026-09-17T08:00:00Z", "2026-09-17T10:00:00Z", "s2"),
  ];
  const result = account(a, work, 2026, 9);
  assert.deepEqual(result.entries.map((e) => [e.date, e.durationMinutes]),
    [["2026-09-15", 120], ["2026-09-17", 120]]);
  assert.equal(result.entries.some((e) => e.date === "2026-09-16"), false);
});

test("German PDF uses session worked time and neutral interruption wording across app locales", () => {
  const result = account(assignment({ employeeCompletedAt: "2026-01-15T11:00:00Z" }), [
    session("2026-01-15T07:00:00Z", "2026-01-15T09:00:00Z", "s1"),
    session("2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z", "s2"),
  ]);
  const data = {
    companyName: "Firma", employeeId: "a", employeeName: "Mitarbeiterin", year: 2026,
    month: 1, monthLabel: "Januar 2026", entries: result.entries,
    totalMinutes: 180, totalLabel: "3:00", jobCount: 1, needsAttention: [],
  };
  for (const appLocale of ["de", "en", "ar", "tr"]) {
    const html = buildTimesheetHtml({ ...data, appLocale });
    assert.match(html, /<html lang="de">/);
    assert.match(html, /Unterbrechung/);
    assert.match(html, /<td class="num">1:00<\/td>/);
    assert.match(html, /<td class="num">3:00<\/td>/);
    assert.doesNotMatch(html, /<th class="num">Pause<\/th>/);
  }
});

test("legacy PDF row and German heading remain unchanged", () => {
  const entry = { jobId: "legacy", date: "2026-07-01", beginLabel: "08:00", endLabel: "11:00",
    durationMinutes: 180, durationLabel: "3:00", customerName: "Alt", remark: "Reinigung" };
  const html = buildTimesheetHtml({ companyName: "Firma", employeeId: "a", employeeName: "Mitarbeiterin",
    year: 2026, month: 7, monthLabel: "Juli 2026", entries: [entry], totalMinutes: 180,
    totalLabel: "3:00", jobCount: 1, needsAttention: [] });
  assert.match(html, /<th class="num">Pause<\/th>/);
  assert.match(html, /<td class="num">0:00<\/td>/);
  assert.match(html, /Automatisch erstellt aus abgeschlossenen Aufträgen/);
});

test("review warning appears in PDF without treating session time as clean payroll", () => {
  const result = account(assignment({ reviewRequired: true }),
    [session("2026-01-15T07:00:00Z", "2026-01-15T09:00:00Z")]);
  const html = buildTimesheetHtml({ companyName: "Firma", employeeId: "a", employeeName: "Mitarbeiterin",
    year: 2026, month: 1, monthLabel: "Januar 2026", entries: result.entries,
    totalMinutes: 120, totalLabel: "2:00", jobCount: 1, needsAttention: [] });
  assert.match(html, /Prüfung erforderlich/);
  assert.match(html, /nicht für die Abrechnung freigegeben/);
});

test("PDF session gap reason remains German even when the app reason is English", () => {
  const html = buildTimesheetHtml({ companyName: "Firma", employeeId: "a", employeeName: "A",
    year: 2026, month: 9, monthLabel: "September 2026", entries: [], totalMinutes: 0,
    totalLabel: "0:00", jobCount: 0, needsAttention: [{ source: "sessions", reason: "session_missing",
      reasonLabel: "No session recorded — review required", date: "2026-09-19",
      customerName: "Kunde" }] });
  assert.match(html, /Keine Sitzung erfasst/);
  assert.doesNotMatch(html, /No session recorded/);
});

// Execute the actual Timesheet service with a small PostgREST-shaped fixture.
// This protects the legacy query and the independent session query together.
function loadTimesheetService(tables) {
  const source = readFileSync(new URL("../services/timesheets/timesheet.service.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const seen = [];
  const supabase = { from(table) {
    const predicates = [];
    const query = {
      select() { return query; },
      eq(field, value) { predicates.push(["eq", field, value]); return query; },
      not(field, op, value) { predicates.push(["not", field, op, value]); return query; },
      gte(field, value) { predicates.push(["gte", field, value]); return query; },
      gt(field, value) { predicates.push(["gt", field, value]); return query; },
      lt(field, value) { predicates.push(["lt", field, value]); return query; },
      in(field, values) { predicates.push(["in", field, values]); return query; },
      order() { return query; },
      then(resolve, reject) {
        seen.push({ table, predicates });
        const value = (row, field) => field.split(".").reduce((current, part) => current?.[part], row);
        const data = (tables[table] ?? []).filter((row) => predicates.every(([op, field, arg, extra]) => {
          const actual = value(row, field);
          if (op === "eq") return actual === arg;
          if (op === "not") return arg === "is" ? actual !== extra : true;
          if (op === "in") return arg.includes(actual);
          if (op === "gte") return actual != null && actual >= arg;
          if (op === "gt") return actual != null && actual > arg;
          if (op === "lt") return actual != null && actual < arg;
          return true;
        }));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  const dateUtils = {
    diffInMinutes: (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)),
    formatDateISO: (d) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null,
    formatTimeHHmm: (d) => d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : null,
    formatDurationHm: (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`,
  };
  const mocks = {
    "@/lib/supabase": { supabase }, "@/i18n": { i18next: { t: (key) => key } },
    "@/services/timesheets/timesheetAbsence.service": { buildTimesheetAbsence: async () => ({ summary: undefined, notices: [] }) },
    "@/services/timesheets/timesheetHtml": { buildTimesheetHtml },
    "@/services/timesheets/sessionAccounting": awaitlessSessionAccounting,
    // Der Stundenzettel liest Arbeitszeit seit Migration 20260922000000 NUR
    // noch über get_effective_work_sessions. Ohne Korrekturzeile ist das
    // wirksame Intervall identisch mit dem rohen — genau das bildet dieser
    // Mock ab, damit die Bestandsfälle unverändert geprüft bleiben.
    "@/services/timesheets/sessionRecovery.service": {
      getEffectiveWorkSessions: async (assignmentIds) =>
        (tables.work_sessions ?? [])
          .filter((session) => assignmentIds.includes(session.job_assignment_id))
          .map((session) => ({ ...session, reviewed: false })),
      getSessionCorrectionAudit: async () => [],
    },
    "@/utils/date": dateUtils,
    "@/utils/jobCorrection": { isLegacyJob: (iso) => Date.parse(iso) < Date.parse("2026-08-12T00:00:00Z") },
    "expo-print": {}, "expo-sharing": {},
  };
  const exports = {};
  vm.runInNewContext(code, { exports, require: (name) => mocks[name] ?? (() => { throw Error(`Unmocked ${name}`); })(), Date, Math, Set, Map, console });
  return { getTimesheet: exports.getTimesheet, seen };
}

const awaitlessSessionAccounting = {
  accountSessionAssignment,
  companyMonthBounds,
  companyDateKey,
  companyTimeLabel,
  validCompanyTimeZone,
};

test("Timesheet service keeps legacy own-time and pre-August fallback output", async () => {
  const legacyRows = [
    { id: "legacy-own", employee_id: "employee-a", time_tracking_mode: "legacy", employee_started_at: "2026-09-15T08:30:00Z", employee_completed_at: "2026-09-15T11:30:00Z",
      j: { id: "job-own", status: "completed", job_type: "single", started_at: "2026-09-15T08:00:00Z", completed_at: "2026-09-15T12:00:00Z", customer_name: "Own", service_name: "Clean", location_address: "Street" } },
    { id: "legacy-old", employee_id: "employee-a", time_tracking_mode: "legacy", employee_started_at: null, employee_completed_at: null,
      j: { id: "job-old", status: "completed", job_type: "single", started_at: "2026-07-01T08:00:00Z", completed_at: "2026-07-01T11:00:00Z", customer_name: "Old", service_name: "Clean", location_address: "Street" } },
  ];
  const service = loadTimesheetService({ job_assignments: legacyRows, work_sessions: [] });
  const september = await service.getTimesheet({ companyName: "Firma", employeeId: "employee-a", employeeName: "A", year: 2026, month: 9, companyTimezone: "Europe/Berlin" });
  const july = await service.getTimesheet({ companyName: "Firma", employeeId: "employee-a", employeeName: "A", year: 2026, month: 7, companyTimezone: "Europe/Berlin" });
  assert.equal(september.entries.length, 1);
  assert.equal(september.entries[0].durationMinutes, 180);
  assert.equal(september.entries[0].customerName, "Own");
  assert.equal(july.entries.length, 1);
  assert.equal(july.entries[0].durationMinutes, 180);
  assert.equal(july.entries[0].customerName, "Old");
});

test("completed employee A is eligible while parent in progress and employee B unfinished", async () => {
  const rows = [
    { id: "assignment-a", employee_id: "employee-a", time_tracking_mode: "sessions", employee_started_at: "2026-09-15T07:00:00Z", employee_completed_at: "2026-09-15T09:00:00Z", work_review_required: false,
      j: { id: "shared-job", status: "in_progress", job_type: "single", started_at: "2026-09-15T07:00:00Z", completed_at: null, customer_name: "Shared", service_name: "Clean", location_address: "Street" } },
    { id: "assignment-b", employee_id: "employee-b", time_tracking_mode: "sessions", employee_started_at: "2026-09-15T07:00:00Z", employee_completed_at: null, work_review_required: false,
      j: { id: "shared-job", status: "in_progress", job_type: "single", started_at: "2026-09-15T07:00:00Z", completed_at: null, customer_name: "Shared", service_name: "Clean", location_address: "Street" } },
  ];
  const sessions = [session("2026-09-15T07:00:00Z", "2026-09-15T09:00:00Z", "session-a", "assignment-a"),
    session("2026-09-15T07:00:00Z", "2026-09-15T09:00:00Z", "session-b", "assignment-b")]
    .map((item) => ({ ...item, employee_id: item.job_assignment_id === "assignment-a" ? "employee-a" : "employee-b" }));
  const service = loadTimesheetService({ job_assignments: rows, work_sessions: sessions });
  const a = await service.getTimesheet({ companyName: "Firma", employeeId: "employee-a", employeeName: "A", year: 2026, month: 9, companyTimezone: "Europe/Berlin" });
  const b = await service.getTimesheet({ companyName: "Firma", employeeId: "employee-b", employeeName: "B", year: 2026, month: 9, companyTimezone: "Europe/Berlin" });
  assert.equal(a.entries.length, 1);
  assert.equal(a.entries[0].durationMinutes, 120);
  assert.equal(a.jobCount, 1);
  assert.equal(b.entries.length, 0);
  assert.ok(service.seen.some((query) => query.table === "job_assignments" && query.predicates.some(([op, field, value]) => op === "eq" && field === "time_tracking_mode" && value === "sessions") &&
    !query.predicates.some(([op, field, value]) => op === "eq" && field === "j.status" && value === "completed")));
});

// ── Regression: Stundenzettel-Audit 2026-10-15 (C1, D1, D2, D3) ─────────────

const DEVICE_ZONES = ["Europe/Berlin", "UTC", "Asia/Riyadh", "America/New_York"];
async function underDeviceZones(run) {
  const original = process.env.TZ;
  const results = [];
  try {
    for (const zone of DEVICE_ZONES) {
      process.env.TZ = zone;
      results.push({ zone, offset: new Date(2026, 0, 15).getTimezoneOffset(), value: await run() });
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
  // Beweis, dass die Geräte-Zeitzone tatsächlich gewechselt hat.
  assert.equal(new Set(results.map((r) => r.offset)).size, DEVICE_ZONES.length);
  return results;
}
const legacyJob = (id, startedAt, completedAt, status = "completed", extra = {}) => ({
  id, status, job_type: "single", started_at: startedAt, completed_at: completedAt,
  customer_name: id, service_name: "Clean", location_address: "Street", ...extra,
});
const legacyRow = (id, employee, ownStart, ownEnd, job) => ({
  id, employee_id: employee, time_tracking_mode: "legacy",
  employee_started_at: ownStart, employee_completed_at: ownEnd, j: job,
});
const sheet = (service, employeeId, year, month) => service.getTimesheet({
  companyName: "Firma", employeeId, employeeName: employeeId, year, month, companyTimezone: "Europe/Berlin" });
// Ergebnisse stammen aus dem vm-Kontext (andere Array-Prototypen) — für
// deepStrictEqual in reine Werte umwandeln.
const plain = (value) => JSON.parse(JSON.stringify(value));
const shape = (data) => plain({
  entries: data.entries.map((e) => [e.date, e.beginLabel, e.endLabel, e.durationMinutes, e.customerName]),
  gaps: data.needsAttention.map((g) => [g.date, g.reason, g.customerName]),
  total: data.totalMinutes, jobCount: data.jobCount,
});

test("D1: legacy month/date/labels follow company timezone under every device timezone", async () => {
  const rows = [
    // Prod-Muster 2d999016: 00:15 Berlin am 19., 22:15 UTC am 18.
    legacyRow("near-midnight", "emp", "2026-09-18T22:15:52Z", "2026-09-18T22:17:05Z",
      legacyJob("near-midnight", "2026-09-18T22:15:52Z", "2026-09-18T22:17:05Z")),
    // Erster Tag des Monats, 00:30 Berlin = 30.09. 22:30 UTC.
    legacyRow("first-day", "emp", "2026-09-30T22:30:00Z", "2026-09-30T23:30:00Z",
      legacyJob("first-day", "2026-09-30T22:30:00Z", "2026-09-30T23:30:00Z")),
    // Letzter Tag des Monats, 23:30 Berlin = 21:30 UTC.
    legacyRow("last-day", "emp", "2026-09-30T21:30:00Z", "2026-09-30T21:50:00Z",
      legacyJob("last-day", "2026-09-30T21:30:00Z", "2026-09-30T21:50:00Z")),
    // Vor-Phase-1-Fallback über die geteilte Uhr, 1. Juli 00:30 Berlin.
    legacyRow("pre-cutoff", "emp", null, null,
      legacyJob("pre-cutoff", "2026-06-30T22:30:00Z", "2026-07-01T01:30:00Z")),
    // Nach Phase 1 ohne eigenes Paar → Lücke, Datum in Firmen-Zeit.
    legacyRow("gap", "emp", "2026-09-30T22:10:00Z", null,
      legacyJob("gap", "2026-09-30T22:10:00Z", "2026-09-30T23:00:00Z")),
  ];
  const service = loadTimesheetService({ job_assignments: rows, work_sessions: [] });
  const runs = await underDeviceZones(async () => ({
    june: shape(await sheet(service, "emp", 2026, 6)),
    july: shape(await sheet(service, "emp", 2026, 7)),
    september: shape(await sheet(service, "emp", 2026, 9)),
    october: shape(await sheet(service, "emp", 2026, 10)),
  }));
  for (const run of runs) assert.deepEqual(run.value, runs[0].value, `device ${run.zone}`);
  const { june, july, september, october } = runs[0].value;
  assert.deepEqual(september.entries, [
    ["2026-09-19", "00:15", "00:17", 1, "near-midnight"],
    ["2026-09-30", "23:30", "23:50", 20, "last-day"],
  ]);
  assert.deepEqual(october.entries, [["2026-10-01", "00:30", "01:30", 60, "first-day"]]);
  assert.deepEqual(october.gaps, [["2026-10-01", "start_only", "gap"]]);
  assert.deepEqual(september.gaps, []);
  assert.deepEqual(july.entries, [["2026-07-01", "00:30", "03:30", 180, "pre-cutoff"]]);
  assert.deepEqual(june.entries, []);
});

test("C1: legacy own pair counts while job stays in_progress for a never-started co-assignee", async () => {
  // Prod-Muster acaf4c5c/8f47f0bf: A startet+beendet selbst, B nie → Auftrag bleibt in_progress.
  const job = legacyJob("stuck", "2026-09-21T20:03:23.983Z", null, "in_progress");
  const rows = [
    legacyRow("a-row", "employee-a", "2026-09-21T20:03:23.983Z", "2026-09-21T22:03:44.965Z", job),
    legacyRow("b-row", "employee-b", null, null, job),
  ];
  const service = loadTimesheetService({ job_assignments: rows, work_sessions: [] });
  const a = await sheet(service, "employee-a", 2026, 9);
  assert.deepEqual(shape(a).entries, [["2026-09-21", "22:03", "00:03", 120, "stuck"]]);
  assert.equal(a.totalMinutes, 120);
  assert.equal(a.jobCount, 1);
  assert.deepEqual(plain(a.needsAttention), []);
  const b = await sheet(service, "employee-b", 2026, 9);
  assert.equal(b.entries.length, 0);
  assert.deepEqual(plain(b.needsAttention), [], "laufender Auftrag ohne eigene Zeit ist keine Lücke");
  assert.equal((await sheet(service, "employee-a", 2026, 10)).entries.length, 0);
});

test("C1: own pair on a completed job appears exactly once, attributed by own start", async () => {
  // Geteilte Uhr startet im September, eigene Zeit im Oktober (Firmen-Zeit).
  const job = legacyJob("cross", "2026-09-30T21:50:00Z", "2026-09-30T23:30:00Z");
  const service = loadTimesheetService({ job_assignments: [
    legacyRow("own", "emp", "2026-09-30T22:10:00Z", "2026-09-30T23:10:00Z", job)], work_sessions: [] });
  const september = await sheet(service, "emp", 2026, 9);
  const october = await sheet(service, "emp", 2026, 10);
  assert.equal(september.entries.length, 0);
  assert.deepEqual(plain(september.needsAttention), []);
  assert.deepEqual(shape(october).entries, [["2026-10-01", "00:10", "01:10", 60, "cross"]]);
});

test("C1: pre-cutoff shared-clock fallback is not broadened to unfinished jobs", async () => {
  const rows = [
    legacyRow("old-open", "emp", null, null, legacyJob("old-open", "2026-07-01T08:00:00Z", null, "in_progress")),
    legacyRow("old-start-only", "emp", "2026-07-02T08:00:00Z", null,
      legacyJob("old-start-only", "2026-07-02T08:00:00Z", null, "in_progress")),
    legacyRow("old-done", "emp", null, null, legacyJob("old-done", "2026-07-03T08:00:00Z", "2026-07-03T10:00:00Z")),
  ];
  const service = loadTimesheetService({ job_assignments: rows, work_sessions: [] });
  const july = await sheet(service, "emp", 2026, 7);
  assert.deepEqual(shape(july).entries, [["2026-07-03", "10:00", "12:00", 120, "old-done"]]);
  assert.deepEqual(plain(july.needsAttention), []);
});

test("D3: Start → Pause → Resume with the second session still open is not session_invalid", () => {
  const a = assignment({ employeeStartedAt: "2026-10-14T08:00:00Z", employeeCompletedAt: null });
  const work = [session("2026-10-14T08:00:00Z", "2026-10-14T09:00:00Z", "s1"),
    session("2026-10-14T09:30:00Z", null, "s2")];
  const running = account(a, work, 2026, 10);
  assert.equal(running.gap, null);
  assert.deepEqual(running.entries, [], "unfertige Arbeit wird nicht abgerechnet");
  assert.equal(running.knownDurationMinutes, 60, "offene Sitzung zählt nicht");
  // Offene Sitzung an einer ABGESCHLOSSENEN Zuweisung bleibt ungültig.
  assert.equal(account({ ...a, employeeCompletedAt: "2026-10-14T10:00:00Z" }, work, 2026, 10).gap, "session_invalid");
  // Offene Sitzung, die NICHT die letzte ist, bleibt ungültig.
  assert.equal(account(a, [session("2026-10-14T08:00:00Z", null, "s1"),
    session("2026-10-14T09:30:00Z", "2026-10-14T10:00:00Z", "s2")], 2026, 10).gap, "session_invalid");
  // Review-Kennzeichen bleibt sichtbar.
  assert.equal(account({ ...a, reviewRequired: true }, work, 2026, 10).gap, "session_review");
});

test("D3: timesheet + PDF carry no false warning for a resumed running assignment", async () => {
  const rows = [{ id: "run", employee_id: "emp", time_tracking_mode: "sessions",
    employee_started_at: "2026-10-14T08:00:00Z", employee_completed_at: null, work_review_required: false,
    j: legacyJob("run", "2026-10-14T08:00:00Z", null, "in_progress") }];
  const sessions = [session("2026-10-14T08:00:00Z", "2026-10-14T09:00:00Z", "s1", "run"),
    session("2026-10-14T09:30:00Z", null, "s2", "run")].map((x) => ({ ...x, employee_id: "emp" }));
  const service = loadTimesheetService({ job_assignments: rows, work_sessions: sessions });
  const data = await sheet(service, "emp", 2026, 10);
  assert.deepEqual(plain(data.needsAttention), []);
  assert.equal(data.totalMinutes, 0);
  assert.doesNotMatch(buildTimesheetHtml(data), /Prüfung erforderlich/);
});

test("D2: month-end crossing by seconds yields no 0-minute row and no extra jobCount", async () => {
  // Prod-Muster 1b827085: 30.09. 22:00:12 → 01.10. 00:00:15 Berlin.
  const rows = [{ id: "edge", employee_id: "emp", time_tracking_mode: "sessions",
    employee_started_at: "2026-09-30T20:00:12.519Z", employee_completed_at: "2026-09-30T22:00:15.423Z",
    work_review_required: false, j: legacyJob("edge", "2026-09-30T20:00:12.519Z", null, "in_progress") }];
  const sessions = [{ ...session("2026-09-30T20:00:12.519Z", "2026-09-30T22:00:15.423Z", "s1", "edge"), employee_id: "emp" }];
  const service = loadTimesheetService({ job_assignments: rows, work_sessions: sessions });
  const september = await sheet(service, "emp", 2026, 9);
  const october = await sheet(service, "emp", 2026, 10);
  assert.deepEqual(shape(september).entries, [["2026-09-30", "22:00", "24:00", 120, "edge"]]);
  assert.equal(september.jobCount, 1);
  assert.equal(october.entries.length, 0);
  assert.equal(october.jobCount, 0);
  assert.equal(october.totalMinutes, 0);
  assert.deepEqual(plain(october.needsAttention), []);
});

test("D2: real non-zero split across midnight keeps largest-remainder rounding", () => {
  const a = assignment({ employeeStartedAt: "2026-06-30T21:30:20Z", employeeCompletedAt: "2026-06-30T22:30:50Z" });
  const work = [session("2026-06-30T21:30:20Z", "2026-06-30T22:30:50Z")];
  const june = account(a, work, 2026, 6).entries.map((e) => e.durationMinutes);
  const july = account(a, work, 2026, 7).entries.map((e) => e.durationMinutes);
  // 29:40 + 30:50 = 60:30 → 61 gesamt (Rundung auf Gesamtsumme), Rest an Juli.
  assert.deepEqual([june, july], [[30], [31]]);
});

test("session path stays device-timezone independent (sessions, pause/resume, DST)", async () => {
  const cases = () => [
    account(assignment({ employeeStartedAt: "2026-09-24T20:39:53.309Z", employeeCompletedAt: "2026-09-24T20:46:12.89Z" }), [
      session("2026-09-24T20:39:53.309Z", "2026-09-24T20:41:37.545Z", "s1"),
      session("2026-09-24T20:45:28.942Z", "2026-09-24T20:46:12.89Z", "s2")], 2026, 9),
    account(assignment({ employeeStartedAt: "2026-10-24T23:30:00Z", employeeCompletedAt: "2026-10-25T03:30:00Z" }),
      [session("2026-10-24T23:30:00Z", "2026-10-25T03:30:00Z")], 2026, 10),
    account(assignment({ employeeStartedAt: "2026-03-29T00:30:00Z", employeeCompletedAt: "2026-03-29T02:30:00Z" }),
      [session("2026-03-29T00:30:00Z", "2026-03-29T02:30:00Z")], 2026, 3),
  ].map((r) => r.entries.map((e) => [e.date, e.beginLabel, e.endLabel, e.durationMinutes, e.interruptionMinutes]));
  const runs = await underDeviceZones(async () => cases());
  for (const run of runs) assert.deepEqual(run.value, runs[0].value, `device ${run.zone}`);
  assert.deepEqual(runs[0].value, [
    [["2026-09-24", "22:39", "22:46", 2, 4]],
    [["2026-10-25", "01:30", "04:30", 240, 0]],
    [["2026-03-29", "01:30", "04:30", 120, 0]],
  ]);
});
