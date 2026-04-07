export type JobStatus = "open" | "in_progress" | "completed";

export type Job = {
  id: string;
  customerName: string;
  location: string;
  time: string;
  service: string;
  employeeId?: string | null;
  employeeName?: string | null;
  status: JobStatus;
  notes?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type CreateJobInput = {
  customerName: string;
  location: string;
  service: string;
  employeeId?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  notes?: string | null;
};

export type EmployeeOption = {
  id: string;
  fullName: string;
};