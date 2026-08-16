// features/absences/components/AbsenceStatusBadge.tsx
// Status-Badge für Abwesenheiten. Nutzt den generischen `Badge` aus
// components/ui — der bestehende `StatusBadge` ist fest an JobStatus/
// utils/jobStatus.ts gebunden (siehe dessen Kopfkommentar) und für einen
// eigenen Status-Enum nicht gedacht.

import { Badge } from "@/components/ui";
import type { AbsenceStatus } from "@/types/absence";
import React from "react";

const LABELS: Record<AbsenceStatus, string> = {
  requested: "Angefragt",
  approved: "Genehmigt",
  rejected: "Abgelehnt",
  cancelled: "Storniert",
  reported: "Gemeldet",
};

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
  return <Badge label={LABELS[status]} variant={VARIANTS[status]} />;
}
