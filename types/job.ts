export type JobStatus = "Open" | "In Progress" | "Completed";

export type Job = {
  id: string;
  customer: string;
  location: string;
  time: string;
  service: string;
  employee: string;
  status: JobStatus;
};