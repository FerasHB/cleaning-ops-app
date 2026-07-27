export type JobStatus = "open" | "in_progress" | "completed";

// Einmaliger Auftrag (single) vs. dauerhafter/wiederkehrender Auftrag (recurring).
export type JobType = "single" | "recurring";

// Ein zugewiesener Mitarbeiter an einem Auftrag (eine Zeile aus job_assignments).
//
// BEWUSST MINIMAL: das Modell trägt nur, was der Lesepfad heute WIRKLICH
// anzeigt. `attendance` und `counts_for_timesheet` existieren in der DB,
// wurden hier aber entfernt — sie hatten keinen einzigen Konsumenten und
// mussten in jedem Fallback-Pfad erfunden werden (aus job.status abgeleitet).
// Insbesondere `counts_for_timesheet` ist die Quelle der Stundenzettel-
// BERECHTIGUNG; ein erfundener Wert dafür im Client wäre eine Abrechnungs-
// Falle. Beide kommen in Phase 7 zurück, wenn `attendance` serverseitig
// gepflegt wird und es echte Konsumenten gibt.
export type JobAssignee = {
  /** PK der Zuweisung — stabiler React-Key, auch bei gelöschtem Konto. */
  assignmentId: string;
  /** NULL = das Mitarbeiterkonto wurde gelöscht (anonymisierter Nachweis). */
  employeeId: string | null;
  /** Lebender Profilname; Fallback auf den Schnappschuss bei gelöschtem Konto. */
  fullName: string;
  /** true, wenn das Konto gelöscht wurde (employeeId === null). */
  isDeleted: boolean;
};

export type Job = {
  id: string;
  customerName: string;
  location: string;
  time: string;
  service: string;

  /**
   * Vollständige Zuweisungsmenge des Auftrags (Phase 5). Leeres Array =
   * niemandem zugewiesen. Maßgeblich für JEDE Anzeige von Mitarbeitern.
   */
  assignees: JobAssignee[];

  /**
   * @deprecated Legacy-Primär aus jobs.assigned_to. NICHT mehr für die
   * Anzeige verwenden — dafür ist `assignees` da.
   *
   * Bleibt in Phase 5 bewusst befüllt, weil er zwei Dinge trägt, die noch
   * nicht umgestellt sind:
   *  1. das Aktions-Gating (start_own_job/complete_own_job verlangen
   *     serverseitig weiterhin assigned_to = auth.uid() — Phase 7),
   *  2. den Schreibpfad beim Anlegen/Bearbeiten (Phase 6).
   * Entfällt mit der Spalte in Phase 11.
   */
  employeeId?: string | null;
  /** @deprecated → `assignees`. Siehe Hinweis bei `employeeId`. */
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

  // Gültigkeitszeitraum der Recurring-Regel (nur auf Parent-Zeilen, "YYYY-MM-DD").
  recurrenceStartDate?: string | null;
  recurrenceEndDate?:   string | null;
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
  // recurring: Gültigkeitszeitraum der Regel ("YYYY-MM-DD")
  recurrenceStartDate?: string | null;
  recurrenceEndDate?:   string | null;
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
  /** Wann (zuletzt) eine Einladung verschickt wurde, falls vorhanden. */
  invitedAt?: string | null;
  /** Wann der Mitarbeiter sein eigenes Passwort gesetzt hat. Null = Einladung noch offen. */
  inviteAcceptedAt?: string | null;
};
