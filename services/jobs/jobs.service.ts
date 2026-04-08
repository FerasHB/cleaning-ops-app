import { supabase } from "@/lib/supabase";
import { CreateJobInput, EmployeeOption, Job } from "@/types/job";

// So sieht ein Job direkt aus der Datenbank aus
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

// Einfaches DB-Format für Mitarbeiter
type EmployeeRow = {
  id: string;
  full_name: string;
};
type UpdateJobInput = {
  jobId: string;
  customerName: string;
  location: string;
  service: string;
  employeeId?: string | null;
  notes?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
};

// Formatiert ein Datum / eine Uhrzeit schön auf Deutsch
function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("de-DE");
}

// Baut aus Start- und Endzeit einen lesbaren Zeittext
function formatTimeRange(start: string | null, end: string | null): string {
  // Wenn gar nichts gesetzt ist
  if (!start && !end) return "Keine Zeit";

  // Nur Start vorhanden
  if (start && !end) return formatDateTime(start);

  // Nur Ende vorhanden
  if (!start && end) return formatDateTime(end);

  // Wenn beides da ist → Bereich anzeigen
  return `${formatDateTime(start!)} - ${formatDateTime(end!)}`;
}

// Wandelt einen DB-Job in unser App-Job-Objekt um
function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    customerName: row.customer_name,
    location: row.location_address,
    time: formatTimeRange(row.scheduled_start, row.scheduled_end),
    service: row.service_name,
    employeeId: row.assigned_to,

    // profiles kann entweder ein Objekt, ein Array oder null sein
    // deshalb fangen wir hier alle Fälle ab
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

// Holt alle Jobs aus Supabase
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

  // DB-Daten in unser App-Format umwandeln
  return (data ?? []).map((item) => mapJob(item as JobRow));
}

// Holt alle aktiven Mitarbeiter für Auswahl / Zuweisung
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

  // full_name aus DB → fullName für die App
  return ((data ?? []) as EmployeeRow[]).map((item) => ({
    id: item.id,
    fullName: item.full_name,
  }));
}

// Erstellt einen neuen Job
export async function createJob(input: CreateJobInput): Promise<Job> {
  // Aktuellen User holen
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError) {
    throw authError;
  }

  const userId = authData.user?.id;

  // Sicherheitshalber prüfen, ob wirklich jemand eingeloggt ist
  if (!userId) {
    throw new Error("Kein eingeloggter Benutzer gefunden.");
  }

  // Profil vom aktuellen User laden
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

  // Ohne company_id kann der Job nicht korrekt angelegt werden
  if (!profile.company_id) {
    throw new Error("Kein company_id im Profil gefunden.");
  }

  // Nur Admins dürfen Jobs erstellen
  if (profile.role !== "admin") {
    throw new Error("Nur Admins dürfen Jobs erstellen.");
  }

  // Daten vorbereiten für den Insert in die jobs-Tabelle
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

  // Job in Supabase anlegen und direkt wieder zurückholen
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

  // Hilfreich fürs Debugging
  console.log("Created job raw data:", data);

  if (error) {
    throw error;
  }

  // Wenn ein Mitarbeiter direkt zugewiesen wurde,
  // versuchen wir eine Push-Nachricht zu schicken
  if (payload.assigned_to) {
    const { data: employee } = await supabase
      .from("profiles")
      .select("expo_push_token, full_name")
      .eq("id", payload.assigned_to)
      .single();

    // Nur senden, wenn wirklich ein Push-Token vorhanden ist
    if (employee?.expo_push_token) {
      await sendPushNotification(
        employee.expo_push_token,
        "Neuer Auftrag",
        `Du hast einen neuen Job: ${payload.service_name}`
      );
    }
  }

  // Rückgabe im App-Format
  return mapJob(data as JobRow);
}

// Aktualisiert einen bestehenden Job
export async function updateJob(input: UpdateJobInput): Promise<Job> {
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
    .select("role")
    .eq("id", userId)
    .single();

  if (profileError) {
    throw new Error("Profil konnte nicht geladen werden.");
  }

  if (!profile || profile.role !== "admin") {
    throw new Error("Nur Admins dürfen Jobs bearbeiten.");
  }

  const payload = {
    assigned_to: input.employeeId ?? null,
    customer_name: input.customerName.trim(),
    service_name: input.service.trim(),
    location_address: input.location.trim(),
    scheduled_start: input.scheduledStart ?? null,
    scheduled_end: input.scheduledEnd ?? null,
    notes: input.notes?.trim() ? input.notes.trim() : null,
  };

  const { data, error } = await supabase
    .from("jobs")
    .update(payload)
    .eq("id", input.jobId)
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

  if (error) {
    throw error;
  }

  return mapJob(data as JobRow);
}

// Setzt einen Job auf "in_progress" und speichert Startzeit
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

  // Zeit zurückgeben, damit wir den State direkt aktualisieren können
  return timestamp;
}

// Setzt einen Job auf "completed" und speichert Endzeit
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

  // Zeit zurückgeben, damit wir den State direkt aktualisieren können
  return timestamp;
}

// Schickt eine Expo Push Notification an ein Gerät
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