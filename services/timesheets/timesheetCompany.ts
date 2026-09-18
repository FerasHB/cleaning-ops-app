// Plain-function-Datei (keine Komponente) — kein useTranslation()-Hook
// möglich. ANDERS als utils/userMessages.ts nutzt diese Datei NICHT die
// exportierte i18next-Instanz direkt (import { i18next } from "@/i18n"):
// dieser Alias-Import wird transitiv von scripts/check-timesheet-company-
// name.mjs eingelesen, einem schmalen node --experimental-strip-types-
// Runner ohne Pfad-Alias-Aufloesung. Stattdessen wie
// utils/jobSchedule.ts (getStartBlockMessage) das Muster "t als expliziter
// Parameter" — der Aufrufer (features/timesheets/hooks/useTimesheet.ts)
// hat aus useTranslation() ohnehin ein aktuelles t.
type CompanyNameSource = {
  name?: string | null;
} | null;

/** Liefert ausschließlich einen belastbaren, nicht-leeren Firmennamen. */
export function resolveTimesheetCompanyName(
  company: CompanyNameSource,
): string | null {
  const name = company?.name?.trim();
  return name ? name : null;
}

/**
 * Arbeitszeitnachweise dürfen nie mit einem erfundenen oder leeren
 * Firmennamen exportiert werden.
 */
export function getTimesheetExportBlockReason(params: {
  companyLoading: boolean;
  companyLoadError: string | null;
  companyName: string | null;
  t: (key: string) => string;
}): string | null {
  if (params.companyLoading) {
    return params.t("timesheets:exportBlockedLoading");
  }
  if (params.companyLoadError || !params.companyName) {
    return params.t("timesheets:exportBlockedUnavailable");
  }
  return null;
}
