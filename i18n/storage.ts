// i18n/storage.ts
// Persistenz der vom Nutzer gewählten Sprache. Ein AsyncStorage-Key,
// analog zu den bestehenden Persistenz-Stellen (services/offline/profile.storage.ts,
// services/auth/recoveryMode.ts).

import AsyncStorage from "@react-native-async-storage/async-storage";
import { type AppLocale, isSupportedLocale } from "./config";

export const LANGUAGE_STORAGE_KEY = "@taskops/language";

/** Gibt die gespeicherte Sprache zurück, oder null wenn keine (gültige) gespeichert ist. */
export async function getStoredLanguage(): Promise<AppLocale | null> {
  try {
    const stored = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isSupportedLocale(stored) ? stored : null;
  } catch {
    // AsyncStorage nicht verfügbar (z. B. sehr früher Boot-Fehler) — Aufrufer
    // fällt auf Gerätesprache/Default zurück, kein Absturz.
    return null;
  }
}

export async function setStoredLanguage(locale: AppLocale): Promise<void> {
  try {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    // Best-effort — ein fehlgeschlagenes Speichern soll den Sprachwechsel
    // in der laufenden Session nicht verhindern.
  }
}
