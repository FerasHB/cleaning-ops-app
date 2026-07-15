// services/offline/profile.storage.ts
// Lokaler Cache für das eigene Auth-Profil (analog zu jobs.storage.ts für Jobs).
// Zweck: Bei einem OFFLINE-Start kann die App das zuletzt bekannte Profil aus
// dem Cache laden, statt endlos auf den Server zu warten. Der Cache wird an die
// User-ID gebunden — auf geteilten Geräten darf das Profil eines anderen Nutzers
// niemals herangezogen werden.
//
// SICHERHEIT (is_active): Der Cache enthält bewusst auch das is_active-Flag.
// Ein zuletzt als deaktiviert bekanntes Profil wird beim Offline-Start NICHT
// wiederhergestellt (siehe AuthContext.loadAndApplyProfile). Bei Reconnect wird
// das Profil zudem frisch geladen und der Deaktiviert-Status erneut geprüft.

import type { AuthProfile } from "@/services/profileService";
import AsyncStorage from "@react-native-async-storage/async-storage";

const PROFILE_STORAGE_KEY = "offline_profile_cache";

type StoredProfilePayload = {
  userId: string;
  profile: AuthProfile;
  updatedAt: string;
};

/**
 * Speichert das aktuelle Profil lokal (an die User-ID gebunden).
 * Best effort — ein Cache-Fehler darf den Auth-Fluss nie blockieren.
 */
export async function saveCachedProfile(profile: AuthProfile): Promise<void> {
  try {
    const payload: StoredProfilePayload = {
      userId: profile.id,
      profile,
      updatedAt: new Date().toISOString(),
    };

    await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error("Failed to save cached profile:", error);
  }
}

/**
 * Lädt das gecachte Profil — aber NUR, wenn es zur erwarteten User-ID gehört.
 * Bei fehlendem/kaputtem Cache oder abweichender User-ID kommt null zurück.
 */
export async function getCachedProfile(
  userId: string,
): Promise<AuthProfile | null> {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as StoredProfilePayload | null;

    if (!parsed || !parsed.profile || parsed.userId !== userId) {
      return null;
    }

    return parsed.profile;
  } catch (error) {
    console.error("Failed to read cached profile:", error);
    return null;
  }
}

/**
 * Löscht das gecachte Profil (bei Logout und erzwungenem Deaktivierungs-Logout).
 */
export async function clearCachedProfile(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PROFILE_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to clear cached profile:", error);
  }
}
