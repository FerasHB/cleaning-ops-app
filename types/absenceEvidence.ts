// types/absenceEvidence.ts
// ─────────────────────────────────────────────────────────────────
// AU-Nachweis zu einer Krankmeldung.
//
// BEWUSST getrennt von Absence.status: die Krankmeldung bleibt
// reported/cancelled, die ärztliche Bestätigung ist ein eigener Vorgang mit
// eigenem Akteur und Zeitpunkt.
//
// KERNREGEL: nur `confirmed` berechtigt zu einer Urlaubs-Rückgabe. Eine
// blosse Krankmeldung nie.
// ─────────────────────────────────────────────────────────────────

export type AuEvidenceStatus = "pending" | "confirmed" | "rejected";

export const AU_STATUS_LABELS: Record<AuEvidenceStatus, string> = {
  pending: "AU offen",
  confirmed: "AU bestätigt",
  rejected: "AU abgelehnt",
};

/** Kein Nachweis vorhanden = noch gar nicht geprüft. */
export const AU_NOT_REVIEWED_LABEL = "Nicht geprüft";

export type AbsenceEvidence = {
  id: string;
  absenceId: string;
  status: AuEvidenceStatus;
  confirmedBy: string | null;
  confirmedAt: string | null;
  note: string | null;
};

/**
 * Ein rückgabefähiger Posten: ein genehmigter Urlaub in einem Urlaubsjahr,
 * dessen Abzug sich mit der bestätigten AU überschneidet.
 *
 * `fullCoverage` sagt, ob die AU den GESAMTEN Urlaub abdeckt. Nur dann ist
 * die Rückgabemenge eindeutig und darf vorbelegt werden — bei einer
 * Teilüberschneidung ist unbekannt, wie viele der abgezogenen Tage in den
 * AU-Zeitraum fallen (der Abzug ist ein Jahres-Aggregat ohne Tagesbezug).
 */
export type AuRestorationCandidate = {
  vacationAbsenceId: string;
  vacationStart: string;
  vacationEnd: string;
  year: number;
  deductedDays: number;
  alreadyRestored: number;
  restorableDays: number;
  overlapStart: string;
  overlapEnd: string;
  fullCoverage: boolean;
};

/** Ein vom Admin bestätigter Rückgabe-Posten. */
export type AuRestorationInput = {
  vacation_absence_id: string;
  year: number;
  days: number;
};
