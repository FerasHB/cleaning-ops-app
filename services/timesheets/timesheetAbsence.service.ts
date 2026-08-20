// services/timesheets/timesheetAbsence.service.ts
// Phase E — Stundenzettel-Abwesenheiten: Orchestrierung getrennt von der
// bestehenden Ist-Zeit-Berechnung (services/timesheets/timesheet.service.ts).
//
// WARUM EINE EIGENE DATEI: die bestehende Ist-Zeit-Logik (mapEntry/mapGap,
// Legacy-Cutoff, geteilte Job-Uhr) ist abrechnungskritisch und darf durch
// diese rein additive Abwesenheits-Ableitung nicht berührt werden — getrennte
// Datei macht das strukturell offensichtlich, statt es nur per Kommentar zu
// behaupten. getTimesheet() ruft am Ende lediglich buildTimesheetAbsence()
// zusätzlich auf und merged das Ergebnis additiv in TimesheetData.
//
// QUELLEN (siehe Architektur-Audit Phase E):
//   * employee_absences (via getEmployeeAbsencesInRange, RLS-skopiert)
//   * jobs.planned_duration_minutes der materialisierten Occurrences
//     (via getScheduleOccurrences, NIE aus tatsächlicher Arbeitszeit oder
//     scheduled_end abgeleitet)
//
// KEINE Occurrence-Abfrage, wenn es im Zeitraum keinen wirksamen
// Abwesenheitstag gibt (siehe buildTimesheetAbsence) — der Regelfall
// "Mitarbeiter ohne Abwesenheit in diesem Monat" kostet damit keine
// zusätzliche Anfrage.

import { getEmployeeAbsencesInRange } from "@/services/absences/absences.service";
import { getScheduleOccurrences } from "@/services/jobs/jobs.service";
import type { TimesheetEntry } from "@/types/timesheet";
import type {
  TimesheetAbsenceDay,
  TimesheetAbsenceSummary,
  TimesheetNotice,
} from "@/types/timesheetAbsence";
import { resolveEffectiveAbsenceDays } from "@/utils/resolveEffectiveAbsenceDays";

function emptySummary(): TimesheetAbsenceSummary {
  return {
    vacationCalendarDays: 0,
    sicknessCalendarDays: 0,
    vacationPlannedWorkDays: 0,
    sicknessPlannedWorkDays: 0,
    vacationPlannedMinutes: 0,
    sicknessPlannedMinutes: 0,
    days: [],
  };
}

/**
 * Lädt Abwesenheiten + geplante Einsatzzeit für einen Mitarbeiter/Zeitraum
 * und baut daraus Zusammenfassung + Hinweise (Phase E).
 *
 * @param entries Bereits geladene Ist-Zeit-Einträge desselben Aufrufs
 *   (getTimesheet) — ausschließlich für den "Arbeit trotz Abwesenheit"-
 *   Hinweis genutzt (Schnittmenge der Tage), NIE für die Planzeit-Berechnung.
 */
export async function buildTimesheetAbsence(params: {
  employeeId: string;
  /** "YYYY-MM-DD", inklusive — identische Monatsgrenzen wie getTimesheet. */
  from: string;
  /** "YYYY-MM-DD", inklusive */
  to: string;
  entries: TimesheetEntry[];
}): Promise<{ summary: TimesheetAbsenceSummary; notices: TimesheetNotice[] }> {
  const { employeeId, from, to, entries } = params;

  const absences = await getEmployeeAbsencesInRange({ employeeId, from, to });
  const effectiveDays = resolveEffectiveAbsenceDays(absences, from, to);

  if (effectiveDays.length === 0) {
    return { summary: emptySummary(), notices: [] };
  }

  // Nur EINE Occurrence-Abfrage für den gesamten Zeitraum, nicht pro Tag.
  const occurrences = await getScheduleOccurrences({
    from,
    to,
    employee: { employeeId },
  });

  // Geplante Minuten je Kalendertag, NUR aus planned_duration_minutes
  // zugewiesener Occurrences — null-Dauer wird ignoriert (Regel 5, nie 8h
  // annehmen, nie aus Ist-Zeit oder scheduled_end ableiten).
  const plannedMinutesByDate = new Map<string, number>();
  for (const job of occurrences) {
    if (!job.date) continue;
    if (job.plannedDurationMinutes == null) continue;
    plannedMinutesByDate.set(
      job.date,
      (plannedMinutesByDate.get(job.date) ?? 0) + job.plannedDurationMinutes,
    );
  }

  const days: TimesheetAbsenceDay[] = effectiveDays.map((day) => {
    const plannedMinutes = plannedMinutesByDate.get(day.date) ?? 0;
    return {
      ...day,
      plannedMinutes,
      hasPlannedWork: plannedMinutes > 0,
    };
  });

  const summary = days.reduce<TimesheetAbsenceSummary>((acc, day) => {
    if (day.type === "vacation") {
      acc.vacationCalendarDays += 1;
      if (day.hasPlannedWork) acc.vacationPlannedWorkDays += 1;
      acc.vacationPlannedMinutes += day.plannedMinutes;
    } else {
      acc.sicknessCalendarDays += 1;
      if (day.hasPlannedWork) acc.sicknessPlannedWorkDays += 1;
      acc.sicknessPlannedMinutes += day.plannedMinutes;
    }
    return acc;
  }, emptySummary());
  summary.days = days;

  // "Arbeit trotz Abwesenheit": Schnittmenge Ist-Zeit-Einträge × wirksame
  // Abwesenheitstage. Rein informativ — ändert weder entries noch
  // totalMinutes noch die Abwesenheits-Klassifizierung.
  const effectiveByDate = new Map(effectiveDays.map((d) => [d.date, d.type]));
  const notices: TimesheetNotice[] = [];
  const seenNoticeDates = new Set<string>();
  for (const entry of entries) {
    const absenceType = effectiveByDate.get(entry.date);
    if (!absenceType || seenNoticeDates.has(entry.date)) continue;
    seenNoticeDates.add(entry.date);
    notices.push({
      type: "work_during_absence",
      date: entry.date,
      absenceType,
    });
  }
  notices.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { summary, notices };
}
