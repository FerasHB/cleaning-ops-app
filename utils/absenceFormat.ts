// utils/absenceFormat.ts
// Geteilte Anzeige-Formatierung für Abwesenheits-Zeiträume — extrahiert aus
// features/absences/components/AbsenceCard.tsx, damit die Admin-Seite
// (features/absences/admin/) dieselbe Formatierung nutzt statt sie zu
// duplizieren ("Krank seit DD.MM." / "DD.MM.–DD.MM.").

import type { Absence } from "@/types/absence";

/** "YYYY-MM-DD" → "DD.MM." (ohne Jahr). */
export function formatDayMonth(dateIso: string): string {
  const [, m, d] = dateIso.split("-");
  return `${d}.${m}.`;
}

/** Lesbarer Zeitraum: Urlaub immer als Bereich, Krankheit ggf. offen-endig. */
export function formatAbsenceDateRange(absence: Absence): string {
  if (absence.type === "vacation") {
    return `${formatDayMonth(absence.startDate)}–${formatDayMonth(absence.endDate!)}`;
  }
  if (absence.endDate) {
    return `${formatDayMonth(absence.startDate)}–${formatDayMonth(absence.endDate)}`;
  }
  return `Seit ${formatDayMonth(absence.startDate)}`;
}
