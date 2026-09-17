type CompanyNameSource = {
  name?: string | null;
} | null;

export const COMPANY_LOADING_EXPORT_ERROR =
  "Firmendaten werden noch geladen. Bitte versuche den PDF-Export gleich erneut.";

export const COMPANY_UNAVAILABLE_EXPORT_ERROR =
  "Der Firmenname konnte nicht geladen werden. Der PDF-Export ist deshalb nicht möglich.";

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
}): string | null {
  if (params.companyLoading) return COMPANY_LOADING_EXPORT_ERROR;
  if (params.companyLoadError || !params.companyName) {
    return COMPANY_UNAVAILABLE_EXPORT_ERROR;
  }
  return null;
}
