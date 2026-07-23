// utils/scheduleView.ts
// Reine, testbare Logik für die Zeitplan-Ansicht: Filter-Definitionen,
// stabile Sortierung und Gruppierung von Occurrences nach Datum.
// KEINE React-/Supabase-Imports.

import type { Job } from "@/types/job";
import { getJobDisplayTime } from "@/utils/jobSchedule";

// Die vier Zeitplan-Filter (executable Jobs: single + Occurrences, nie Parents).
export type ScheduleFilter = "heute" | "bevorstehend" | "ueberfaellig" | "erledigt";

export const SCHEDULE_FILTERS: { key: ScheduleFilter; label: string }[] = [
  { key: "heute", label: "Heute" },
  { key: "bevorstehend", label: "Bevorstehend" },
  { key: "ueberfaellig", label: "Überfällig" },
  { key: "erledigt", label: "Erledigt" },
];

// Datums-Key "YYYY-MM-DD" einer Occurrence (single/Occurrence tragen `date`).
export function scheduleDateKey(job: Job): string | null {
  if (job.date) return job.date.slice(0, 10);
  if (job.scheduledStart) {
    const d = new Date(job.scheduledStart);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
  }
  return null;
}

// Stabile Sortierung: nach Datum, dann Uhrzeit, dann id (Tie-Breaker).
// `direction` steuert die Datumsrichtung (asc für Heute/Bevorstehend/Überfällig,
// desc für Erledigt).
export function compareSchedule(
  a: Job,
  b: Job,
  direction: "asc" | "desc" = "asc",
): number {
  const ka = scheduleDateKey(a) ?? "";
  const kb = scheduleDateKey(b) ?? "";
  let cmp = ka.localeCompare(kb);
  if (cmp === 0) {
    const ta = getJobDisplayTime(a) ?? "";
    const tb = getJobDisplayTime(b) ?? "";
    cmp = ta.localeCompare(tb);
  }
  if (cmp === 0) cmp = a.id.localeCompare(b.id);
  return direction === "asc" ? cmp : -cmp;
}

export type ScheduleSection = {
  dateKey: string;
  title: string;
  data: Job[];
};

// Menschlich lesbares Datums-Label ("Heute", "Morgen", "Gestern", sonst
// "Mo, 24.07.2026"). `ref` = heutiger Kalendertag als "YYYY-MM-DD".
export function formatSectionTitle(dateKey: string, refKey: string): string {
  if (dateKey === refKey) return "Heute";

  const [y, m, d] = dateKey.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return dateKey;
  const date = new Date(y, m - 1, d);

  const [ry, rm, rd] = refKey.split("-").map((n) => parseInt(n, 10));
  const ref = new Date(ry, rm - 1, rd);
  const diffDays = Math.round((date.getTime() - ref.getTime()) / 86400000);
  if (diffDays === 1) return "Morgen";
  if (diffDays === -1) return "Gestern";

  return date.toLocaleDateString("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Gruppiert Occurrences nach Datum in SectionList-Sektionen.
 * Sektionen sind nach Datum sortiert (Richtung `direction`), innerhalb einer
 * Sektion nach Uhrzeit. Occurrences ohne Datum landen in einer eigenen
 * "Ohne Datum"-Sektion am Ende.
 */
export function groupByDate(
  jobs: Job[],
  refKey: string,
  direction: "asc" | "desc" = "asc",
): ScheduleSection[] {
  const buckets = new Map<string, Job[]>();
  const NO_DATE = "__no_date__";

  for (const job of jobs) {
    const key = scheduleDateKey(job) ?? NO_DATE;
    const arr = buckets.get(key);
    if (arr) arr.push(job);
    else buckets.set(key, [job]);
  }

  const dateKeys = [...buckets.keys()].filter((k) => k !== NO_DATE);
  dateKeys.sort((a, b) =>
    direction === "asc" ? a.localeCompare(b) : b.localeCompare(a),
  );

  const sections: ScheduleSection[] = dateKeys.map((dateKey) => ({
    dateKey,
    title: formatSectionTitle(dateKey, refKey),
    data: [...(buckets.get(dateKey) ?? [])].sort((a, b) =>
      compareSchedule(a, b, direction),
    ),
  }));

  if (buckets.has(NO_DATE)) {
    sections.push({
      dateKey: NO_DATE,
      title: "Ohne Datum",
      data: buckets.get(NO_DATE) ?? [],
    });
  }

  return sections;
}
