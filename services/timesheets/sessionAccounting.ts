import type { TimesheetEntry } from "@/types/timesheet";

export type RecordedSession = {
  id: string;
  job_assignment_id: string;
  started_at: string;
  ended_at: string | null;
};

export type SessionAssignment = {
  id: string;
  jobId: string;
  customerName: string;
  remark: string;
  employeeStartedAt: string | null;
  employeeCompletedAt: string | null;
  reviewRequired: boolean;
};

export type SessionAccountingResult = {
  entries: TimesheetEntry[];
  gap: "session_missing" | "session_invalid" | "session_review" | null;
  knownDurationMinutes: number;
};

const DAY_MS = 86_400_000;

export function validCompanyTimeZone(value: string | null | undefined): string {
  const candidate = value?.trim() || "Europe/Berlin";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return "Europe/Berlin";
  }
}

function partsAt(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function companyDateKey(instant: number, timeZone: string): string {
  const parts = partsAt(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function companyTimeLabel(instant: number, timeZone: string): string {
  const parts = partsAt(instant, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

/** First real UTC instant on a company-local calendar date, including DST days. */
export function companyMidnightUtc(year: number, month: number, day: number, timeZone: string): number {
  const anchor = Date.UTC(year, month - 1, day);
  const target = new Date(anchor).toISOString().slice(0, 10);
  let low = anchor - 2 * DAY_MS;
  let high = anchor + 2 * DAY_MS;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (companyDateKey(mid, timeZone) >= target) high = mid;
    else low = mid;
  }
  return high;
}

export function companyMonthBounds(year: number, month: number, timeZone: string) {
  const zone = validCompanyTimeZone(timeZone);
  return {
    start: companyMidnightUtc(year, month, 1, zone),
    end: companyMidnightUtc(year, month + 1, 1, zone),
  };
}

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

type DayBucket = { workedMs: number; interruptedMs: number; firstWork: number | null; lastWork: number | null };

/** Apportion rounded minutes across dates without rounding every slice up. */
function roundedMinutesByDay(days: Map<string, DayBucket>, field: "workedMs" | "interruptedMs") {
  const portions = [...days.entries()].map(([date, day]) => ({
    date, exact: day[field] / 60000,
  }));
  const rounded = new Map(portions.map(({ date, exact }) => [date, Math.floor(exact)]));
  const total = Math.round(portions.reduce((sum, portion) => sum + portion.exact, 0));
  let extra = total - [...rounded.values()].reduce((sum, minutes) => sum + minutes, 0);
  portions.sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.date.localeCompare(b.date));
  for (const portion of portions) {
    if (extra-- <= 0) break;
    rounded.set(portion.date, rounded.get(portion.date)! + 1);
  }
  return rounded;
}

/** Splits real elapsed milliseconds at company-local midnight, not at UTC midnight. */
function allocateByLocalDay(start: number, end: number, timeZone: string, add: (date: string, start: number, end: number) => void) {
  let cursor = start;
  while (cursor < end) {
    const date = companyDateKey(cursor, timeZone);
    let boundary = end;
    if (companyDateKey(end - 1, timeZone) !== date) {
      let low = cursor;
      let high = end;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (companyDateKey(mid, timeZone) === date) low = mid;
        else high = mid;
      }
      boundary = high;
    }
    add(date, cursor, boundary);
    cursor = boundary;
  }
}

/** Session-only accounting; never consults assignment or parent lifecycle duration. */
export function accountSessionAssignment(
  assignment: SessionAssignment,
  sessions: RecordedSession[],
  year: number,
  month: number,
  requestedTimeZone: string,
): SessionAccountingResult {
  const timeZone = validCompanyTimeZone(requestedTimeZone);
  if (sessions.length === 0) {
    return { entries: [], gap: assignment.employeeCompletedAt || assignment.reviewRequired ? "session_missing" : null, knownDurationMinutes: 0 };
  }
  const ordered = [...sessions].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  let previousEnd = -Infinity;
  let valid = true;
  let knownMs = 0;
  for (const session of ordered) {
    const start = Date.parse(session.started_at);
    const end = session.ended_at ? Date.parse(session.ended_at) : NaN;
    if (session.job_assignment_id !== assignment.id || !Number.isFinite(start) || !Number.isFinite(end) ||
      end <= start || start < previousEnd) {
      valid = false;
      continue;
    }
    knownMs += end - start;
    previousEnd = end;
  }
  const firstStart = Date.parse(ordered[0].started_at);
  const finalEnd = ordered.at(-1)?.ended_at ? Date.parse(ordered.at(-1)!.ended_at!) : NaN;
  const completedAt = assignment.employeeCompletedAt ? Date.parse(assignment.employeeCompletedAt) : null;
  if (!assignment.employeeStartedAt || Date.parse(assignment.employeeStartedAt) !== firstStart ||
    (completedAt !== null && (!Number.isFinite(completedAt) || completedAt < finalEnd))) valid = false;

  if (!valid) return {
    entries: [], gap: "session_invalid", knownDurationMinutes: Math.round(knownMs / 60000),
  };
  if (!assignment.employeeCompletedAt) return {
    entries: [], gap: assignment.reviewRequired ? "session_review" : null,
    knownDurationMinutes: Math.round(knownMs / 60000),
  };

  const byDay = new Map<string, DayBucket>();
  const bucket = (date: string): DayBucket => {
    let value = byDay.get(date);
    if (!value) {
      value = { workedMs: 0, interruptedMs: 0, firstWork: null, lastWork: null };
      byDay.set(date, value);
    }
    return value;
  };
  for (let index = 0; index < ordered.length; index++) {
    const session = ordered[index];
    const start = Date.parse(session.started_at);
    const end = Date.parse(session.ended_at!);
    if (index > 0) {
      const priorEnd = Date.parse(ordered[index - 1].ended_at!);
      allocateByLocalDay(priorEnd, start, timeZone, (date, from, to) => {
        bucket(date).interruptedMs += to - from;
      });
    }
    allocateByLocalDay(start, end, timeZone, (date, from, to) => {
      const day = bucket(date);
      day.workedMs += to - from;
      day.firstWork = Math.min(day.firstWork ?? from, from);
      day.lastWork = Math.max(day.lastWork ?? to, to);
    });
  }

  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const workedMinutesByDay = roundedMinutesByDay(byDay, "workedMs");
  const interruptedMinutesByDay = roundedMinutesByDay(byDay, "interruptedMs");
  const entries: TimesheetEntry[] = [...byDay.entries()]
    .filter(([date]) => date.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => {
      const durationMinutes = workedMinutesByDay.get(date)!;
      const interruptionMinutes = interruptedMinutesByDay.get(date)!;
      const lastEndAtNextMidnight = day.lastWork !== null && companyDateKey(day.lastWork, timeZone) !== date;
      return {
        entryId: `${assignment.id}:${date}`, assignmentId: assignment.id, source: "sessions" as const,
        jobId: assignment.jobId, date,
        beginLabel: day.firstWork === null ? "--:--" : companyTimeLabel(day.firstWork, timeZone),
        endLabel: day.lastWork === null ? "--:--" : lastEndAtNextMidnight ? "24:00" : companyTimeLabel(day.lastWork, timeZone),
        durationMinutes, durationLabel: formatMinutes(durationMinutes),
        interruptionMinutes, interruptionLabel: formatMinutes(interruptionMinutes),
        reviewRequired: assignment.reviewRequired,
        customerName: assignment.customerName, remark: assignment.remark,
      };
    });
  return {
    entries, gap: assignment.reviewRequired ? "session_review" : null,
    knownDurationMinutes: Math.round(knownMs / 60000),
  };
}
