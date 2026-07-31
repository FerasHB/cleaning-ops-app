// features/jobs/components/JobPendingActionHint.tsx
// Job-spezifischer Hinweis, ob für DIESEN Auftrag eine Aktion offline in der
// Warteschlange liegt (z.B. "Start wartet auf Internet"). Rein lesende
// Auswertung des bereits vorhandenen JobContext-Zustands (`pendingActions`)
// — keine eigene Queue-/Sync-Logik, kein Schreibzugriff. Ergänzt die
// globale <OfflineBanner/>, die nur die Gesamtzahl zeigt, um eine
// Zuordnung zum gerade geöffneten Job.

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { PendingJobAction } from "@/services/offline/jobs.queue";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  jobId: string;
  pendingActions: PendingJobAction[];
};

function labelFor(type: PendingJobAction["type"]): string {
  switch (type) {
    case "start_job":
      return "Start wartet auf Internet";
    case "complete_job":
      return "Abschluss wartet auf Synchronisierung";
    default:
      return "Änderung wartet auf Synchronisierung";
  }
}

export function JobPendingActionHint({ jobId, pendingActions }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const jobPending = pendingActions.filter((a) => a.jobId === jobId);
  if (jobPending.length === 0) return null;

  return (
    <View
      style={styles.wrap}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      {jobPending.map((action) => (
        <View key={action.id} style={styles.row}>
          <Ionicons
            name="time-outline"
            size={14}
            color={theme.colors.statusOpen}
          />
          <Text style={styles.text}>{labelFor(action.type)}</Text>
        </View>
      ))}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    wrap: {
      gap: 6,
      backgroundColor: theme.colors.statusOpenBg,
      borderWidth: 1,
      borderColor: theme.colors.statusOpenBorder,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    text: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.statusOpen,
      flexShrink: 1,
    },
  });
}
