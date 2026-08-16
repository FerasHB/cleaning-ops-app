// utils/absenceGrouping.ts
// Gruppiert "Meine Abwesenheiten" in Aktuell/Bevorstehend/Vergangen.
//
// Rein clientseitige Anzeige-Heuristik (keine Occurrences wie bei Jobs) —
// beschrieben hier, damit sie nicht in mehreren Screens neu erfunden wird:
//   * rejected/cancelled  → immer "Vergangen" (entschiedener/abgeschlossener
//     Zustand, unabhängig vom Datum).
//   * end_date < heute    → "Vergangen".
//   * start_date <= heute (und offen/laufend) → "Aktuell".
//   * start_date > heute  → "Bevorstehend".

import type { Absence } from "@/types/absence";
import { formatDateISO } from "@/utils/date";

export type AbsenceGroup = "current" | "upcoming" | "past";

export function categorizeAbsence(
  absence: Absence,
  today: Date = new Date(),
): AbsenceGroup {
  if (absence.status === "cancelled" || absence.status === "rejected") {
    return "past";
  }

  const todayIso = formatDateISO(today)!;

  if (absence.endDate && absence.endDate < todayIso) {
    return "past";
  }

  if (absence.startDate <= todayIso) {
    return "current";
  }

  return "upcoming";
}

export function groupAbsences(
  absences: Absence[],
  today: Date = new Date(),
): { current: Absence[]; upcoming: Absence[]; past: Absence[] } {
  const current: Absence[] = [];
  const upcoming: Absence[] = [];
  const past: Absence[] = [];

  for (const absence of absences) {
    const group = categorizeAbsence(absence, today);
    if (group === "current") current.push(absence);
    else if (group === "upcoming") upcoming.push(absence);
    else past.push(absence);
  }

  // Aktuell/Bevorstehend: nächstliegendes zuerst. Vergangen: jüngstes zuerst.
  current.sort((a, b) => a.startDate.localeCompare(b.startDate));
  upcoming.sort((a, b) => a.startDate.localeCompare(b.startDate));
  past.sort((a, b) => b.startDate.localeCompare(a.startDate));

  return { current, upcoming, past };
}
