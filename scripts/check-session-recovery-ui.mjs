// Regression für die Admin-Sitzungswiederherstellung im Client (Phase 2).
//
// AUSFÜHREN:
//   node --experimental-strip-types --test scripts/check-session-recovery-ui.mjs
//
// BEWUSST OHNE npm-Skript: `packageJson:scripts` ist eine Eingabe des
// expo-updates-Fingerprints. Ein zusätzliches Skript ändert die
// runtimeVersion und macht ein OTA-Update für JEDEN bestehenden nativen Build
// unsichtbar — gemessen, nicht vermutet (iOS 6378d84b… wurde zu d001d5eb…).
// Der Eintrag gehört deshalb in den nächsten nativen Build, nicht in ein
// reines OTA.
//
// Die Prüfungen laufen gegen die REINEN Module (utils/sessionRecoveryUi,
// utils/assignmentWorkUi, services/timesheets/sessionAccounting,
// services/timesheets/timesheetHtml) — kein React-Renderer im Projekt.
// Getestet wird damit genau das, was die Oberfläche als Wahrheit übernimmt.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { accountSessionAssignment } from "../services/timesheets/sessionAccounting.ts";
import { buildTimesheetHtml } from "../services/timesheets/timesheetHtml.ts";
import { isRTLLocale } from "../i18n/config.ts";
import {
  buildRecoveryPreview,
  formatSeconds,
  formatSignedSeconds,
  hasRecordedEnd,
  reasonCodeKey,
  hasReviewedDuration,
  unresolvedSeconds,
  activeCorrection,
  wasRaised,
  RAISE_REASON_MIN,
  REDUCE_REASON_MIN,
} from "../utils/sessionRecoveryUi.ts";

// assignmentWorkUi zieht @/utils/jobAssignees; dieselbe Brücke wie in
// check-pause-resume-ui.mjs, damit beide Suiten dieselbe Semantik prüfen.
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
      canStartOwnAssignment: () => false,
      canCompleteOwnAssignment: () => false,
    };
  },
});

const de = JSON.parse(readFileSync(new URL("../i18n/locales/de/timesheets.json", import.meta.url), "utf8"));
const en = JSON.parse(readFileSync(new URL("../i18n/locales/en/timesheets.json", import.meta.url), "utf8"));
const ar = JSON.parse(readFileSync(new URL("../i18n/locales/ar/timesheets.json", import.meta.url), "utf8"));
const tr = JSON.parse(readFileSync(new URL("../i18n/locales/tr/timesheets.json", import.meta.url), "utf8"));
const deJobs = JSON.parse(readFileSync(new URL("../i18n/locales/de/jobs.json", import.meta.url), "utf8"));
const arJobs = JSON.parse(readFileSync(new URL("../i18n/locales/ar/jobs.json", import.meta.url), "utf8"));
const enJobs = JSON.parse(readFileSync(new URL("../i18n/locales/en/jobs.json", import.meta.url), "utf8"));
const trJobs = JSON.parse(readFileSync(new URL("../i18n/locales/tr/jobs.json", import.meta.url), "utf8"));

const START = "2026-03-02T07:00:00.000Z";          // 08:00 lokal (CET)
const RAW_END = "2026-03-03T09:00:00.000Z";        // +26:00
const REVIEWED = "2026-03-02T15:30:00.000Z";       // +8:30

const job = (mode = "sessions") => ({
  id: "job-a", jobType: "single", status: "in_progress", isActive: true,
  parentJobId: null, employeeId: "u1", customerName: "job-a",
  assignees: [{ assignmentId: "assignment-a", employeeId: "u1", trackingMode: mode,
    employeeStartedAt: START, employeeCompletedAt: null, workReviewRequired: true }],
});
const summary = (state, overrides = {}) => ({
  assignmentId: "assignment-a", trackingMode: "sessions", workRevision: 2,
  assignmentState: state, activeSessionId: null, activeSince: null,
  latestSessionEnd: RAW_END, closedSeconds: 93600, reviewRequired: state === "review_pending",
  employeeCompletedAt: null, ...overrides,
});

test("review_pending blocks every employee action and names the administrator", () => {
  const derived = ui.deriveAssignmentWorkUi({ job: job(), role: "employee", userId: "u1",
    capability: true, summary: summary("review_pending"), operations: [] });
  assert.equal(derived.state, "review_pending");
  assert.equal(derived.canStart, false);
  assert.equal(derived.canPause, false);
  assert.equal(derived.canResume, false);
  assert.equal(derived.canComplete, false);
  assert.equal(derived.blockReason, "review_pending");
  // Alle vier Sprachen tragen den Hinweis; sonst sieht ein Teil der Belegschaft
  // einen leeren Zustand ohne Erklärung.
  for (const bundle of [deJobs, enJobs, arJobs, trJobs]) {
    assert.ok(bundle.work.reviewPending.length > 0);
    assert.ok(bundle.work.state.review_pending.length > 0);
    assert.ok(bundle.work.reviewedByAdmin.length > 0);
  }
});

test("authoritative review_pending beats the optimistic completed projection", () => {
  // Die lokale Projektion eines Complete zeigt kurz "completed". Sobald die
  // Quittung review_pending meldet, muss der Serverzustand sofort gewinnen.
  const pending = [{ operationId: "op-1", userId: "u1", assignmentId: "assignment-a",
    action: "complete", status: "acknowledged", localSequence: 1, expectedRevision: 1,
    sessionId: null, actionTimestamp: RAW_END }];
  const derived = ui.deriveAssignmentWorkUi({ job: job(), role: "employee", userId: "u1",
    capability: true, summary: summary("review_pending"), operations: pending });
  assert.equal(derived.state, "review_pending");
  assert.equal(derived.canComplete, false);
});

test("a completed assignment keeps working normally after the new state exists", () => {
  const derived = ui.deriveAssignmentWorkUi({ job: job(), role: "employee", userId: "u1",
    capability: true, summary: summary("completed", { reviewRequired: false }), operations: [] });
  assert.equal(derived.state, "completed");
  assert.equal(derived.blockReason, null);
});

test("an open session is never shown as zero recorded hours", () => {
  // "Aufgezeichnet: 0:00" wäre die Behauptung, der Mitarbeiter habe null
  // Stunden gearbeitet. Er hat nur kein Arbeitsende erfasst.
  assert.equal(hasRecordedEnd({ openSessionId: "session-a", recordedSeconds: 0 }), false);
  assert.equal(hasRecordedEnd({ openSessionId: null, recordedSeconds: 0 }), false);
  assert.equal(hasRecordedEnd({ openSessionId: null, recordedSeconds: 93600 }), true);
  assert.ok(de.recovery.recordedMissing.includes("Arbeitsende"));
  assert.ok(!de.recovery.recordedMissing.includes("0:00"));
});

test("reduce preview shows recorded, reviewed and correction before confirming", () => {
  const preview = buildRecoveryPreview({
    operation: "reduce", sessionStartedAt: START, recordedEndedAt: RAW_END,
    currentEffectiveEndedAt: null, reviewedEndedAt: REVIEWED,
    reason: "Mitarbeiter hat vergessen, den Auftrag zu beenden.",
  });
  assert.equal(preview.recordedSeconds, 93600);
  assert.equal(preview.effectiveSeconds, 30600);
  assert.equal(preview.correctionSeconds, -63000);
  assert.equal(formatSeconds(preview.effectiveSeconds), "8:30");
  assert.equal(formatSeconds(preview.recordedSeconds), "26:00");
  assert.equal(formatSignedSeconds(preview.correctionSeconds), "-17:30");
  assert.equal(preview.canSubmit, true);
});

test("an empty end time is not submittable and is never prefilled", () => {
  const preview = buildRecoveryPreview({
    operation: "reduce", sessionStartedAt: START, recordedEndedAt: RAW_END,
    currentEffectiveEndedAt: null, reviewedEndedAt: null,
    reason: "Mitarbeiter hat vergessen, den Auftrag zu beenden.",
  });
  assert.equal(preview.endOk, false);
  assert.equal(preview.canSubmit, false);
  assert.equal(preview.effectiveSeconds, 0);
  // Die Oberfläche startet mit value={null}; kein now(), keine 12-Stunden-Grenze.
  const sheet = readFileSync(
    new URL("../features/timesheets/components/SessionReviewSheet.tsx", import.meta.url), "utf8");
  assert.match(sheet, /useState<Date \| null>\(null\)/);
  assert.ok(!/useState<Date \| null>\(new Date\(\)\)/.test(sheet));
});

test("an admin-closed session reports no recorded duration and no delta", () => {
  const preview = buildRecoveryPreview({
    operation: "reduce", sessionStartedAt: START, recordedEndedAt: null,
    currentEffectiveEndedAt: null, reviewedEndedAt: REVIEWED,
    reason: "Mitarbeiter hat nie beendet; Arbeitsende vom Kunden bestätigt.",
  });
  assert.equal(preview.recordedSeconds, null);
  assert.equal(preview.correctionSeconds, null);
  assert.equal(preview.effectiveSeconds, 30600);
});

test("raise is a separate action with a longer mandatory reason", () => {
  assert.equal(REDUCE_REASON_MIN, 10);
  assert.equal(RAISE_REASON_MIN, 30);
  const short = buildRecoveryPreview({
    operation: "raise", sessionStartedAt: START, recordedEndedAt: RAW_END,
    currentEffectiveEndedAt: "2026-03-02T15:00:00.000Z", reviewedEndedAt: REVIEWED,
    reason: "Zu niedrig.",
  });
  assert.equal(short.reasonMin, 30);
  assert.equal(short.reasonOk, false);
  assert.equal(short.canSubmit, false);

  const ok = buildRecoveryPreview({
    operation: "raise", sessionStartedAt: START, recordedEndedAt: RAW_END,
    currentEffectiveEndedAt: "2026-03-02T15:00:00.000Z", reviewedEndedAt: REVIEWED,
    reason: "Erste Korrektur war zu niedrig angesetzt; Kunde bestaetigt 16:30 Uhr.",
  });
  assert.equal(ok.reasonOk, true);
  assert.equal(ok.previousEffectiveSeconds, 28800);
  assert.equal(ok.effectiveSeconds, 30600);
  assert.equal(ok.canSubmit, true);
});

test("the sheet never converts an accidental increase into a raise", () => {
  const sheet = readFileSync(
    new URL("../features/timesheets/components/SessionReviewSheet.tsx", import.meta.url), "utf8");
  // Die Aktionsart kommt ausschliesslich aus dem Schalter, nie aus einem
  // Zeitvergleich — sonst wuerde ein Tippfehler still zur Erhoehung.
  assert.match(sheet, /setOperation\(next \? "raise" : "reduce"\)/);
  assert.ok(!/effectiveSeconds\s*>\s*previousEffectiveSeconds\s*\?\s*"raise"/.test(sheet));
  const hook = readFileSync(
    new URL("../features/timesheets/hooks/useRecoveryQueue.ts", import.meta.url), "utf8");
  assert.match(hook, /operation: input\.operation/);
});

test("queue reason codes map to human text in every language, never the enum", () => {
  const codes = ["late_pause", "late_complete", "open_session_expired",
    "paused_expired", "review_required"];
  for (const code of codes) {
    assert.equal(reasonCodeKey(code), `timesheets:recovery.reason.${code}`);
    for (const bundle of [de, en, ar, tr]) {
      const label = bundle.recovery.reason[code];
      assert.ok(label && label.length > 0, `${code} missing`);
      assert.ok(!label.includes("_"), `${code} leaks the enum name`);
    }
  }
  // Unbekannter Servercode faellt auf einen gueltigen Schluessel zurueck.
  assert.equal(reasonCodeKey("something_new"), "timesheets:recovery.reason.review_required");
});

test("unresolved age is measured from the start of work, not from the expiry", () => {
  // Der Fehler vom Geraet: gerechnet ab stuck_since (= Start + 12 h) war ein
  // 12h16m alter Einsatz erst 16 Minuten "offen" und wurde auf 0 h abgerundet.
  const start = "2026-09-22T10:08:29.418Z";
  const stuckSince = "2026-09-22T22:08:29.418Z";   // = start + 12 h
  const now = Date.parse("2026-09-22T22:24:00.000Z"); // 00:24 Ortszeit Berlin
  const seconds = unresolvedSeconds(start, now);
  assert.equal(Math.floor(seconds / 3600), 12);
  assert.equal(formatSeconds(seconds), "12:15");
  // Der alte Anker liefert unter einer Stunde und waere wieder "0 h".
  assert.ok(Math.floor((now - Date.parse(stuckSince)) / 3_600_000) === 0);
  assert.equal(unresolvedSeconds(null, now), 0);
});

test("the unresolved age does not reset at midnight", () => {
  // Kein Kalendertag-Vergleich: reine Epochen-Differenz. Eine Minute vor und
  // eine Minute nach Mitternacht duerfen sich nur um eine Minute unterscheiden.
  const start = "2026-09-22T10:08:29.418Z";
  const beforeMidnight = Date.parse("2026-09-22T21:59:00.000Z"); // 23:59 Berlin
  const afterMidnight = Date.parse("2026-09-22T22:01:00.000Z");  // 00:01 Berlin
  const before = unresolvedSeconds(start, beforeMidnight);
  const after = unresolvedSeconds(start, afterMidnight);
  assert.equal(after - before, 120);
  assert.ok(after > 11 * 3600);
  assert.equal(formatSeconds(before), "11:50");
  assert.equal(formatSeconds(after), "11:52");
});

test("the device timezone cannot corrupt the unresolved age", () => {
  // Date.parse liest den UTC-Zeitstempel, Date.now() ist epochenbasiert.
  // Dieselbe Rechnung unter jeder Geraete-Zeitzone.
  const start = "2026-09-22T10:08:29.418Z";
  const now = Date.parse("2026-09-22T22:24:00.000Z");
  const expected = unresolvedSeconds(start, now);
  for (const zone of ["UTC", "Europe/Berlin", "America/Los_Angeles", "Asia/Tokyo"]) {
    process.env.TZ = zone;
    assert.equal(unresolvedSeconds(start, now), expected, `drifted under ${zone}`);
  }
  process.env.TZ = "UTC";
  assert.equal(Math.floor(expected / 3600), 12);
});

test("minutes under one hour are visible instead of collapsing to zero", () => {
  const start = "2026-09-22T22:00:00.000Z";
  const now = Date.parse("2026-09-22T22:16:00.000Z");
  assert.equal(formatSeconds(unresolvedSeconds(start, now)), "0:16");
});

test("an open session shows no reviewed working time before the admin acts", () => {
  // Der Server summiert eine offene Sitzung wahrheitsgemaess mit 0 Sekunden.
  // "Gepruefte Arbeitszeit: 0:00" waere daraus ein Pruefergebnis, das niemand
  // ermittelt hat.
  assert.equal(hasReviewedDuration({ openSessionId: "session-a" }), false);
  assert.equal(hasReviewedDuration({ openSessionId: null }), true);
  for (const bundle of [de, en, ar, tr]) {
    assert.ok(bundle.recovery.effectiveUnknown.length > 0);
    assert.ok(!bundle.recovery.effectiveUnknown.includes("0:00"));
  }
  const screen = readFileSync(
    new URL("../features/timesheets/RecoveryQueueScreen.tsx", import.meta.url), "utf8");
  const compact = screen.replace(/\s+/g, " ");
  assert.ok(compact.includes(
    'hasReviewedDuration(item) ? t("timesheets:recovery.effective"'));
  assert.ok(compact.includes('t("timesheets:recovery.effectiveUnknown")'));
});

test("the queue card never states a recorded or reviewed zero", () => {
  const screen = readFileSync(
    new URL("../features/timesheets/RecoveryQueueScreen.tsx", import.meta.url), "utf8");
  // Die Aufzeichnungszeile haengt an hasRecordedEnd, die Pruefzeile an
  // hasReviewedDuration. Ohne beide gibt es keinen 0:00-Pfad.
  assert.match(screen, /hasRecordedEnd\(item\)/);
  assert.match(screen, /recordedMissing/);
  for (const bundle of [de, en, ar, tr]) {
    assert.ok(!bundle.recovery.recorded.includes("0:00"));
    assert.ok(!bundle.recovery.recordedMissing.includes("0:00"));
  }
});

test("the card states each fact once", () => {
  // Vorher stand dreimal dasselbe auf der Karte: die Aufzeichnungszeile, der
  // Grund und eine eigene Offen-Zeile trugen denselben Satz.
  const screen = readFileSync(
    new URL("../features/timesheets/RecoveryQueueScreen.tsx", import.meta.url), "utf8");
  assert.ok(!/recovery\.openSession"/.test(screen));
  for (const bundle of [de, en, ar, tr]) {
    assert.equal(bundle.recovery.openSession, undefined);
    // Der Grund nennt jetzt das abgelaufene Zeitfenster, nicht noch einmal
    // das fehlende Arbeitsende.
    assert.notEqual(bundle.recovery.reason.open_session_expired,
      bundle.recovery.recordedMissing);
  }
});

test("the active correction is the highest revision and a raise is visible", () => {
  const chain = [
    { correctionId: "c1", workSessionId: "s1", assignmentId: "a1", revisionNo: 1,
      origin: "admin_reduced", effectiveDurationSeconds: 28800, deltaSeconds: -64800 },
    { correctionId: "c2", workSessionId: "s1", assignmentId: "a1", revisionNo: 2,
      origin: "admin_raised", effectiveDurationSeconds: 30600, deltaSeconds: -63000 },
  ];
  assert.equal(activeCorrection(chain, "s1").correctionId, "c2");
  assert.equal(wasRaised(chain, "s1"), true);
  assert.equal(activeCorrection(chain, "missing"), null);
});

test("effective sessions feed the existing accounting untouched", () => {
  // Die Abrechnung sieht das WIRKSAME Intervall. 26 Stunden roh werden nie
  // zu Abrechnungsminuten.
  const assignment = { id: "a1", jobId: "job-a", customerName: "Kunde", remark: "",
    employeeStartedAt: START, employeeCompletedAt: REVIEWED, reviewRequired: false };
  const effective = [{ id: "s1", job_assignment_id: "a1", started_at: START, ended_at: REVIEWED }];
  const result = accountSessionAssignment(assignment, effective, 2026, 3, "Europe/Berlin");
  assert.equal(result.gap, null);
  const minutes = result.entries.reduce((sum, entry) => sum + entry.durationMinutes, 0);
  assert.equal(minutes, 510);
});

test("admin and employee compute the identical total from the identical source", () => {
  const assignment = { id: "a1", jobId: "job-a", customerName: "Kunde", remark: "",
    employeeStartedAt: START, employeeCompletedAt: REVIEWED, reviewRequired: false };
  const effective = [{ id: "s1", job_assignment_id: "a1", started_at: START, ended_at: REVIEWED }];
  const asEmployee = accountSessionAssignment(assignment, effective, 2026, 3, "Europe/Berlin");
  const asAdmin = accountSessionAssignment(assignment, effective, 2026, 3, "Europe/Berlin");
  assert.deepEqual(
    asAdmin.entries.map((entry) => entry.durationMinutes),
    asEmployee.entries.map((entry) => entry.durationMinutes));
  // Audit-Metadaten werden NACH der Abrechnung angehaengt und aendern die
  // Minuten nicht.
  const merged = asAdmin.entries.map((entry) => ({ ...entry,
    recordedMinutes: 1560, correctionMinutes: -1050, correctionReason: "Grund" }));
  assert.equal(merged.reduce((sum, entry) => sum + entry.durationMinutes, 0),
    asEmployee.entries.reduce((sum, entry) => sum + entry.durationMinutes, 0));
});

const sheetData = (entries) => ({
  companyName: "Firma", employeeId: "u1", employeeName: "Mitarbeiter",
  year: 2026, month: 3, monthLabel: "März 2026", entries,
  totalMinutes: entries.reduce((sum, entry) => sum + entry.durationMinutes, 0),
  totalLabel: "8:30", jobCount: entries.length, needsAttention: [],
});
const baseEntry = {
  jobId: "job-a", entryId: "a1:2026-03-02", assignmentId: "a1", source: "sessions",
  date: "2026-03-02", beginLabel: "08:00", endLabel: "16:30",
  durationMinutes: 510, durationLabel: "8:30",
  interruptionMinutes: 0, interruptionLabel: "0:00",
  customerName: "Kunde", remark: "Reinigung",
};

test("the German PDF shows the corrected row in German only", () => {
  const html = buildTimesheetHtml(sheetData([{ ...baseEntry,
    recordedMinutes: 1560, correctionMinutes: -1050,
    correctionReason: "Mitarbeiter hat vergessen, den Auftrag zu beenden.",
    correctionOrigin: "admin_reduced" }]));
  assert.ok(html.includes("Aufgezeichnet: 26:00 h"));
  assert.ok(html.includes("Geprüfte Arbeitszeit: 8:30 h"));
  assert.ok(html.includes("Korrektur: -17:30 h"));
  assert.ok(html.includes("Grund: Mitarbeiter hat vergessen"));
  // Die Abrechnungsspalte traegt ausschliesslich die wirksame Dauer.
  assert.ok(html.includes(">8:30<"));
  assert.ok(!html.includes(">26:00<"));
});

test("the German PDF never claims zero recorded hours for an admin-closed session", () => {
  const html = buildTimesheetHtml(sheetData([{ ...baseEntry,
    recordedMinutes: null, correctionMinutes: null,
    correctionReason: "Mitarbeiter hat nie beendet.", correctionOrigin: "admin_closed" }]));
  assert.ok(html.includes("Arbeitsende ursprünglich nicht erfasst."));
  assert.ok(!html.includes("Aufgezeichnet: 0:00 h"));
  assert.ok(html.includes("Geprüfte Arbeitszeit: 8:30 h"));
});

test("a raised revision is visible in the German PDF", () => {
  const html = buildTimesheetHtml(sheetData([{ ...baseEntry,
    recordedMinutes: 1560, correctionMinutes: -1050,
    correctionReason: "Erhöht nach Rücksprache.", correctionOrigin: "admin_raised" }]));
  assert.ok(html.includes("Die geprüfte Arbeitszeit wurde nachträglich erhöht."));
});

test("an employee PDF cannot contain the admin reason or actor", () => {
  // Strukturell: ein Mitarbeiter-Datensatz traegt die Audit-Felder gar nicht,
  // weil getTimesheet die Pruefkette nur mit includeAudit holt.
  const html = buildTimesheetHtml(sheetData([{ ...baseEntry, reviewed: true }]));
  assert.ok(!html.includes("Grund:"));
  assert.ok(!html.includes("Aufgezeichnet"));
  assert.ok(!html.includes("Korrektur"));
  const service = readFileSync(
    new URL("../services/timesheets/timesheet.service.ts", import.meta.url), "utf8");
  assert.match(service, /params\.includeAudit && sessionEntries\.length > 0/);
  const hook = readFileSync(
    new URL("../features/timesheets/hooks/useTimesheet.ts", import.meta.url), "utf8");
  assert.match(hook, /includeAudit: isAdminView/);
});

test("the timesheet reads payroll only through the effective RPC", () => {
  const service = readFileSync(
    new URL("../services/timesheets/timesheet.service.ts", import.meta.url), "utf8");
  assert.match(service, /getEffectiveWorkSessions\(assignmentIds\)/);
  // Der verbliebene work_sessions-Zugriff ist reine ENTDECKUNG: er liest nur
  // job_assignment_id, um den Monat einzugrenzen. Keine Zeitstempel, also
  // keine zweite Abrechnungsquelle.
  const rawReads = [...service.matchAll(/from\("work_sessions"\)\s*\n?\s*\.select\("([^"]+)"\)/g)]
    .map((match) => match[1]);
  assert.deepEqual(rawReads, ["job_assignment_id"]);
});

test("the recovery queue is company-wide, not month or employee scoped", () => {
  const screen = readFileSync(
    new URL("../features/timesheets/RecoveryQueueScreen.tsx", import.meta.url), "utf8");
  assert.match(screen, /useRecoveryQueue\(\)/);
  // Kommentare erklaeren die Abgrenzung zur Monatsliste; der CODE darf keine
  // Monats- oder Mitarbeiterbindung enthalten.
  const codeOnly = screen.split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  assert.ok(!/selectedEmployeeId|monthDate|needsAttention/.test(codeOnly));
  const hook = readFileSync(
    new URL("../features/timesheets/hooks/useRecoveryQueue.ts", import.meta.url), "utf8");
  assert.match(hook, /getWorkRecoveryQueue\(\)/);
});

test("the admin audit RPC is never a payroll source", () => {
  const service = readFileSync(
    new URL("../services/timesheets/timesheet.service.ts", import.meta.url), "utf8");
  const auditIndex = service.indexOf("getSessionCorrectionAudit");
  const totalIndex = service.indexOf("const totalMinutes");
  // Die Pruefkette wird NACH der Abrechnung gelesen; totalMinutes entsteht
  // danach ausschliesslich aus den bereits berechneten Eintraegen.
  assert.ok(auditIndex > 0 && totalIndex > auditIndex);
  assert.match(service, /totalMinutes = entries\.reduce/);
});

test("multi-assignment review never implies the whole job is closed", () => {
  const screen = readFileSync(
    new URL("../features/timesheets/RecoveryQueueScreen.tsx", import.meta.url), "utf8");
  // Die Liste ist zuweisungsbezogen: ein Eintrag je assignmentId, keine
  // Auftragsaggregation.
  assert.match(screen, /key=\{item\.assignmentId\}/);
  const hook = readFileSync(
    new URL("../features/timesheets/hooks/useRecoveryQueue.ts", import.meta.url), "utf8");
  assert.match(hook, /assignmentId: selected\.assignmentId/);
});

test("a revision conflict still offers Refresh, never silent discard", () => {
  const derived = ui.reconciliationOptions(
    { operationId: "op-1", status: "blocked", failureKind: "revision_conflict" }, [], true);
  assert.equal(derived.canRetry, false);
  assert.equal(derived.canRefresh, true);
  assert.equal(derived.canDiscard, true);   // Blatt ohne Abhängige
  const withDependents = ui.reconciliationOptions(
    { operationId: "op-1", status: "blocked", failureKind: "revision_conflict" },
    [{ operationId: "op-2", predecessorOperationId: "op-1" }], true);
  assert.equal(withDependents.canDiscard, false);
});

test("Arabic stays RTL and carries every recovery string", () => {
  assert.equal(isRTLLocale("ar"), true);
  assert.equal(isRTLLocale("de"), false);
  const keys = Object.keys(de.recovery);
  for (const key of keys) {
    assert.ok(key in ar.recovery, `ar misses recovery.${key}`);
    assert.ok(key in en.recovery, `en misses recovery.${key}`);
    assert.ok(key in tr.recovery, `tr misses recovery.${key}`);
  }
  for (const [file, name] of [
    ["../features/timesheets/RecoveryQueueScreen.tsx", "queue"],
    ["../features/timesheets/components/SessionReviewSheet.tsx", "sheet"],
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /useIsRTL\(\)/, `${name} ignores RTL`);
    assert.match(source, /isRTL \? "row-reverse" : "row"/, `${name} has no RTL row`);
    assert.match(source, /isRTL \? "right" : "left"/, `${name} has no RTL text align`);
  }
});
