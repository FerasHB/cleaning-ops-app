// hooks/useJobStatusLabels.ts
// EINE kanonische, ÜBERSETZTE Beschriftung je Job-Status.
//
// Farben/Reihenfolge bleiben in utils/jobStatus.ts (dort bewusst kein i18n,
// damit die Datei frei von React-/i18n-Importen bleibt — siehe deren
// Kopfkommentar). Wortlaut kommt aus i18n/locales/*/common.json (status.*).
// Jeder Aufrufer, der bisher die alte (rein deutsche) getJobStatusLabel()
// nutzte, verwendet jetzt diesen Hook — eine Quelle für alle Screens/
// Komponenten, kein Wortlaut driftet mehr einzeln auseinander.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@/types/job";

export function useJobStatusLabels(): Record<JobStatus, string> {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      open: t("common:status.open"),
      in_progress: t("common:status.inProgress"),
      completed: t("common:status.completed"),
    }),
    [t],
  );
}
