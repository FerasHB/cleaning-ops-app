import { Job } from "@/types/job";
import { buildLegacyAssignees } from "@/utils/jobAssignees";
import AsyncStorage from "@react-native-async-storage/async-storage";

const JOBS_STORAGE_KEY = "offline_jobs_cache";

type StoredJobsPayload = {
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
 * Speichert die aktuelle Jobliste lokal im AsyncStorage.
 */
export async function saveCachedJobs(jobs: Job[]): Promise<void> {
  try {
    const payload: StoredJobsPayload = {
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
 * Lädt die lokal gespeicherten Jobs.
 * Wenn nichts vorhanden ist oder Daten kaputt sind, kommt [] zurück.
 */
export async function getCachedJobs(): Promise<Job[]> {
  try {
    const raw = await AsyncStorage.getItem(JOBS_STORAGE_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as StoredJobsPayload | null;

    if (!parsed || !Array.isArray(parsed.jobs)) {
      return [];
    }

    return parsed.jobs.map(normalizeCachedJob);
  } catch (error) {
    console.error("Failed to read cached jobs:", error);
    return [];
  }
}

/**
 * Liefert zusätzliche Cache-Infos zurück,
 * z.B. wann der Cache zuletzt aktualisiert wurde.
 */
export async function getCachedJobsPayload(): Promise<StoredJobsPayload | null> {
  try {
    const raw = await AsyncStorage.getItem(JOBS_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as StoredJobsPayload | null;

    if (!parsed || !Array.isArray(parsed.jobs)) {
      return null;
    }

    return { ...parsed, jobs: parsed.jobs.map(normalizeCachedJob) };
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