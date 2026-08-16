import type { Job, JobAssignee } from "@/types/job";

/**
 * Zentrale Helfer für die Anzeige der Zuweisungsmenge eines Auftrags.
 *
 * Gleiche Begründung wie bei utils/jobSchedule.ts: die Frage „wer ist diesem
 * Auftrag zugewiesen und wie schreibe ich das hin?" darf nicht in jedem Screen
 * neu beantwortet werden. Job-Karte, Detail, Dashboard, Mitarbeiter-Detail,
 * Suche und Filter nutzen ausschließlich diese Funktionen.
 *
 * WICHTIG — Anzeige vs. Berechtigung: die Formatier-Helfer beantworten NUR,
 * wer angezeigt wird. Für Aktions-Buttons gibt es genau zwei Gates, die dem
 * jeweiligen SERVER-Prädikat entsprechen müssen:
 *
 *   canRunJobActions()  → Start/Abschluss. Serverseitig erlauben
 *                         start_own_job/complete_own_job seit Phase 7 die
 *                         volle Zuweisungsmenge (ODER Legacy-Primär).
 *   isPrimaryAssignee() → Kommentar schreiben, Foto-Upload, Ungelesen-Status.
 *                         Deren INSERT-Policies verlangen weiterhin
 *                         jobs.assigned_to = auth.uid().
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
 * Stelle der Menge). Für ANZEIGE und FILTER — und seit Phase 7 zusätzlich
 * die Grundlage von `canRunJobActions` (Start/Abschluss). NICHT ausreichend
 * für Kommentar-/Foto-Schreibrechte, dafür siehe `isPrimaryAssignee`.
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
 * NUR NOCH für die Schreibpfade, die serverseitig weiterhin
 * jobs.assigned_to = auth.uid() verlangen:
 *   * Kommentar schreiben  (Policy „employee insert comments on own jobs")
 *   * Foto-Upload          (job_photos + storage.objects INSERT)
 *   * Ungelesen-Status     (job_comment_reads INSERT/UPDATE)
 *
 * Würde die UI dort die volle Zuweisungsmenge nutzen, bekäme ein sekundär
 * Zugewiesener einen Button, der mit 42501 bzw. „Job not found or not
 * allowed" fehlschlägt.
 *
 * NICHT MEHR für Start/Abschluss: diese laufen seit Phase 7 über die
 * Zuweisungsmenge — siehe `canRunJobActions`.
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
 * Diese Funktion spiegelt bewusst ZEICHENGENAU das Prädikat von
 * start_own_job/complete_own_job (Migration 20260731000000):
 *
 *  1. Rolle 'employee' — Admins ändern den Status nie über diese RPCs.
 *  2. job_type 'single' — Parent-Recurring-Regeln sind keine ausführbaren
 *     Termine. Steht wie serverseitig AUSSERHALB der Oder-Verknüpfung:
 *     Recurring-Parent-Regeln tragen seit Phase 4 selbst Zuweisungen.
 *  3. Zugewiesen — entweder über die Zuweisungsmenge (`assignees`, der
 *     Normalfall) ODER über den Legacy-Zeiger `employeeId`.
 *
 * ZUM LEGACY-ZWEIG IN (3): er ist kein Rest, sondern nötig. Es existieren
 * Bestands-Aufträge mit `assigned_to`, für die keine job_assignments-Zeile
 * angelegt wurde (der Phase-1-Backfill hat nicht-konforme Zeilen bewusst
 * erhalten). Serverseitig darf dieser Mitarbeiter starten; ohne den Zweig
 * würde die App ihm den Button vorenthalten. Fällt mit Phase 11.
 *
 * Die Bedingung „nur der Legacy-Primär" ist mit Phase 7 ENTFALLEN: die
 * Job-Uhr gehört dem Auftrag, nicht einem einzelnen Mitarbeiter. Jeder
 * Zugewiesene darf starten und abschließen; der erste Erfolg gewinnt, alle
 * anderen sehen danach denselben Status.
 */
export function canRunJobActions(
  job: Pick<Job, "employeeId" | "jobType" | "assignees">,
  role: string | null | undefined,
  employeeId: string | null | undefined,
): boolean {
  if (role !== "employee") return false;
  if (job.jobType !== "single") return false;
  return isAssignedTo(job, employeeId) || isPrimaryAssignee(job, employeeId);
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
/**
 * Darf für diese Zuweisung eine Admin-Zeitkorrektur angeboten werden?
 * (Phase B1 — spiegelt die Vorbedingungen von admin_correct_assignment_time,
 * soweit sie auf der Zuweisung selbst erkennbar sind.)
 *
 * Zwei Ausschlüsse:
 *  1. LEGACY-Zeilen aus buildLegacyAssignees tragen eine synthetische
 *     `legacy:<jobId>:<employeeId>`-Kennung statt einer echten UUID. Ein
 *     Aufruf damit wäre ein Typfehler auf der RPC, kein fachlicher Fehler —
 *     der Button darf dort gar nicht erst erscheinen.
 *  2. Anonymisierte Zeilen (gelöschtes Konto, employeeId === null) lehnt die
 *     RPC ausdrücklich ab: eine Korrektur könnte für niemanden im
 *     Stundenzettel erscheinen.
 *
 * Die Auftrags-Bedingungen (job_type='single', abgeschlossen, nach dem
 * Phase-1-Cutoff) prüft weiterhin allein die RPC — sie sind hier nicht
 * zuverlässig bekannt.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCorrectableAssignment(assignee: JobAssignee): boolean {
  if (!assignee.employeeId) return false;
  return UUID_RE.test(assignee.assignmentId);
}

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
      // HART null (Phase B1): dieser Zweig kennt die echte Zuweisungszeile
      // nicht. Die geteilte Job-Uhr hier einzusetzen würde einem Mitarbeiter
      // eine individuelle Arbeitszeit andichten, die er nie erfasst hat —
      // genau die Abrechnungs-Falle, die types/job.ts beschreibt.
      // Folge: die Korrektur-Aktion bleibt für solche Zeilen ausgeblendet
      // (die synthetische assignmentId ist ohnehin keine echte UUID).
      employeeStartedAt: null,
      employeeCompletedAt: null,
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
