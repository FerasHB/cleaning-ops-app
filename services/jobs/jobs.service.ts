import { supabase } from "@/lib/supabase";
import {
  CreateJobInput,
  EmployeeOption,
  Job,
  JobAssignee,
  JobType,
} from "@/types/job";
import { normalizeTime } from "@/utils/date";
import { buildLegacyAssignees } from "@/utils/jobAssignees";

// Wird von updateJob() geworfen, wenn set_job_assignments bereits
// erfolgreich committed wurde, das nachfolgende jobs-UPDATE und/oder
// update_job_occurrences aber fehlgeschlagen ist. Die beiden Schreibvorgänge
// sind ZWEI getrennte Netzwerk-Requests, keine gemeinsame Transaktion — ein
// Fehlschlag hier ist deshalb NIE ein vollständiger Rollback, sondern ein
// echter Teilerfolg: die Zuweisungsmenge steht bereits, andere Feldänderungen
// (oder die Occurrence-Synchronisierung) nicht. `job` trägt den frisch vom
// Server nachgelesenen Stand, damit Aufrufer die UI korrekt aktualisieren
// können, statt auf dem Vor-Speichern-Zustand hängen zu bleiben.
export class PartialUpdateError extends Error {
  readonly job: Job | null;

  constructor(message: string, job: Job | null) {
    super(message);
    this.name = "PartialUpdateError";
    this.job = job;
  }
}

// Eine Zeile aus job_assignments, wie sie eingebettet zurückkommt.
// profiles ist der LEBENDE Mitarbeiter; bei gelöschtem Konto ist
// employee_id NULL und profiles fehlt — dann trägt der Snapshot den Namen.
type JobAssignmentRow = {
  id: string;
  employee_id: string | null;
  employee_name_snapshot: string | null;
  assigned_at: string | null;
  profiles?:
  | { id: string; full_name: string | null }
  | { id: string; full_name: string | null }[]
  | null;
};

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
  started_by: string | null;
  completed_by: string | null;
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
  // Zuweisungsmenge (Phase 5). Alias "assignments" im Select, damit sie sich
  // nicht mit dem Legacy-Embed profiles:assigned_to überschneidet.
  assignments?: JobAssignmentRow[] | null;
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
  // Zuweisungsmenge (Phase 6 Schreibpfad). jobs.assigned_to wird NICHT mehr
  // direkt geschrieben — siehe updateJob() unten.
  employeeIds?: string[];
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

// Bereinigt eine Mitarbeiter-ID-Liste: entfernt leere Werte und Duplikate.
// set_job_assignments dedupliziert serverseitig zusätzlich selbst — hier
// geht es nur um ein deterministisches Client-Payload.
function normalizeEmployeeIds(ids: string[] | null | undefined): string[] {
  return Array.from(new Set((ids ?? []).filter((id): id is string => !!id)));
}

// Ersetzt die Zuweisungsmenge eines Auftrags transaktional über die
// Phase-3/4-RPC set_job_assignments (nur Admin, serverseitig validiert).
//
// WICHTIG: das Rückgabeergebnis der RPC (setof job_assignments) wird HIER
// BEWUSST NICHT verwendet. Es sind rohe Tabellenzeilen (u. a.
// employee_name_snapshot) — NICHT der auf den lebenden Profilnamen
// gemappte Job. Für die UI wird nach dem Aufruf immer separat per
// readBackJob()/getJobById() frisch gelesen, damit die Anzeige exakt dem
// tatsächlichen Serverstand entspricht (siehe createJob/updateJob unten).
async function callSetJobAssignments(
  jobId: string,
  employeeIds: string[],
): Promise<void> {
  const { error } = await supabase.rpc("set_job_assignments", {
    p_job_id: jobId,
    p_employee_ids: employeeIds,
  });

  if (error) {
    throw error;
  }
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

// EINZIGE Spaltenauswahl für Job-Abfragen. Vor Phase 5 lag dieselbe Liste
// zusätzlich viermal inline (getJobs, createJob, updateJob, getJobOccurrences);
// mit der neuen Zuweisungsmenge wären das vier Stellen, an denen ein
// vergessener Embed stillschweigend eine leere Mitarbeiterliste erzeugt.
// Deshalb konsolidiert — alle Abfragen nutzen ausschließlich diese Konstante.
//
// assigned_to + profiles:assigned_to bleiben bewusst enthalten: das
// Aktions-Gating läuft seit Phase 7 über die Zuweisungsmenge, der Legacy-Zeiger
// deckt aber weiterhin (a) Bestandszeilen ohne Zuweisungszeile, (b) die
// Kommentar-/Foto-Schreibpfade und (c) den Schreibpfad — bis Phase 11.
const JOB_SELECT = `
  id,
  customer_name,
  service_name,
  location_address,
  scheduled_start,
  scheduled_end,
  status,
  started_at,
  completed_at,
  started_by,
  completed_by,
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
  ),
  assignments:job_assignments (
    id,
    employee_id,
    employee_name_snapshot,
    assigned_at,
    profiles:employee_id (
      id,
      full_name
    )
  )
`;

// PostgREST liefert eingebettete 1:1-Beziehungen mal als Objekt, mal als
// Array (abhängig davon, ob die Beziehung als to-one erkannt wird).
function firstProfileName(
  profiles: JobAssignmentRow["profiles"] | JobRow["profiles"],
): string | null {
  if (!profiles) return null;
  if (Array.isArray(profiles)) return profiles[0]?.full_name ?? null;
  return profiles.full_name ?? null;
}

// Wandelt die eingebetteten Zuweisungszeilen in die App-Darstellung.
//
// NAMENSREGEL (entspricht der Vorgabe der Phase-1-Migration): der LEBENDE
// Profilname gewinnt, solange das Profil existiert; erst wenn das Konto
// gelöscht wurde (employee_id IS NULL), trägt der Schnappschuss den Namen.
//
// SORTIERUNG: nach assigned_at, dann Name, dann assignmentId. Ohne stabile
// Reihenfolge würde die Mitarbeiterliste einer Karte bei jedem Neuladen
// springen — PostgREST garantiert für eingebettete Mengen keine Ordnung.
function mapAssignees(rows: JobAssignmentRow[] | null | undefined): JobAssignee[] {
  if (!rows || rows.length === 0) return [];

  return rows
    .map((row) => {
      const livingName = firstProfileName(row.profiles);
      const snapshot = row.employee_name_snapshot?.trim() || null;

      return {
        assignedAt: row.assigned_at ?? "",
        assignee: {
          assignmentId: row.id,
          employeeId: row.employee_id,
          fullName: livingName?.trim() || snapshot || "Unbekannt",
          isDeleted: row.employee_id === null,
        } satisfies JobAssignee,
      };
    })
    .sort((a, b) => {
      const timeDiff = a.assignedAt.localeCompare(b.assignedAt);
      if (timeDiff !== 0) return timeDiff;
      const nameDiff = a.assignee.fullName.localeCompare(
        b.assignee.fullName,
        "de",
      );
      if (nameDiff !== 0) return nameDiff;
      return a.assignee.assignmentId.localeCompare(b.assignee.assignmentId);
    })
    .map((entry) => entry.assignee);
}

// Liest einen gerade geschriebenen Job EINMAL frisch nach.
//
// Warum: die eingebettete Zuweisungsmenge im RETURNING eines INSERT/UPDATE
// ist NICHT verlaesslich. Die Kompatibilitaets-Trigger aus Phase 2 schreiben
// job_assignments in AFTER-Triggern; der Embed derselben Anweisung sieht
// deren Ergebnis nicht mehr. Gegen PostgREST reproduziert:
//
//   INSERT (assigned_to=Erika) -> assignments: []        | frisch: [Erika]
//   UPDATE (assigned_to=Zoe)   -> assignments: [Erika]   | frisch: [Zoe]
//
// Ohne Nachlesen zeigte ein neu angelegter Auftrag "Nicht zugewiesen" und ein
// bearbeiteter den VORHERIGEN Mitarbeiter — und beides landete zusaetzlich
// ueber saveCachedJobs im Offline-Cache.
//
// FALLBACK, wenn das Nachlesen scheitert (Netz, RLS, kein Datensatz):
// Der Schreibvorgang war erfolgreich und darf NIE nachtraeglich als Fehler
// erscheinen — es wird also immer ein Job zurueckgegeben, nie geworfen.
//
// Entscheidend ist, WAS dann in `assignees` steht. mapJob(row) allein waere
// hier falsch: es traegt exakt die unzuverlaessige Embed-Menge und damit
// wieder `[]` (nach dem Anlegen) bzw. die ALTE Menge (nach dem Bearbeiten) —
// und der JobContext schreibt das Ergebnis in State UND AsyncStorage.
// Stattdessen wird die Menge aus dem Legacy-Zeiger abgeleitet
// (buildLegacyAssignees): genau ein Mitarbeiter, nie geraten, nie mehrere.
//
// Der Legacy-Zeiger ist an dieser Stelle verlaesslich: assigned_to ist eine
// echte Spalte der gerade geschriebenen Zeile und kommt frisch aus dem
// RETURNING — nur die eingebettete Beziehung hinkt hinterher.
//
// BEIDE Fehlerpfade werden geloggt (Ausnahme UND leeres Ergebnis), damit ein
// stiller Fallback nicht unbemerkt bleibt.
async function readBackJob(row: JobRow): Promise<Job> {
  const base = mapJob(row);

  try {
    const fresh = await getJobById(row.id);
    if (fresh) return fresh;

    console.error(
      "[jobs.service] Nachlesen nach Schreibvorgang lieferte keinen Datensatz " +
      `(Job ${row.id}) — Zuweisungen werden aus dem Legacy-Zeiger abgeleitet.`,
    );
  } catch (err) {
    console.error(
      "[jobs.service] Nachlesen nach Schreibvorgang fehlgeschlagen " +
      `(Job ${row.id}) — Zuweisungen werden aus dem Legacy-Zeiger abgeleitet.`,
      err,
    );
  }

  return { ...base, assignees: buildLegacyAssignees(base) };
}

// Wandelt einen DB-Job in unser App-Job-Objekt um
function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    customerName: row.customer_name,
    location: row.location_address,
    time: formatTimeRange(row.scheduled_start, row.scheduled_end),
    service: row.service_name,

    // Maßgeblich für jede Anzeige (Phase 5).
    assignees: mapAssignees(row.assignments),

    // @deprecated — nur noch Aktions-Gating und Schreibpfad, siehe types/job.ts
    employeeId: row.assigned_to,
    employeeName: firstProfileName(row.profiles),

    status: row.status,
    notes: row.notes,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    startedAt: row.started_at,
    completedAt: row.completed_at,

    // Akteure der Übergänge (Phase 7) — Nachvollziehbarkeit, KEINE
    // Abrechnungs- oder Berechtigungsgrundlage (siehe types/job.ts).
    startedBy: row.started_by,
    completedBy: row.completed_by,

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
    .select(JOB_SELECT)
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

  // Zuweisungsmenge normalisieren (dedupliziert, ohne leere Werte).
  const employeeIds = normalizeEmployeeIds(input.employeeIds);

  // Daten vorbereiten für den Insert in die jobs-Tabelle. KEIN assigned_to
  // mehr — die Zuweisungsmenge wird ausschließlich über set_job_assignments()
  // unten geschrieben; die Legacy-Spalte pflegt danach allein der
  // Phase-2-Kompatibilitäts-Trigger (Richtung B: job_assignments -> jobs).
  const payload = {
    company_id: profile.company_id,
    created_by: userId,
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
    .select(JOB_SELECT)
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

  // Zuweisungsmenge JETZT setzen — VOR jeder Occurrence-Generierung weiter
  // unten, damit generate_job_occurrences (bei recurring) über
  // inherit_occurrence_assignments bereits die richtige Menge an die
  // erzeugten Termine weitergibt. Schlägt das fehl, existiert bereits eine
  // Job-Zeile ohne die vom Admin gewählten Zuweisungen — das darf NICHT
  // still bleiben. Kompensation: den unvollständigen Job wieder löschen,
  // damit kein "Geister-Job" ohne Zuweisung liegen bleibt.
  try {
    await callSetJobAssignments(data.id, employeeIds);
  } catch (assignError) {
    try {
      await supabase.from("jobs").delete().eq("id", data.id);
    } catch (compensationError) {
      if (__DEV__) {
        console.error(
          "[createJob] Kompensations-Löschung fehlgeschlagen:",
          compensationError,
        );
      }
      throw new Error(
        `Job wurde angelegt, aber die Mitarbeiterzuweisung ist fehlgeschlagen UND ` +
          `der Job konnte danach nicht automatisch wieder gelöscht werden ` +
          `(Job-ID ${data.id}). Der Auftrag existiert möglicherweise ohne ` +
          `Zuweisungen — bitte manuell in Supabase prüfen.`,
      );
    }

    const assignMsg =
      assignError instanceof Error ? assignError.message : String(assignError);
    throw new Error(
      `Job konnte nicht mit den gewählten Mitarbeitern angelegt werden ` +
        `(${assignMsg}). Der unvollständig angelegte Job wurde automatisch ` +
        `wieder entfernt.`,
    );
  }

  // Bei Recurring Jobs: konkrete Einzel-Termine für die nächsten 8 Wochen erzeugen.
  // Fehler hier brechen den Job-Create nicht ab — der Parent existiert bereits
  // UND ist bereits korrekt zugewiesen (s.o.).
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

  // Push-Benachrichtigung: WICHTIG — vorübergehend weiterhin nur EIN
  // Empfänger (der erste gewählte Mitarbeiter), exakt wie vor Phase 6, wo
  // ohnehin nur ein einzelner assigned_to existierte. Der Job ist nach dem
  // erfolgreichen Insert + erfolgreicher Zuweisung oben bereits vollständig
  // angelegt — ein Fehler beim Push-Versand (Netzwerk, Expo-Service down,
  // etc.) darf createJob NICHT fehlschlagen lassen, sonst zeigt die UI
  // "Fehler" bei einem in Wahrheit bereits erfolgreich erstellten Job an
  // (Risiko: Admin tippt erneut → Duplikat). Daher: eigenes try/catch, nur
  // loggen, niemals werfen.
  //
  // TODO(Phase 8): an ALLE gewählten Mitarbeiter fächern, sobald der
  // client-seitige Push-Fetch hier durch die notification_outbox/
  // Dispatcher-Pipeline mit recipient_id ersetzt wird (siehe Roadmap).
  const primaryEmployeeId = employeeIds[0] ?? null;
  if (primaryEmployeeId) {
    try {
      const { data: employee } = await supabase
        .from("profiles")
        .select("expo_push_token, full_name")
        .eq("id", primaryEmployeeId)
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

  // Rückgabe im App-Format. Frisch nachlesen, damit `assignees` exakt den
  // gerade per set_job_assignments geschriebenen Stand widerspiegelt
  // (siehe readBackJob).
  return {
    job: await readBackJob(data as unknown as JobRow),
    recurringOccurrencesFailed,
  };
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

  // Terminierung validieren & aufbauen (single vs. recurring). Bewusst VOR
  // jedem Schreibvorgang (inkl. set_job_assignments unten) — ein
  // clientseitiger Validierungsfehler darf keine halb angewandte Änderung
  // hinterlassen.
  const schedule = buildSchedulePayload(input);
  const employeeIds = normalizeEmployeeIds(input.employeeIds);

  // Zuweisungsmenge ZUERST schreiben — VOR dem jobs-UPDATE und vor
  // update_job_occurrences weiter unten, damit die Regel-Synchronisierung
  // (bei recurring Parents) bereits die NEUE Menge sieht und über
  // inherit_occurrence_assignments an nicht individuell angepasste Termine
  // weitergibt. Würde man stattdessen zuerst die Regel-Felder speichern und
  // erst danach die Zuweisung, sähen frisch generierte/synchronisierte
  // Termine noch die ALTE Menge.
  //
  // NICHT TRANSAKTIONAL mit dem jobs-UPDATE danach: schlägt das UPDATE nach
  // einem erfolgreichen set_job_assignments fehl, bleibt die neue
  // Zuweisungsmenge gespeichert, während Kundenname/Termin/etc. auf dem
  // alten Stand bleiben. Es gibt in dieser Phase keine RPC, die beides
  // atomar zusammenfasst — dieses Risiko ist im Implementierungsbericht
  // dokumentiert und wird NICHT durch eine neue Migration behoben.
  await callSetJobAssignments(input.jobId, employeeIds);

  const payload: {
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
    // KEIN assigned_to mehr — siehe createJob() und die Erläuterung oben.
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
    .select(JOB_SELECT)
    .single();

  // Bei Recurring-Parent-Jobs: zukünftige offene Occurrences löschen und neu
  // erzeugen. Nur für Parent-Regeln (parent_job_id IS NULL), nicht für
  // Occurrences selbst — und nur, wenn das jobs-UPDATE selbst erfolgreich
  // war (sonst existiert `data`/`data.parent_job_id` nicht zuverlässig).
  let occurrenceError: { message: string } | null = null;
  if (!error && input.jobType === "recurring" && !data.parent_job_id) {
    const { error: occErr } = await supabase.rpc(
      "update_job_occurrences",
      { parent_job_id_input: input.jobId }
    );
    if (occErr) {
      occurrenceError = occErr;
      console.error("[updateJob] update_job_occurrences fehlgeschlagen:", occErr.message, occErr);
    }
  }

  if (error || occurrenceError) {
    // TEILERFOLG: set_job_assignments oben ist bereits committed — jobs-
    // UPDATE und update_job_occurrences sind separate Requests ohne
    // gemeinsame Transaktion mit Schritt 1. KEIN automatischer Retry, KEIN
    // Vortäuschen eines vollständigen Rollbacks. Stattdessen den echten
    // Serverstand frisch nachlesen und einen dedizierten Fehlertyp werfen,
    // den Aufrufer (JobContext/EditJobScreen) von einem gewöhnlichen Fehler
    // unterscheiden und passend anzeigen können.
    const fresh = await getJobById(input.jobId);

    const reasons: string[] = [];
    if (error) {
      reasons.push(
        "die übrigen Änderungen an diesem Auftrag (z. B. Kunde, Ort, Termin) wurden NICHT gespeichert",
      );
    }
    if (occurrenceError) {
      reasons.push(
        "die Termine des Dauerauftrags konnten nicht an die neue Zuweisung angeglichen werden",
      );
    }

    throw new PartialUpdateError(
      `Die Mitarbeiterzuweisung wurde gespeichert, aber ${reasons.join(" und ")}. ` +
        `Bitte prüfen Sie den aktuellen Stand und speichern Sie bei Bedarf erneut.`,
      fresh,
    );
  }

  // Frisch nachlesen, damit `assignees` exakt den gerade per
  // set_job_assignments geschriebenen Stand widerspiegelt (siehe readBackJob).
  return readBackJob(data as unknown as JobRow);
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
    .select(JOB_SELECT)
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

// ─────────────────────────────────────────────────────────────────────────
// Gebundene Abfragen für die Zeitplan-/Daueraufträge-Trennung (Admin).
// Alle Queries laufen unter RLS (Firma/Rolle serverseitig erzwungen) und sind
// bewusst nach oben begrenzt, damit die PostgREST-1000-Zeilen-Grenze die
// Standard-Screens niemals abschneiden kann.
// ─────────────────────────────────────────────────────────────────────────

// Sicherheitslimit für einzelne Zeitplan-Abfragen (deutlich unter 1000).
const SCHEDULE_PAGE_SIZE = 200;

// Direktes Laden EINES Jobs per ID (Cache-Miss-Fallback für JobDetail/Edit).
// RLS entscheidet über Sichtbarkeit: fremde Firma oder (für Employees) fremder
// Job → kein Datensatz → null. Kein Fehler, damit die UI sauber „nicht
// gefunden" anzeigen kann.
export async function getJobById(jobId: string): Promise<Job | null> {
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) return null;
  return mapJob(data as JobRow);
}

// Mitarbeiter-Filter für Zeitplan-Queries (serverseitig).
//   - employeeId gesetzt          → Mitarbeiter ist dem Auftrag zugewiesen
//   - unassigned = true           → Auftrag hat GAR KEINE Zuweisung
//   - beides leer                 → alle Mitarbeiter
export type EmployeeFilter = { employeeId?: string; unassigned?: boolean };

// Zusätzliche Embeds, die AUSSCHLIESSLICH als Filter-Prädikat dienen.
//
// WARUM EIN ZWEITER EMBED? Der Anzeige-Embed `assignments` muss IMMER die
// vollständige Zuweisungsmenge liefern. Würde man ihn selbst filtern, zeigte
// eine nach Mitarbeiter X gefilterte Liste an jedem Auftrag nur noch X —
// die Kolleginnen und Kollegen verschwänden aus der Anzeige. Der zweite,
// aliasierte Embed schränkt deshalb nur die ZEILENMENGE ein und wird nie
// gelesen. PostgREST dupliziert dabei keine Zeilen (verifiziert).
const ASSIGNEE_FILTER_EMBED = `,f:job_assignments!inner(employee_id)`;
const UNASSIGNED_FILTER_EMBED = `,f:job_assignments!left(employee_id)`;

// Liefert die Spaltenauswahl inklusive des passenden Filter-Embeds.
// WICHTIG: Filter-Embed und Filter-Bedingung gehören zusammen — immer beide
// über applySelect/applyEmployeeFilter mit DEMSELBEN filter aufrufen.
function jobSelectFor(filter?: EmployeeFilter): string {
  if (filter?.unassigned) return JOB_SELECT + UNASSIGNED_FILTER_EMBED;
  if (filter?.employeeId) return JOB_SELECT + ASSIGNEE_FILTER_EMBED;
  return JOB_SELECT;
}

// Wendet den Mitarbeiter-Filter auf einen Query-Builder an (serverseitig).
//
// „Nicht zugewiesen" läuft bewusst NICHT mehr über assigned_to IS NULL:
// compat_primary_assignee() setzt den Legacy-Zeiger auch dann auf NULL, wenn
// zwar Zuweisungen existieren, aber keine davon spurenfrei und aktiv ist
// (z. B. bereits gestartet oder Mitarbeiter deaktiviert). Die Legacy-Spalte
// ist damit KEIN verlässlicher Indikator für „hat niemanden" — die
// Zuweisungsmenge selbst schon.
function applyEmployeeFilter<T>(query: T, filter?: EmployeeFilter): T {
  if (!filter) return query;
  const q = query as any;
  if (filter.unassigned) return q.is("f", null);
  if (filter.employeeId) return q.eq("f.employee_id", filter.employeeId);
  return query;
}

// Executable Jobs (single-Jobs UND generierte Occurrences) in einem
// begrenzten Datumsfenster. Recurring-Parent-Regeln sind per job_type='single'
// grundsätzlich ausgeschlossen (Parents sind die einzigen 'recurring'-Zeilen).
export type ScheduleRangeParams = {
  from: string; // "YYYY-MM-DD" inklusiv
  to: string; // "YYYY-MM-DD" inklusiv
  statuses?: ("open" | "in_progress" | "completed")[];
  limit?: number;
  employee?: EmployeeFilter;
};

export async function getScheduleOccurrences(
  params: ScheduleRangeParams,
): Promise<Job[]> {
  let query = supabase
    .from("jobs")
    .select(jobSelectFor(params.employee))
    .eq("job_type", "single")
    .gte("date", params.from)
    .lte("date", params.to);

  if (params.statuses && params.statuses.length > 0) {
    query = query.in("status", params.statuses);
  }
  query = applyEmployeeFilter(query, params.employee);

  const { data, error } = await query
    .order("date", { ascending: true })
    .order("start_time", { ascending: true })
    .order("id", { ascending: true })
    .limit(params.limit ?? SCHEDULE_PAGE_SIZE);

  if (error) {
    throw error;
  }
  return (data ?? []).map((row) => mapJob(row as unknown as JobRow));
}

// Überfällige executable Jobs: offen/in Arbeit mit Datum vor heute.
// Nach Datum absteigend (jüngste zuerst), begrenzt.
export async function getOverdueOccurrences(
  todayKey: string,
  employee?: EmployeeFilter,
  limit: number = SCHEDULE_PAGE_SIZE,
): Promise<Job[]> {
  let query = supabase
    .from("jobs")
    .select(jobSelectFor(employee))
    .eq("job_type", "single")
    .in("status", ["open", "in_progress"])
    .lt("date", todayKey);
  query = applyEmployeeFilter(query, employee);

  const { data, error } = await query
    .order("date", { ascending: false })
    .order("start_time", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }
  return (data ?? []).map((row) => mapJob(row as unknown as JobRow));
}

// Erledigte executable Jobs, nach Abschlusszeit absteigend, keyset-fähig
// (before = ISO-Zeitstempel; lädt ältere Seiten). Begrenzt.
export async function getCompletedOccurrences(
  before?: string,
  employee?: EmployeeFilter,
  limit: number = SCHEDULE_PAGE_SIZE,
): Promise<Job[]> {
  let query = supabase
    .from("jobs")
    .select(jobSelectFor(employee))
    .eq("job_type", "single")
    .eq("status", "completed")
    .not("completed_at", "is", null);

  if (before) {
    query = query.lt("completed_at", before);
  }
  query = applyEmployeeFilter(query, employee);

  const { data, error } = await query
    .order("completed_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }
  return (data ?? []).map((row) => mapJob(row as unknown as JobRow));
}

// Nur die Parent-Regeln (Daueraufträge): recurring UND parent_job_id IS NULL.
// Occurrences sind hier grundsätzlich ausgeschlossen. Wenige Zeilen pro Firma.
export async function getRecurringRules(): Promise<Job[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_SELECT)
    .eq("job_type", "recurring")
    .is("parent_job_id", null)
    .order("customer_name", { ascending: true })
    .order("id", { ascending: true })
    .limit(SCHEDULE_PAGE_SIZE);

  if (error) {
    throw error;
  }
  return (data ?? []).map((row) => mapJob(row as unknown as JobRow));
}

// Zusammenfassung der Occurrences je Regel (nächster Termin + „hat Termine?")
// für die Regel-Gesundheit. EINE gebündelte, fenster-begrenzte Query über die
// nahe Zukunft aller übergebenen Regel-IDs (statt N Einzelabfragen).
export type RuleOccurrenceSummaryRow = {
  parentJobId: string;
  nextOccurrenceDate: string | null;
  hasOccurrences: boolean;
};

export async function getUpcomingOccurrenceSummaries(
  ruleIds: string[],
  todayKey: string,
  horizonDays: number = 120,
): Promise<Map<string, RuleOccurrenceSummaryRow>> {
  const result = new Map<string, RuleOccurrenceSummaryRow>();
  if (ruleIds.length === 0) return result;

  // Vorbelegen: standardmäßig „keine Termine" (überschrieben, sobald gefunden).
  for (const id of ruleIds) {
    result.set(id, {
      parentJobId: id,
      nextOccurrenceDate: null,
      hasOccurrences: false,
    });
  }

  const to = new Date(todayKey);
  to.setDate(to.getDate() + horizonDays);
  const toKey = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, "0")}-${String(to.getDate()).padStart(2, "0")}`;

  const { data, error } = await supabase
    .from("jobs")
    .select("parent_job_id, date")
    .in("parent_job_id", ruleIds)
    .gte("date", todayKey)
    .lte("date", toKey)
    .order("date", { ascending: true })
    .limit(1000);

  if (error) {
    throw error;
  }

  for (const row of (data ?? []) as { parent_job_id: string; date: string | null }[]) {
    const pid = row.parent_job_id;
    if (!pid) continue;
    const entry = result.get(pid);
    if (!entry) continue;
    entry.hasOccurrences = true;
    // Da nach date aufsteigend sortiert, ist der erste Treffer der nächste Termin.
    if (entry.nextOccurrenceDate === null && row.date) {
      entry.nextOccurrenceDate = row.date.slice(0, 10);
    }
  }

  return result;
}

// Serverseitige, gebündelte KPI-Zähler für das Admin-Dashboard.
// Gibt AUSSCHLIESSLICH Zahlen zurück (count/head) — es werden nie Zeilen
// übertragen, daher unabhängig von der 1000-Zeilen-Grenze. Recurring-Parents
// sind über job_type='single' immer ausgeschlossen.
export type ScheduleKpis = {
  heute: number;
  offen: number;
  inArbeit: number;
  erledigt: number;
  ueberfaellig: number;
};

async function countJobs(
  build: (q: any) => any,
): Promise<number> {
  const base = supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("job_type", "single");
  const { count, error } = await build(base);
  if (error) {
    throw error;
  }
  return count ?? 0;
}

// Dauerauftrag (de)aktivieren: setzt is_active auf der Parent-Regel und
// synchronisiert die zukünftigen Occurrences NICHT-destruktiv über die
// bereits deployte update_job_occurrences (prune/sync/generate). Läuft unter
// der Admin-RLS-Policy „admin update jobs in own company".
export async function setRecurringRuleActive(
  ruleId: string,
  active: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update({ is_active: active })
    .eq("id", ruleId)
    .eq("job_type", "recurring")
    .is("parent_job_id", null);

  if (error) {
    throw error;
  }

  // Occurrences angleichen (best-effort; die Regeländerung ist bereits
  // gespeichert). Fehler hier blockieren den Toggle nicht.
  const { error: rpcError } = await supabase.rpc("update_job_occurrences", {
    parent_job_id_input: ruleId,
  });
  if (rpcError) {
    console.error(
      "[setRecurringRuleActive] update_job_occurrences fehlgeschlagen:",
      rpcError.message,
    );
  }
}

// Operatives Fenster für „Offen" (Tage ab morgen) und Rückschau für „Erledigt".
export const KPI_OPEN_WINDOW_DAYS = 30; // Offen: morgen … heute+30
export const KPI_COMPLETED_LOOKBACK_DAYS = 30; // Erledigt: letzte 30 Tage

// "YYYY-MM-DD" + n Tage → "YYYY-MM-DD" (ohne Zeitzonen-Verschiebung).
function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// Serverseitige, gebündelte KPI-Zähler mit klaren OPERATIVEN Fenstern.
// Jede Kennzahl hat eine eindeutige, dokumentierte Datumsspanne. Zähler sind
// count/head (keine Zeilen), also unabhängig vom Ladefenster / der
// 1000-Zeilen-Grenze. Recurring-Parents sind über job_type='single' immer
// ausgeschlossen; date-NULL-Zeilen fallen durch die Datumsvergleiche heraus.
//
// Fenster (todayKey = heute):
//   • Heute fällig : date = heute                         (alle Status)
//   • Offen        : status=open  UND  morgen ≤ date ≤ heute+30
//                    (KEIN heute → eigene Karte; KEINE Überfälligen → eigene
//                     Karte; KEINE Ferntermine jenseits +30 Tage)
//   • In Arbeit    : status=in_progress                   (unbegrenzt, klein)
//   • Erledigt     : status=completed  UND  completed_at ≥ heute−30
//                    (letzte 30 Tage, operative Rückschau)
//   • Überfällig   : status∈(open,in_progress)  UND  date < heute
export async function getScheduleKpis(todayKey: string): Promise<ScheduleKpis> {
  const tomorrowKey = addDaysToKey(todayKey, 1);
  const openEndKey = addDaysToKey(todayKey, KPI_OPEN_WINDOW_DAYS);
  const completedSinceKey = addDaysToKey(todayKey, -KPI_COMPLETED_LOOKBACK_DAYS);

  const [heute, offen, inArbeit, erledigt, ueberfaellig] = await Promise.all([
    // Heute fällig: executable Jobs mit Datum = heute
    countJobs((q) => q.eq("date", todayKey)),
    // Offen: offene executable Jobs von morgen bis heute+30 (operatives Fenster)
    countJobs((q) =>
      q.eq("status", "open").gte("date", tomorrowKey).lte("date", openEndKey),
    ),
    // In Arbeit: laufende executable Jobs
    countJobs((q) => q.eq("status", "in_progress")),
    // Erledigt: abgeschlossene executable Jobs der letzten 30 Tage (completed_at)
    countJobs((q) =>
      q.eq("status", "completed").gte("completed_at", completedSinceKey),
    ),
    // Überfällig: offen/in Arbeit mit Datum vor heute
    countJobs((q) => q.in("status", ["open", "in_progress"]).lt("date", todayKey)),
  ]);

  return { heute, offen, inArbeit, erledigt, ueberfaellig };
}