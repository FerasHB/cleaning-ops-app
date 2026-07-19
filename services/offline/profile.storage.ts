// services/offline/profile.storage.ts
// Lokaler Cache für das eigene Auth-Profil (analog zu jobs.storage.ts für Jobs).
// Zweck: Bei einem OFFLINE-Start kann die App das zuletzt bekannte Profil aus
// dem Cache laden, statt endlos auf den Server zu warten. Der Cache wird an die
// User-ID gebunden — auf geteilten Geräten darf das Profil eines anderen Nutzers
// niemals herangezogen werden.
//
// WICHTIG (Vollständigkeit): Für das Routing braucht app/index eine gültige
// `role` (admin|employee). Ein unvollständiges Profil (role null) führte offline
// zu einem Dauerspinner, weil weder Admin- noch Employee-Tabs erreichbar sind.
// Deshalb wird NUR ein vollständiges Profil gecacht UND beim Lesen erneut auf
// Vollständigkeit + Cache-Version geprüft. Ein alter/unvollständiger Cache gilt
// als "kein Cache" → app/index zeigt offline einen klaren Fehlerbildschirm.
//
// SICHERHEIT (is_active): Der Cache enthält auch das is_active-Flag. Ein zuletzt
// als deaktiviert bekanntes Profil wird beim Offline-Start NICHT wiederhergestellt
// (siehe AuthContext.loadAndApplyProfile).

import type { AppRole, AuthProfile } from "@/services/profileService";
import AsyncStorage from "@react-native-async-storage/async-storage";

export const PROFILE_STORAGE_KEY = "offline_profile_cache";
// v2: vollständiges Profil (inkl. role/company_id) + Validierung beim Lesen.
// v3: Profil enthält invite_accepted_at (Einladungs-Flow). Bump nötig, damit
// ein älterer Cache ohne dieses Feld nicht fälschlich als "Einladung offen"
// gelesen wird (app/index.tsx leitet sonst bereits aktive Mitarbeiter
// fälschlich auf accept-invite um). Bump invalidiert automatisch jeden
// älteren/teilweisen Cache — beim nächsten Online-Start wird frisch geladen.
export const PROFILE_CACHE_VERSION = 3;

type StoredProfilePayload = {
  version: number;
  userId: string;
  profile: AuthProfile;
  updatedAt: string;
};

function isValidRole(role: unknown): role is AppRole {
  return role === "admin" || role === "employee";
}

// Vollständig genug für den Offline-Start: eindeutige Identität UND gültige
// Rolle. company_id DARF null sein (Admin vor Company-Setup) — app/index leitet
// dann nach /setup-company. Die Rolle ist das fürs Routing entscheidende Feld.
export function isCompleteProfile(
  p: AuthProfile | null | undefined,
): p is AuthProfile {
  return (
    !!p &&
    typeof p.id === "string" &&
    p.id.length > 0 &&
    isValidRole(p.role) &&
    typeof p.is_active === "boolean"
  );
}

/**
 * Speichert das aktuelle Profil lokal (an die User-ID + Cache-Version gebunden).
 * Nur VOLLSTÄNDIGE Profile werden gecacht — ein Teilprofil darf einen guten
 * Cache nie überschreiben. Best effort; ein Cache-Fehler blockiert nie den Auth-Fluss.
 */
export async function saveCachedProfile(profile: AuthProfile): Promise<void> {
  // Rolle für das Log VOR dem Type-Guard lesen (danach würde TS den Zweig zu
  // `never` verengen). Zur Laufzeit kann das Profil trotz Typ unvollständig sein.
  const roleForLog = (profile as unknown as { role?: unknown })?.role;
  if (!isCompleteProfile(profile)) {
    if (__DEV__) {
      console.warn(
        "saveCachedProfile: unvollständiges Profil NICHT gecacht (role:",
        roleForLog,
        ")",
      );
    }
    return;
  }

  try {
    const payload: StoredProfilePayload = {
      version: PROFILE_CACHE_VERSION,
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
 * Lädt das gecachte Profil — aber NUR, wenn Cache-Version, User-ID UND
 * Vollständigkeit stimmen. Sonst null (→ Offline-Fehlerzustand statt Spinner).
 */
export async function getCachedProfile(
  userId: string,
): Promise<AuthProfile | null> {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredProfilePayload> | null;
    if (!parsed) return null;

    // Alte Cache-Version / falscher User / unvollständiges Profil → nicht verwenden.
    if (parsed.version !== PROFILE_CACHE_VERSION) return null;
    if (parsed.userId !== userId) return null;
    if (!isCompleteProfile(parsed.profile ?? null)) return null;

    return parsed.profile as AuthProfile;
  } catch (error) {
    console.error("Failed to read cached profile:", error);
    return null;
  }
}

/**
 * NUR für Diagnose: liefert die ROHEN gecachten Werte (auch bei ungültigem/
 * altem Cache), damit sichtbar wird, WAS im Cache steht.
 */
export async function peekCachedProfileRaw(): Promise<{
  version: number | null;
  userId: string | null;
  role: string | null;
  companyId: string | null;
} | null> {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      version?: number;
      userId?: string;
      profile?: { role?: string; company_id?: string | null };
    } | null;
    return {
      version: parsed?.version ?? null,
      userId: parsed?.userId ?? null,
      role: parsed?.profile?.role ?? null,
      companyId: parsed?.profile?.company_id ?? null,
    };
  } catch {
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
