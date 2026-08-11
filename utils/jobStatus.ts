// utils/jobStatus.ts
// ─────────────────────────────────────────────────────────────────
// EINE kanonische Darstellung für den Job-Status (Wortlaut + Farbtripel).
//
// Warum zentral: Wortlaut und Farben lagen doppelt in `components/JobCard.tsx`
// (getStatusConfig) und `components/ui/StatusBadge.tsx` (DEFAULT_LABELS +
// getStatusColors), dazu ein drittes und viertes Mal als Filter-Chip- und
// KPI-Beschriftungen in den Screens. Jede Kopie konnte eigenständig
// abdriften — genau das war passiert (die Arbeitszeit-Karte beschriftete
// `completed` als „Abgeschlossen", während direkt darunter „ERLEDIGT" stand).
//
// KANONISCHES VOKABULAR (Stand dieses PRs):
//   open        → „Offen"
//   in_progress → „In Arbeit"
//   completed   → „Erledigt"
//
// „In Arbeit" (statt „In Bearbeitung") ist bewusst gewählt: es ist der Wortlaut,
// den bereits ALLE Live-Flächen verwendeten (Karten, Badges, Filter, KPIs), es
// ist kürzer und bricht damit in schmalen Chips/KPI-Kacheln nicht um.
// „In Bearbeitung"/„Abgeschlossen" standen nur in `i18n/translations.ts`, das
// ausschließlich vom nicht gerouteten HomeScreen benutzt wird.
// Eine spätere Umbenennung ist jetzt eine Ein-Zeilen-Änderung an JOB_STATUS_LABELS.
//
// Bewusst KEINE React-/Theme-Imports: die Farbpalette kommt als Parameter
// herein (`useAppTheme().colors`), damit die Datei rein und testbar bleibt.
// ─────────────────────────────────────────────────────────────────

import type { ColorPalette } from "@/constants/colors";
import type { JobStatus } from "@/types/job";

/** Kanonische deutsche Beschriftung je Job-Status. */
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  open: "Offen",
  in_progress: "In Arbeit",
  completed: "Erledigt",
};

/** Reihenfolge für Status-Sortierung/Filterleisten: offen → in Arbeit → erledigt. */
export const JOB_STATUS_ORDER: JobStatus[] = ["open", "in_progress", "completed"];

/** Kanonische Beschriftung eines Status (für Chips, KPIs, Fließtext). */
export function getJobStatusLabel(status: JobStatus): string {
  return JOB_STATUS_LABELS[status];
}

export type JobStatusMeta = {
  label: string;
  /** Textfarbe (auch für Dot/Icon in derselben Semantik). */
  text: string;
  bg: string;
  border: string;
};

/**
 * Beschriftung + Farbtripel eines Status aus der aktuellen Palette.
 * Light/Dark kommen automatisch mit, weil die Palette vom Theme stammt.
 */
export function getJobStatusMeta(
  status: JobStatus,
  colors: ColorPalette,
): JobStatusMeta {
  switch (status) {
    case "open":
      return {
        label: JOB_STATUS_LABELS.open,
        text: colors.statusOpen,
        bg: colors.statusOpenBg,
        border: colors.statusOpenBorder,
      };
    case "in_progress":
      return {
        label: JOB_STATUS_LABELS.in_progress,
        text: colors.statusInProgress,
        bg: colors.statusInProgressBg,
        border: colors.statusInProgressBorder,
      };
    case "completed":
      return {
        label: JOB_STATUS_LABELS.completed,
        text: colors.statusCompleted,
        bg: colors.statusCompletedBg,
        border: colors.statusCompletedBorder,
      };
  }
}
