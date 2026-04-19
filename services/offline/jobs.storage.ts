import { Job } from "@/types/job";
import AsyncStorage from "@react-native-async-storage/async-storage";

const JOBS_STORAGE_KEY = "offline_jobs_cache";

type StoredJobsPayload = {
  jobs: Job[];
  updatedAt: string;
};

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

    return parsed.jobs;
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

    return parsed;
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