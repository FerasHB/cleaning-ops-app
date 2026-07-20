import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import {
  completeJob as completeJobService,
  createJob as createJobService,
  deleteJob as deleteJobService,
  getEmployees as getEmployeesService,
  setEmployeeActive as setEmployeeActiveService,
  getJobs,
  startJob as startJobService,
  updateJob as updateJobService,
} from "@/services/jobs/jobs.service";
import {
  getUnreadCommentJobIds,
  markJobCommentsAsRead as markJobCommentsAsReadService,
} from "@/services/comments/comments.service";
import { dispatchAdminNotifications } from "@/services/notifications/adminNotifications";
import { applyPendingActionsToJobs } from "@/services/offline/jobs.merge";
import {
  addPendingJobAction,
  getPendingJobActions,
  PendingJobAction,
} from "@/services/offline/jobs.queue";
import { getCachedJobs, saveCachedJobs } from "@/services/offline/jobs.storage";
import { syncPendingJobActions } from "@/services/offline/jobs.sync";
import { CreateJobInput, EmployeeOption, Job, JobType } from "@/types/job";
import { isNetworkError } from "@/utils/networkError";
import NetInfo from "@react-native-community/netinfo";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type JobContextType = {
  jobs: Job[];
  employees: EmployeeOption[];
  loading: boolean;
  error: string | null;
  refreshJobs: () => Promise<void>;
  refreshEmployees: () => Promise<void>;
  // Setzt den Aktiv-Status eines Mitarbeiters und lädt die Liste neu.
  setEmployeeActive: (employeeId: string, active: boolean) => Promise<void>;
  // Gibt zurück, ob die Recurring-Occurrence-Generierung fehlschlug, damit die
  // UI zwischen vollem Erfolg und Teil-Erfolg (Job angelegt, Termine fehlen)
  // unterscheiden kann.
  createJob: (
    input: CreateJobInput,
  ) => Promise<{ recurringOccurrencesFailed: boolean }>;
  updateJob: (input: {
    jobId: string;
    customerName: string;
    location: string;
    service: string;
    employeeId?: string | null;
    notes?: string | null;
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
    jobType: JobType;
    date?: string | null;
    startTime?: string | null;
    recurringDays?: string[] | null;
    isActive?: boolean;
    recurrenceStartDate?: string | null;
    recurrenceEndDate?: string | null;
  }) => Promise<void>;
  deleteJob: (jobId: string) => Promise<void>;
  startJob: (jobId: string) => Promise<void>;
  completeJob: (jobId: string) => Promise<void>;
  // Markiert die Kommentare eines Jobs als gesehen (entfernt den roten Punkt).
  markJobCommentsAsRead: (jobId: string) => Promise<void>;

  // ── Nur lesbare UI-State-Werte für die Save-Status-Anzeige ──
  // (keine neue Offline-Logik — nur sichtbar gemachte Queue-/Netz-Infos)
  online: boolean;
  pendingCount: number;
  pendingActions: PendingJobAction[];
  isSyncing: boolean;
  syncFailed: boolean;
  retrySync: () => Promise<void>;
};

const JobContext = createContext<JobContextType | undefined>(undefined);

async function isOnline(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return !!state.isConnected;
}

function updateJobInList(
  jobs: Job[],
  jobId: string,
  updates: Partial<Job>,
): Job[] {
  return jobs.map((job): Job => {
    if (job.id !== jobId) {
      return job;
    }

    return {
      ...job,
      ...updates,
    };
  });
}

// Setzt das hasUnreadComments-Flag anhand der ungelesenen Job-IDs.
// Reines In-Memory-Merging — der Cache bleibt unberührt (Offline-Services
// werden nicht angefasst).
function mergeUnreadFlags(jobs: Job[], unreadJobIds: string[]): Job[] {
  const unreadSet = new Set(unreadJobIds);
  return jobs.map((job): Job => ({
    ...job,
    hasUnreadComments: unreadSet.has(job.id),
  }));
}

export function JobProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Lesbare Save-Status-Werte (UI-only)
  const [online, setOnline] = useState(true);
  const [pendingActions, setPendingActions] = useState<PendingJobAction[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);

  // Guards gegen doppelte Initialisierung / parallele Syncs
  const didInitialLoadRef = useRef(false);
  const hasHandledFirstNetInfoEventRef = useRef(false);
  const syncInProgressRef = useRef(false);
  const refreshJobsInProgressRef = useRef(false);

  const refreshPendingState = useCallback(async () => {
    const actions = await getPendingJobActions();
    setPendingActions(actions);
    setPendingCount(actions.length);
  }, []);

  const runPendingSyncSafely = useCallback(async () => {
    if (syncInProgressRef.current) {
      return;
    }

    syncInProgressRef.current = true;
    setIsSyncing(true);
    if (__DEV__) {
      console.log("[Jobs] Queue-Sync gestartet");
    }

    try {
      const result = await syncPendingJobActions();
      setSyncFailed(result.failed > 0);
    } finally {
      syncInProgressRef.current = false;
      setIsSyncing(false);
      await refreshPendingState();
      if (__DEV__) {
        console.log("[Jobs] Queue-Sync beendet");
      }
    }
  }, [refreshPendingState]);

  const refreshJobs = useCallback(async () => {
    if (refreshJobsInProgressRef.current) {
      return;
    }

    refreshJobsInProgressRef.current = true;

    try {
      setError(null);

      const online = await isOnline();

      if (online) {
        if (__DEV__) {
          console.log("[Jobs] Quelle: remote");
        }
        const serverJobs = await getJobs();
        await saveCachedJobs(serverJobs);

        const pendingActions = await getPendingJobActions();
        const mergedJobs = applyPendingActionsToJobs(
          serverJobs,
          pendingActions,
        );

        // Ungelesene Kommentare best-effort dazumergen (online-only).
        // Schlägt das fehl, zeigen wir die Jobs trotzdem (ohne Punkt).
        let unreadJobIds: string[] = [];
        try {
          unreadJobIds = await getUnreadCommentJobIds();
        } catch (unreadErr) {
          // Netzwerkfehler hier erwartbar (Verbindung verloren) → kein Redbox.
          if (!isNetworkError(unreadErr)) {
            console.error("Failed to load unread comment job ids:", unreadErr);
          }
        }

        setJobs(mergeUnreadFlags(mergedJobs, unreadJobIds));
        return;
      }

      if (__DEV__) {
        console.log("[Jobs] Quelle: cache (offline)");
      }
      const cachedJobs = await getCachedJobs();
      const pendingActions = await getPendingJobActions();
      const mergedJobs = applyPendingActionsToJobs(cachedJobs, pendingActions);

      setJobs(mergedJobs);
    } catch (err: any) {
      // Erwartete Offline-/Netzwerkfehler nicht als harten Fehler behandeln:
      // kein console.error (sonst Redbox im Dev), kein setError. Cache laden.
      const networkError = isNetworkError(err);

      if (!networkError) {
        console.error("Failed to load jobs:", err);
      } else if (__DEV__) {
        console.warn("Jobs offline geladen (kein Netz) — nutze Cache.");
      }

      try {
        const cachedJobs = await getCachedJobs();
        const pendingActions = await getPendingJobActions();
        const mergedJobs = applyPendingActionsToJobs(
          cachedJobs,
          pendingActions,
        );

        setJobs(mergedJobs);
      } catch (cacheErr) {
        console.error("Failed to load cached jobs:", cacheErr);
      }

      // Bei Netzwerkfehler keinen Fehler-State setzen — Offline ist erwartbar
      // und der Cache wurde bereits geladen. Nur echte Fehler sichtbar machen.
      if (!networkError) {
        setError(err?.message ?? "Jobs konnten nicht geladen werden.");
      }
    } finally {
      refreshJobsInProgressRef.current = false;
      await refreshPendingState();
    }
  }, [refreshPendingState]);

  const retrySync = useCallback(async () => {
    await runPendingSyncSafely();
    await refreshJobs();
  }, [runPendingSyncSafely, refreshJobs]);

  const refreshEmployees = useCallback(async () => {
    try {
      const online = await isOnline();

      if (!online) {
        return;
      }

      const data = await getEmployeesService();
      setEmployees(data);
    } catch (err: any) {
      // Netzwerkfehler (Verbindung mitten im Request verloren) ist erwartbar —
      // kein Redbox, kein Fehler-State. Nur echte Fehler sichtbar machen.
      if (isNetworkError(err)) {
        if (__DEV__) {
          console.warn("Mitarbeiter offline nicht geladen (kein Netz).");
        }
        return;
      }
      console.error("Failed to load employees:", err);
      setError(err?.message ?? "Mitarbeiter konnten nicht geladen werden.");
    }
  }, []);

  // Mitarbeiter deaktivieren/reaktivieren. Schreibt direkt auf profiles.is_active
  // (unter Admin-RLS) und lädt danach die Liste neu, damit Badge/Picker stimmen.
  const setEmployeeActive = useCallback(
    async (employeeId: string, active: boolean) => {
      await setEmployeeActiveService(employeeId, active);
      await refreshEmployees();
    },
    [refreshEmployees],
  );

  useEffect(() => {
    if (!session) {
      setJobs([]);
      setEmployees([]);
      setLoading(false);
      setError(null);
      setPendingActions([]);
      setPendingCount(0);
      setIsSyncing(false);
      setSyncFailed(false);

      didInitialLoadRef.current = false;
      hasHandledFirstNetInfoEventRef.current = false;
      syncInProgressRef.current = false;
      refreshJobsInProgressRef.current = false;
      return;
    }

    if (didInitialLoadRef.current) {
      return;
    }

    didInitialLoadRef.current = true;

    const loadAll = async () => {
      // 1) SOFORT aus dem lokalen Cache rendern. loading wird ausschließlich vom
      //    lokalen Cache-Laden gesteuert — NICHT vom Netzwerk. Damit kann ein
      //    (offline) hängender Remote-Request den Tab-/Root-Render niemals
      //    blockieren. Genau hier lag der Offline-Kaltstart-Spinner: loadAll
      //    wartete auf refreshJobs()/refreshEmployees(), deren Remote-Call bei
      //    schlechtem/erstem NetInfo-Status hängen blieb, bevor loading=false lief.
      setError(null);
      try {
        const [cachedJobs, pending] = await Promise.all([
          getCachedJobs(),
          getPendingJobActions(),
        ]);
        setJobs(applyPendingActionsToJobs(cachedJobs, pending));
        setPendingActions(pending);
        setPendingCount(pending.length);
      } catch (err) {
        console.error("Failed to load cached jobs on init:", err);
      } finally {
        setLoading(false);
      }

      // 2) Danach im HINTERGRUND: Online-Status ermitteln und – nur wenn online –
      //    synchronisieren + frische Daten laden. KEIN loading-Gate mehr; ein
      //    hängender Remote-Request betrifft nur die Aktualisierung, nie den Render.
      const online = await isOnline();
      setOnline(online);

      if (!online) {
        // Offline: der Cache genügt. Der NetInfo-Listener synchronisiert bei
        // Reconnect automatisch (siehe Effect unten).
        return;
      }

      try {
        await runPendingSyncSafely();
        await Promise.all([refreshJobs(), refreshEmployees()]);
      } catch (err) {
        if (__DEV__) {
          console.warn("[Jobs] Hintergrund-Refresh fehlgeschlagen:", err);
        }
      }
    };

    loadAll();
  }, [session, refreshJobs, refreshEmployees, runPendingSyncSafely]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const unsubscribe = NetInfo.addEventListener(async (state) => {
      const online = !!state.isConnected;
      setOnline(online);

      // Erstes Event beim Mount ignorieren,
      // weil NetInfo direkt den aktuellen Zustand liefert
      if (!hasHandledFirstNetInfoEventRef.current) {
        hasHandledFirstNetInfoEventRef.current = true;
        return;
      }

      if (!online) {
        return;
      }

      try {
        await runPendingSyncSafely();
        await refreshJobs();
      } catch (err) {
        console.error("Failed to sync after reconnect:", err);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [session, refreshJobs, runPendingSyncSafely]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const channel = supabase
      .channel("jobs-realtime")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "jobs",
        },
        async (payload) => {
          if (__DEV__) {
            console.log("Realtime jobs change:", payload.eventType);
          }

          try {
            const online = await isOnline();

            if (!online) {
              return;
            }

            await refreshJobs();
          } catch (err) {
            console.error("Realtime refresh failed:", err);
          }
        },
      )
      .subscribe((status) => {
        if (__DEV__) {
          console.log("Jobs realtime status:", status);
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session, refreshJobs]);

  const createJob = useCallback(async (input: CreateJobInput) => {
    try {
      const { job: createdJob, recurringOccurrencesFailed } =
        await createJobService(input);

      setJobs((prevJobs) => {
        const exists = prevJobs.some((job) => job.id === createdJob.id);
        const nextJobs: Job[] = exists ? prevJobs : [createdJob, ...prevJobs];

        saveCachedJobs(nextJobs).catch((err) =>
          console.error("Failed to cache jobs after create:", err),
        );

        return nextJobs;
      });

      if (__DEV__) {
        console.log("Creating job with employeeId:", input.employeeId);
      }

      return { recurringOccurrencesFailed };
    } catch (err) {
      console.error("Failed to create job:", err);
      throw err;
    }
  }, []);

  const updateJob = useCallback(
    async (input: {
      jobId: string;
      customerName: string;
      location: string;
      service: string;
      employeeId?: string | null;
      notes?: string | null;
      scheduledStart?: string | null;
      scheduledEnd?: string | null;
      jobType: JobType;
      date?: string | null;
      startTime?: string | null;
      recurringDays?: string[] | null;
      isActive?: boolean;
    }) => {
      try {
        const updatedJob = await updateJobService(input);

        setJobs((prevJobs) => {
          const nextJobs: Job[] = prevJobs.map(
            (job): Job => (job.id === updatedJob.id ? updatedJob : job),
          );

          saveCachedJobs(nextJobs).catch((err) =>
            console.error("Failed to cache jobs after update:", err),
          );

          return nextJobs;
        });
      } catch (err) {
        console.error("Failed to update job:", err);
        throw err;
      }
    },
    [],
  );

  const deleteJob = useCallback(async (jobId: string) => {
    try {
      await deleteJobService(jobId);

      setJobs((prevJobs) => {
        const nextJobs: Job[] = prevJobs.filter((job) => job.id !== jobId);

        saveCachedJobs(nextJobs).catch((err) =>
          console.error("Failed to cache jobs after delete:", err),
        );

        return nextJobs;
      });
    } catch (err) {
      console.error("Failed to delete job:", err);
      throw err;
    }
  }, []);

  const startJob = useCallback(async (jobId: string) => {
    try {
      const online = await isOnline();

      if (online) {
        const startedAt = await startJobService(jobId);

        setJobs((prevJobs) => {
          const nextJobs = updateJobInList(prevJobs, jobId, {
            status: "in_progress",
            startedAt,
          });

          saveCachedJobs(nextJobs).catch((err) =>
            console.error("Failed to cache jobs after start:", err),
          );

          return nextJobs;
        });

        // Admin-Push serverseitig anstoßen (best effort — kein await, kein
        // Einfluss auf den bereits erfolgten Statuswechsel).
        void dispatchAdminNotifications();

        return;
      }

      const timestamp = new Date().toISOString();

      const nextActions = await addPendingJobAction({
        type: "start_job",
        jobId,
        timestamp,
      });
      setPendingActions(nextActions);
      setPendingCount(nextActions.length);

      setJobs((prevJobs) => {
        const nextJobs = updateJobInList(prevJobs, jobId, {
          status: "in_progress",
          startedAt: timestamp,
        });

        saveCachedJobs(nextJobs).catch((err) =>
          console.error("Failed to cache jobs after offline start:", err),
        );

        return nextJobs;
      });
    } catch (err) {
      console.error("Failed to start job:", err);
      throw err;
    }
  }, []);

  const completeJob = useCallback(async (jobId: string) => {
    try {
      const online = await isOnline();

      if (online) {
        const completedAt = await completeJobService(jobId);

        setJobs((prevJobs) => {
          const nextJobs = updateJobInList(prevJobs, jobId, {
            status: "completed",
            completedAt,
          });

          saveCachedJobs(nextJobs).catch((err) =>
            console.error("Failed to cache jobs after complete:", err),
          );

          return nextJobs;
        });

        // Admin-Push serverseitig anstoßen (best effort — kein await, kein
        // Einfluss auf den bereits erfolgten Statuswechsel).
        void dispatchAdminNotifications();

        return;
      }

      const timestamp = new Date().toISOString();

      const nextActions = await addPendingJobAction({
        type: "complete_job",
        jobId,
        timestamp,
      });
      setPendingActions(nextActions);
      setPendingCount(nextActions.length);

      setJobs((prevJobs) => {
        const nextJobs = updateJobInList(prevJobs, jobId, {
          status: "completed",
          completedAt: timestamp,
        });

        saveCachedJobs(nextJobs).catch((err) =>
          console.error("Failed to cache jobs after offline complete:", err),
        );

        return nextJobs;
      });
    } catch (err) {
      console.error("Failed to complete job:", err);
      throw err;
    }
  }, []);

  const markJobCommentsAsRead = useCallback(async (jobId: string) => {
    // Optimistisch sofort den Punkt entfernen (gute UX, kein Warten auf DB).
    setJobs((prevJobs) =>
      updateJobInList(prevJobs, jobId, { hasUnreadComments: false }),
    );

    try {
      await markJobCommentsAsReadService(jobId);
    } catch (err) {
      // Kein Revert: offline/Fehler → Punkt erscheint beim nächsten
      // refreshJobs ohnehin wieder. Keine Offline-Queue (bewusst).
      // Netzwerkfehler offline leise ignorieren (kein Redbox); nur echte
      // Fehler loggen.
      if (!isNetworkError(err)) {
        console.error("Failed to mark job comments as read:", err);
      }
    }
  }, []);

  const value = useMemo(
    () => ({
      jobs,
      employees,
      loading,
      error,
      refreshJobs,
      refreshEmployees,
      setEmployeeActive,
      createJob,
      updateJob,
      deleteJob,
      startJob,
      completeJob,
      markJobCommentsAsRead,
      online,
      pendingCount,
      pendingActions,
      isSyncing,
      syncFailed,
      retrySync,
    }),
    [
      jobs,
      employees,
      loading,
      error,
      refreshJobs,
      refreshEmployees,
      setEmployeeActive,
      createJob,
      updateJob,
      deleteJob,
      startJob,
      completeJob,
      markJobCommentsAsRead,
      online,
      pendingCount,
      pendingActions,
      isSyncing,
      syncFailed,
      retrySync,
    ],
  );

  return <JobContext.Provider value={value}>{children}</JobContext.Provider>;
}

export function useJobs() {
  const context = useContext(JobContext);

  if (!context) {
    throw new Error("useJobs must be used within a JobProvider");
  }

  return context;
}
