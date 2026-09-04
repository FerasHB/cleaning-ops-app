import type { Job, JobAssignee } from "@/types/job";
import { isPausedRecurringOccurrence } from "@/utils/jobSchedule";

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
 *   canRunJobActions() → Start/Abschluss. Serverseitig erlauben
 *                        start_own_job/complete_own_job seit Phase 7 die
 *                        volle Zuweisungsmenge (ODER Legacy-Primär).
 *   isAssignedTo()     → seit 20260826000001 ZUSÄTZLICH Kommentar schreiben
 *                        und Foto-Upload. Die INSERT-Policies auf
 *                        job_comments/job_photos/storage.objects erlauben
 *                        seither ebenfalls die volle Zuweisungsmenge.
 *                        Seit 20260904000000 gilt dasselbe für das Markieren
 *                        des Ungelesen-Status (job_comment_reads
 *                        INSERT/UPDATE + get_unread_comment_job_ids()) —
 *                        dort aber ODER-verknüpft mit isPrimaryAssignee(),
 *                        siehe canMarkCommentsRead in JobDetailScreen.
 *
 * isPrimaryAssignee() ist kein eigenständiges Gate mehr, aber weiterhin der
 * LEGACY-ZWEIG von zwei Gates: canRunJobActions() und canMarkCommentsRead.
 * Beide Server-Prädikate lauten `assigned_to = auth.uid() OR
 * is_assigned_to_job(job)` — ein Client-Gate, das nur einen der beiden Zweige
 * abbildet, ist falsch. Fällt mit Phase 11.
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
 * Stelle der Menge). Für ANZEIGE und FILTER, Grundlage von `canRunJobActions`
 * (Start/Abschluss, seit Phase 7) und seit 20260826000001 zusätzlich für
 * Kommentar schreiben und Foto-Upload. Seit 20260904000000 auch für das
 * Markieren des Ungelesen-Status — damit ist dies das EINZIGE
 * Zuweisungs-Gate für Kommentare und Fotos.
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
 * KEIN eigenes Gate mehr, sondern der LEGACY-ZWEIG von zwei Gates —
 * Bestands-Aufträge mit `assigned_to`, für die keine job_assignments-Zeile
 * existiert (`mapAssignees` liefert dort `[]`, `isAssignedTo` also false):
 *
 *   1. `canRunJobActions` (Start/Abschluss, Begründung dort)
 *   2. `canMarkCommentsRead` in JobDetailScreen (Ungelesen-Status)
 *
 * Zu (2): der frühere Sonderfall „nur der Legacy-Primär darf markieren" ist
 * entfallen — seit 20260826000001 darf die volle Zuweisungsmenge auf
 * job_comment_reads schreiben, seit 20260904000000 wertet
 * get_unread_comment_job_ids() sie ebenfalls aus. Beide Server-Prädikate
 * tragen aber WEITERHIN den Legacy-Zweig, deshalb muss das Client-Gate ihn
 * ebenfalls tragen: sonst meldet die RPC einen Bestands-Auftrag als
 * ungelesen, den der Client nie zu markieren versucht — der rote Punkt
 * bliebe dauerhaft stehen.
 *
 * Kommentar schreiben und Foto-Upload laufen dagegen allein über
 * `isAssignedTo` (siehe dort). Fällt mit Phase 11.
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
 *
 *  4. KEIN pausierter Dauerauftrags-Termin — eine generierte Occurrence,
 *     deren Parent-Regel deaktiviert wurde (is_active=false, status='open').
 *     Spiegelt den Server-Guard in start_own_job (Migration 20260829000000);
 *     historische (in_progress/completed) Termine sind nie betroffen, siehe
 *     isPausedRecurringOccurrence().
 */
export function canRunJobActions(
  job: Pick<
    Job,
    "employeeId" | "jobType" | "assignees" | "parentJobId" | "isActive" | "status"
  >,
  role: string | null | undefined,
  employeeId: string | null | undefined,
): boolean {
  if (role !== "employee") return false;
  if (job.jobType !== "single") return false;
  if (isPausedRecurringOccurrence(job)) return false;
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
