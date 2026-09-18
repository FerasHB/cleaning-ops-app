// i18n/index.ts
// Initialisierung + Sprachwechsel. Ersetzt die alte, seit dem Initial-Commit
// unbenutzte Attrappe (i18n/translations.ts + i18n/useTranslation.ts) durch
// i18next/react-i18next.
//
// Bewusst KEIN <I18nextProvider>: `i18next.use(initReactI18next)` macht die
// hier initialisierte Instanz zur globalen Default-Instanz, die
// react-i18next-Hooks (useTranslation) automatisch finden — react-i18next
// bietet diese Reaktivität bereits fertig, ein zusätzlicher Context-Wrapper
// wäre unnötige Abstraktion für eine einzelne globale Instanz.

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, NAMESPACES, type AppLocale } from "./config";
import { resolveInitialLocale } from "./resolveLocale";
import { syncRTLFlag } from "./rtl";
import { setStoredLanguage } from "./storage";

import commonAr from "./locales/ar/common.json";
import commonDe from "./locales/de/common.json";
import commonEn from "./locales/en/common.json";
import commonTr from "./locales/tr/common.json";

import jobsAr from "./locales/ar/jobs.json";
import jobsDe from "./locales/de/jobs.json";
import jobsEn from "./locales/en/jobs.json";
import jobsTr from "./locales/tr/jobs.json";

import profileAr from "./locales/ar/profile.json";
import profileDe from "./locales/de/profile.json";
import profileEn from "./locales/en/profile.json";
import profileTr from "./locales/tr/profile.json";

import absencesAr from "./locales/ar/absences.json";
import absencesDe from "./locales/de/absences.json";
import absencesEn from "./locales/en/absences.json";
import absencesTr from "./locales/tr/absences.json";

import timesheetsAr from "./locales/ar/timesheets.json";
import timesheetsDe from "./locales/de/timesheets.json";
import timesheetsEn from "./locales/en/timesheets.json";
import timesheetsTr from "./locales/tr/timesheets.json";

import adminAr from "./locales/ar/admin.json";
import adminDe from "./locales/de/admin.json";
import adminEn from "./locales/en/admin.json";
import adminTr from "./locales/tr/admin.json";

import authAr from "./locales/ar/auth.json";
import authDe from "./locales/de/auth.json";
import authEn from "./locales/en/auth.json";
import authTr from "./locales/tr/auth.json";

const resources = {
  de: {
    common: commonDe,
    jobs: jobsDe,
    profile: profileDe,
    absences: absencesDe,
    timesheets: timesheetsDe,
    admin: adminDe,
    auth: authDe,
  },
  en: {
    common: commonEn,
    jobs: jobsEn,
    profile: profileEn,
    absences: absencesEn,
    timesheets: timesheetsEn,
    admin: adminEn,
    auth: authEn,
  },
  ar: {
    common: commonAr,
    jobs: jobsAr,
    profile: profileAr,
    absences: absencesAr,
    timesheets: timesheetsAr,
    admin: adminAr,
    auth: authAr,
  },
  tr: {
    common: commonTr,
    jobs: jobsTr,
    profile: profileTr,
    absences: absencesTr,
    timesheets: timesheetsTr,
    admin: adminTr,
    auth: authTr,
  },
} satisfies Record<AppLocale, Record<string, unknown>>;

let initPromise: Promise<AppLocale> | null = null;

/**
 * Löst die Startsprache auf und initialisiert i18next. Idempotent (mehrfacher
 * Aufruf liefert dieselbe Promise) — sicher aus app/_layout.tsx aufrufbar,
 * auch wenn der Effekt aus irgendeinem Grund erneut liefe.
 *
 * Der Aufrufer (RootLayout) MUSS mit dem Rendern warten, bis diese Promise
 * aufgelöst ist — sonst rendert ein erster Frame in der Fallback-Sprache,
 * bevor auf die gespeicherte/Geräte-Sprache gewechselt wird (Sprach-Flash).
 */
export function initI18n(): Promise<AppLocale> {
  if (!initPromise) {
    initPromise = (async () => {
      const locale = await resolveInitialLocale();

      await i18next.use(initReactI18next).init({
        resources,
        lng: locale,
        fallbackLng: DEFAULT_LOCALE,
        ns: NAMESPACES,
        defaultNS: "common",
        interpolation: { escapeValue: false },
        returnNull: false,
      });

      // Synchronisiert nur das native Flag für den NÄCHSTEN App-Start (siehe
      // rtl.ts) — bewusst OHNE Neustart-Hinweis beim kalten Start: der Nutzer
      // hat hier noch keine Aktion ausgelöst, ein Hinweis direkt beim Öffnen
      // wäre weder verständlich noch nötig (Layout-Richtung war beim letzten
      // Start bereits korrekt gesetzt, falls sie es je geändert hat).
      syncRTLFlag(locale);

      return locale;
    })();
  }
  return initPromise;
}

/**
 * Wechselt die Sprache zur Laufzeit: i18next (löst Re-Render in allen
 * useTranslation()-Verbrauchern aus), Persistenz, RTL-Flag-Sync.
 * @returns restartRequired, wenn sich das native RTL-Flag geändert hat — der
 * Aufrufer (UI) zeigt in diesem Fall einen Neustart-Hinweis.
 */
export async function changeAppLanguage(
  locale: AppLocale,
): Promise<{ restartRequired: boolean }> {
  await i18next.changeLanguage(locale);
  await setStoredLanguage(locale);
  const restartRequired = syncRTLFlag(locale);
  return { restartRequired };
}

export { i18next };
export type { AppLocale };
export {
  DEFAULT_LOCALE,
  INTL_LOCALE_TAGS,
  LANGUAGE_NAMES,
  SUPPORTED_LOCALES,
  isRTLLocale,
} from "./config";
