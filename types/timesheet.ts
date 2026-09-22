// types/timesheet.ts
// Typen für den Stundenzettel / Arbeitszeitnachweis (PDF-Export).
// Legacy-Zeit kommt aus Zuweisungs-/Auftragszeitstempeln, Session-Zeit aus
// geschlossenen work_sessions. Es gibt keine eigene Timesheet-Tabelle.

import type { TimesheetAbsenceSummary, TimesheetNotice } from "@/types/timesheetAbsence";

/**
 * Eine Zeile im Stundenzettel = ein abgeschlossener Job.
 * Mehrere Jobs am selben Tag ergeben mehrere Einträge (mehrere Zeilen).
 */
export type TimesheetEntry = {
  jobId: string;
  /** Session-Tageszeilen brauchen einen stabilen Schlüssel jenseits der Job-ID. */
  entryId?: string;
  assignmentId?: string;
  source?: "legacy" | "sessions";
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
  /** Nur Session-Modus: Lücken zwischen tatsächlichen Arbeitsintervallen. */
  interruptionMinutes?: number;
  interruptionLabel?: string;
  /** Bekannte Ist-Zeit, die vor einer Abrechnung geprüft werden muss. */
  reviewRequired?: boolean;
  /**
   * Neutraler Marker: eine Admin-Korrektur wirkt auf diese Zeile. Trägt
   * bewusst KEINEN Grund und KEINEN Akteur und geht deshalb auch an
   * Mitarbeitende.
   */
  reviewed?: boolean;
  /**
   * ANZEIGE-METADATEN, NUR ADMIN (Migration 20260922000000).
   *
   * Sie werden ERST NACH der Abrechnung angehängt und verändern
   * `durationMinutes`/`totalMinutes` niemals — `durationMinutes` ist und bleibt
   * die wirksame Arbeitszeit aus get_effective_work_sessions.
   *
   * `recordedMinutes` ist NULL, wenn der Mitarbeiter nie ein Arbeitsende
   * erfasst hat; "0" würde behaupten, er habe null Stunden gearbeitet.
   * `correctionMinutes` ist dann ebenfalls NULL — ohne erfasstes Ende gibt es
   * keine Differenz.
   *
   * In einem Mitarbeiter-Stundenzettel sind diese Felder nicht vorhanden. Das
   * ist strukturell, nicht nur ungerendert: der Admin-Grund erreicht den
   * Mitarbeiter-PDF-Export dadurch auch bei einem künftigen Render-Fehler nicht.
   */
  recordedMinutes?: number | null;
  correctionMinutes?: number | null;
  correctionReason?: string;
  correctionOrigin?: "admin_reduced" | "admin_closed" | "admin_raised";
  /** Auftrag/Kunde (customer_name). */
  customerName: string;
  /** Bemerkung: Service ggf. mit Ort (service_name · location_address). */
  remark: string;
};

/**
 * Warum eine Zuweisung keine saubere, ungeprüfte Abrechnungszeit liefert.
 * Eine Session-Review-Lücke kann parallel zu einer bekannten Ist-Zeit stehen.
 */
export type TimesheetGapReason = "no_time" | "start_only" | "end_only" |
  "session_missing" | "session_invalid" | "session_review";

/**
 * Eine Legacy-Zuweisung ohne Eintrag oder eine Session-Zuweisung mit
 * Aufzeichnungslücke beziehungsweise noch ungeprüfter Ist-Zeit.
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
  /** PK der job_assignments-Zeile; nur bei Legacy korrigierbar. */
  assignmentId: string;
  source?: "legacy" | "sessions";
  knownDurationMinutes?: number;
  employeeId: string;
  employeeName: string;
  jobId: string;
  customerName: string;
  /** Service ggf. mit Ort — gleiche Bauform wie TimesheetEntry.remark. */
  remark: string;
  /** Berichtstag "YYYY-MM-DD". */
  date: string;
  /** Assignment-Lifecycle-Zeit, nicht Session-Arbeitszeit. */
  employeeStartedAt: string | null;
  employeeCompletedAt: string | null;
  /** Geteilte Auftragszeit — NUR Korrektur-Vorschlag, nie Arbeitszeit. */
  sharedStartedAt: string | null;
  sharedCompletedAt: string | null;
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

  /**
   * Abwesenheits-Zusammenfassung (Urlaub/Krankheit) für denselben Zeitraum
   * (Phase E). ADDITIV — beeinflusst `entries`/`totalMinutes` nicht. Optional,
   * damit ältere Aufrufer/Tests ohne dieses Feld weiter kompilieren.
   */
  absenceSummary?: TimesheetAbsenceSummary;

  /**
   * Informative Hinweise (z. B. "Arbeit trotz Abwesenheit"), bewusst GETRENNT
   * von `needsAttention` — keine Korrektur-Aktion, kein Eingriff in die
   * Ist-Zeit-Berechnung (Phase E).
   */
  notices?: TimesheetNotice[];
};
