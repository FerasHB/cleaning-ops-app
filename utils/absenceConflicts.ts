// utils/absenceConflicts.ts
// Phase D — reine Zuordnung "Termin-Datum × aktive Abwesenheit", ohne
// Supabase-Abhängigkeit (testbar, wiederverwendbar für Einzel-Zuweisung UND
// Recurring-Vorschau). Die Netzwerk-Abfrage lebt getrennt in
// services/absences/absenceConflicts.ts.
//
// ZEITZONEN-SEMANTIK: reine "YYYY-MM-DD"-String-Vergleiche, kein
// `new Date(dateString)` — Absenzen und Job-Termine sind beides
// zeitzonenfreie Kalendertage (siehe CLAUDE.md, Abschnitt "Datum/Zeit").

import type { Absence, AbsenceType } from "@/types/absence";

export type AssignmentAbsenceConflict = {
  employeeId: string;
  employeeName: string;
  absenceId: string;
  type: AbsenceType;
  /** "YYYY-MM-DD" — der konkrete Termin-/Occurrence-Tag, der kollidiert. */
  date: string;
  startDate: string;
  endDate: string | null;
};

export type CandidateAssignment = {
  employeeId: string;
  employeeName: string;
  /** "YYYY-MM-DD" */
  date: string;
};

/**
 * Findet jede Kombination aus geplantem Termin und aktiver Abwesenheit
 * desselben Mitarbeiters. `absences` sollte bereits nur aktive (genehmigter
 * Urlaub / gemeldete Krankheit) Zeilen enthalten (siehe
 * getActiveAbsencesForEmployeesInRange) — diese Funktion prüft das NICHT
 * erneut, sie ordnet nur zu.
 *
 * Mehrfachtreffer bewusst NICHT auf einen pro Mitarbeiter eingedampft:
 * unterschiedliche Termin-Tage oder unterschiedliche Abwesenheits-Zeilen
 * (z. B. Urlaub UND Krankheit desselben Mitarbeiters) sind je ein echter,
 * eigener Konflikt. Nur exakte Duplikate (gleicher Mitarbeiter, gleiche
 * Abwesenheit, gleicher Termin-Tag) werden einmalig gezählt.
 */
export function findAssignmentConflicts(
  absences: Absence[],
  assignments: CandidateAssignment[],
): AssignmentAbsenceConflict[] {
  const conflicts: AssignmentAbsenceConflict[] = [];
  const seen = new Set<string>();

  for (const assignment of assignments) {
    for (const absence of absences) {
      if (absence.employeeId !== assignment.employeeId) continue;
      if (assignment.date < absence.startDate) continue;
      if (absence.endDate !== null && assignment.date > absence.endDate) continue;

      const key = `${assignment.employeeId}|${absence.id}|${assignment.date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      conflicts.push({
        employeeId: assignment.employeeId,
        employeeName: assignment.employeeName,
        absenceId: absence.id,
        type: absence.type,
        date: assignment.date,
        startDate: absence.startDate,
        endDate: absence.endDate,
      });
    }
  }

  return conflicts;
}
