// components/ui/StatusBadge.tsx
// ─────────────────────────────────────────────────────────────────
// Job-Status-Badge mit farbigem Dot-Indikator.
// Unterstützt alle drei Job-Status (open, in_progress, completed).
// Lesbarer und semantisch korrekter als die generische Badge-Komponente.
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ColorPalette } from "@/constants/colors";

export type JobStatus = "open" | "in_progress" | "completed";

interface StatusBadgeProps {
  status: JobStatus;
  /** Optionale custom Labels (Standard: Deutsch) */
  labels?: { open?: string; in_progress?: string; completed?: string };
}

const DEFAULT_LABELS = {
  open:        "Offen",
  in_progress: "In Arbeit",
  completed:   "Erledigt",
};

function getStatusColors(status: JobStatus, colors: ColorPalette) {
  switch (status) {
    case "open":
      return {
        text:   colors.statusOpen,
        bg:     colors.statusOpenBg,
        border: colors.statusOpenBorder,
        dot:    colors.statusOpen,
      };
    case "in_progress":
      return {
        text:   colors.statusInProgress,
        bg:     colors.statusInProgressBg,
        border: colors.statusInProgressBorder,
        dot:    colors.statusInProgress,
      };
    case "completed":
      return {
        text:   colors.statusCompleted,
        bg:     colors.statusCompletedBg,
        border: colors.statusCompletedBorder,
        dot:    colors.statusCompleted,
      };
  }
}

export function StatusBadge({ status, labels }: StatusBadgeProps) {
  const theme = useAppTheme();
  const statusColors = useMemo(
    () => getStatusColors(status, theme.colors),
    [status, theme.colors]
  );
  const styles = useMemo(() => createStyles(statusColors), [statusColors]);

  const label = { ...DEFAULT_LABELS, ...labels }[status];

  return (
    <View style={styles.badge}>
      <View style={styles.dot} />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

function createStyles(statusColors: ReturnType<typeof getStatusColors>) {
  return StyleSheet.create({
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 9999,
      backgroundColor: statusColors.bg,
      borderWidth: 1,
      borderColor: statusColors.border,
      alignSelf: "flex-start",
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 9999,
      backgroundColor: statusColors.dot,
    },
    label: {
      fontSize: 12,
      fontWeight: "600" as const,
      color: statusColors.text,
      letterSpacing: 0.3,
    },
  });
}
