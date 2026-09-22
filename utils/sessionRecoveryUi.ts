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

/** Ganze Stunden seit `stuckSince`; die Warteschlange sortiert nach Alter. */
export function stuckHours(stuckSince: string | null, now: number): number {
  const since = stuckSince ? Date.parse(stuckSince) : NaN;
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, Math.floor((now - since) / 3_600_000));
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
