// components/JobCard.tsx
import {
  Colors,
  Radius,
  Shadows,
  Spacing,
  Typography,
} from "@/constants/theme";
import { Job } from "@/types/job";
import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

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

const STATUS_CONFIG = {
  open: {
    label: "Offen",
    textColor: Colors.status.warning,
    bgColor: Colors.status.warningBg,
  },
  in_progress: {
    label: "In Arbeit",
    textColor: Colors.accent.text,
    bgColor: Colors.accent.subtle,
  },
  completed: {
    label: "Erledigt",
    textColor: Colors.status.success,
    bgColor: Colors.status.successBg,
  },
} as const;

export default function JobCard({ job, onStart, onComplete, onEdit }: Props) {
  const status = STATUS_CONFIG[job.status];

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

        <View style={[styles.statusBadge, { backgroundColor: status.bgColor }]}>
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
        <TouchableOpacity style={styles.editButton} onPress={onEdit}>
          <Text style={styles.editButtonText}>Bearbeiten</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border.default,
    padding: Spacing.lg,
    gap: Spacing.md,
    ...Shadows.sm,
  },

  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: Spacing.sm,
  },

  customerName: {
    flex: 1,
    fontSize: Typography.size.lg,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
  },

  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.full,
  },

  statusText: {
    fontSize: Typography.size.xs,
    fontWeight: Typography.weight.semibold,
  },

  infoBlock: {
    gap: 4,
  },

  label: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
    fontWeight: Typography.weight.semibold,
    textTransform: "uppercase",
  },

  value: {
    fontSize: Typography.size.sm,
    color: Colors.text.primary,
    lineHeight: Typography.size.sm * Typography.leading.normal,
  },

  notesBox: {
    backgroundColor: Colors.bg.elevated,
    borderRadius: Radius.md,
    padding: Spacing.md,
    gap: 4,
  },

  notesText: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
    lineHeight: Typography.size.sm * Typography.leading.normal,
  },

  buttonRow: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },

  button: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
  },

  startButton: {
    backgroundColor: Colors.accent.default,
    borderColor: Colors.accent.default,
  },

  completeButton: {
    backgroundColor: Colors.status.successBg,
    borderColor: Colors.status.success,
  },

  disabledButton: {
    backgroundColor: Colors.bg.elevated,
    borderColor: Colors.border.default,
  },

  buttonText: {
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.semibold,
  },

  startButtonText: {
    color: Colors.white,
  },

  completeButtonText: {
    color: Colors.status.success,
  },

  disabledButtonText: {
    color: Colors.text.muted,
  },

  editButton: {
    minHeight: 44,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.bg.overlay,
    borderWidth: 1,
    borderColor: Colors.border.default,
  },

  editButtonText: {
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
  },
});
