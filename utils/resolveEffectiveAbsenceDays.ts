// utils/resolveEffectiveAbsenceDays.ts
// Phase E — reine Ableitung "welche Abwesenheitsart gilt an diesem
// Kalendertag?", ohne Supabase-Abhängigkeit (testbar, wiederverwendbar für
// Stundenzettel-Anzeige UND -Berechnung). Analoges Muster zu
// utils/absenceConflicts.ts (Phase D): pure Zuordnung, Netzwerk-Abfrage lebt
// getrennt in services/absences/*.
//
// ZEITZONEN-SEMANTIK: ausschließlich "YYYY-MM-DD"-String-Vergleiche/-Iteration.
// KEIN `new Date("YYYY-MM-DD")` (verschiebt in manchen Zeitzonen auf den
// Vor-/Folgetag) — Datumskomponenten werden stattdessen einzeln geparst und
// über `new Date(y, m-1, d)` (lokal, sicher) konstruiert, exakt wie
// TimesheetScreen.formatDayShort es bereits tut.
//
// PRIORITÄT BEI ÜBERSCHNEIDUNG: Krank > Urlaub (siehe Architektur-Audit Phase
// E, Abschnitt 11). Ein Kalendertag hat NIE zwei wirksame Abwesenheitsarten.
// Beide zugrunde liegenden employee_absences-Zeilen bleiben dabei unverändert
// in der DB — diese Funktion verändert nichts, sie ordnet nur zu.
//
// WICHTIG — KEINE RECHTLICHE AUSSAGE: "wirksam" bedeutet hier ausschließlich
// "für die Stundenzettel-Anzeige berücksichtigt". Eine gemeldete Krankheit
// (status=reported) ist kein medizinischer Nachweis (Arbeitsunfähigkeit) und
// stellt keinen Urlaubsanspruch wieder her — siehe Kopfkommentar in
// types/timesheetAbsence.ts.

import type { Absence, AbsenceType } from "@/types/absence";
import type { EffectiveAbsenceDay } from "@/types/timesheetAbsence";
import { formatDateISO } from "@/utils/date";

/**
 * Entscheidet, ob eine Abwesenheits-Zeile für die Stundenzettel-Ableitung
 * überhaupt in Frage kommt. Als austauschbarer Parameter (statt fest verdrahtet)
 * gehalten, damit eine künftige Unterscheidung "gemeldet" vs. "medizinisch
 * bestätigt" (Architektur-Audit Phase E, Abschnitt 17) später nachgerüstet
 * werden kann, ohne resolveEffectiveAbsenceDays oder dessen Aufrufer
 * umzuschreiben — nur dieses Prädikat müsste sich ändern.
 *
 * requested/rejected/cancelled sind NIE aktiv — unabhängig vom Datum.
 */
export type AbsenceEligibilityPredicate = (absence: Absence) => boolean;

export const isOperationallyActiveAbsence: AbsenceEligibilityPredicate = (
  absence,
) =>
  (absence.type === "vacation" && absence.status === "approved") ||
  (absence.type === "sickness" && absence.status === "reported");

// Ordnet, welcher Typ bei Überschneidung gewinnt. Krank zuerst = höhere Prio.
const TYPE_PRIORITY: AbsenceType[] = ["sickness", "vacation"];

// "YYYY-MM-DD" → Folgetag als "YYYY-MM-DD", lokal berechnet (kein UTC-Drift).
function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map((n) => parseInt(n, 10));
  const next = new Date(year, month - 1, day + 1);
  return formatDateISO(next)!;
}

// Deckt eine Abwesenheit den gegebenen Kalendertag ab? offene Krankheit
// (end_date = null) deckt ab start_date jeden Folgetag ab.
function covers(absence: Absence, dateKey: string): boolean {
  if (dateKey < absence.startDate) return false;
  if (absence.endDate !== null && dateKey > absence.endDate) return false;
  return true;
}

/**
 * Leitet für jeden Kalendertag in [from, to] (inklusive, lokal) die wirksame
 * Abwesenheitsart eines EINZELNEN Mitarbeiters ab. `absences` sollte bereits
 * auf diesen Mitarbeiter eingegrenzt sein (Aufrufer-Verantwortung, siehe
 * getEmployeeAbsencesInRange) — diese Funktion filtert nur nach `isActive`
 * und Zeitraum, nicht nach employee_id.
 *
 * Tage ohne wirksame Abwesenheit fehlen im Ergebnis (kein Eintrag mit
 * type=null). Iteration ist strikt auf [from, to] begrenzt — eine Abwesenheit,
 * die vor `from` beginnt oder nach `to` endet, trägt nur innerhalb dieses
 * Fensters bei (siehe Monatsgrenzen-Fall im Architektur-Audit, Abschnitt 5).
 */
export function resolveEffectiveAbsenceDays(
  absences: Absence[],
  from: string,
  to: string,
  isActive: AbsenceEligibilityPredicate = isOperationallyActiveAbsence,
): EffectiveAbsenceDay[] {
  if (from > to) return [];

  const active = absences.filter(isActive);
  if (active.length === 0) return [];

  const result: EffectiveAbsenceDay[] = [];

  for (let dateKey = from; dateKey <= to; dateKey = nextDateKey(dateKey)) {
    const covering = active.filter((absence) => covers(absence, dateKey));
    if (covering.length === 0) continue;

    const winningType = TYPE_PRIORITY.find((type) =>
      covering.some((absence) => absence.type === type),
    )!;

    const sourceAbsenceIds = covering
      .filter((absence) => absence.type === winningType)
      .map((absence) => absence.id);

    result.push({ date: dateKey, type: winningType, sourceAbsenceIds });
  }

  return result;
}
