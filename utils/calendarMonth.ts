// utils/calendarMonth.ts
// ─────────────────────────────────────────────────────────────────
// Reine Rechen-Helfer für den Monatskalender (Mo–So-Raster) und die
// Zuordnung von Jobs auf Kalendertage.
//
// Bewusst OHNE React/Theme-Import: die Datei ist rein und damit testbar,
// und dieselbe Tages-Zuordnung kann von Grid, Tages-Agenda und Zählern
// benutzt werden, statt in jedem Screen neu erfunden zu werden.
//
// ZEITZONEN-SEMANTIK (unverändert zur bisherigen Kalender-Ansicht):
// Ein Kalendertag ist ein LOKALER Tag. `job.date` ist bereits ein
// zeitzonenfreier "YYYY-MM-DD"-Schlüssel und wird direkt übernommen;
// nur der Alt-Daten-Fallback `scheduledStart` (ISO-Zeitstempel) wird über
// `formatDateISO` lokal auf einen Kalendertag reduziert.
// ─────────────────────────────────────────────────────────────────

import type { Job } from "@/types/job";
import { formatDateISO } from "@/utils/date";
import { getJobDisplayTime } from "@/utils/jobSchedule";

/** Eine Zelle des Monatsrasters. */
export type MonthCell = {
  /** Lokales Datum der Zelle. */
  date: Date;
  /** Datums-Schlüssel "YYYY-MM-DD". */
  key: string;
  /** Gehört die Zelle zum angezeigten Monat (Nachbarmonats-Tage: false)? */
  inMonth: boolean;
};

/** Monats-Schlüssel "YYYY-MM" eines Datums. */
export function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" oder "YYYY-MM-DD" → lokales Date (1. des Monats bzw. der Tag). */
export function keyToDate(key: string): Date {
  const [y, m, d] = key.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Monats-Schlüssel um `delta` Monate verschieben ("2026-12" + 1 → "2027-01"). */
export function addMonths(monthKey: string, delta: number): string {
  const base = keyToDate(monthKey);
  return monthKeyOf(new Date(base.getFullYear(), base.getMonth() + delta, 1));
}

/** Deutsches Monats-Label, z. B. „August 2026". */
export function formatMonthLabel(monthKey: string): string {
  return keyToDate(monthKey).toLocaleDateString("de-DE", {
    month: "long",
    year: "numeric",
  });
}

/** Ausgeschriebenes Tages-Label, z. B. „Mittwoch, 12. August 2026". */
export function formatDayLabel(dayKey: string): string {
  return keyToDate(dayKey).toLocaleDateString("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Monatsraster als Wochen-Zeilen (Mo–So).
 * Liefert je nach Monat 4, 5 oder 6 Zeilen — führende/nachlaufende Tage
 * stammen aus den Nachbarmonaten (`inMonth: false`).
 */
export function buildMonthMatrix(monthKey: string): MonthCell[][] {
  const base = keyToDate(monthKey);
  const year = base.getFullYear();
  const month = base.getMonth();

  // JS getDay(): So=0 … Sa=6 → wir wollen Mo=0 … So=6
  const leading = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;

  const rows: MonthCell[][] = [];
  for (let i = 0; i < totalCells; i += 7) {
    const week: MonthCell[] = [];
    for (let j = 0; j < 7; j++) {
      // Negative/überlaufende Tage normalisiert JS Date automatisch.
      const d = new Date(year, month, 1 - leading + i + j);
      week.push({
        date: d,
        key: formatDateISO(d) ?? "",
        inMonth: d.getMonth() === month,
      });
    }
    rows.push(week);
  }
  return rows;
}

/**
 * Datums-Schlüssel "YYYY-MM-DD" eines Jobs.
 * single/Occurrence hat `date`; Fallback `scheduledStart` (Alt-Daten).
 * Parent-Recurring-Regeln haben keinen Kalendertag → null.
 */
export function getJobDateKey(job: Job): string | null {
  if (job.date) return job.date.slice(0, 10);
  return formatDateISO(job.scheduledStart ? new Date(job.scheduledStart) : null);
}

/** Sortierung innerhalb eines Tages: nach Uhrzeit, Jobs ohne Zeit ans Ende. */
export function compareByDisplayTime(a: Job, b: Job): number {
  const ta = getJobDisplayTime(a);
  const tb = getJobDisplayTime(b);
  if (!ta && !tb) return 0;
  if (!ta) return 1;
  if (!tb) return -1;
  return ta.localeCompare(tb);
}

/**
 * Jobs auf Kalendertage verteilen — EINMAL pro Job-Liste statt einmal pro
 * Zelle. Das Monatsraster hat bis zu 42 Zellen; ein Filter-Durchlauf je
 * Zelle wäre O(Zellen × Jobs) bei jedem Render.
 * Jede Tagesliste ist bereits nach Uhrzeit sortiert.
 */
export function groupJobsByDateKey(jobs: Job[]): Map<string, Job[]> {
  const map = new Map<string, Job[]>();
  for (const job of jobs) {
    const key = getJobDateKey(job);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(job);
    else map.set(key, [job]);
  }
  for (const list of map.values()) {
    list.sort(compareByDisplayTime);
  }
  return map;
}
