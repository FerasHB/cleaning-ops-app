// i18n/resolveLocale.ts
// Sprach-Auflösung beim App-Start, in dieser Priorität:
//   1. Gespeicherte Nutzer-Sprache (AsyncStorage)
//   2. Gerätesprache (expo-localization)
//   3. Deutsch (DEFAULT_LOCALE)
// Eine nicht unterstützte Gerätesprache fällt auf Deutsch zurück (kein
// Teil-Match auf eine "ähnliche" Sprache).

import * as Localization from "expo-localization";
import { DEFAULT_LOCALE, type AppLocale, isSupportedLocale } from "./config";
import { getStoredLanguage } from "./storage";

/** Normalisiert einen BCP-47-Tag ("en-US") oder Sprachcode ("en") auf AppLocale. */
export function normalizeToAppLocale(
  tag: string | null | undefined,
): AppLocale {
  if (!tag) return DEFAULT_LOCALE;
  const base = tag.split("-")[0]?.toLowerCase();
  return isSupportedLocale(base) ? base : DEFAULT_LOCALE;
}

/** Bevorzugte Gerätesprache, auf eine unterstützte AppLocale normalisiert. */
export function getDeviceLocale(): AppLocale {
  const [primary] = Localization.getLocales();
  return normalizeToAppLocale(primary?.languageCode ?? primary?.languageTag);
}

export async function resolveInitialLocale(): Promise<AppLocale> {
  const stored = await getStoredLanguage();
  if (stored) return stored;
  return getDeviceLocale();
}
