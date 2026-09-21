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
import {
  formatDateISO,
  formatDateOnlyLocalized,
  isSameLocalDate,
  normalizeTime,
} from "@/utils/date";
import { i18next, INTL_LOCALE_TAGS, type AppLocale } from "@/i18n";
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
 * Ein PAUSIERTER Dauerauftrags-Termin: die Parent-Regel wurde deaktiviert
 * (`setRecurringRuleActive(rule, false)`), woraufhin `update_job_occurrences`
 * den offenen Zukunftstermin per SYNC auf `is_active = false` gesetzt hat.
 *
 * Solche Termine sind KEINE aktionierbare Arbeit mehr:
 *   - `start_own_job` lehnt sie serverseitig ab (Migration 20260829000000),
 *   - sie gehören nicht in operative Listen/Kalender (Mitarbeiter UND Admin),
 *   - `canRunJobActions` blendet den Start-Button aus.
 *
 * BEWUSST ENG: greift nur bei einer generierten Occurrence
 * (`parentJobId` gesetzt), die `is_active === false` UND `status === "open"`
 * ist. Historische Termine (`in_progress`/`completed`) sind NIE betroffen —
 * deaktivieren darf niemals Arbeitshistorie verstecken. Gewöhnliche
 * Einzelaufträge (`parentJobId == null`) sind strukturell ausgenommen: das
 * Formular schreibt sie immer aktiv (`buildSchedulePayload`).
 */
export function isPausedRecurringOccurrence(
  job: Pick<Job, "parentJobId" | "isActive" | "status">,
): boolean {
  return (
    job.parentJobId != null &&
    job.isActive === false &&
    job.status === "open"
  );
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

/** Scheduled time is a company-local wall clock. Parse the instant only for
 * legacy rows missing a canonical date or start time. */
export function formatJobScheduleLocalized(
  job: Pick<Job, "date" | "startTime" | "scheduledStart">,
): string | null {
  const locale = INTL_LOCALE_TAGS[i18next.language as AppLocale] ?? "de-DE";
  const canonicalDate = formatDateOnlyLocalized(job.date);
  const canonicalTime = normalizeTime(job.startTime);
  const fallback = !canonicalDate || !canonicalTime
    ? (job.scheduledStart ? new Date(job.scheduledStart) : null)
    : null;
  const legacyDate = fallback && !isNaN(fallback.getTime()) ? fallback : null;
  const date = canonicalDate ?? formatDateOnlyLocalized(formatDateISO(legacyDate));
  const wallTime = canonicalTime ?? (legacyDate ? timeFromISO(job.scheduledStart) : null);
  const time = wallTime
    ? wallTime.split(":").map((part) => new Intl.NumberFormat(locale, {
        minimumIntegerDigits: 2,
        useGrouping: false,
      }).format(Number(part))).join(":")
    : null;
  if (date && time) return i18next.t("jobs:comments.dateAt", { date, time });
  return date ?? time;
}

/**
 * Lesbares Wochentags-Label für recurring Jobs ("Mo, Do").
 * Für single Jobs leerer String.
 */
export function getRecurringDaysLabel(job: Job): string {
  if (job.jobType !== "recurring") return "";
  return formatRecurringDays(job.recurringDays);
}

/**
 * Darf dieser Auftrag JETZT gestartet werden (Terminregel, Phase 16)?
 *
 * SPIEGELT die Server-Regel public.job_start_date_allowed (Migration
 * 20260917000000) zeichengenau:
 *   - Start am Kalendertag des Termins, ODER
 *   - Nachtzuschlag: Spaetdienst (startTime >= 20:00) darf bis 02:00 des
 *     FOLGETAGS erstmals gestartet werden.
 *   - Ohne `date` niemals (fail-closed, wie serverseitig).
 *
 * MASSGEBLICH BLEIBT DER SERVER. Diese Funktion existiert nur, damit die App
 * keinen Button anbietet, den start_own_job garantiert ablehnt, und damit die
 * Meldung den konkreten Termin nennen kann.
 *
 * BEKANNTE ANNAEHERUNG: der Server rechnet in der Zeitzone der FIRMA
 * (companies.timezone). Der Client kennt sie nicht — `Job` traegt sie nicht,
 * und ein zusaetzlicher Abruf nur fuer diese Anzeige waere unverhaeltnismaessig.
 * Gerechnet wird deshalb in der GERAETE-Zeitzone, genau wie isJobToday() das
 * seit je tut. Fuer den deutschen Betrieb sind beide identisch; weichen sie ab,
 * entscheidet weiterhin der Server (die App zeigt dann im Extremfall einen
 * Button, dessen Aufruf sauber abgelehnt wird — nie umgekehrt ein stiller
 * Erfolg).
 */
export function isJobStartDateAllowed(
  job: Pick<Job, "date" | "startTime">,
  ref: Date = new Date(),
): boolean {
  const dateKey = job.date?.slice(0, 10);
  if (!dateKey) return false;

  const todayKey = formatDateISO(ref);
  if (dateKey === todayKey) return true;

  // Nachtzuschlag
  const start = normalizeTime(job.startTime);
  if (!start || start < "20:00") return false;
  if (ref.getHours() >= 2) return false;

  const yesterday = new Date(ref);
  yesterday.setDate(yesterday.getDate() - 1);
  return dateKey === formatDateISO(yesterday);
}

/**
 * Warum darf dieser Auftrag JETZT nicht gestartet werden? `null`, wenn er
 * gestartet werden darf. Rein client-seitige UX-Vorschau — die tatsächliche
 * Durchsetzung bleibt bei start_own_job; dessen eigene Ablehnung kommt
 * bewusst weiterhin auf Deutsch zurück (server-seitiger Fallback-Text, siehe
 * CLAUDE.md), unabhängig von der hier gewählten App-Sprache.
 *
 * `t`/`localeTag` kommen vom Aufrufer (useTranslation()/i18n.language),
 * damit diese reine Utility-Funktion nicht selbst an die i18next-Instanz
 * gebunden ist.
 */
export function getStartBlockMessage(
  job: Pick<Job, "date" | "startTime">,
  t: (key: string, opts?: Record<string, unknown>) => string,
  localeTag: string,
  ref: Date = new Date(),
): string | null {
  if (isJobStartDateAllowed(job, ref)) return null;

  const dateKey = job.date?.slice(0, 10);
  if (!dateKey) {
    return t("jobs:startBlock.noDateConfigured");
  }

  const [y, m, d] = dateKey.split("-").map((n) => parseInt(n, 10));
  const label =
    y && m && d
      ? new Date(y, m - 1, d).toLocaleDateString(localeTag, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })
      : dateKey;
  const todayKey = formatDateISO(ref) ?? "";

  return dateKey > todayKey
    ? t("jobs:startBlock.scheduledFuture", { date: label })
    : t("jobs:startBlock.scheduledPast", { date: label });
}

/**
 * Geplantes Ende "HH:mm", abgeleitet aus startTime + plannedDurationMinutes
 * (Phase 3, Planned Duration Foundation). NULL, wenn eines der beiden fehlt —
 * KEIN Rückgriff auf scheduledEnd (siehe CLAUDE.md: start_time + Dauer ist
 * die einzige Quelle der geplanten Terminierung).
 */
export function getPlannedEndTime(
  job: Pick<Job, "startTime" | "plannedDurationMinutes">,
): string | null {
  const start = normalizeTime(job.startTime);
  const duration = job.plannedDurationMinutes;
  if (!start || !duration || duration <= 0) return null;

  const [h, m] = start.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;

  const totalMinutes = (h * 60 + m + duration) % (24 * 60);
  const endH = Math.floor(totalMinutes / 60);
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}
