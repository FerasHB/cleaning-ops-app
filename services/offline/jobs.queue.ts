import AsyncStorage from "@react-native-async-storage/async-storage";

export type PendingJobActionType = "start_job" | "complete_job";

// pending: wartet auf den nächsten Sync-Versuch (Normalfall).
// failed_permanent: der Server hat die Aktion inhaltlich/autoritativ
// abgelehnt (falsche App-Version, Abschluss ohne eigenen Start, Auftrag
// nicht mehr im passenden Status, …) — ein erneuter Versuch mit denselben
// Daten würde IMMER wieder dasselbe Ergebnis liefern. Wird deshalb nicht
// mehr automatisch erneut versucht, aber auch nicht stillschweigend
// gelöscht — sichtbar für den Nutzer, bis er sie ausdrücklich bestätigt
// (siehe dismissFailedJobAction).
export type PendingActionStatus = "pending" | "failed_permanent";

type PendingJobActionBase = {
  id: string;
  /** Besitzer der Aktion — nur DIESER Nutzer darf sie ausführen. */
  userId: string;
  jobId: string;
  timestamp: string;
  status: PendingActionStatus;
  /** Nur bei status="failed_permanent": die dem Nutzer bereits sicher
   *  anzeigbare Ablehnungsmeldung (toUserMessage-Ausgabe zum Zeitpunkt des
   *  Fehlschlags), damit die UI sie nicht erneut herleiten muss. */
  failureMessage?: string;
};

export type PendingJobAction =
  | (PendingJobActionBase & { type: "start_job" })
  | (PendingJobActionBase & { type: "complete_job" });

const JOBS_QUEUE_STORAGE_KEY = "offline_jobs_queue";

// v2: Warteschlange trägt Version + Besitzer je Aktion (vorher: nacktes Array
// ohne jede Zuordnung).
//
// SICHERHEIT — geteilte Geräte: Ohne Besitzer konnte die Sync-Routine die
// offline erfassten Aktionen von Nutzer A unter der Sitzung von Nutzer B
// ausführen. Ist B demselben Auftrag zugewiesen, läuft A's Aktion mit A's
// Zeitstempel unter B's Sitzung tatsächlich durch — eine falsche Zuschreibung
// von Arbeitszeit UND ein falscher started_by/completed_by.
//
// Seit Phase 7 („Shared Job Time", Migration 20260731000000) darf JEDER
// Zugewiesene starten und abschließen. Der Sonderfall „B ist demselben
// Auftrag zugewiesen" ist damit kein Randfall mehr, sondern bei
// mehrfach zugewiesenen Aufträgen der Normalfall — die Besitzer-Bindung
// dieser Warteschlange ist dadurch WICHTIGER geworden, nicht weniger wichtig.
//
// v3 (Client-Compatibility-Fundament, Migration 20260916120000): jede
// Aktion trägt jetzt `status`. v2-Zeilen sind weiterhin vollständig
// zuordenbar (userId vorhanden) — anders als der v1→v2-Sprung werden sie
// deshalb NICHT verworfen, sondern beim Lesen auf status="pending"
// hochgezogen (siehe readAllActions).
export const JOBS_QUEUE_VERSION = 3;

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
    typeof a.timestamp === "string" &&
    (a.status === "pending" || a.status === "failed_permanent")
  );
}

// v2-Zeile (vor status) auf v3 hochziehen — vollständig zuordenbar, deshalb
// keine Verwerfung wie beim v1→v2-Sprung (siehe readAllActions).
function migrateV2Action(value: unknown): PendingJobAction | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Partial<PendingJobAction>;
  if (
    typeof a.id !== "string" ||
    typeof a.userId !== "string" ||
    !a.userId ||
    (a.type !== "start_job" && a.type !== "complete_job") ||
    typeof a.jobId !== "string" ||
    typeof a.timestamp !== "string"
  ) {
    return null;
  }
  return { ...a, type: a.type, status: "pending" } as PendingJobAction;
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
  if (!payload || !Array.isArray(payload.actions)) {
    await AsyncStorage.removeItem(JOBS_QUEUE_STORAGE_KEY);
    return [];
  }

  // v2 → v3: status fehlt, aber die Zeilen sind vollständig zuordenbar —
  // hochziehen statt verwerfen (siehe JOBS_QUEUE_VERSION-Kommentar).
  if (payload.version === 2) {
    return payload.actions
      .map(migrateV2Action)
      .filter((a): a is PendingJobAction => a !== null);
  }

  if (payload.version !== JOBS_QUEUE_VERSION) {
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
    status: "pending" as const,
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
 * Entfernt eine Aktion endgültig — sowohl für den Erfolgsfall (erfolgreich
 * synchronisiert) als auch für das bewusste Bestätigen/Ausblenden eines
 * dauerhaft fehlgeschlagenen Eintrags durch den Nutzer (dismissFailedJobAction
 * unten ruft dieselbe Funktion auf). Fremde Aktionen bleiben unangetastet.
 */
export async function removePendingJobAction(
  actionId: string,
): Promise<PendingJobAction[]> {
  const allActions = await getAllPendingJobActions();
  const nextAll = allActions.filter((action) => action.id !== actionId);

  await savePendingJobActions(nextAll);

  return nextAll;
}

/**
 * Markiert eine Aktion als DAUERHAFT fehlgeschlagen (server-autoritative
 * Ablehnung, z. B. falsche App-Version, Abschluss ohne eigenen Start, Auftrag
 * nicht mehr im passenden Status) — wird NICHT gelöscht (kein stiller
 * Datenverlust) und NICHT weiter automatisch erneut versucht (ein erneuter
 * Versuch mit denselben Daten würde immer wieder dasselbe Ergebnis liefern).
 * Bleibt sichtbar, bis der Nutzer sie ausdrücklich bestätigt
 * (removePendingJobAction/dismissFailedJobAction).
 */
export async function markPendingJobActionFailed(
  actionId: string,
  failureMessage: string,
): Promise<PendingJobAction[]> {
  const allActions = await getAllPendingJobActions();
  const nextAll = allActions.map((action) =>
    action.id === actionId
      ? { ...action, status: "failed_permanent" as const, failureMessage }
      : action,
  );

  await savePendingJobActions(nextAll);

  return nextAll;
}

/**
 * Bestätigt/entfernt einen dauerhaft fehlgeschlagenen Eintrag — löscht NUR
 * den lokalen Warteschlangen-Eintrag, verändert nie den Server-Zustand (der
 * Auftrag selbst ist davon nie betroffen, die Aktion ist ja nie erfolgreich
 * ausgeführt worden).
 */
export async function dismissFailedJobAction(
  actionId: string,
): Promise<PendingJobAction[]> {
  return removePendingJobAction(actionId);
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