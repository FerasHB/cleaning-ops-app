// components/JobCard.tsx
import {
  Colors,
  Radius,
  Shadows,
  Spacing,
  Typography,
} from "@/constants/theme";
import { Job } from "@/types/job";
import React, { useRef } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

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
    accent: Colors.status.warning,
  },
  in_progress: {
    label: "In Arbeit",
    fg: Colors.accent.text,
    bg: Colors.accent.subtle,
    border: Colors.accent.subtle,
    accent: Colors.accent.default,
  },
  completed: {
    label: "Erledigt",
    fg: Colors.status.success,
    bg: Colors.status.successBg,
    border: Colors.status.successBg,
    accent: Colors.status.success,
  },
} as const;

function PressableButton({
  onPress,
  disabled,
  style,
  children,
}: {
  onPress: () => void;
  disabled?: boolean;
  style?: object;
  children: React.ReactNode;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = () => {
    Animated.spring(scale, {
      toValue: 0.97,
      useNativeDriver: true,
      speed: 40,
      bounciness: 4,
    }).start();
  };

  const onPressOut = () => {
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 30,
      bounciness: 6,
    }).start();
  };

  return (
    <Animated.View
      style={[{ transform: [{ scale }] }, disabled && { opacity: 0.45 }]}
    >
      <TouchableOpacity
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        disabled={disabled}
        activeOpacity={1}
        style={style}
      >
        {children}
      </TouchableOpacity>
    </Animated.View>
  );
}

export default function JobCard({ job, onStart, onComplete, onEdit }: Props) {
  const cfg = STATUS_CONFIG[job.status];
  const startTime = formatTime(job.scheduledStart);
  const endTime = formatTime(job.scheduledEnd);
  const scheduleDate = formatDate(job.scheduledStart);
  const timeDisplay =
    startTime && endTime ? `${startTime} – ${endTime}` : startTime;

  const canStart = job.status === "open";
  const canComplete = job.status === "in_progress";

  return (
    <View style={styles.card}>
      <View style={[styles.topAccent, { backgroundColor: cfg.accent }]} />

      <View style={styles.body}>
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <Text style={styles.customerName} numberOfLines={1}>
              {job.customerName}
            </Text>
            <Text style={styles.serviceLabel} numberOfLines={1}>
              {job.service}
            </Text>
          </View>

          <View
            style={[
              styles.badge,
              { backgroundColor: cfg.bg, borderColor: cfg.border },
            ]}
          >
            <View style={[styles.badgeDot, { backgroundColor: cfg.accent }]} />
            <Text style={[styles.badgeText, { color: cfg.fg }]}>
              {cfg.label}
            </Text>
          </View>
        </View>

        <View style={styles.metaGrid}>
          <MetaChip icon="📍" value={job.location} />

          {(timeDisplay || scheduleDate) && (
            <MetaChip
              icon="🕐"
              value={[scheduleDate, timeDisplay].filter(Boolean).join(" · ")}
            />
          )}

          {job.employeeName && <MetaChip icon="👤" value={job.employeeName} />}
        </View>

        {job.notes ? (
          <View style={styles.notesBox}>
            <Text style={styles.notesLabel}>NOTIZ</Text>
            <Text style={styles.notesText} numberOfLines={2}>
              {job.notes}
            </Text>
          </View>
        ) : null}

        <View style={styles.divider} />

        <View style={styles.actions}>
          <PressableButton
            onPress={onStart}
            disabled={!canStart}
            style={[
              styles.actionBtn,
              canStart ? styles.actionBtnPrimary : styles.actionBtnGhost,
            ]}
          >
            <Text
              style={[
                styles.actionBtnText,
                canStart
                  ? styles.actionBtnTextPrimary
                  : styles.actionBtnTextMuted,
              ]}
            >
              Start
            </Text>
          </PressableButton>

          <PressableButton
            onPress={onComplete}
            disabled={!canComplete}
            style={[
              styles.actionBtn,
              canComplete ? styles.actionBtnSuccess : styles.actionBtnGhost,
            ]}
          >
            <Text
              style={[
                styles.actionBtnText,
                canComplete
                  ? styles.actionBtnTextSuccess
                  : styles.actionBtnTextMuted,
              ]}
            >
              Fertig
            </Text>
          </PressableButton>
        </View>

        {onEdit && (
          <PressableButton
            onPress={onEdit}
            style={[
              styles.actionBtn,
              styles.actionBtnEdit,
              styles.actionBtnFull,
            ]}
          >
            <Text style={[styles.actionBtnText, styles.actionBtnTextEdit]}>
              Bearbeiten
            </Text>
          </PressableButton>
        )}
      </View>
    </View>
  );
}

function MetaChip({ icon, value }: { icon: string; value: string }) {
  return (
    <View style={styles.metaChip}>
      <Text style={styles.metaIcon}>{icon}</Text>
      <Text style={styles.metaText} numberOfLines={1}>
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
    overflow: "hidden",
    ...Shadows.md,
  },

  topAccent: {
    height: 3,
    width: "100%",
  },

  body: {
    padding: Spacing.lg,
    gap: Spacing.md,
  },

  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: Spacing.sm,
  },

  headerLeft: {
    flex: 1,
    gap: 4,
  },

  customerName: {
    fontSize: Typography.size.md,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    lineHeight: Typography.size.md * Typography.leading.tight,
  },

  serviceLabel: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
    fontWeight: Typography.weight.medium,
  },

  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
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
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },

  metaGrid: {
    gap: 6,
  },

  metaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  metaIcon: {
    fontSize: 13,
    width: 18,
    textAlign: "center",
  },

  metaText: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
    flex: 1,
  },

  notesBox: {
    backgroundColor: Colors.bg.elevated,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.border.subtle,
    gap: 4,
  },

  notesLabel: {
    fontSize: Typography.size.xs,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.muted,
    letterSpacing: 0.5,
  },

  notesText: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
    lineHeight: Typography.size.sm * Typography.leading.normal,
  },

  divider: {
    height: 1,
    backgroundColor: Colors.border.subtle,
  },

  actions: {
    flexDirection: "row",
    gap: Spacing.sm,
  },

  actionBtn: {
    flex: 1,
    minHeight: 46,
    paddingVertical: 12,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },

  actionBtnFull: {
    width: "100%",
    marginTop: Spacing.xs,
  },

  actionBtnPrimary: {
    backgroundColor: Colors.accent.default,
    borderColor: Colors.accent.default,
  },

  actionBtnSuccess: {
    backgroundColor: Colors.status.successBg,
    borderColor: Colors.status.success,
  },

  actionBtnEdit: {
    backgroundColor: Colors.bg.elevated,
    borderColor: Colors.border.default,
  },

  actionBtnGhost: {
    backgroundColor: Colors.bg.overlay,
    borderColor: Colors.border.subtle,
  },

  actionBtnText: {
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.semibold,
  },

  actionBtnTextMuted: {
    color: Colors.text.muted,
  },

  actionBtnTextPrimary: {
    color: Colors.white,
  },

  actionBtnTextSuccess: {
    color: Colors.status.success,
  },

  actionBtnTextEdit: {
    color: Colors.text.primary,
  },
});
