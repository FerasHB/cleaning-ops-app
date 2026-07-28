import type { Job, JobAssignee } from "@/types/job";

/**
 * Zentrale Helfer für die Anzeige der Zuweisungsmenge eines Auftrags.
 *
 * Gleiche Begründung wie bei utils/jobSchedule.ts: die Frage „wer ist diesem
 * Auftrag zugewiesen und wie schreibe ich das hin?" darf nicht in jedem Screen
 * neu beantwortet werden. Job-Karte, Detail, Dashboard, Mitarbeiter-Detail,
 * Suche und Filter nutzen ausschließlich diese Funktionen.
 *
 * WICHTIG — Anzeige vs. Berechtigung: diese Helfer beantworten NUR, wer
 * angezeigt wird. Sie sind KEINE Grundlage für Aktions-Buttons. Start und
 * Abschluss laufen über start_own_job/complete_own_job, die serverseitig
 * weiterhin jobs.assigned_to = auth.uid() verlangen (Phase 7). Dafür gibt es
 * bewusst `isPrimaryAssignee`.
 */

export const UNASSIGNED_LABEL = "Nicht zugewiesen";

/** Kennzeichnung für Zuweisungen, deren Mitarbeiterkonto gelöscht wurde. */
export const DELETED_SUFFIX = " (ehemalig)";

/** Alle Zugewiesenen eines Jobs — nie undefined, auch bei Alt-Daten. */
export function getAssignees(job: Pick<Job, "assignees">): JobAssignee[] {
  return job.assignees ?? [];
}

/** Namen aller Zugewiesenen in stabiler Reihenfolge (Service sortiert bereits). */
export function getAssigneeNames(job: Pick<Job, "assignees">): string[] {
  return getAssignees(job).map((a) =>
    a.isDeleted ? `${a.fullName}${DELETED_SUFFIX}` : a.fullName,
  );
}

/** true, wenn dem Job niemand zugewiesen ist. */
export function isUnassigned(job: Pick<Job, "assignees">): boolean {
  return getAssignees(job).length === 0;
}

/**
 * true, wenn der Mitarbeiter dem Auftrag zugewiesen ist (egal an welcher
 * Stelle der Menge). Für ANZEIGE und FILTER — nicht für Aktions-Gating.
 */
export function isAssignedTo(
  job: Pick<Job, "assignees">,
  employeeId: string | null | undefined,
): boolean {
  if (!employeeId) return false;
  return getAssignees(job).some((a) => a.employeeId === employeeId);
}

/**
 * true, wenn der Mitarbeiter der LEGACY-PRIMÄR des Auftrags ist.
 *
 * Ausschließlich für das Aktions-Gating (Start/Abschluss/Foto-Upload/
 * Kommentar) gedacht: die zugehörigen RPCs und Schreib-Policies verlangen
 * serverseitig weiterhin jobs.assigned_to = auth.uid(). Würde die UI hier
 * die volle Menge nutzen, bekäme ein sekundär Zugewiesener einen Button,
 * der mit „Job not found or not allowed" fehlschlägt. Fällt mit Phase 7.
 */
export function isPrimaryAssignee(
  job: Pick<Job, "employeeId">,
  employeeId: string | null | undefined,
): boolean {
  if (!employeeId) return false;
  return job.employeeId === employeeId;
}

/**
 * Darf für DIESEN Nutzer an DIESEM Auftrag ein Start-/Fertig-Button
 * erscheinen?
 *
 * Zentral, weil die Antwort an fünf Stellen gebraucht wird (Jobliste,
 * Employee-Übersicht, Kalender, Home, Detail) und eine falsch-positive
 * Antwort einen Button erzeugt, der serverseitig garantiert fehlschlägt.
 *
 * Drei Bedingungen:
 *  1. Rolle 'employee' — Admins ändern den Status nie über diese RPCs.
 *  2. job_type 'single' — Parent-Recurring-Regeln sind keine ausführbaren
 *     Termine.
 *  3. LEGACY-PRIMÄR (nicht die Zuweisungsmenge!) — start_own_job und
 *     complete_own_job verlangen weiterhin assigned_to = auth.uid().
 *     Seit Phase 5 sieht ein Mitarbeiter auch Aufträge, denen er nur
 *     sekundär zugewiesen ist; ohne Bedingung 3 bekäme er dort einen
 *     Button, der mit „Job not found or not allowed" endet.
 *
 * Bedingung 3 fällt mit Phase 7, wenn die RPCs die Zuweisungsmenge kennen.
 */
export function canRunJobActions(
  job: Pick<Job, "employeeId" | "jobType">,
  role: string | null | undefined,
  employeeId: string | null | undefined,
): boolean {
  if (role !== "employee") return false;
  if (job.jobType !== "single") return false;
  return isPrimaryAssignee(job, employeeId);
}

/**
 * Baut aus den LEGACY-Feldern (`employeeId`/`employeeName`) eine sichere
 * Ein-Element-Zuweisungsliste.
 *
 * EINZIGE Notfall-Quelle für `assignees`, wenn die echte Zuweisungsmenge
 * nicht verfügbar ist. Genau zwei Aufrufer:
 *
 *  1. `readBackJob()` in services/jobs/jobs.service.ts — wenn das frische
 *     Nachlesen nach einem erfolgreichen INSERT/UPDATE scheitert. Ohne diese
 *     Ableitung stünde dort `[]` (nach dem Anlegen, ununterscheidbar von
 *     „niemandem zugewiesen") bzw. die ALTE Menge (nach dem Bearbeiten) —
 *     und der JobContext schriebe genau das in State und AsyncStorage.
 *  2. `normalizeCachedJob()` in services/offline/jobs.storage.ts — für
 *     Cache-Einträge, die eine App-Version VOR Phase 5 geschrieben hat und
 *     die `assignees` noch nicht kennen.
 *
 * Beide Fälle sind dasselbe Problem: nur der Legacy-Zeiger ist bekannt.
 *
 * BEWUSSTE EIGENSCHAFTEN:
 *  - Erfindet NIE mehrere Zugewiesene. Der Legacy-Zeiger kann genau einen
 *    Mitarbeiter ausdrücken; mehr zu behaupten wäre geraten.
 *  - Erfindet KEINE Anwesenheits- oder Abrechnungsdaten (deshalb trägt
 *    `JobAssignee` diese Felder nicht mehr, siehe types/job.ts).
 *  - Gelöschte Konten: `jobs.assigned_to` wird bei der Kontolöschung auf NULL
 *    gesetzt (ON DELETE SET NULL). Der Legacy-Zeiger trägt dann keinerlei
 *    Information mehr — das Ergebnis ist korrekt `[]`, und es wird bewusst
 *    KEIN anonymer Platzhalter erfunden. Die echte anonymisierte Zeile
 *    (employeeId = null + Namens-Schnappschuss) entsteht ausschließlich auf
 *    dem regulären Lesepfad in `mapAssignees()`.
 *  - `assignmentId` ist synthetisch (Präfix `legacy:`): für diesen Eintrag
 *    existiert keine echte job_assignments-ID. Wird nur als React-Key genutzt
 *    und ist am Präfix als abgeleitet erkennbar.
 */
export function buildLegacyAssignees(
  job: Pick<Job, "id" | "employeeId" | "employeeName">,
): JobAssignee[] {
  if (!job.employeeId) return [];

  return [
    {
      assignmentId: `legacy:${job.id}:${job.employeeId}`,
      employeeId: job.employeeId,
      fullName: job.employeeName?.trim() || "Unbekannt",
      isDeleted: false,
    },
  ];
}

/**
 * Kompakte Anzeige für enge Stellen (Job-Karte, Listenzeilen):
 * bis `maxNames` Namen, der Rest als „+N".
 *
 * Beispiele (maxNames = 2):
 *   []                       -> "Nicht zugewiesen"
 *   [Anna]                   -> "Anna"
 *   [Anna, Bert]             -> "Anna, Bert"
 *   [Anna, Bert, Cora, Dora] -> "Anna, Bert +2"
 */
export function formatAssigneesShort(
  job: Pick<Job, "assignees">,
  maxNames: number = 2,
): string {
  const names = getAssigneeNames(job);
  if (names.length === 0) return UNASSIGNED_LABEL;
  if (names.length <= maxNames) return names.join(", ");
  return `${names.slice(0, maxNames).join(", ")} +${names.length - maxNames}`;
}

/**
 * Vollständige Aufzählung — für Detailansichten, Screenreader-Label und den
 * Suchindex, wo Kürzen falsch wäre.
 */
export function formatAssigneesFull(job: Pick<Job, "assignees">): string {
  const names = getAssigneeNames(job);
  return names.length === 0 ? UNASSIGNED_LABEL : names.join(", ");
}
