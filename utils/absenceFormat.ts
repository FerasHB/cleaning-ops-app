// utils/absenceFormat.ts
// Geteilte Anzeige-Formatierung für Abwesenheits-Zeiträume — extrahiert aus
// features/absences/components/AbsenceCard.tsx, damit die Admin-Seite
// (features/absences/admin/) dieselbe Formatierung nutzt statt sie zu
// duplizieren ("Krank seit DD.MM." / "DD.MM.–DD.MM.").

import type { Absence } from "@/types/absence";
import { i18next, INTL_LOCALE_TAGS, type AppLocale } from "@/i18n";

/**
 * "YYYY-MM-DD" → Tag+Monat (ohne Jahr) in der aktiven App-Sprache, z. B.
 * "05.03." (de) / "03/05" (en) / "05.03" (tr) / arabische Ziffern (ar).
 * Baut das Datum lokal (kein `new Date("YYYY-MM-DD")` — das parst als
 * UTC-Mitternacht und kann je nach Zeitzone auf den Vortag rutschen).
 */
export function formatDayMonth(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map((n) => parseInt(n, 10));
  const date = new Date(y, (m || 1) - 1, d || 1);
  const localeTag = INTL_LOCALE_TAGS[i18next.language as AppLocale] ?? "de-DE";
  return date.toLocaleDateString(localeTag, { day: "2-digit", month: "2-digit" });
}

/** Lesbarer Zeitraum: Urlaub immer als Bereich, Krankheit ggf. offen-endig. */
export function formatAbsenceDateRange(absence: Absence): string {
  if (absence.type === "vacation") {
    return `${formatDayMonth(absence.startDate)}–${formatDayMonth(absence.endDate!)}`;
  }
  if (absence.endDate) {
    return `${formatDayMonth(absence.startDate)}–${formatDayMonth(absence.endDate)}`;
  }
  return `${i18next.t("absences:card.rangeSincePrefix")} ${formatDayMonth(absence.startDate)}`;
}
