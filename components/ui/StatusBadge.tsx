// components/ui/StatusBadge.tsx
// ─────────────────────────────────────────────────────────────────
// Job-Status-Badge mit farbigem Dot-Indikator.
// Unterstützt alle drei Job-Status (open, in_progress, completed).
//
// Beschriftung UND Farben kommen aus `utils/jobStatus.ts` — der einzigen
// Quelle für Job-Status-Darstellung (siehe dortigen Kopfkommentar).
// Die frühere `labels`-Prop (custom Beschriftungen) ist entfallen: sie war der
// Weg, über den die Arbeitszeit-Karte „Abgeschlossen" statt „Erledigt" zeigte.
// Wer den Wortlaut ändern will, ändert ihn in JOB_STATUS_LABELS — für alle.
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { getJobStatusMeta, type JobStatusMeta } from "@/utils/jobStatus";
import type { JobStatus } from "@/types/job";

export type { JobStatus };

interface StatusBadgeProps {
  status: JobStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const theme = useAppTheme();
  const meta = useMemo(
    () => getJobStatusMeta(status, theme.colors),
    [status, theme.colors],
  );
  const styles = useMemo(() => createStyles(meta), [meta]);

  return (
    <View style={styles.badge}>
      <View style={styles.dot} />
      <Text style={styles.label}>{meta.label}</Text>
    </View>
  );
}

function createStyles(meta: JobStatusMeta) {
  return StyleSheet.create({
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 9999,
      backgroundColor: meta.bg,
      borderWidth: 1,
      borderColor: meta.border,
      alignSelf: "flex-start",
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 9999,
      backgroundColor: meta.text,
    },
    label: {
      fontSize: 12,
      fontWeight: "600" as const,
      color: meta.text,
      letterSpacing: 0.3,
    },
  });
}
