import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import {
  completeJob as completeJobService,
  createJob as createJobService,
  getEmployees as getEmployeesService,
  getJobs,
  startJob as startJobService,
  updateJob as updateJobService,
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

// Was der JobContext später für die App bereitstellt
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
  startJob: (jobId: string) => Promise<void>;
  completeJob: (jobId: string) => Promise<void>;
};

// Context erstellen
const JobContext = createContext<JobContextType | undefined>(undefined);

export function JobProvider({ children }: { children: React.ReactNode }) {
  // Prüfen, ob ein User eingeloggt ist
  const { session } = useAuth();

  // Liste aller Jobs
  const [jobs, setJobs] = useState<Job[]>([]);

  // Liste aller Mitarbeiter für Dropdown / Zuweisung
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);

  // Globaler Loading-State für Jobs + Mitarbeiter
  const [loading, setLoading] = useState(true);

  // Fehlertext, falls etwas schiefgeht
  const [error, setError] = useState<string | null>(null);

  // Jobs neu aus der DB laden
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

  // Mitarbeiter neu aus der DB laden
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
    // Wenn kein User eingeloggt ist → alles zurücksetzen
    if (!session) {
      setJobs([]);
      setEmployees([]);
      setLoading(false);
      return;
    }

    // Lädt beim Start Jobs und Mitarbeiter gleichzeitig
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

  useEffect(() => {
    // Ohne Session kein Realtime nötig
    if (!session) {
      return;
    }

    // Realtime-Channel für Änderungen an der jobs-Tabelle
    const channel = supabase
      .channel("jobs-realtime")
      .on(
        "postgres_changes",
        {
          event: "*", // reagiert auf INSERT, UPDATE, DELETE
          schema: "public",
          table: "jobs",
        },
        async (payload) => {
          console.log("Realtime jobs change:", payload.eventType);
          // Bei jeder Änderung Jobs neu laden
          await refreshJobs();
        },
      )
      .subscribe((status) => {
        console.log("Jobs realtime status:", status);
      });

    // Channel beim Unmount wieder sauber entfernen
    return () => {
      supabase.removeChannel(channel);
    };
  }, [session, refreshJobs]);

  // Neuen Job erstellen
  const createJob = useCallback(async (input: CreateJobInput) => {
    try {
      const createdJob = await createJobService(input);

      // Job nur hinzufügen, wenn er noch nicht durch Realtime in der Liste ist
      setJobs((prevJobs) => {
        const exists = prevJobs.some((job) => job.id === createdJob.id);

        if (exists) {
          return prevJobs;
        }

        return [createdJob, ...prevJobs];
      });

      console.log("Creating job with employeeId:", input.employeeId);
    } catch (err) {
      console.error("Failed to create job:", err);
      throw err;
    }
  }, []);

  // Bestehenden Job bearbeiten
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

        setJobs((prevJobs) =>
          prevJobs.map((job) => (job.id === updatedJob.id ? updatedJob : job)),
        );
      } catch (err) {
        console.error("Failed to update job:", err);
        throw err;
      }
    },
    [],
  );

  // Job starten
  const startJob = useCallback(async (jobId: string) => {
    try {
      const startedAt = await startJobService(jobId);

      // Status und Startzeit lokal direkt updaten
      setJobs((prevJobs) => {
        const exists = prevJobs.some((job) => job.id === jobId);

        if (!exists) {
          return prevJobs;
        }

        return prevJobs.map((job) =>
          job.id === jobId
            ? {
                ...job,
                status: "in_progress",
                startedAt,
              }
            : job,
        );
      });
    } catch (err) {
      console.error("Failed to start job:", err);
      throw err;
    }
  }, []);

  // Job abschließen
  const completeJob = useCallback(async (jobId: string) => {
    try {
      const completedAt = await completeJobService(jobId);

      // Status und Endzeit lokal direkt updaten
      setJobs((prevJobs) => {
        const exists = prevJobs.some((job) => job.id === jobId);

        if (!exists) {
          return prevJobs;
        }

        return prevJobs.map((job) =>
          job.id === jobId
            ? {
                ...job,
                status: "completed",
                completedAt,
              }
            : job,
        );
      });
    } catch (err) {
      console.error("Failed to complete job:", err);
      throw err;
    }
  }, []);

  // Alles, was im Context verfügbar sein soll
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
      startJob,
      completeJob,
    ],
  );

  return <JobContext.Provider value={value}>{children}</JobContext.Provider>;
}

// Eigener Hook für einfacheren Zugriff auf den JobContext
export function useJobs() {
  const context = useContext(JobContext);

  // Schutz, falls der Hook außerhalb vom Provider benutzt wird
  if (!context) {
    throw new Error("useJobs must be used within a JobProvider");
  }

  return context;
}
