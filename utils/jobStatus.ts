// utils/jobStatus.ts
// ─────────────────────────────────────────────────────────────────
// EINE kanonische Darstellung für den Job-Status (Farbtripel + Reihenfolge).
//
// Warum zentral: Wortlaut und Farben lagen früher doppelt in
// `components/JobCard.tsx` (getStatusConfig) und `components/ui/StatusBadge.tsx`
// (DEFAULT_LABELS + getStatusColors), dazu ein drittes und viertes Mal als
// Filter-Chip- und KPI-Beschriftungen in den Screens. Jede Kopie konnte
// eigenständig abdriften — genau das war passiert (die Arbeitszeit-Karte
// beschriftete `completed` als „Abgeschlossen", während direkt darunter
// „ERLEDIGT" stand).
//
// Beschriftung (übersetzt) kommt seit der Mehrsprachigkeit NICHT mehr von
// hier, sondern aus hooks/useJobStatusLabels.ts (i18n/locales/*/common.json,
// status.*) — diese Datei bleibt bewusst frei von React-/i18n-Importen, damit
// sie rein und testbar bleibt. Farben/Reihenfolge sind sprachunabhängig und
// bleiben deshalb hier.
//
// Aufrufer, die eine Beschriftung brauchen (Badges, Chips, KPIs), holen sie
// über useJobStatusLabels() und reichen sie an getJobStatusMeta() durch —
// EINE Quelle für Wortlaut (i18n) und EINE Quelle für Farben (hier), kein
// Drift zwischen Screens/Komponenten möglich.
// ─────────────────────────────────────────────────────────────────

import type { ColorPalette } from "@/constants/colors";
import type { JobStatus } from "@/types/job";

/** Reihenfolge für Status-Sortierung/Filterleisten: offen → in Arbeit → erledigt. */
export const JOB_STATUS_ORDER: JobStatus[] = ["open", "in_progress", "completed"];

export type JobStatusColors = {
  /** Textfarbe (auch für Dot/Icon in derselben Semantik). */
  text: string;
  bg: string;
  border: string;
};

export type JobStatusMeta = JobStatusColors & {
  label: string;
};

/** Farbtripel eines Status aus der aktuellen Palette (Light/Dark kommen automatisch mit der Palette). */
export function getJobStatusColors(
  status: JobStatus,
  colors: ColorPalette,
): JobStatusColors {
  switch (status) {
    case "open":
      return {
        text: colors.statusOpen,
        bg: colors.statusOpenBg,
        border: colors.statusOpenBorder,
      };
    case "in_progress":
      return {
        text: colors.statusInProgress,
        bg: colors.statusInProgressBg,
        border: colors.statusInProgressBorder,
      };
    case "completed":
      return {
        text: colors.statusCompleted,
        bg: colors.statusCompletedBg,
        border: colors.statusCompletedBorder,
      };
  }
}

/**
 * Beschriftung + Farbtripel eines Status. `label` kommt vom Aufrufer (aus
 * useJobStatusLabels()) — siehe Dateikopf, warum diese Datei selbst nicht
 * übersetzt.
 */
export function getJobStatusMeta(
  status: JobStatus,
  colors: ColorPalette,
  label: string,
): JobStatusMeta {
  return { label, ...getJobStatusColors(status, colors) };
}
