// features/jobs/utils/assignmentAbsenceWarning.ts
// Phase D — orchestriert die Zuweisungs-Konflikt-Prüfung (Termin(e) ×
// aktive Abwesenheiten) für Job erstellen/bearbeiten und formatiert das
// Ergebnis als EINE Warnung (nie eine je Mitarbeiter/Termin).
//
// WARNUNG, NIE SPERRE: ein Fehler bei der Prüfung selbst (Netzwerk etc.)
// blockiert das Speichern NICHT — die Prüfung ist rein informativ, siehe
// useAssignmentAbsenceGuard.

import { i18next } from "@/i18n";
import { getActiveAbsencesForEmployeesInRange } from "@/services/absences/absenceConflicts";
import type { AbsenceType } from "@/types/absence";
import type { EmployeeOption, JobType } from "@/types/job";
import {
  findAssignmentConflicts,
  type AssignmentAbsenceConflict,
} from "@/utils/absenceConflicts";
import { formatDayMonth } from "@/utils/absenceFormat";
import { previewRecurringOccurrenceDates } from "@/utils/recurringOccurrencePreview";
import type { WeekdayKey } from "@/utils/recurrence";

export type AssignmentAbsenceCheckInput = {
  employeeIds: string[];
  employees: EmployeeOption[];
  jobType: JobType;
  /** "YYYY-MM-DD" — nur bei jobType "single" relevant. */
  singleDate: string | null;
  /** nur bei jobType "recurring" relevant. */
  recurringDays: WeekdayKey[];
  recurrenceStartDate: string | null;
  recurrenceEndDate: string | null;
};

/**
 * Ermittelt Kandidaten-Termine aus den AKTUELLEN Formularwerten (single:
 * genau ein Tag; recurring: über previewRecurringOccurrenceDates — spiegelt
 * exakt den Server-Horizont, siehe dort) und prüft sie in EINER gebündelten
 * Abfrage gegen aktive Abwesenheiten der ausgewählten Mitarbeiter.
 *
 * Leeres Ergebnis bei: keine Zuweisung, keine gültigen Kandidaten-Termine
 * (z. B. Datum noch nicht gewählt), oder keine Konflikte gefunden.
 */
export async function checkAssignmentAbsenceConflicts(
  input: AssignmentAbsenceCheckInput,
): Promise<AssignmentAbsenceConflict[]> {
  if (input.employeeIds.length === 0) return [];

  const candidateDates =
    input.jobType === "single"
      ? input.singleDate
        ? [input.singleDate]
        : []
      : previewRecurringOccurrenceDates({
          recurringDays: input.recurringDays,
          recurrenceStartDate: input.recurrenceStartDate,
          recurrenceEndDate: input.recurrenceEndDate,
        });

  if (candidateDates.length === 0) return [];

  let from = candidateDates[0];
  let to = candidateDates[0];
  for (const date of candidateDates) {
    if (date < from) from = date;
    if (date > to) to = date;
  }

  const absences = await getActiveAbsencesForEmployeesInRange({
    employeeIds: input.employeeIds,
    from,
    to,
  });
  if (absences.length === 0) return [];

  const nameById = new Map(input.employees.map((e) => [e.id, e.fullName]));
  const assignments = input.employeeIds.flatMap((employeeId) =>
    candidateDates.map((date) => ({
      employeeId,
      employeeName: nameById.get(employeeId) ?? i18next.t("common:states.unknown"),
      date,
    })),
  );

  return findAssignmentConflicts(absences, assignments);
}

export type AssignmentAbsenceWarningText = {
  title: string;
  message: string;
  confirmLabel: string;
};

const MAX_PREVIEW_ROWS = 5;

function typeLabel(type: AbsenceType): string {
  return i18next.t(
    type === "vacation" ? "jobs:absenceConflict.typeVacation" : "jobs:absenceConflict.typeSickness",
  );
}

/**
 * Formatiert die gefundenen Konflikte als EINE Warnung — nie eine je
 * Mitarbeiter/Termin (siehe CLAUDE.md-Vorgabe / Phase-D-Anforderung 8).
 * Drei Formen, je nach Auftragstyp und Konfliktzahl:
 *   - recurring: "Bei N geplanten Einsätzen gibt es Abwesenheiten: …"
 *   - single, genau ein Konflikt: "Lena ist am 18.08. im Urlaub."
 *   - single, mehrere Konflikte: "N Mitarbeiter sind an diesem Tag abwesend: …"
 */
export function formatAssignmentAbsenceWarning(
  conflicts: AssignmentAbsenceConflict[],
  jobType: JobType,
): AssignmentAbsenceWarningText {
  if (jobType === "recurring") {
    const rows = conflicts
      .slice(0, MAX_PREVIEW_ROWS)
      .map((c) => `• ${formatDayMonth(c.date)} — ${c.employeeName} (${typeLabel(c.type)})`);
    const remaining = conflicts.length - rows.length;

    const lines = [
      i18next.t("jobs:absenceConflict.recurringIntro", { count: conflicts.length }),
      "",
      ...rows,
      ...(remaining > 0 ? [i18next.t("jobs:absenceConflict.moreRows", { count: remaining })] : []),
    ];

    return {
      title: i18next.t("jobs:absenceConflict.titlePlural"),
      message: lines.join("\n"),
      confirmLabel: i18next.t("jobs:absenceConflict.confirmCreate"),
    };
  }

  // single: genau ein Mitarbeiter, ein Termin, ein Konflikt → Satzform.
  if (conflicts.length === 1) {
    const c = conflicts[0];
    return {
      title: i18next.t("jobs:absenceConflict.titleSingular"),
      message: i18next.t(
        c.type === "vacation"
          ? "jobs:absenceConflict.singleConflictVacation"
          : "jobs:absenceConflict.singleConflictSickness",
        { name: c.employeeName, date: formatDayMonth(c.date) },
      ),
      confirmLabel: i18next.t("jobs:absenceConflict.confirmAssign"),
    };
  }

  const uniqueEmployees = new Set(conflicts.map((c) => c.employeeId)).size;
  const rows = conflicts
    .slice(0, MAX_PREVIEW_ROWS)
    .map((c) => `• ${c.employeeName} — ${typeLabel(c.type)}`);
  const remaining = conflicts.length - rows.length;

  const lines = [
    i18next.t("jobs:absenceConflict.multiEmployeesIntro", { count: uniqueEmployees }),
    "",
    ...rows,
    ...(remaining > 0 ? [i18next.t("jobs:absenceConflict.moreRows", { count: remaining })] : []),
  ];

  return {
    title: i18next.t("jobs:absenceConflict.titlePlural"),
    message: lines.join("\n"),
    confirmLabel: i18next.t("jobs:absenceConflict.confirmAssign"),
  };
}
