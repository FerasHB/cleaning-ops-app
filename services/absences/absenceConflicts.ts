// services/absences/absenceConflicts.ts
// Phase D — Kalender-Abwesenheiten + Zuweisungs-Warnung.
//
// Eine gebündelte Abfrage für die Zuweisungs-Konflikt-Prüfung: aktive
// Abwesenheiten mehrerer Mitarbeiter über einen begrenzten Zeitraum, in
// EINEM Query statt einer Abfrage je Mitarbeiter. RLS ("admin read company
// absences") beschränkt bereits auf die eigene Firma — kein RPC nötig,
// gleiches Muster wie getCompanyAbsencesInRange().
//
// Nur für den Admin-Zuweisungspfad (JobFormFields/EditJobScreen) gedacht.
// Die reine Konflikt-Zuordnung (Abwesenheit × Termin-Datum) lebt getrennt in
// utils/absenceConflicts.ts — dort ohne Supabase-Abhängigkeit, hier nur die
// Netzwerk-Abfrage.

import { supabase } from "@/lib/supabase";
import {
  ABSENCE_SELECT,
  ACTIVE_ABSENCE_FILTER_OR,
  mapAbsence,
  type AbsenceRow,
} from "@/services/absences/absences.service";
import type { Absence } from "@/types/absence";
import { toUserMessage } from "@/utils/userMessages";

/**
 * Aktive Abwesenheiten (genehmigter Urlaub / gemeldete Krankheit) der
 * übergebenen Mitarbeiter mit echter Zeitraum-Überschneidung zu [from, to].
 * EIN Query für alle übergebenen IDs (kein Loop pro Mitarbeiter).
 *
 * Leeres employeeIds-Array → leeres Ergebnis, ohne Netzwerk-Aufruf (kein
 * Job ohne Zuweisung kann einen Konflikt haben).
 */
export async function getActiveAbsencesForEmployeesInRange(params: {
  employeeIds: string[];
  /** "YYYY-MM-DD", inklusive */
  from: string;
  /** "YYYY-MM-DD", inklusive */
  to: string;
}): Promise<Absence[]> {
  const uniqueIds = Array.from(new Set(params.employeeIds));
  if (uniqueIds.length === 0) return [];

  const { data, error } = await supabase
    .from("employee_absences")
    .select(ABSENCE_SELECT)
    .in("employee_id", uniqueIds)
    .or(ACTIVE_ABSENCE_FILTER_OR)
    .lte("start_date", params.to)
    .or(`end_date.is.null,end_date.gte.${params.from}`);

  if (error) {
    throw new Error(
      toUserMessage(error, "Die Abwesenheiten konnten nicht geprüft werden."),
    );
  }
  return (data ?? []).map((row) => mapAbsence(row as AbsenceRow));
}
