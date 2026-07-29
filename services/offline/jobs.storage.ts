import { Job } from "@/types/job";
import { buildLegacyAssignees } from "@/utils/jobAssignees";
import AsyncStorage from "@react-native-async-storage/async-storage";

const JOBS_STORAGE_KEY = "offline_jobs_cache";

// v2: Cache ist an die User-ID gebunden (vorher: eine einzige globale Liste).
//
// SICHERHEIT — geteilte Geräte: Vor v2 trug der Cache weder Version noch
// Besitzer. Meldete sich Nutzer A ab und Nutzer B an, las JobContext beim
// Start unmittelbar diesen Cache und rendert A's Aufträge (Kunden, Adressen,
// Notizen, Kolleginnen) in B's Oberfläche — online bis zum ersten Refresh,
// OFFLINE dauerhaft. Genau dieselbe Absicherung existiert seit v2 bereits für
// den Profil-Cache (services/offline/profile.storage.ts) und wird hier
// bewusst 1:1 gespiegelt.
//
// Der Version-Bump invalidiert automatisch jeden älteren (unscoped) Cache:
// eine Nutzlast ohne `version`/`userId` lässt sich keinem Nutzer zuordnen und
// wird deshalb FAIL-CLOSED verworfen statt geraten.
export const JOBS_CACHE_VERSION = 2;

type StoredJobsPayload = {
  version: number;
  userId: string;
  jobs: Job[];
  updatedAt: string;
};

/**
 * Hebt einen Job aus einem ÄLTEREN Cache auf das Phase-5-Format an.
 *
 * Warum das nötig ist: der Cache überlebt das App-Update. Ein vor Phase 5
 * geschriebener Eintrag kennt `assignees` nicht. Ohne diesen Shim zeigte der
 * erste (offline) Kaltstart nach dem Update überall „Nicht zugewiesen" —
 * eine sichtbare Regression genau in der Situation, für die der Cache da ist.
 *
 * Die Ableitung teilt sich die Logik mit dem Fallback in `readBackJob()`
 * (services/jobs/jobs.service.ts) — beide stehen vor demselben Problem:
 * nur der Legacy-Zeiger ist bekannt. Deshalb EIN gemeinsamer Helfer, damit
 * die beiden Pfade nicht auseinanderlaufen (genau das war ein Review-Befund).
 *
 * Der Shim stellt den vorherigen Informationsstand her, nicht mehr: vor dem
 * Update wurde ohnehin nur dieser eine Mitarbeiter angezeigt. Beim ersten
 * erfolgreichen Online-Refresh kommt die echte Menge nach.
 */
function normalizeCachedJob(job: Job): Job {
  if (Array.isArray(job.assignees)) return job;
  return { ...job, assignees: buildLegacyAssignees(job) };
}

/**
 * Liest die Nutzlast und gibt sie NUR zurück, wenn Version UND Besitzer
 * stimmen. Jede Abweichung (alte Version, fremder/fehlender Nutzer, kaputte
 * Daten) gilt als „kein Cache" — fail closed, nie geraten.
 */
async function readOwnedPayload(
  userId: string,
): Promise<StoredJobsPayload | null> {
  const raw = await AsyncStorage.getItem(JOBS_STORAGE_KEY);
  if (!raw) return null;

  const parsed = JSON.parse(raw) as Partial<StoredJobsPayload> | null;
  if (!parsed) return null;

  // Alte Cache-Version / fremder User / kaputte Daten → nicht verwenden.
  if (parsed.version !== JOBS_CACHE_VERSION) return null;
  if (!parsed.userId || parsed.userId !== userId) return null;
  if (!Array.isArray(parsed.jobs)) return null;

  return {
    version: parsed.version,
    userId: parsed.userId,
    jobs: parsed.jobs.map(normalizeCachedJob),
    updatedAt: parsed.updatedAt ?? "",
  };
}

/**
 * Speichert die aktuelle Jobliste lokal im AsyncStorage — gebunden an den
 * Nutzer, dem die Daten gehören.
 *
 * Es gibt bewusst weiterhin nur EINEN Schlüssel: der Cache des zuletzt aktiven
 * Nutzers überschreibt den vorherigen. Mehrere Nutzer-Caches parallel zu halten
 * würde auf einem geteilten Gerät fremde Firmendaten unbegrenzt aufbewahren —
 * genau das soll dieser Fix verhindern.
 */
export async function saveCachedJobs(
  userId: string | null,
  jobs: Job[],
): Promise<void> {
  // Ohne bekannten Besitzer wird NICHT geschrieben — ein Cache ohne Zuordnung
  // wäre beim nächsten Lesen ohnehin ungültig (fail closed).
  if (!userId) return;

  try {
    const payload: StoredJobsPayload = {
      version: JOBS_CACHE_VERSION,
      userId,
      jobs,
      updatedAt: new Date().toISOString(),
    };

    await AsyncStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error("Failed to save cached jobs:", error);
    throw error;
  }
}

/**
 * Lädt die lokal gespeicherten Jobs DIESES Nutzers.
 * Fremder/alter/kaputter Cache → [] (nie die Daten eines anderen Nutzers).
 */
export async function getCachedJobs(userId: string | null): Promise<Job[]> {
  // Kein angemeldeter Nutzer → kein Cache-Zugriff (fail closed).
  if (!userId) return [];

  try {
    const payload = await readOwnedPayload(userId);
    return payload?.jobs ?? [];
  } catch (error) {
    console.error("Failed to read cached jobs:", error);
    return [];
  }
}

/**
 * Liefert zusätzliche Cache-Infos zurück (z.B. wann zuletzt aktualisiert) —
 * ebenfalls nur für den Besitzer des Caches.
 */
export async function getCachedJobsPayload(
  userId: string | null,
): Promise<StoredJobsPayload | null> {
  if (!userId) return null;

  try {
    return await readOwnedPayload(userId);
  } catch (error) {
    console.error("Failed to read cached jobs payload:", error);
    return null;
  }
}

/**
 * Löscht den lokalen Job-Cache komplett.
 */
export async function clearCachedJobs(): Promise<void> {
  try {
    await AsyncStorage.removeItem(JOBS_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to clear cached jobs:", error);
    throw error;
  }
}