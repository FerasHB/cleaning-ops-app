import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import {
  completeJob as completeJobService,
  createJob as createJobService,
  deleteJob as deleteJobService,
  getEmployees as getEmployeesService,
  getJobs,
  startJob as startJobService,
  updateJob as updateJobService,
} from "@/services/jobs/jobs.service";
import { applyPendingActionsToJobs } from "@/services/offline/jobs.merge";
import {
  addPendingJobAction,
  getPendingJobActions,
} from "@/services/offline/jobs.queue";
import { getCachedJobs, saveCachedJobs } from "@/services/offline/jobs.storage";
import { syncPendingJobActions } from "@/services/offline/jobs.sync";
import { CreateJobInput, EmployeeOption, Job } from "@/types/job";
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
  createJob: (input: CreateJobInput) => Promise<void>;
  updateJob: (input: {
    jobId: string;
    customerName: string;
    location: string;
    service: string;
    employeeId?: string | null;
    notes?: string | null;
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
  }) => Promise<void>;
  deleteJob: (jobId: string) => Promise<void>;
  startJob: (jobId: string) => Promise<void>;
  completeJob: (jobId: string) => Promise<void>;
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

export function JobProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guards gegen doppelte Initialisierung / parallele Syncs
  const didInitialLoadRef = useRef(false);
  const hasHandledFirstNetInfoEventRef = useRef(false);
  const syncInProgressRef = useRef(false);
  const refreshJobsInProgressRef = useRef(false);

  const runPendingSyncSafely = useCallback(async () => {
    if (syncInProgressRef.current) {
      return;
    }

    syncInProgressRef.current = true;

    try {
      await syncPendingJobActions();
    } finally {
      syncInProgressRef.current = false;
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    if (refreshJobsInProgressRef.current) {
      return;
    }

    refreshJobsInProgressRef.current = true;

    try {
      setError(null);

      const online = await isOnline();

      if (online) {
        const serverJobs = await getJobs();
        await saveCachedJobs(serverJobs);

        const pendingActions = await getPendingJobActions();
        const mergedJobs = applyPendingActionsToJobs(
          serverJobs,
          pendingActions,
        );

        setJobs(mergedJobs);
        return;
      }

      const cachedJobs = await getCachedJobs();
      const pendingActions = await getPendingJobActions();
      const mergedJobs = applyPendingActionsToJobs(cachedJobs, pendingActions);

      setJobs(mergedJobs);
    } catch (err: any) {
      console.error("Failed to load jobs:", err);

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

      setError(err?.message ?? "Jobs konnten nicht geladen werden.");
    } finally {
      refreshJobsInProgressRef.current = false;
    }
  }, []);

  const refreshEmployees = useCallback(async () => {
    try {
      const online = await isOnline();

      if (!online) {
        return;
      }

      const data = await getEmployeesService();
      setEmployees(data);
    } catch (err: any) {
      console.error("Failed to load employees:", err);
      setError(err?.message ?? "Mitarbeiter konnten nicht geladen werden.");
    }
  }, []);

  useEffect(() => {
    if (!session) {
      setJobs([]);
      setEmployees([]);
      setLoading(false);
      setError(null);

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
      try {
        setLoading(true);
        setError(null);

        await runPendingSyncSafely();
        await Promise.all([refreshJobs(), refreshEmployees()]);
      } finally {
        setLoading(false);
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
          console.log("Realtime jobs change:", payload.eventType);

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
        console.log("Jobs realtime status:", status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session, refreshJobs]);

  const createJob = useCallback(async (input: CreateJobInput) => {
    try {
      const createdJob = await createJobService(input);

      setJobs((prevJobs) => {
        const exists = prevJobs.some((job) => job.id === createdJob.id);
        const nextJobs: Job[] = exists ? prevJobs : [createdJob, ...prevJobs];

        saveCachedJobs(nextJobs).catch((err) =>
          console.error("Failed to cache jobs after create:", err),
        );

        return nextJobs;
      });

      console.log("Creating job with employeeId:", input.employeeId);
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

        return;
      }

      const timestamp = new Date().toISOString();

      await addPendingJobAction({
        type: "start_job",
        jobId,
        timestamp,
      });

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

        return;
      }

      const timestamp = new Date().toISOString();

      await addPendingJobAction({
        type: "complete_job",
        jobId,
        timestamp,
      });

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

  const value = useMemo(
    () => ({
      jobs,
      employees,
      loading,
      error,
      refreshJobs,
      refreshEmployees,
      createJob,
      updateJob,
      deleteJob,
      startJob,
      completeJob,
    }),
    [
      jobs,
      employees,
      loading,
      error,
      refreshJobs,
      refreshEmployees,
      createJob,
      updateJob,
      deleteJob,
      startJob,
      completeJob,
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
