// i18n/config.ts
// Einzige Quelle der Wahrheit für unterstützte Sprachen. Andere Module
// (resolveLocale, rtl, index) und UI-Code importieren AUSSCHLIESSLICH von
// hier — keine Sprachliste an zweiter Stelle pflegen.

/** Unterstützte App-Sprachen. Reihenfolge = Anzeige-Reihenfolge im Sprachwähler. */
export const SUPPORTED_LOCALES = ["de", "en", "ar", "tr"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/** Fallback, wenn weder gespeicherte Sprache noch Gerätesprache passen. */
export const DEFAULT_LOCALE: AppLocale = "de";

/** Sprachen mit rechts-nach-links-Schrift. */
export const RTL_LOCALES: readonly AppLocale[] = ["ar"];

/**
 * Eigenbezeichnung jeder Sprache in ihrer eigenen Schrift (z. B. für den
 * Sprachwähler) — bewusst NICHT übersetzt, das ist die übliche UX-Konvention
 * für Sprachnamen (jede Sprache zeigt sich selbst).
 */
export const LANGUAGE_NAMES: Record<AppLocale, string> = {
  de: "Deutsch",
  en: "English",
  ar: "العربية",
  tr: "Türkçe",
};

/**
 * BCP-47-Tag je Sprache für `Intl`/`toLocaleDateString` & Co. Phase A nutzt
 * das noch nicht flächendeckend (siehe Audit) — Phase B–E ersetzen die
 * hartkodierten "de-DE"-Aufrufe schrittweise hierdurch.
 */
export const INTL_LOCALE_TAGS: Record<AppLocale, string> = {
  de: "de-DE",
  en: "en-US",
  ar: "ar-SA",
  tr: "tr-TR",
};

/**
 * i18next-Namespaces. Phase C fügt jobs/profile/absences/timesheets hinzu
 * (Employee-Bereich). Weitere Namespaces (auth, admin) folgen erst, wenn die
 * jeweilige Phase (siehe i18n-Audit, Abschnitt 7) den zugehörigen
 * Screen-Bereich migriert.
 */
export const NAMESPACES = [
  "common",
  "jobs",
  "profile",
  "absences",
  "timesheets",
  "admin",
  "auth",
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export function isSupportedLocale(value: unknown): value is AppLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export function isRTLLocale(locale: AppLocale): boolean {
  return RTL_LOCALES.includes(locale);
}
