// utils/recurringOccurrencePreview.ts
// Phase D — spiegelt die Horizont-/Wochentag-Logik der SQL-Funktion
// generate_job_occurrences client-seitig, um VOR dem Speichern zu wissen,
// welche Termine der Server gleich materialisieren wird (für die
// Abwesenheits-Konflikt-Vorschau bei Recurring-Jobs, Create UND Edit).
//
// Verifizierte Quelle (nicht angenommen, direkt im SQL gelesen):
// supabase/migrations/20260813000000_planned_duration_foundation.sql,
// Funktion generate_job_occurrences — die aktuell gültige Fassung
// (unveraendert gegenueber 20260728000000_occurrence_assignment_inheritance.sql
// bis auf die dort NICHT relevante planned_duration_minutes-Spalte).
//
//   generation_start := greatest(
//     coalesce(recurrence_start_date, current_date),
//     current_date
//   );
//   hard_limit := generation_start + interval '730 days';
//   generation_end := least(
//     coalesce(recurrence_end_date, generation_start + interval '3 months'),
//     hard_limit
//   );
//   -- Schleife check_date von generation_start bis generation_end (inklusiv,
//   -- <=), Wochentag über isodow (Mo=1…So=7) gegen recurring_days geprüft.
//
// Diese Funktion ruft die RPC NICHT auf — reine Terminvorschau aus den
// AKTUELLEN Formularwerten, damit Edit (wo bereits materialisierte
// Occurrences existieren können, die den ungespeicherten Formularstand aber
// noch nicht widerspiegeln) genau wie Create funktioniert.

import { keyToDate } from "@/utils/calendarMonth";
import { formatDateISO } from "@/utils/date";
import { getWeekdayKey, type WeekdayKey } from "@/utils/recurrence";

// Bounded wie die Server-Funktion — verhindert eine unbegrenzte Schleife bei
// fehlendem Enddatum.
const HARD_LIMIT_DAYS = 730;
const DEFAULT_HORIZON_MONTHS = 3;

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Liefert die "YYYY-MM-DD"-Termine, die generate_job_occurrences für die
 * übergebene Regel JETZT materialisieren würde — begrenzt auf den echten
 * Server-Horizont (min. Regel-Ende bzw. +3 Monate, hart gedeckelt auf
 * 730 Tage ab Start). Leeres Array bei fehlenden Wochentagen oder wenn der
 * Zeitraum bereits vollständig in der Vergangenheit liegt (Server generiert
 * dann ebenfalls nichts).
 */
export function previewRecurringOccurrenceDates(params: {
  recurringDays: WeekdayKey[];
  /** "YYYY-MM-DD" oder null */
  recurrenceStartDate: string | null;
  /** "YYYY-MM-DD" oder null */
  recurrenceEndDate: string | null;
}): string[] {
  if (params.recurringDays.length === 0) return [];

  const today = startOfToday();
  const ruleStart = params.recurrenceStartDate
    ? keyToDate(params.recurrenceStartDate)
    : today;

  const generationStart = ruleStart.getTime() > today.getTime() ? ruleStart : today;
  const hardLimit = addDays(generationStart, HARD_LIMIT_DAYS);

  const ruleEnd = params.recurrenceEndDate
    ? keyToDate(params.recurrenceEndDate)
    : addMonths(generationStart, DEFAULT_HORIZON_MONTHS);

  const generationEnd = ruleEnd.getTime() < hardLimit.getTime() ? ruleEnd : hardLimit;

  const days = new Set(params.recurringDays);
  const dates: string[] = [];

  let cursor = generationStart;
  while (cursor.getTime() <= generationEnd.getTime()) {
    if (days.has(getWeekdayKey(cursor))) {
      const key = formatDateISO(cursor);
      if (key) dates.push(key);
    }
    cursor = addDays(cursor, 1);
  }

  return dates;
}
