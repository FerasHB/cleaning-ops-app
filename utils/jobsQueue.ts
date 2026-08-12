// utils/jobsQueue.ts
// ─────────────────────────────────────────────────────────────────
// Reine Aufbereitung der Employee-Jobliste für den Jobs-Tab (Smart Queue).
// Gleiches Prinzip wie utils/occurrenceAgenda.ts und utils/calendarMonth.ts:
// KEINE React-/Supabase-Imports, damit die Gruppierung testbar bleibt und
// nicht im Screen selbst nachgebaut wird.
//
// REGELN (siehe CLAUDE.md / PR-Vorgabe „Smart Jobs Tab"):
//   Aktiv      → status 'in_progress' UND canRunJobActions (unabhängig vom
//                Datum — ein spät gestarteter Auftrag bleibt aktiv, nie
//                „überfällig").
//   Überfällig → status 'open', date < heute. Bewusst NICHT 'in_progress':
//                das deckt bereits „Aktiv" ab, sonst erschiene derselbe
//                Auftrag zweimal.
//   Nächstes   → der zeitlich früheste 'open'-Job (heute oder Zukunft,
//                exkl. Aktiv/Überfällig), einmalig herausgehoben.
//   Heute/Zukunft → alles Übrige, nach Tag gruppiert. 'Nächstes' und 'Aktiv'
//                sind daraus entfernt (keine Doppel-Darstellung).
//   Vergangen (nur completed) → kann nur entstehen, wenn ein Auftrag mit
//                Datum in der Vergangenheit bereits abgeschlossen wurde
//                (offene/aktive Vergangenheit landet immer in Überfällig/
//                Aktiv, nie hier). Wird nur für den „Erledigt"-Filter
//                gerendert — im Standardfall soll Historie die Ansicht nicht
//                dominieren (siehe Screen).
// ─────────────────────────────────────────────────────────────────

import { MONTH_NAMES_DE } from "@/utils/calendarMonth";
import { formatDateISO } from "@/utils/date";
import { canRunJobActions } from "@/utils/jobAssignees";
import { getJobDisplayTime, isJobToday } from "@/utils/jobSchedule";
import { getWeekdayKey, WEEKDAYS } from "@/utils/recurrence";
import type { Job, JobStatus } from "@/types/job";

export type JobStatusFilter = "all" | JobStatus;

export type JobDateGroup = {
  /** "YYYY-MM-DD" — stabiler Key. */
  key: string;
  /** "Heute" | "Morgen" | "Freitag, 14. August". */
  label: string;
  jobs: Job[];
};

export type JobQueueSections = {
  active: Job[];
  overdue: Job[];
  next: Job | null;
  today: JobDateGroup | null;
  future: JobDateGroup[];
  /** Nur für den „Erledigt"-Filter relevant — siehe Datei-Kopf. */
  pastCompleted: JobDateGroup[];
};

export type TodayStatusCounts = {
  total: number;
  open: number;
  inProgress: number;
  completed: number;
};

function fullWeekdayLabel(date: Date): string {
  const key = getWeekdayKey(date);
  return WEEKDAYS.find((w) => w.key === key)?.label ?? "";
}

// Erwartet einen reinen "YYYY-MM-DD"-Schlüssel und baut daraus LOKAL ein
// Datum (kein `new Date("YYYY-MM-DD")` — das parst als UTC-Mitternacht und
// kann je nach Zeitzone auf den Vortag rutschen).
function dateFromKey(key: string): Date | null {
  const [y, m, d] = key.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function dateGroupLabel(key: string, todayKey: string, tomorrowKey: string): string {
  if (key === todayKey) return "Heute";
  if (key === tomorrowKey) return "Morgen";
  const date = dateFromKey(key);
  if (!date) return key;
  const monthName = MONTH_NAMES_DE[date.getMonth()];
  return `${fullWeekdayLabel(date)}, ${date.getDate()}. ${monthName}`;
}

// Anzeige-Uhrzeit als sortierbarer String; Jobs ohne Uhrzeit sortieren ans
// Tagesende statt an den Anfang.
function displayTimeSortKey(job: Job): string {
  return getJobDisplayTime(job) ?? "99:99";
}

// Innerhalb eines Tages: offene/aktive Jobs zuerst (nach Uhrzeit), erledigte
// zuletzt — Erledigtes soll den Tag nicht dominieren (siehe PR-Vorgabe).
function sortDayJobs(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    const weightA = a.status === "completed" ? 1 : 0;
    const weightB = b.status === "completed" ? 1 : 0;
    if (weightA !== weightB) return weightA - weightB;
    return displayTimeSortKey(a).localeCompare(displayTimeSortKey(b));
  });
}

/**
 * Baut die operative Gliederung des Jobs-Tabs aus der bereits geladenen
 * Job-Liste (JobContext) — keine eigene Abfrage, keine Seiteneffekte.
 *
 * @param jobs         Alle Jobs des Mitarbeiters (aus useJobs().jobs).
 * @param now          Referenzzeitpunkt („heute").
 * @param role         Rolle des aktuellen Nutzers (Gate für Aktiv).
 * @param employeeId   Eigene Mitarbeiter-ID (Gate für Aktiv).
 * @param statusFilter Aktiver Status-Filter ('all' | 'open' | 'in_progress' | 'completed').
 */
export function buildJobQueueSections(
  jobs: Job[],
  now: Date,
  role: string | null | undefined,
  employeeId: string | null | undefined,
  statusFilter: JobStatusFilter,
): JobQueueSections {
  const todayKey = formatDateISO(now) ?? "";
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = formatDateISO(tomorrow) ?? "";

  // Nur konkrete Einzeltermine — Parent-Recurring-Regeln haben keinen Tag
  // und gehören nicht in eine Tages-/Warteschlangen-Ansicht (siehe auch
  // EmployeeJobsCalendarScreen).
  const singleJobs = jobs.filter((j) => j.jobType === "single");
  const scoped =
    statusFilter === "all"
      ? singleJobs
      : singleJobs.filter((j) => j.status === statusFilter);

  const active = scoped.filter(
    (j) => j.status === "in_progress" && canRunJobActions(j, role, employeeId),
  );
  const activeIds = new Set(active.map((j) => j.id));

  const overdue = [...scoped]
    .filter((j) => j.status === "open" && !!j.date && j.date < todayKey)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const overdueIds = new Set(overdue.map((j) => j.id));

  const upcomingOpen = [...scoped]
    .filter(
      (j) =>
        j.status === "open" &&
        (!j.date || j.date >= todayKey) &&
        !activeIds.has(j.id),
    )
    .sort((a, b) => {
      const dateA = a.date ?? todayKey;
      const dateB = b.date ?? todayKey;
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      return displayTimeSortKey(a).localeCompare(displayTimeSortKey(b));
    });

  const next = upcomingOpen[0] ?? null;

  const excluded = new Set<string>([...activeIds, ...overdueIds]);
  if (next) excluded.add(next.id);

  const remaining = scoped.filter((j) => !excluded.has(j.id));

  const todayJobs: Job[] = [];
  const futureByDate = new Map<string, Job[]>();
  const pastByDate = new Map<string, Job[]>();

  for (const job of remaining) {
    const key = job.date;
    // Kein Datum (Alt-Daten ohne `date`) → in den Heute-Topf, damit nichts
    // unsichtbar verschwindet.
    if (!key || key === todayKey) {
      todayJobs.push(job);
    } else if (key > todayKey) {
      const list = futureByDate.get(key) ?? [];
      list.push(job);
      futureByDate.set(key, list);
    } else {
      // Vergangenheit landet in `remaining` nur noch für completed (offen
      // → Überfällig, aktiv → Aktiv — siehe Filter oben).
      const list = pastByDate.get(key) ?? [];
      list.push(job);
      pastByDate.set(key, list);
    }
  }

  const today: JobDateGroup | null =
    todayJobs.length > 0
      ? { key: todayKey, label: "Heute", jobs: sortDayJobs(todayJobs) }
      : null;

  const future: JobDateGroup[] = [...futureByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({
      key,
      label: dateGroupLabel(key, todayKey, tomorrowKey),
      jobs: sortDayJobs(list),
    }));

  // Neueste Vergangenheit zuerst — relevanter als der älteste Abschluss.
  const pastCompleted: JobDateGroup[] = [...pastByDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, list]) => ({
      key,
      label: dateGroupLabel(key, todayKey, tomorrowKey),
      jobs: sortDayJobs(list),
    }));

  return { active, overdue, next, today, future, pastCompleted };
}

/**
 * Status-Zähler für die Kopfzeile ("Heute 5 · Offen 3 · In Arbeit 1 ·
 * Erledigt 1"). Bewusst IMMER auf Basis aller heutigen Jobs — unabhängig
 * vom aktiven Status-Filter — damit die Zahl nicht je nach Filter ihre
 * Bedeutung wechselt (siehe PR-Vorgabe: keine irreführenden Summen).
 */
export function getTodayStatusCounts(jobs: Job[], now: Date): TodayStatusCounts {
  const todayJobs = jobs.filter(
    (j) => j.jobType === "single" && isJobToday(j, now),
  );
  return {
    total: todayJobs.length,
    open: todayJobs.filter((j) => j.status === "open").length,
    inProgress: todayJobs.filter((j) => j.status === "in_progress").length,
    completed: todayJobs.filter((j) => j.status === "completed").length,
  };
}
