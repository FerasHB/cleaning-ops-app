import { supabase } from "@/lib/supabase";
import { CreateJobInput, EmployeeOption, Job, JobType } from "@/types/job";
import { normalizeTime } from "@/utils/date";

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
  job_type: JobType | null;
  date: string | null;
  start_time: string | null;
  recurring_days: string[] | null;
  is_active: boolean | null;
  parent_job_id: string | null;
  recurrence_start_date: string | null;
  recurrence_end_date: string | null;
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
// Hinweis: profiles hat KEINE email-Spalte (siehe lib/schema.sql) — die
// E-Mail liegt nur in auth.users. Daher wird email hier NICHT selektiert.
type EmployeeRow = {
  id: string;
  full_name: string | null;
  role: "admin" | "employee" | null;
  is_active: boolean | null;
  invited_at: string | null;
  invite_accepted_at: string | null;
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
  // ── Terminierung ──
  jobType: JobType;
  date?: string | null;
  startTime?: string | null;
  recurringDays?: string[] | null;
  isActive?: boolean;
  recurrenceStartDate?: string | null;
  recurrenceEndDate?: string | null;
};

// Validiert & normalisiert die Terminierungs-Felder serverseitig
// (nicht nur auf die UI verlassen). Wirft bei ungültiger Kombination.
function buildSchedulePayload(input: {
  jobType: JobType;
  date?: string | null;
  startTime?: string | null;
  recurringDays?: string[] | null;
  isActive?: boolean;
  recurrenceStartDate?: string | null;
  recurrenceEndDate?: string | null;
}): {
  job_type: JobType;
  date: string | null;
  start_time: string | null;
  recurring_days: string[] | null;
  is_active: boolean;
  recurrence_start_date: string | null;
  recurrence_end_date: string | null;
} {
  const startTime = input.startTime?.trim() || null;

  if (!startTime) {
    throw new Error("Uhrzeit fehlt.");
  }

  if (input.jobType === "recurring") {
    const days = (input.recurringDays ?? []).filter(Boolean);
    if (days.length === 0) {
      throw new Error("Bitte mindestens einen Wochentag auswählen.");
    }
    if (!input.recurrenceStartDate) {
      throw new Error("Startdatum fehlt.");
    }
    return {
      job_type: "recurring",
      date: null,
      start_time: startTime,
      recurring_days: days,
      is_active: input.isActive ?? true,
      recurrence_start_date: input.recurrenceStartDate,
      recurrence_end_date: input.recurrenceEndDate ?? null,
    };
  }

  // single
  if (!input.date) {
    throw new Error("Datum fehlt.");
  }
  return {
    job_type: "single",
    date: input.date,
    start_time: startTime,
    recurring_days: null,
    is_active: true,
    recurrence_start_date: null,
    recurrence_end_date: null,
  };
}

// Formatiert ein Datum / eine Uhrzeit schön auf Deutsch
function formatDateTime(value: string): string {
  const date = new Date(value);

  if (isNaN(date.getTime())) {
    return "Ungültiges Datum";
  }

  return date.toLocaleString("de-DE");
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

    // Terminierung — bestehende Zeilen ohne Typ gelten als "single"/aktiv.
    jobType: row.job_type ?? "single",
    date: row.date,
    // DB liefert "HH:mm:ss" → auf "HH:mm" normalisieren
    startTime: normalizeTime(row.start_time),
    recurringDays: row.recurring_days,
    isActive: row.is_active ?? true,

    // Recurring-Job-Materialisierung: gesetzt wenn Occurrence eines Parents.
    parentJobId: row.parent_job_id ?? null,
    isOccurrence: row.parent_job_id != null,
    recurrenceStartDate: row.recurrence_start_date ?? null,
    recurrenceEndDate: row.recurrence_end_date ?? null,
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
      job_type,
      date,
      start_time,
      recurring_days,
      is_active,
      parent_job_id,
      recurrence_start_date,
      recurrence_end_date,
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
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    throw userError;
  }

  if (!user) {
    throw new Error("Nicht eingeloggt.");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("company_id")
    .eq("id", user.id)
    .single();

  if (profileError) {
    throw profileError;
  }

  if (!profile?.company_id) {
    return [];
  }

  // Alle Mitarbeiter der Firma laden — inkl. inaktiver, damit die Admin-Liste
  // und der Detail-Screen deaktivierte Mitarbeiter weiterhin anzeigen können.
  // Das Filtern auf "nur aktive" passiert gezielt am Zuweisungs-Picker, nicht
  // hier in der Datenquelle.
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active, invited_at, invite_accepted_at")
    .eq("company_id", profile.company_id)
    .eq("role", "employee")
    .order("is_active", { ascending: false }) // aktive zuerst
    .order("full_name", { ascending: true });

  if (error) {
    throw error;
  }

  return ((data ?? []) as EmployeeRow[]).map((item) => ({
    id: item.id,
    fullName: item.full_name ?? "Unbenannt",
    // profiles.email existiert nicht → bewusst null, UI zeigt Fallback
    email: null,
    role: item.role ?? "employee",
    isActive: item.is_active ?? null,
    invitedAt: item.invited_at ?? null,
    inviteAcceptedAt: item.invite_accepted_at ?? null,
  }));
}

// Setzt den Aktiv-Status eines Mitarbeiters (Deaktivieren/Reaktivieren).
// Läuft unter der RLS-Policy "admin update profiles in own company" — daher
// keine RPC nötig. Der Guard .eq("role", "employee") verhindert versehentliche
// Updates an Admin-Profilen; die Firmen-Zugehörigkeit erzwingt die RLS.
// Beim Deaktivieren wird zusätzlich der gespeicherte Push-Token gelöscht,
// damit auf einem geteilten Gerät keine Benachrichtigung mehr beim
// deaktivierten Mitarbeiter ankommen kann (serverseitige Durchsetzung des
// Zugriffs erfolgt separat über RLS/RPCs, siehe lib/schema.sql).
export async function setEmployeeActive(
  employeeId: string,
  active: boolean,
): Promise<void> {
  const payload: { is_active: boolean; expo_push_token?: null } = {
    is_active: active,
  };

  if (!active) {
    payload.expo_push_token = null;
  }

  const { error } = await supabase
    .from("profiles")
    .update(payload)
    .eq("id", employeeId)
    .eq("role", "employee");

  if (error) {
    throw error;
  }
}

// Ergebnis von createJob: der angelegte Job plus ein Hinweis, ob die
// Generierung der Recurring-Occurrences fehlgeschlagen ist. So kann die UI einen
// vollen Erfolg von einem Teil-Erfolg unterscheiden (Job angelegt, aber Termine
// noch nicht erzeugt), ohne den bereits erstellten Job als Fehler zu behandeln.
export type CreateJobResult = {
  job: Job;
  // true nur bei recurring, wenn generate_job_occurrences fehlschlug.
  recurringOccurrencesFailed: boolean;
};

// Erstellt einen neuen Job
export async function createJob(input: CreateJobInput): Promise<CreateJobResult> {
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

  // Pflichtfelder server-seitig härten (nicht nur auf die UI verlassen)
  const customerName = input.customerName.trim();
  const serviceName = input.service.trim();
  const locationAddress = input.location.trim();

  if (!customerName) {
    throw new Error("Kundenname fehlt.");
  }

  if (!locationAddress) {
    throw new Error("Adresse fehlt.");
  }

  if (!serviceName) {
    throw new Error("Service fehlt.");
  }

  // Terminierung validieren & aufbauen (single vs. recurring)
  const schedule = buildSchedulePayload(input);

  // Daten vorbereiten für den Insert in die jobs-Tabelle
  const payload = {
    company_id: profile.company_id,
    created_by: userId,
    assigned_to: input.employeeId ?? null,
    customer_name: customerName,
    service_name: serviceName,
    location_address: locationAddress,
    // scheduled_start wird für single zusätzlich befüllt (siehe AdminScreen),
    // damit Detail-/Monats-Anzeigen weiter funktionieren; recurring → null.
    scheduled_start: input.scheduledStart ?? null,
    scheduled_end: input.scheduledEnd ?? null,
    notes: input.notes?.trim() ? input.notes.trim() : null,
    status: "open" as const,
    ...schedule,
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
      job_type,
      date,
      start_time,
      recurring_days,
      is_active,
      parent_job_id,
      recurrence_start_date,
      recurrence_end_date,
      assigned_to,
      profiles:assigned_to (
        id,
        full_name
      )
      `
    )
    .single();

  // Hilfreich fürs Debugging (nur in Development)
  if (__DEV__) {
    console.log("Created job raw data:", data);
  }

  if (error) {
    throw error;
  }

  // Sicherheitscheck: data muss nach erfolgreichem Insert vorhanden sein.
  if (!data) {
    throw new Error("Job wurde angelegt, aber kein Datensatz zurückgegeben.");
  }

  // Bei Recurring Jobs: konkrete Einzel-Termine für die nächsten 8 Wochen erzeugen.
  // Fehler hier brechen den Job-Create nicht ab — der Parent existiert bereits.
  if (__DEV__) {
    console.log(
      "[createJob] job_type:", schedule.job_type,
      "| parent id:", data.id,
      "| generate occurrences:", schedule.job_type === "recurring"
    );
  }

  // Merkt sich, ob die Occurrence-Generierung fehlschlug — die UI zeigt dann
  // keinen vollen Erfolg an (der Parent-Job existiert aber bereits).
  let recurringOccurrencesFailed = false;

  if (schedule.job_type === "recurring") {
    const { data: rpcResult, error: occurrenceError } = await supabase.rpc(
      "generate_job_occurrences",
      { parent_job_id_input: data.id }
    );
    if (occurrenceError) {
      recurringOccurrencesFailed = true;
      // Immer loggen (nicht nur in Dev), damit der Fehler im Expo-Log sichtbar ist.
      console.error(
        "[createJob] generate_job_occurrences fehlgeschlagen:",
        occurrenceError.message,
        occurrenceError
      );
    } else if (__DEV__) {
      console.log("[createJob] Occurrences generiert:", rpcResult);
    }
  }

  // Wenn ein Mitarbeiter direkt zugewiesen wurde, versuchen wir eine
  // Push-Nachricht zu schicken. WICHTIG: Der Job ist nach dem erfolgreichen
  // Insert oben bereits vollständig angelegt — ein Fehler beim Push-Versand
  // (Netzwerk, Expo-Service down, etc.) darf createJob NICHT fehlschlagen
  // lassen, sonst zeigt die UI "Fehler" bei einem in Wahrheit bereits
  // erfolgreich erstellten Job an (Risiko: Admin tippt erneut → Duplikat).
  // Daher: eigenes try/catch, nur loggen, niemals werfen.
  if (payload.assigned_to) {
    try {
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
    } catch (pushError) {
      console.error(
        "[createJob] Push-Benachrichtigung fehlgeschlagen (Job wurde trotzdem erstellt):",
        pushError
      );
    }
  }

  // Rückgabe im App-Format
  return { job: mapJob(data as JobRow), recurringOccurrencesFailed };
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

  // Pflichtfelder server-seitig härten (nicht nur auf die UI verlassen)
  const customerName = input.customerName.trim();
  const serviceName = input.service.trim();
  const locationAddress = input.location.trim();

  if (!customerName) {
    throw new Error("Kundenname fehlt.");
  }

  if (!locationAddress) {
    throw new Error("Adresse fehlt.");
  }

  if (!serviceName) {
    throw new Error("Service fehlt.");
  }

  // Terminierung validieren & aufbauen (single vs. recurring)
  const schedule = buildSchedulePayload(input);

  const payload: {
    assigned_to: string | null;
    customer_name: string;
    service_name: string;
    location_address: string;
    scheduled_start: string | null;
    notes: string | null;
    scheduled_end?: string | null;
    job_type: JobType;
    date: string | null;
    start_time: string | null;
    recurring_days: string[] | null;
    is_active: boolean;
  } = {
    assigned_to: input.employeeId ?? null,
    customer_name: customerName,
    service_name: serviceName,
    location_address: locationAddress,
    // single: aus date+time abgeleiteter ISO-Wert; recurring: null
    scheduled_start: input.scheduledStart ?? null,
    notes: input.notes?.trim() ? input.notes.trim() : null,
    ...schedule,
  };

  // scheduled_end nur dann ins Update aufnehmen, wenn explizit übergeben.
  // Sonst würde ein bestehender Endzeitpunkt bei jeder Bearbeitung
  // versehentlich auf null gesetzt (Datenverlust), weil die UI das Feld
  // aktuell nicht mitschickt.
  if (input.scheduledEnd !== undefined) {
    payload.scheduled_end = input.scheduledEnd;
  }

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
      job_type,
      date,
      start_time,
      recurring_days,
      is_active,
      parent_job_id,
      recurrence_start_date,
      recurrence_end_date,
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

  // Bei Recurring-Parent-Jobs: zukünftige offene Occurrences löschen und neu erzeugen.
  // Nur für Parent-Regeln (parent_job_id IS NULL), nicht für Occurrences selbst.
  // Fehler hier brechen das Update nicht ab — die Regeländerung ist bereits gespeichert.
  if (input.jobType === "recurring" && !data.parent_job_id) {
    const { error: occurrenceError } = await supabase.rpc(
      "update_job_occurrences",
      { parent_job_id_input: input.jobId }
    );
    if (occurrenceError) {
      console.error("[updateJob] update_job_occurrences fehlgeschlagen:", occurrenceError.message, occurrenceError);
    }
  }

  return mapJob(data as JobRow);
}

// Setzt einen Job auf "in_progress" und speichert Startzeit.
// WICHTIG: Läuft über die RPC start_own_job, weil Employees per RLS
// KEIN direktes UPDATE auf jobs haben (siehe lib/schema.sql). Der Timestamp
// wird als Parameter übergeben, damit die Offline-Sync den echten
// Aktionszeitpunkt (statt "jetzt") nachreichen kann.
export async function startJob(
  jobId: string,
  startedAt?: string,
): Promise<string> {
  const timestamp = startedAt ?? new Date().toISOString();

  const { data, error } = await supabase.rpc("start_own_job", {
    job_id_input: jobId,
    started_at_input: timestamp,
  });

  if (error) {
    throw error;
  }

  // Die RPC gibt den tatsächlich gesetzten Timestamp zurück.
  // Falls (z.B. ältere Signatur) nichts zurückkommt, fallen wir auf den
  // übergebenen Timestamp zurück, damit der State sauber aktualisiert wird.
  return typeof data === "string" && data ? data : timestamp;
}

// Setzt einen Job auf "completed" und speichert Endzeit.
// WICHTIG: Läuft über die RPC complete_own_job (gleicher RLS-Grund wie oben).
export async function completeJob(
  jobId: string,
  completedAt?: string,
): Promise<string> {
  const timestamp = completedAt ?? new Date().toISOString();

  const { data, error } = await supabase.rpc("complete_own_job", {
    job_id_input: jobId,
    completed_at_input: timestamp,
  });

  if (error) {
    throw error;
  }

  // Die RPC gibt den tatsächlich gesetzten Timestamp zurück.
  return typeof data === "string" && data ? data : timestamp;
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

// Lädt alle generierten Occurrences eines Recurring-Parent-Jobs.
// Wird im Admin-Detail-Screen genutzt, um die Terminübersicht anzuzeigen.
// Sortiert nach Datum aufsteigend, dann nach Uhrzeit.
export async function getJobOccurrences(parentJobId: string): Promise<Job[]> {
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
      job_type,
      date,
      start_time,
      recurring_days,
      is_active,
      parent_job_id,
      recurrence_start_date,
      recurrence_end_date,
      assigned_to,
      profiles:assigned_to (
        id,
        full_name
      )
      `
    )
    .eq("parent_job_id", parentJobId)
    .order("date", { ascending: true })
    .order("start_time", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((item) => mapJob(item as JobRow));
}

// Löscht einen bestehenden Job
export async function deleteJob(jobId: string): Promise<void> {
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
    throw new Error("Nur Admins dürfen Jobs löschen.");
  }

  const { error } = await supabase.from("jobs").delete().eq("id", jobId);

  if (error) {
    throw error;
  }
}