export type JobStatus = "open" | "in_progress" | "completed";

// Einmaliger Auftrag (single) vs. dauerhafter/wiederkehrender Auftrag (recurring).
export type JobType = "single" | "recurring";

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

  // ── Terminierung (single vs. recurring) ──
  // jobType "single": einmaliger Auftrag mit date + startTime.
  // jobType "recurring": wiederkehrend an recurringDays (Wochentage) + startTime.
  jobType: JobType;
  // Nur bei single gesetzt: "YYYY-MM-DD".
  date?: string | null;
  // Uhrzeit "HH:mm" (bei single und recurring).
  startTime?: string | null;
  // Nur bei recurring: Wochentage als Kurzcodes ("mon" … "sun").
  recurringDays?: string[] | null;
  // Nur aktive Aufträge werden Mitarbeitern "heute" angezeigt.
  isActive: boolean;

  // True, wenn dieser Job für den aktuellen User ungelesene Kommentare hat
  // (roter Punkt). Wird im JobContext nach getJobs gemerged, nicht in mapJob.
  hasUnreadComments?: boolean;

  // ── Recurring-Job-Materialisierung ──
  // Gesetzt wenn dieser Job eine generierte Occurrence eines Recurring-Parents ist.
  // NULL bei normalen Single-Jobs und bei Recurring-Parent-Regeln selbst.
  parentJobId?: string | null;
  // Kurzform: true wenn parentJobId gesetzt (= konkrete Occurrence eines Recurring Jobs).
  isOccurrence?: boolean;
};

export type CreateJobInput = {
  customerName: string;
  location: string;
  service: string;
  employeeId?: string | null;
  notes?: string | null;

  // ── Terminierung ──
  jobType: JobType;
  // single: Pflicht. "YYYY-MM-DD"
  date?: string | null;
  // single + recurring: Uhrzeit "HH:mm"
  startTime?: string | null;
  // recurring: Pflicht (mind. ein Wochentag), Kurzcodes "mon" … "sun"
  recurringDays?: string[] | null;
  // recurring: Aktiv-Schalter (Default true)
  isActive?: boolean;
  // Für single zusätzlich aus date + startTime abgeleiteter ISO-Zeitstempel
  // (hält die bestehenden Detail-/Monats-Anzeigen lauffähig).
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
};

export type EmployeeOption = {
  id: string;
  fullName: string;
  email?: string | null;
  role?: "admin" | "employee" | string | null;
  isActive?: boolean | null;
};
