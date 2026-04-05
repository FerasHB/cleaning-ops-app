export type JobStatus = "open" | "in_progress" | "completed";

export interface Job {
  id: string;
  customer: string;
  location: string;
  time: string;
  service: string;
  employee: string;
  status: JobStatus;
}