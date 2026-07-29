import AsyncStorage from "@react-native-async-storage/async-storage";

export type PendingJobActionType = "start_job" | "complete_job";

export type PendingJobAction =
  | {
      id: string;
      /** Besitzer der Aktion — nur DIESER Nutzer darf sie ausführen. */
      userId: string;
      type: "start_job";
      jobId: string;
      timestamp: string;
    }
  | {
      id: string;
      userId: string;
      type: "complete_job";
      jobId: string;
      timestamp: string;
    };

const JOBS_QUEUE_STORAGE_KEY = "offline_jobs_queue";

// v2: Warteschlange trägt Version + Besitzer je Aktion (vorher: nacktes Array
// ohne jede Zuordnung).
//
// SICHERHEIT — geteilte Geräte: Ohne Besitzer konnte die Sync-Routine die
// offline erfassten Aktionen von Nutzer A unter der Sitzung von Nutzer B
// ausführen. Serverseitig scheitern die meisten davon (start_own_job/
// complete_own_job verlangen assigned_to = auth.uid()), ABER im Sonderfall
// „B ist demselben Auftrag zugewiesen" wäre A's Aktion mit A's Zeitstempel
// unter B's Sitzung tatsächlich durchgelaufen — eine falsche Zuschreibung
// von Arbeitszeit.
export const JOBS_QUEUE_VERSION = 2;

type StoredQueuePayload = {
  version: number;
  actions: PendingJobAction[];
};

function generateActionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidAction(value: unknown): value is PendingJobAction {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<PendingJobAction>;
  return (
    typeof a.id === "string" &&
    typeof a.userId === "string" &&
    !!a.userId &&
    (a.type === "start_job" || a.type === "complete_job") &&
    typeof a.jobId === "string" &&
    typeof a.timestamp === "string"
  );
}

/**
 * Liest ALLE Aktionen aller Nutzer — ausschließlich für Schreibvorgänge
 * (Anhängen/Entfernen), damit fremde Aktionen beim Speichern erhalten bleiben.
 *
 * MIGRATION v1 → v2 (fail closed): Eine alte Nutzlast ist ein nacktes Array
 * ohne `userId`. Solche Aktionen lassen sich KEINEM Nutzer zuordnen. Sie
 * werden deshalb verworfen statt dem gerade angemeldeten Nutzer zugeschrieben
 * — Zuschreiben wäre genau der Fehler, den dieser Fix behebt (fremde Aktion
 * unter fremder Sitzung). Betroffen ist nur ein sehr schmales Fenster:
 * Aktionen, die vor dem Update offline erfasst und bis zum Update nicht
 * synchronisiert wurden.
 */
async function readAllActions(): Promise<PendingJobAction[]> {
  const raw = await AsyncStorage.getItem(JOBS_QUEUE_STORAGE_KEY);
  if (!raw) return [];

  const parsed = JSON.parse(raw) as unknown;

  // v1: nacktes Array ohne Version/Besitzer → nicht zuordenbar, verwerfen.
  if (Array.isArray(parsed)) {
    if (__DEV__) {
      console.warn(
        `[jobs.queue] Alte, nicht zuordenbare Warteschlange verworfen (${parsed.length} Aktion(en)).`,
      );
    }
    await AsyncStorage.removeItem(JOBS_QUEUE_STORAGE_KEY);
    return [];
  }

  const payload = parsed as Partial<StoredQueuePayload> | null;
  if (
    !payload ||
    payload.version !== JOBS_QUEUE_VERSION ||
    !Array.isArray(payload.actions)
  ) {
    await AsyncStorage.removeItem(JOBS_QUEUE_STORAGE_KEY);
    return [];
  }

  // Einzelne kaputte Einträge aussortieren, den Rest behalten.
  return payload.actions.filter(isValidAction);
}

/**
 * Alle Aktionen (aller Nutzer). Nur für Sync-/Speicherlogik, NICHT für die UI.
 */
export async function getAllPendingJobActions(): Promise<PendingJobAction[]> {
  try {
    return await readAllActions();
  } catch (error) {
    console.error("Failed to read offline jobs queue:", error);
    return [];
  }
}

/**
 * Aktionen DIESES Nutzers — Grundlage für Anzeige (Badge/Banner) und Sync.
 * Fremde Aktionen bleiben gespeichert, sind hier aber unsichtbar.
 */
export async function getPendingJobActions(
  userId: string | null,
): Promise<PendingJobAction[]> {
  // Kein angemeldeter Nutzer → keine Aktionen (fail closed).
  if (!userId) return [];

  const actions = await getAllPendingJobActions();
  return actions.filter((action) => action.userId === userId);
}

export async function savePendingJobActions(
  actions: PendingJobAction[],
): Promise<void> {
  try {
    const payload: StoredQueuePayload = {
      version: JOBS_QUEUE_VERSION,
      actions,
    };
    await AsyncStorage.setItem(JOBS_QUEUE_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error("Failed to save offline jobs queue:", error);
    throw error;
  }
}

/**
 * Hängt eine Aktion für DIESEN Nutzer an. Gibt die Aktionen des Nutzers
 * zurück (nicht die fremden) — passend für pendingCount/pendingActions.
 */
export async function addPendingJobAction(input: {
  userId: string;
  type: PendingJobActionType;
  jobId: string;
  timestamp?: string;
}): Promise<PendingJobAction[]> {
  const allActions = await getAllPendingJobActions();

  const base = {
    id: generateActionId(),
    userId: input.userId,
    jobId: input.jobId,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };

  const nextAction: PendingJobAction =
    input.type === "start_job"
      ? { ...base, type: "start_job" }
      : { ...base, type: "complete_job" };

  const nextAll = [...allActions, nextAction];
  await savePendingJobActions(nextAll);

  return nextAll.filter((action) => action.userId === input.userId);
}

/**
 * Entfernt eine erfolgreich synchronisierte Aktion. Fremde Aktionen bleiben
 * dabei unangetastet erhalten.
 */
export async function removePendingJobAction(
  actionId: string,
): Promise<PendingJobAction[]> {
  const allActions = await getAllPendingJobActions();
  const nextAll = allActions.filter((action) => action.id !== actionId);

  await savePendingJobActions(nextAll);

  return nextAll;
}

export async function clearPendingJobActions(): Promise<void> {
  try {
    await AsyncStorage.removeItem(JOBS_QUEUE_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to clear offline jobs queue:", error);
    throw error;
  }
}

/**
 * Optional hilfreich:
 * Gibt alle Actions DIESES Nutzers für einen bestimmten Job zurück.
 */
export async function getPendingActionsForJob(
  userId: string,
  jobId: string,
): Promise<PendingJobAction[]> {
  const actions = await getPendingJobActions(userId);
  return actions.filter((action) => action.jobId === jobId);
}