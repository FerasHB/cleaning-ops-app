// features/absences/components/AbsenceStatusBadge.tsx
// Status-Badge für Abwesenheiten. Nutzt den generischen `Badge` aus
// components/ui — der bestehende `StatusBadge` ist fest an JobStatus/
// utils/jobStatus.ts gebunden (siehe dessen Kopfkommentar) und für einen
// eigenen Status-Enum nicht gedacht.
//
// Beschriftung übersetzt (i18n/locales/*/absences.json, status.*) — gemeinsame
// Quelle für Mitarbeiter (AbsenceCard) UND Admin (AdminAbsenceRow), analog zu
// hooks/useJobStatusLabels.ts für Job-Status.

import { Badge } from "@/components/ui";
import type { AbsenceStatus } from "@/types/absence";
import React from "react";
import { useTranslation } from "react-i18next";

const VARIANTS: Record<
  AbsenceStatus,
  "default" | "success" | "warning" | "danger" | "info"
> = {
  requested: "warning",
  approved: "success",
  rejected: "danger",
  cancelled: "default",
  reported: "info",
};

export function AbsenceStatusBadge({ status }: { status: AbsenceStatus }) {
  const { t } = useTranslation();
  return (
    <Badge label={t(`absences:status.${status}`)} variant={VARIANTS[status]} />
  );
}
