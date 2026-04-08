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

// ── Props ──
type Props = {
  job: Job;
  onStart: () => void;
  onComplete: () => void;
  onEdit?: () => void; // optional → nur für Admin sichtbar
};

// ── Helpers ──
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
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

const STATUS_CONFIG = {
  open: {
    label: "Offen",
    fg: Colors.status.warning,
    bg: Colors.status.warningBg,
    border: Colors.status.warningBg,
    dot: Colors.status.warning,
  },
  in_progress: {
    label: "In Arbeit",
    fg: Colors.accent.text,
    bg: Colors.accent.subtle,
    border: Colors.accent.subtle,
    dot: Colors.accent.default,
  },
  completed: {
    label: "Erledigt",
    fg: Colors.status.success,
    bg: Colors.status.successBg,
    border: Colors.status.successBg,
    dot: Colors.status.success,
  },
} as const;

export default function JobCard({ job, onStart, onComplete, onEdit }: Props) {
  const statusConfig = STATUS_CONFIG[job.status];

  const startTime = formatTime(job.scheduledStart);
  const endTime = formatTime(job.scheduledEnd);
  const scheduleDate = formatDate(job.scheduledStart);

  const timeDisplay =
    startTime && endTime ? `${startTime} – ${endTime}` : startTime;

  const canStart = job.status === "open";
  const canComplete = job.status === "in_progress";

  return (
    <View style={styles.card}>
      <View style={[styles.accentBar, { backgroundColor: statusConfig.fg }]} />

      <View style={styles.content}>
        {/* Header */}
        <View style={styles.headerRow}>
          <Text style={styles.customerName} numberOfLines={1}>
            {job.customerName}
          </Text>

          <View
            style={[
              styles.badge,
              {
                backgroundColor: statusConfig.bg,
                borderColor: statusConfig.border,
              },
            ]}
          >
            <View
              style={[styles.badgeDot, { backgroundColor: statusConfig.dot }]}
            />
            <Text style={[styles.badgeText, { color: statusConfig.fg }]}>
              {statusConfig.label}
            </Text>
          </View>
        </View>

        {/* Service */}
        <Text style={styles.serviceText}>{job.service}</Text>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Info */}
        <View style={styles.infoGrid}>
          <InfoRow icon="📍" value={job.location} />

          {(timeDisplay || scheduleDate) && (
            <InfoRow
              icon="🕐"
              value={[scheduleDate, timeDisplay].filter(Boolean).join(" · ")}
            />
          )}

          {job.employeeName && <InfoRow icon="👤" value={job.employeeName} />}
        </View>

        {/* Notes */}
        {job.notes ? (
          <View style={styles.notesBox}>
            <Text style={styles.notesLabel}>Notiz</Text>
            <Text style={styles.notesText} numberOfLines={2}>
              {job.notes}
            </Text>
          </View>
        ) : null}

        {/* Buttons */}
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[
              styles.btn,
              styles.btnStart,
              !canStart && styles.btnDisabled,
            ]}
            onPress={onStart}
            disabled={!canStart}
          >
            <Text style={[styles.btnText, !canStart && styles.btnTextDisabled]}>
              Start
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.btn,
              styles.btnComplete,
              !canComplete && styles.btnDisabled,
            ]}
            onPress={onComplete}
            disabled={!canComplete}
          >
            <Text
              style={[styles.btnText, !canComplete && styles.btnTextDisabled]}
            >
              Fertig
            </Text>
          </TouchableOpacity>

          {/* Admin Button */}
          {onEdit && (
            <TouchableOpacity
              style={[styles.btn, styles.btnEdit]}
              onPress={onEdit}
            >
              <Text style={styles.btnTextEdit}>Bearbeiten</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

function InfoRow({ icon, value }: { icon: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoIcon}>{icon}</Text>
      <Text style={styles.infoText} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border.default,
    flexDirection: "row",
    overflow: "hidden",
    ...Shadows.md,
  },
  accentBar: {
    width: 3,
  },
  content: {
    flex: 1,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  customerName: {
    flex: 1,
    fontSize: Typography.size.md,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
  },
  serviceText: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: Radius.full,
  },
  badgeText: {
    fontSize: Typography.size.xs,
    fontWeight: Typography.weight.semibold,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border.subtle,
  },
  infoGrid: {
    gap: 4,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  infoIcon: {
    width: 16,
  },
  infoText: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
  },
  notesBox: {
    backgroundColor: Colors.bg.elevated,
    padding: Spacing.sm,
    borderRadius: Radius.sm,
  },
  notesLabel: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
  },
  notesText: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
  },
  buttonRow: {
    flexDirection: "row",
    gap: Spacing.sm,
  },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: Radius.md,
    alignItems: "center",
  },
  btnStart: {
    backgroundColor: Colors.accent.default,
  },
  btnComplete: {
    backgroundColor: Colors.status.successBg,
  },
  btnEdit: {
    backgroundColor: Colors.bg.elevated,
    borderWidth: 1,
    borderColor: Colors.border.default,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    color: "white",
    fontWeight: Typography.weight.semibold,
  },
  btnTextDisabled: {
    color: Colors.text.muted,
  },
  btnTextEdit: {
    color: Colors.text.primary,
    fontWeight: Typography.weight.semibold,
  },
});
