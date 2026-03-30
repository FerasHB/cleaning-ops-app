import React, { createContext, useContext, useState } from "react";
import { Job } from "../types/job";
import { initialJobs } from "./jobs";

type JobContextType = {
  jobs: Job[];
  startJob: (id: string) => void;
  completeJob: (id: string) => void;
  addJob: (job: Job) => void; // 👈 NEU
};
const JobContext = createContext<JobContextType | undefined>(undefined);

export const JobProvider = ({ children }: { children: React.ReactNode }) => {
  const [jobs, setJobs] = useState<Job[]>(initialJobs);

  const addJob = (job: Job) => {
    setJobs((prev) => [job, ...prev]);
  };

  const startJob = (id: string) => {
    setJobs((prev) =>
      prev.map((job) =>
        job.id === id ? { ...job, status: "In Progress" } : job,
      ),
    );
  };

  const completeJob = (id: string) => {
    setJobs((prev) =>
      prev.map((job) =>
        job.id === id ? { ...job, status: "Completed" } : job,
      ),
    );
  };

  return (
    <JobContext.Provider value={{ jobs, startJob, completeJob, addJob }}>
      {children}
    </JobContext.Provider>
  );
};

export const useJobs = () => {
  const context = useContext(JobContext);
  if (!context) {
    throw new Error("useJobs must be used within JobProvider");
  }
  return context;
};
