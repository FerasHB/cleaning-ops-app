// utils/absenceCalendarMarkers.ts
// Phase D — reine Zuordnung "Kalendertag × aktive Abwesenheiten" für den
// Monatskalender (Zellen-Marker + Tages-Agenda). Getrennt von
// utils/calendarMonth.ts, weil Absenzen über ZEITRÄUME laufen (start_date/
// end_date), nicht über ein einzelnes Datumsfeld wie job.date — die
// Job-Gruppierung dort (groupJobsByDateKey) passt für Absenzen nicht.
//
// Bewusst OHNE React/Theme-Import: rein und testbar, gleiches Prinzip wie
// calendarMonth.ts.

import type { Absence, AbsenceType } from "@/types/absence";
import { keyToDate } from "@/utils/calendarMonth";
import { formatDateISO } from "@/utils/date";

function addDaysToKey(dateKey: string, days: number): string {
  const d = keyToDate(dateKey);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  return formatDateISO(next) ?? dateKey;
}

/**
 * Verteilt jede Abwesenheit auf jeden Kalendertag, den sie innerhalb von
 * [range.from, range.to] abdeckt (offen-endige Krankheit: bis range.to
 * geklammert — weiter muss nicht iteriert werden, außerhalb der Sichtbarkeit
 * ist ohnehin nichts zu zeigen). Ein Tag mit mehreren Abwesenheiten trägt
 * mehrere Einträge — die Verdichtung auf Marker-Typen passiert erst in
 * `absenceTypesForDay`.
 */
export function buildAbsenceDayIndex(
  absences: Absence[],
  range: { from: string; to: string },
): Map<string, Absence[]> {
  const map = new Map<string, Absence[]>();

  for (const absence of absences) {
    const start = absence.startDate > range.from ? absence.startDate : range.from;
    const end =
      absence.endDate && absence.endDate < range.to ? absence.endDate : range.to;
    if (start > end) continue;

    let cursor = start;
    while (cursor <= end) {
      const list = map.get(cursor);
      if (list) list.push(absence);
      else map.set(cursor, [absence]);
      cursor = addDaysToKey(cursor, 1);
    }
  }

  return map;
}

/**
 * Vorkommende Abwesenheits-TYPEN eines Tages, kanonisch geordnet
 * (Urlaub → Krank) — höchstens einer je Typ, unabhängig davon, wie viele
 * Mitarbeiter betroffen sind (Phase-D-Anforderung: nie ein Marker je
 * Mitarbeiter).
 */
export function absenceTypesForDay(
  dayAbsences: Absence[] | undefined,
): AbsenceType[] {
  if (!dayAbsences || dayAbsences.length === 0) return [];
  const types = new Set(dayAbsences.map((a) => a.type));
  const ordered: AbsenceType[] = [];
  if (types.has("vacation")) ordered.push("vacation");
  if (types.has("sickness")) ordered.push("sickness");
  return ordered;
}
