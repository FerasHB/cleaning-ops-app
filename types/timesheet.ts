// types/timesheet.ts
// Typen für den Stundenzettel / Arbeitszeitnachweis (PDF-Export).
// Quelle ist ausschließlich die jobs-Tabelle (abgeschlossene Aufträge) — es gibt
// keine eigene Timesheet-Tabelle. Aggregation passiert clientseitig.

/**
 * Eine Zeile im Stundenzettel = ein abgeschlossener Job.
 * Mehrere Jobs am selben Tag ergeben mehrere Einträge (mehrere Zeilen).
 */
export type TimesheetEntry = {
  jobId: string;
  /** Lokaler Arbeitstag "YYYY-MM-DD", abgeleitet aus started_at. */
  date: string;
  /** Beginn als lokale Uhrzeit "HH:mm" (started_at). */
  beginLabel: string;
  /** Ende als lokale Uhrzeit "HH:mm" (completed_at). */
  endLabel: string;
  /** Dauer in Minuten (completed_at − started_at, ≥ 0). */
  durationMinutes: number;
  /** Dauer formatiert als "H:mm". */
  durationLabel: string;
  /** Auftrag/Kunde (customer_name). */
  customerName: string;
  /** Bemerkung: Service ggf. mit Ort (service_name · location_address). */
  remark: string;
};

/**
 * Warum eine Zuweisung KEINEN abrechenbaren Eintrag erzeugt.
 * Reine Klassifizierung der vorhandenen Zeitstempel — keine Bewertung.
 */
export type TimesheetGapReason = "no_time" | "start_only" | "end_only";

/**
 * Eine Zuweisung, die im gewählten Monat KEINEN Stundenzettel-Eintrag ergibt,
 * obwohl der Auftrag abgeschlossen ist (Phase B1).
 *
 * WARUM ES DIESEN TYP GIBT: `mapEntry` verwirft solche Zeilen bewusst (siehe
 * timesheet.service.ts) — der Mitarbeiter verschwindet dadurch komplett aus
 * dem Stundenzettel, ohne dass der Admin merkt, dass etwas fehlt. Genau diese
 * verworfenen Zeilen werden hier sichtbar gemacht, damit sie korrigiert
 * werden können.
 *
 * WICHTIG: `sharedStartedAt`/`sharedCompletedAt` sind die GETEILTE Auftragszeit
 * und ausschließlich ein VORSCHLAG für die Korrektur. Sie sind NICHT die
 * Arbeitszeit dieses Mitarbeiters und dürfen nirgends als solche angezeigt
 * oder summiert werden.
 */
export type TimesheetGap = {
  /** PK der job_assignments-Zeile — Eingabe für admin_correct_assignment_time. */
  assignmentId: string;
  employeeId: string;
  employeeName: string;
  jobId: string;
  customerName: string;
  /** Service ggf. mit Ort — gleiche Bauform wie TimesheetEntry.remark. */
  remark: string;
  /** Arbeitstag "YYYY-MM-DD", abgeleitet aus der GETEILTEN Startzeit. */
  date: string;
  /** Aktuell erfasste Eigenzeit (mindestens eine davon ist null). */
  employeeStartedAt: string | null;
  employeeCompletedAt: string | null;
  /** Geteilte Auftragszeit — NUR Korrektur-Vorschlag, nie Arbeitszeit. */
  sharedStartedAt: string;
  sharedCompletedAt: string;
  reason: TimesheetGapReason;
  /** Lesbare Kurzbeschreibung des Problems (deutsch). */
  reasonLabel: string;
};

/**
 * Vollständiger Stundenzettel für einen Mitarbeiter + Monat.
 * Wird aus den Einträgen im Hook zusammengesetzt und an den PDF-Builder übergeben.
 */
export type TimesheetData = {
  companyName: string;
  employeeId: string;
  employeeName: string;
  /** Jahr, z.B. 2026. */
  year: number;
  /** Monat 1–12. */
  month: number;
  /** Anzeige z.B. "Juni 2026". */
  monthLabel: string;
  entries: TimesheetEntry[];
  /** Summe aller Dauern in Minuten. */
  totalMinutes: number;
  /** Summe formatiert als "H:mm". */
  totalLabel: string;
  /** Anzahl abgeschlossener Jobs (= Anzahl Einträge). */
  jobCount: number;
  /**
   * Zuweisungen im Zeitraum, die KEINEN Eintrag erzeugen konnten (Phase B1).
   * Fließen bewusst NICHT in `entries`, `totalMinutes` oder den PDF-Export ein —
   * sie sind nicht abrechenbar, solange sie nicht korrigiert wurden.
   */
  needsAttention: TimesheetGap[];
};
