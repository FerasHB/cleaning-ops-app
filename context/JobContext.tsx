import { useAuth } from "@/context/AuthContext";
import {
  completeJob as completeJobService,
  getJobs,
  startJob as startJobService,
} from "@/services/jobs/jobs.service";
import { Job } from "@/types/job";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
type JobContextType = {
  jobs: Job[];
  loading: boolean;
  error: string | null;
  refreshJobs: () => Promise<void>;
  startJob: (jobId: string) => Promise<void>;
  completeJob: (jobId: string) => Promise<void>;
};

const JobContext = createContext<JobContextType | undefined>(undefined);

export function JobProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshJobs = useCallback(async () => {
    try {
      setError(null);
      const data = await getJobs();
      setJobs(data);
    } catch (err: any) {
      console.error("Failed to load jobs:", err);
      setError(err?.message ?? "Jobs konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session) {
      setJobs([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    refreshJobs();
  }, [session, refreshJobs]);

  const startJob = useCallback(async (jobId: string) => {
    try {
      await startJobService(jobId);

      setJobs((prevJobs) =>
        prevJobs.map((job) =>
          job.id === jobId
            ? {
                ...job,
                status: "in_progress",
                startedAt: new Date().toISOString(),
              }
            : job,
        ),
      );
    } catch (err) {
      console.error("Failed to start job:", err);
      throw err;
    }
  }, []);

  const completeJob = useCallback(async (jobId: string) => {
    try {
      await completeJobService(jobId);

      setJobs((prevJobs) =>
        prevJobs.map((job) =>
          job.id === jobId
            ? {
                ...job,
                status: "completed",
                completedAt: new Date().toISOString(),
              }
            : job,
        ),
      );
    } catch (err) {
      console.error("Failed to complete job:", err);
      throw err;
    }
  }, []);

  const value = useMemo(
    () => ({
      jobs,
      loading,
      error,
      refreshJobs,
      startJob,
      completeJob,
    }),
    [jobs, loading, error, refreshJobs, startJob, completeJob],
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
