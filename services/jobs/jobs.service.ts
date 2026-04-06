import { supabase } from "@/lib/supabase";
import { Job } from "@/types/job";

type JobRow = {
  id: string;
  customer_name: string;
  service_name: string;
  location_address: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  status: "open" | "in_progress" | "completed";
  started_at: string | null;
  completed_at: string | null;
  notes: string | null;
  assigned_to: string | null;
  profiles?: {
    id: string;
    full_name: string;
  }[] | null;
};

function formatTimeRange(start: string | null, end: string | null): string {
  if (!start && !end) return "Keine Zeit";
  if (start && !end) return new Date(start).toLocaleString();
  if (!start && end) return new Date(end).toLocaleString();

  return `${new Date(start!).toLocaleString()} - ${new Date(end!).toLocaleString()}`;
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    customerName: row.customer_name.trim(),
    location: row.location_address.trim(),
    time: formatTimeRange(row.scheduled_start, row.scheduled_end),
    service: row.service_name.trim(),
    employeeId: row.assigned_to,
    employeeName: row.profiles?.[0]?.full_name ?? null,
    status: row.status,
    notes: row.notes,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function getJobs(): Promise<Job[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select(
      `
      id,
      customer_name,
      service_name,
      location_address,
      scheduled_start,
      scheduled_end,
      status,
      started_at,
      completed_at,
      notes,
      assigned_to,
      profiles:assigned_to (
        id,
        full_name
      )
    `
    )
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((item) => mapJob(item as JobRow));
}

export async function startJob(jobId: string): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "in_progress",
      started_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (error) {
    throw error;
  }
}

export async function completeJob(jobId: string): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (error) {
    throw error;
  }
}