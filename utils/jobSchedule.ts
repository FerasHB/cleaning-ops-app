// utils/jobSchedule.ts
// Zentrale Helfer für die Terminierung von Jobs (single + recurring).
// Werden von EmployeeOverviewScreen, AdminDashboardScreen und JobCard genutzt,
// damit die "Heute fällig"- und Anzeige-Logik nur an EINER Stelle lebt.
//
// TODO (bewusst noch KEIN Occurrence-System):
// Wiederkehrende Jobs sind aktuell Templates/Regeln (eine Zeile in der DB),
// nicht pro Tag materialisierte Vorkommen. Status (open/in_progress/completed)
// sowie started_at/completed_at gelten daher global pro Regel, nicht pro Tag.
// Für sauberes Tages-Status-Tracking (z.B. "heute erledigt" je Wochentag)
// brauchen wir später echte Job-Occurrences. Bis dahin beantwortet isJobToday()
// nur "ist heute fällig?" ohne tagesgenauen Status.

import type { Job } from "@/types/job";
import { isSameLocalDate, normalizeTime } from "@/utils/date";
import { formatRecurringDays, isWeekdayInList } from "@/utils/recurrence";

// Vergleicht einen ISO-Zeitstempel mit dem Kalendertag von `ref` (lokal).
function isSameDayISO(iso: string | null | undefined, ref: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

// Extrahiert "HH:mm" (lokal) aus einem ISO-Zeitstempel.
function timeFromISO(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Ist dieser Job heute fällig?
 * - nur aktive Jobs (isActive !== false)
 * - single:    date == heute (Fallback: scheduledStart == heute, für Alt-Daten)
 * - recurring: heutiger Wochentag in recurringDays enthalten
 */
export function isJobToday(job: Job, ref: Date = new Date()): boolean {
  if (job.isActive === false) return false;

  if (job.jobType === "recurring") {
    return isWeekdayInList(ref, job.recurringDays);
  }

  // single
  if (job.date) return isSameLocalDate(job.date, ref);
  return isSameDayISO(job.scheduledStart, ref);
}

/**
 * Anzeige-Uhrzeit "HH:mm": bevorzugt das strukturierte start_time,
 * sonst Fallback auf scheduledStart (Alt-Daten / single ohne start_time).
 */
export function getJobDisplayTime(job: Job): string | null {
  return normalizeTime(job.startTime) ?? timeFromISO(job.scheduledStart);
}

/**
 * Lesbares Wochentags-Label für recurring Jobs ("Mo, Do").
 * Für single Jobs leerer String.
 */
export function getRecurringDaysLabel(job: Job): string {
  if (job.jobType !== "recurring") return "";
  return formatRecurringDays(job.recurringDays);
}
