// types/timesheetAbsence.ts
// Phase E — Stundenzettel-Abwesenheiten: additive Typen. Ergänzen TimesheetData
// (types/timesheet.ts) um Urlaub/Krankheit, ohne dessen bestehende Felder
// (entries/totalMinutes/needsAttention) anzufassen.
//
// WICHTIG (siehe CLAUDE.md-Grundsatz + Architektur-Audit Phase E): dies ist
// eine rein OPERATIVE Klassifizierung für die Stundenzettel-Anzeige. Eine
// gemeldete Krankheit (status=reported) ist KEIN medizinischer Nachweis und
// stellt keinen Urlaubsanspruch wieder her — siehe resolveEffectiveAbsenceDays.

/**
 * Ein Kalendertag, an dem für einen Mitarbeiter genau EINE Abwesenheitsart
 * "wirksam" ist (Krank > Urlaub bei Überschneidung, siehe
 * utils/resolveEffectiveAbsenceDays.ts). Reine Ableitung — die zugrunde
 * liegenden employee_absences-Zeilen werden dabei nie verändert.
 */
export type EffectiveAbsenceDay = {
  /** "YYYY-MM-DD", lokal */
  date: string;
  type: "vacation" | "sickness";
  /** IDs der employee_absences-Zeilen, aus denen dieser Tag resultiert (>1 bei überlappenden Zeilen gleichen Typs). */
  sourceAbsenceIds: string[];
};

/**
 * Ein effektiver Abwesenheitstag angereichert um die geplante Einsatzzeit
 * (Summe von jobs.planned_duration_minutes der an diesem Tag zugewiesenen
 * Occurrences, NIE aus tatsächlicher Arbeitszeit oder scheduled_end
 * abgeleitet — siehe services/timesheets/timesheetAbsence.service.ts).
 */
export type TimesheetAbsenceDay = EffectiveAbsenceDay & {
  /** Summe der geplanten Minuten zugewiesener Occurrences an diesem Tag (0 = keine geplant, oder alle ohne Dauer). */
  plannedMinutes: number;
  /** true, wenn an diesem Tag mindestens eine zugewiesene Occurrence mit geplanter Dauer existiert. */
  hasPlannedWork: boolean;
};

/**
 * Zusammenfassung für einen Mitarbeiter/Monat. Trennt bewusst:
 *   * Kalendertage   — reine Abwesenheits-Kalendertage (KEINE Urlaubskonto-Aussage).
 *   * PlannedWorkDays — Tage mit tatsächlich geplanten Einsätzen an diesem Tag.
 *   * PlannedMinutes  — die daraus resultierende geplante Einsatzzeit.
 * Niemals als "Arbeitszeit"/"Bezahlte Zeit" beschriften — siehe UI-Komponente.
 */
export type TimesheetAbsenceSummary = {
  vacationCalendarDays: number;
  sicknessCalendarDays: number;

  vacationPlannedWorkDays: number;
  sicknessPlannedWorkDays: number;

  vacationPlannedMinutes: number;
  sicknessPlannedMinutes: number;

  days: TimesheetAbsenceDay[];
};

/**
 * Informativer Hinweis, KEIN Korrektur-Datensatz (siehe TimesheetGap in
 * types/timesheet.ts — bewusst getrennt, damit needsAttention semantisch
 * sauber "erfordert eine Korrektur-Aktion" bedeutet).
 */
export type TimesheetNotice = {
  type: "work_during_absence";
  /** "YYYY-MM-DD" — der Tag, an dem sowohl ein tatsächlicher Eintrag als auch eine wirksame Abwesenheit vorliegen. */
  date: string;
  absenceType: "vacation" | "sickness";
};
