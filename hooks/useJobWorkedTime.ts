// hooks/useJobWorkedTime.ts
// ─────────────────────────────────────────────────────────────────
// Arbeitszeit eines Jobs (Minuten + Label + Running-Flag). Tickt minütlich,
// solange der Job läuft (in_progress) — Cleaning-Business-App, keine
// Stoppuhr, daher reicht Minutengenauigkeit statt sekündlichem Re-Render.
// Abgeschlossene/offene Jobs ticken nicht (Wert ist bereits final).
//
// Einzige Stelle mit einem Live-Interval für Job-Arbeitszeit — sowohl die
// kompakte JobCard-Zeile als auch die WorkedTimeCard nutzen diesen Hook,
// damit die Tick-Logik nicht dupliziert wird. State lebt in der jeweils
// aufrufenden Komponente, ein Tick re-rendert also nur diese eine Instanz.
// ─────────────────────────────────────────────────────────────────

import type { Job } from "@/types/job";
import { getJobWorkedLabel, getJobWorkedMinutes } from "@/utils/jobDuration";
import { useEffect, useState } from "react";

const TICK_MS = 60_000;

type JobTimeFields = Pick<Job, "status" | "startedAt" | "completedAt">;

export type JobWorkedTime = {
  /** Arbeitszeit in Minuten (0, wenn noch nicht gestartet). */
  minutes: number;
  /** Langform-Label (z.B. "1h 35min"), null wenn noch nicht gestartet. */
  label: string | null;
  /** Läuft der Job gerade (status === "in_progress")? */
  isRunning: boolean;
};

export function useJobWorkedTime(job: JobTimeFields): JobWorkedTime {
  const isRunning = job.status === "in_progress" && !!job.startedAt;
  const [now, setNow] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setNow(new Date().toISOString()), TICK_MS);
    return () => clearInterval(interval);
  }, [isRunning]);

  const nowIso = isRunning ? now : undefined;
  return {
    minutes: getJobWorkedMinutes(job, nowIso),
    label: getJobWorkedLabel(job, nowIso),
    isRunning,
  };
}
