import { useAuth } from "@/context/AuthContext";
import {
  completeJob as completeJobService,
  createJob as createJobService,
  getEmployees as getEmployeesService,
  getJobs,
  startJob as startJobService,
} from "@/services/jobs/jobs.service";
import { CreateJobInput, EmployeeOption, Job } from "@/types/job";
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
  employees: EmployeeOption[];
  loading: boolean;
  error: string | null;
  refreshJobs: () => Promise<void>;
  refreshEmployees: () => Promise<void>;
  createJob: (input: CreateJobInput) => Promise<void>;
  startJob: (jobId: string) => Promise<void>;
  completeJob: (jobId: string) => Promise<void>;
};

const JobContext = createContext<JobContextType | undefined>(undefined);

export function JobProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
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
    }
  }, []);

  const refreshEmployees = useCallback(async () => {
    try {
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
      return;
    }

    const loadAll = async () => {
      try {
        setLoading(true);
        setError(null);
        await Promise.all([refreshJobs(), refreshEmployees()]);
      } finally {
        setLoading(false);
      }
    };

    loadAll();
  }, [session, refreshJobs, refreshEmployees]);

  const createJob = useCallback(async (input: CreateJobInput) => {
    try {
      const createdJob = await createJobService(input);
      setJobs((prevJobs) => [createdJob, ...prevJobs]);
    } catch (err) {
      console.error("Failed to create job:", err);
      throw err;
    }
  }, []);

  const startJob = useCallback(async (jobId: string) => {
    try {
      const startedAt = await startJobService(jobId);

      setJobs((prevJobs) =>
        prevJobs.map((job) =>
          job.id === jobId
            ? {
                ...job,
                status: "in_progress",
                startedAt,
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
      const completedAt = await completeJobService(jobId);

      setJobs((prevJobs) =>
        prevJobs.map((job) =>
          job.id === jobId
            ? {
                ...job,
                status: "completed",
                completedAt,
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
      employees,
      loading,
      error,
      refreshJobs,
      refreshEmployees,
      createJob,
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
