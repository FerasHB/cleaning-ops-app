import { supabase } from "@/lib/supabase";
import { CreateJobInput, EmployeeOption, Job } from "@/types/job";

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
  profiles?:
    | {
        id: string;
        full_name: string;
      }
    | {
        id: string;
        full_name: string;
      }[]
    | null;
};

type EmployeeRow = {
  id: string;
  full_name: string;
};

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("de-DE");
}

function formatTimeRange(start: string | null, end: string | null): string {
  if (!start && !end) return "Keine Zeit";
  if (start && !end) return formatDateTime(start);
  if (!start && end) return formatDateTime(end);

  return `${formatDateTime(start!)} - ${formatDateTime(end!)}`;
}

function mapJob(row: JobRow): Job {
  
  return {
    id: row.id,
    customerName: row.customer_name,
    location: row.location_address,
    time: formatTimeRange(row.scheduled_start, row.scheduled_end),
    service: row.service_name,
    employeeId: row.assigned_to,
    employeeName: Array.isArray(row.profiles)
      ? row.profiles[0]?.full_name ?? null
      : row.profiles?.full_name ?? null,
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

export async function getEmployees(): Promise<EmployeeOption[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("role", "employee")
    .eq("is_active", true)
    .order("full_name", { ascending: true });

  if (error) {
    throw error;
  }

  return ((data ?? []) as EmployeeRow[]).map((item) => ({
    id: item.id,
    fullName: item.full_name,
  }));
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError) {
    throw authError;
  }

  const userId = authData.user?.id;

  if (!userId) {
    throw new Error("Kein eingeloggter Benutzer gefunden.");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("company_id, role")
    .eq("id", userId)
    .single();

  if (profileError) {
    throw new Error("Profil konnte nicht geladen werden.");
  }

  if (!profile) {
    throw new Error("Kein Profil für den aktuellen Benutzer gefunden.");
  }

  if (!profile.company_id) {
    throw new Error("Kein company_id im Profil gefunden.");
  }

  if (profile.role !== "admin") {
    throw new Error("Nur Admins dürfen Jobs erstellen.");
  }

  const payload = {
    company_id: profile.company_id,
    created_by: userId,
    assigned_to: input.employeeId ?? null,
    customer_name: input.customerName.trim(),
    service_name: input.service.trim(),
    location_address: input.location.trim(),
    scheduled_start: input.scheduledStart ?? null,
    scheduled_end: input.scheduledEnd ?? null,
    notes: input.notes?.trim() ? input.notes.trim() : null,
    status: "open" as const,
  };

  const { data, error } = await supabase
    .from("jobs")
    .insert(payload)
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
    .single();
console.log("Created job raw data:", data);
  if (error) {
    throw error;
  }
if (payload.assigned_to) {
  const { data: employee } = await supabase
    .from("profiles")
    .select("expo_push_token, full_name")
    .eq("id", payload.assigned_to)
    .single();

  if (employee?.expo_push_token) {
    await sendPushNotification(
      employee.expo_push_token,
      "Neuer Auftrag",
      `Du hast einen neuen Job: ${payload.service_name}`
    );
  }
}
  return mapJob(data as JobRow);
}

export async function startJob(jobId: string): Promise<string> {
  const timestamp = new Date().toISOString();

  const { error } = await supabase
    .from("jobs")
    .update({
      status: "in_progress",
      started_at: timestamp,
    })
    .eq("id", jobId);

  if (error) {
    throw error;
  }

  return timestamp;
}

export async function completeJob(jobId: string): Promise<string> {
  const timestamp = new Date().toISOString();

  const { error } = await supabase
    .from("jobs")
    .update({
      status: "completed",
      completed_at: timestamp,
    })
    .eq("id", jobId);

  if (error) {
    throw error;
  }

  return timestamp;
}

async function sendPushNotification(token: string, title: string, body: string) {
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: token,
      sound: "default",
      title,
      body,
    }),
  });
}