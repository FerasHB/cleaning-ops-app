// utils/jobDuration.ts
// Job-level Arbeitszeit-Helfer — baut auf den Dauer-Primitiven aus utils/date.ts
// auf. Zentrale Stelle für "wie lange hat dieser Job gedauert/dauert er schon",
// damit UI-Komponenten und spätere Auswertungen (Stundenzettel, Wochen-/
// Monatssummen, Payroll, Durchschnittsdauer, CSV/PDF-Export) dieselbe Logik
// teilen statt eigene diffInMinutes-Aufrufe zu duplizieren.

import type { Job } from "@/types/job";
import { diffInMinutes, formatDurationLong } from "@/utils/date";

type JobTimeFields = Pick<Job, "startedAt" | "completedAt">;

/**
 * Arbeitszeit eines Jobs in Minuten.
 * - Noch nicht gestartet: 0.
 * - Läuft noch (kein completedAt): Differenz von startedAt bis `nowIso`.
 * - Abgeschlossen: Differenz von startedAt bis completedAt (nowIso wird ignoriert).
 */
export function getJobWorkedMinutes(
  job: JobTimeFields,
  nowIso: string = new Date().toISOString(),
): number {
  if (!job.startedAt) return 0;
  return diffInMinutes(job.startedAt, job.completedAt ?? nowIso);
}

/**
 * Arbeitszeit eines Jobs als Langform-Label (z.B. "1h 35min").
 * Null, wenn der Job noch nicht gestartet wurde (kein Wert anzuzeigen).
 */
export function getJobWorkedLabel(
  job: JobTimeFields,
  nowIso?: string,
): string | null {
  if (!job.startedAt) return null;
  return formatDurationLong(getJobWorkedMinutes(job, nowIso));
}
