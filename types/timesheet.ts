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
};
