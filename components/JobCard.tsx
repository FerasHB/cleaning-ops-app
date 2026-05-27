// components/JobCard.tsx
// Job-Karte mit Status-Badge, Details und Action-Buttons.
// Vollständig theme-aware (Light + Dark Mode).

import { useAppTheme } from "@/hooks/useAppTheme";
import { Job } from "@/types/job";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

type Props = {
  job: Job;
  onStart: () => void;
  onComplete: () => void;
  onEdit?: () => void;
};

function formatTime(iso?: string | null): string | null {
  if (!iso) return null;

  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;

  return date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso?: string | null): string | null {
  if (!iso) return null;

  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;

  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ── Status-Mapping als Funktion (damit Theme-Farben aktuell bleiben)
function getStatusConfig(theme: AppTheme, status: Job["status"]) {
  switch (status) {
    case "open":
      return {
        label: "Offen",
        textColor: theme.colors.statusOpen,
        bgColor: theme.colors.statusOpenBg,
        borderColor: theme.colors.statusOpenBorder,
      };
    case "in_progress":
      return {
        label: "In Arbeit",
        textColor: theme.colors.statusInProgress,
        bgColor: theme.colors.statusInProgressBg,
        borderColor: theme.colors.statusInProgressBorder,
      };
    case "completed":
      return {
        label: "Erledigt",
        textColor: theme.colors.statusCompleted,
        bgColor: theme.colors.statusCompletedBg,
        borderColor: theme.colors.statusCompletedBorder,
      };
  }
}

export default function JobCard({ job, onStart, onComplete, onEdit }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const status = getStatusConfig(theme, job.status);

  const date = formatDate(job.scheduledStart);
  const startTime = formatTime(job.scheduledStart);
  const endTime = formatTime(job.scheduledEnd);

  let scheduleText = "Keine Zeit";
  if (date && startTime && endTime) {
    scheduleText = `${date}, ${startTime} - ${endTime}`;
  } else if (date && startTime) {
    scheduleText = `${date}, ${startTime}`;
  } else if (date) {
    scheduleText = date;
  }

  const canStart = job.status === "open";
  const canComplete = job.status === "in_progress";

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.customerName}>{job.customerName}</Text>

        <View
          style={[
            styles.statusBadge,
            { backgroundColor: status.bgColor, borderColor: status.borderColor },
          ]}
        >
          <Text style={[styles.statusText, { color: status.textColor }]}>
            {status.label}
          </Text>
        </View>
      </View>

      <View style={styles.infoBlock}>
        <Text style={styles.label}>Service</Text>
        <Text style={styles.value}>{job.service}</Text>
      </View>

      <View style={styles.infoBlock}>
        <Text style={styles.label}>Ort</Text>
        <Text style={styles.value}>{job.location}</Text>
      </View>

      <View style={styles.infoBlock}>
        <Text style={styles.label}>Zeit</Text>
        <Text style={styles.value}>{scheduleText}</Text>
      </View>

      {job.employeeName ? (
        <View style={styles.infoBlock}>
          <Text style={styles.label}>Mitarbeiter</Text>
          <Text style={styles.value}>{job.employeeName}</Text>
        </View>
      ) : null}

      {job.notes ? (
        <View style={styles.notesBox}>
          <Text style={styles.label}>Notiz</Text>
          <Text style={styles.notesText}>{job.notes}</Text>
        </View>
      ) : null}

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[
            styles.button,
            styles.startButton,
            !canStart && styles.disabledButton,
          ]}
          onPress={onStart}
          disabled={!canStart}
          activeOpacity={0.85}
        >
          <Text
            style={[
              styles.buttonText,
              styles.startButtonText,
              !canStart && styles.disabledButtonText,
            ]}
          >
            Start
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.button,
            styles.completeButton,
            !canComplete && styles.disabledButton,
          ]}
          onPress={onComplete}
          disabled={!canComplete}
          activeOpacity={0.85}
        >
          <Text
            style={[
              styles.buttonText,
              styles.completeButtonText,
              !canComplete && styles.disabledButtonText,
            ]}
          >
            Fertig
          </Text>
        </TouchableOpacity>
      </View>

      {onEdit ? (
        <TouchableOpacity
          style={styles.editButton}
          onPress={onEdit}
          activeOpacity={0.85}
        >
          <Text style={styles.editButtonText}>Bearbeiten</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
      ...theme.shadows.sm,
    },

    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      gap: theme.spacing.sm,
    },

    customerName: {
      flex: 1,
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },

    statusBadge: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: theme.radius.full,
      borderWidth: 1,
    },

    statusText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      letterSpacing: theme.typography.letterSpacing.wide,
    },

    infoBlock: {
      gap: 4,
    },

    label: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wide,
      textTransform: "uppercase",
    },

    value: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
    },

    notesBox: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
      gap: 4,
    },

    notesText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.sm,
    },

    buttonRow: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },

    button: {
      flex: 1,
      minHeight: theme.spacing.tapTarget,
      borderRadius: theme.radius.md,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing.md,
      borderWidth: 1,
    },

    startButton: {
      backgroundColor: theme.colors.primaryContainer,
      borderColor: theme.colors.primaryContainer,
    },

    completeButton: {
      backgroundColor: theme.colors.statusCompletedBg,
      borderColor: theme.colors.statusCompletedBorder,
    },

    disabledButton: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderColor: theme.colors.outlineVariant,
    },

    buttonText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },

    startButtonText: {
      color: theme.colors.onPrimaryContainer,
    },

    completeButtonText: {
      color: theme.colors.statusCompleted,
    },

    disabledButtonText: {
      color: theme.colors.outline,
    },

    editButton: {
      minHeight: theme.spacing.tapTarget,
      borderRadius: theme.radius.md,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surfaceContainer,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
    },

    editButtonText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
  });
}
