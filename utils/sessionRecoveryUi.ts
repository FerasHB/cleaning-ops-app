// utils/sessionRecoveryUi.ts
// Reine Anzeige-/Validierungslogik der Admin-Sitzungsprüfung. Bewusst ohne
// React-Native-Import, damit sie isoliert testbar bleibt (gleiches Muster wie
// utils/assignmentWorkUi.ts).
//
// KEINE ABRECHNUNG HIER: diese Datei formatiert und validiert, sie berechnet
// keine Stundenzettel-Minuten. Die Abrechnungswahrheit bleibt
// get_effective_work_sessions + accountSessionAssignment.

import type {
  RecoveryQueueItem,
  SessionCorrectionAudit,
} from "@/services/timesheets/sessionRecovery.service";

export const REDUCE_REASON_MIN = 10;
export const RAISE_REASON_MIN = 30;

export type RecoveryOperation = "reduce" | "raise";

/** "H:mm" aus Sekunden, gleiche Bauform wie formatWorkedSeconds. */
export function formatSeconds(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Vorzeichenbehaftet, damit eine Korrektur als "-17:30" lesbar bleibt. */
export function formatSignedSeconds(seconds: number): string {
  const sign = seconds < 0 ? "-" : seconds > 0 ? "+" : "";
  return `${sign}${formatSeconds(Math.abs(seconds))}`;
}

/**
 * Hat der Mitarbeiter überhaupt ein Arbeitsende erfasst?
 *
 * WARUM NICHT `recordedSeconds > 0` ALS ANZEIGE: der Server liefert für eine
 * nie beendete Sitzung wahrheitsgemäß 0 erfasste Sekunden. "Aufgezeichnet:
 * 0:00" würde aber behaupten, der Mitarbeiter habe null Stunden gearbeitet —
 * tatsächlich hat er nur nicht auf "Beenden" getippt. Beides muss die
 * Oberfläche unterscheiden.
 */
export function hasRecordedEnd(item: Pick<RecoveryQueueItem,
  "openSessionId" | "recordedSeconds">): boolean {
  return item.openSessionId === null && item.recordedSeconds > 0;
}

export type RecoveryPreview = {
  operation: RecoveryOperation;
  /** null, wenn der Mitarbeiter nie ein Ende erfasst hat. */
  recordedSeconds: number | null;
  effectiveSeconds: number;
  /** null, wenn es kein erfasstes Ende gibt, mit dem man vergleichen könnte. */
  correctionSeconds: number | null;
  reasonMin: number;
  reasonOk: boolean;
  endOk: boolean;
  /** Erst true, wenn Zeit UND Grund gültig sind. */
  canSubmit: boolean;
  /** Für die Bestätigung eines raise: der vorherige geprüfte Wert. */
  previousEffectiveSeconds: number | null;
};

/**
 * Live-Vorschau vor der Bestätigung. Der Admin sieht die Abrechnungsfolge in
 * Zahlen, BEVOR er bestätigt — nicht erst danach.
 */
export function buildRecoveryPreview(input: {
  operation: RecoveryOperation;
  sessionStartedAt: string;
  /** Vom Mitarbeiter erfasstes Ende; null, wenn er keines erfasst hat. */
  recordedEndedAt: string | null;
  /** Aktuell wirksames Ende (letzte Korrektur), falls vorhanden. */
  currentEffectiveEndedAt: string | null;
  /** Vom Admin eingegebenes Arbeitsende; null, solange das Feld leer ist. */
  reviewedEndedAt: string | null;
  reason: string;
}): RecoveryPreview {
  const start = Date.parse(input.sessionStartedAt);
  const reviewed = input.reviewedEndedAt ? Date.parse(input.reviewedEndedAt) : NaN;
  const recordedEnd = input.recordedEndedAt ? Date.parse(input.recordedEndedAt) : NaN;
  const currentEnd = input.currentEffectiveEndedAt
    ? Date.parse(input.currentEffectiveEndedAt) : NaN;

  const recordedSeconds = Number.isFinite(recordedEnd) && Number.isFinite(start)
    ? Math.max(0, Math.round((recordedEnd - start) / 1000)) : null;
  const previousEffectiveSeconds = Number.isFinite(currentEnd) && Number.isFinite(start)
    ? Math.max(0, Math.round((currentEnd - start) / 1000)) : null;
  const effectiveSeconds = Number.isFinite(reviewed) && Number.isFinite(start)
    ? Math.max(0, Math.round((reviewed - start) / 1000)) : 0;

  const reasonMin = input.operation === "raise" ? RAISE_REASON_MIN : REDUCE_REASON_MIN;
  const reasonOk = input.reason.trim().length >= reasonMin;
  // Ein leeres Feld ist kein Fehler, nur "noch nicht abschickbar" — der Admin
  // soll den Wert bewusst setzen, nicht einen Vorschlag bestätigen.
  const endOk = Number.isFinite(reviewed) && Number.isFinite(start) && reviewed > start;

  return {
    operation: input.operation,
    recordedSeconds,
    effectiveSeconds,
    correctionSeconds: recordedSeconds === null ? null : effectiveSeconds - recordedSeconds,
    reasonMin,
    reasonOk,
    endOk,
    canSubmit: endOk && reasonOk,
    previousEffectiveSeconds,
  };
}

/** i18n-Schlüssel je Server-Grund; nie der rohe Enum-Wert in der Oberfläche. */
export function reasonCodeKey(code: string): string {
  const known = ["late_pause", "late_complete", "open_session_expired",
    "paused_expired", "review_required"];
  return `timesheets:recovery.reason.${known.includes(code) ? code : "review_required"}`;
}

/**
 * Wie lange ist dieser Einsatz schon ungelöst?
 *
 * ANKER IST `employee_started_at`, NICHT `stuck_since`.
 * `stuck_since` ist `employee_started_at + 12 Stunden` — der Zeitpunkt, ab dem
 * der Mitarbeiter nicht mehr selbst abschließen kann. Gerechnet ab diesem
 * Wert zeigte die Karte für einen 12h16m alten Einsatz "Seit 0 h offen": seit
 * dem Ablauf waren tatsächlich erst 16 Minuten vergangen. Die Beschriftung
 * verspricht aber das Alter der Arbeit, und das beginnt beim Arbeitsbeginn.
 *
 * Reine Epochen-Arithmetik über UTC-Zeitstempel: kein Kalendertag, keine
 * lokale Zeitzone, kein Mitternachtssprung. Die Geräte-Zeitzone kann das
 * Ergebnis deshalb nicht verfälschen.
 */
export function unresolvedSeconds(employeeStartedAt: string | null, now: number): number {
  const since = employeeStartedAt ? Date.parse(employeeStartedAt) : NaN;
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, Math.round((now - since) / 1000));
}

/**
 * Steht die geprüfte Arbeitszeit überhaupt schon fest?
 *
 * Solange eine Sitzung offen ist, hat sie kein wirksames Ende; der Server
 * summiert sie deshalb wahrheitsgemäß mit 0 Sekunden. "Geprüfte Arbeitszeit:
 * 0:00 h" wäre daraus aber die Behauptung, die Prüfung habe null Stunden
 * ergeben — dabei hat noch gar keine Prüfung stattgefunden.
 */
export function hasReviewedDuration(item: Pick<RecoveryQueueItem, "openSessionId">): boolean {
  return item.openSessionId === null;
}

/** Aktive Korrektur je Sitzung = höchste Revision. Append-only Kette. */
export function activeCorrection(
  chain: SessionCorrectionAudit[], sessionId: string,
): SessionCorrectionAudit | null {
  return chain
    .filter((item) => item.workSessionId === sessionId)
    .sort((a, b) => b.revisionNo - a.revisionNo)[0] ?? null;
}

/** War der zuletzt wirksame Stand eine nachträgliche Erhöhung? */
export function wasRaised(chain: SessionCorrectionAudit[], sessionId: string): boolean {
  return activeCorrection(chain, sessionId)?.origin === "admin_raised";
}
