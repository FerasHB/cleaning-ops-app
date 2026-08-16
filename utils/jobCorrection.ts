// utils/jobCorrection.ts
// Ist ein Auftrag überhaupt für eine Admin-Zeitkorrektur zugänglich?
//
// WARUM EIGENE DATEI: der Grenzwert PHASE1_CUTOFF_ISO wird an zwei Stellen
// gebraucht — im Stundenzettel (welche Zeitquelle gilt?) und in der UI (darf
// die Korrektur-Aktion überhaupt erscheinen?). Er ist abrechnungsrelevant und
// darf deshalb NICHT zweimal im Code stehen. Diese Datei ist die einzige
// Quelle; services/timesheets/timesheet.service.ts importiert ihn von hier.
//
// Die Prädikate spiegeln die Vorbedingungen von admin_correct_assignment_time
// (Migration 20260814000000), soweit sie am Job erkennbar sind. Maßgeblich
// bleibt die RPC — hier geht es nur darum, dem Admin gar nicht erst eine
// Aktion anzubieten, die serverseitig zwingend abgelehnt würde.

import type { Job } from "@/types/job";

/**
 * Zeitpunkt, ab dem start_own_job/complete_own_job die individuellen
 * Zeitstempel (job_assignments.employee_started_at/employee_completed_at)
 * überhaupt schreiben — entspricht Migration 20260812000000 ("Phase 1
 * Worked Time"). Aufträge, die davor abgeschlossen wurden, kennen keine
 * individuelle Zeit; der Stundenzettel rechnet dort mit der geteilten
 * Job-Uhr.
 */
export const PHASE1_CUTOFF_ISO = "2026-08-12T00:00:00.000Z";

/**
 * true, wenn dieser Auftrag VOR Phase 1 abgeschlossen wurde — dann gilt im
 * Stundenzettel der Fallback auf die geteilte Job-Uhr.
 */
export function isLegacyJob(jobCompletedAtIso: string): boolean {
  return new Date(jobCompletedAtIso).getTime() < Date.parse(PHASE1_CUTOFF_ISO);
}

/**
 * Darf für diesen AUFTRAG eine Zeitkorrektur angeboten werden?
 *
 * Drei Bedingungen, alle deckungsgleich mit der RPC:
 *  1. abgeschlossen — an offenen/laufenden Aufträgen ist eine fehlende
 *     Eigenzeit KEIN Fehler, sondern der Normalzustand.
 *  2. vollständige geteilte Uhr — ohne sie liefert der Stundenzettel für
 *     diesen Auftrag ohnehin keine Zeile (serverseitiger Filter).
 *  3. nach dem Phase-1-Grenzwert — für Alt-Aufträge gilt der Legacy-Fallback:
 *     der Mitarbeiter bekommt dort bereits Stunden gutgeschrieben, eine
 *     fehlende Eigenzeit ist also weder ein Mangel noch korrigierbar.
 *
 * BEWUSST NICHT geprüft: job_type='single'. Diese Karte rendert für
 * Recurring-Parent-Regeln ohnehin ohne Admin-Zusätze (RecurringRuleDetailScreen
 * übergibt kein isAdmin), und die RPC lehnt sie zuverlässig ab.
 */
export function isCorrectableJob(
  job: Pick<Job, "status" | "startedAt" | "completedAt">,
): boolean {
  if (job.status !== "completed") return false;
  if (!job.startedAt || !job.completedAt) return false;
  return !isLegacyJob(job.completedAt);
}
