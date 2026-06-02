// components/JobCard.tsx
// Kompakte Übersichts-Karte für Job-Listen.
// Vollständig theme-aware (Light + Dark Mode).
//
// Design-Prinzip:
// - Card ist Navigations-Tile zum DetailScreen — onPress macht ganze Karte tappable
// - Nur die wichtigsten Felder sichtbar (Kunde, Service, Ort, Zeit)
// - Mitarbeiter-Zeile nur wenn `showEmployeeName` gesetzt ist (i.d.R. nur Admin)
// - Genau EINE kontextuelle Quick-Action: "Start" bei open, "Fertig" bei in_progress
// - Notizen, Edit, ausführliche Felder → leben im DetailScreen
//
// Tap-Verhalten:
// - Tap auf Card-Fläche → onPress (Detail)
// - Tap auf Quick-Action-Button → onStart/onComplete (Inner-Touch gewinnt in RN)

import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import { Job } from "@/types/job";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

type Props = {
  job: Job;
  /** Tap auf die Karte (außerhalb der Quick-Action) — i.d.R. Detail-Navigation */
  onPress?: () => void;
  /**
   * Inline-Quick-Action "Start" — wird nur gezeigt, wenn übergeben UND job.status === "open".
   * Wer keine Inline-Action will (z.B. Admin), lässt das Prop einfach weg.
   */
  onStart?: () => void;
  /**
   * Inline-Quick-Action "Fertig" — wird nur gezeigt, wenn übergeben UND job.status === "in_progress".
   */
  onComplete?: () => void;
  /** Soll der Name des zugewiesenen Mitarbeiters in der Card stehen? (Default: false) */
  showEmployeeName?: boolean;
};

// ─────────────────────────────────────────────
// Zeit-Formatierung
// ─────────────────────────────────────────────
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

// ── Status-Farben aus Theme (jeder Status hat sein Farbtripel)
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

export default function JobCard({
  job,
  onPress,
  onStart,
  onComplete,
  showEmployeeName = false,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const status = getStatusConfig(theme, job.status);

  // Zeit-Zeile bauen
  const date = formatDate(job.scheduledStart);
  const startTime = formatTime(job.scheduledStart);
  const endTime = formatTime(job.scheduledEnd);

  let scheduleText: string | null = null;
  if (date && startTime && endTime) {
    scheduleText = `${date} · ${startTime} – ${endTime}`;
  } else if (date && startTime) {
    scheduleText = `${date} · ${startTime}`;
  } else if (date) {
    scheduleText = date;
  }

  // Service · Ort (kompakte Einzeiler-Subline)
  const subline = [job.service, job.location].filter(Boolean).join(" · ");

  // Quick-Action — exakt EINE, abhängig von Status (oder gar keine)
  const showStartAction = job.status === "open" && !!onStart;
  const showCompleteAction = job.status === "in_progress" && !!onComplete;
  const employeeText = showEmployeeName ? job.employeeName : null;

  // Footer wird nur gerendert, wenn Mitarbeiter ODER Action vorhanden
  const hasFooter = !!employeeText || showStartAction || showCompleteAction;

  // ── Root: TouchableOpacity wenn navigierbar, sonst stiller View
  const CardRoot: React.ComponentType<{
    style: any;
    children: React.ReactNode;
  }> = onPress
    ? (props) => (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={onPress}
          {...props}
        />
      )
    : (props) => <View {...props} />;

  return (
    <CardRoot
      style={[
        styles.card,
        {
          borderColor: status.borderColor,
          borderLeftColor: status.borderColor,
          borderLeftWidth: 4,
        },
      ]}
    >
      {/* ── Header: Kunde + Status + Chevron ── */}
      <View style={styles.header}>
        <Text style={styles.customerName} numberOfLines={1}>
          {job.customerName}
        </Text>

        <View style={styles.headerRight}>
          {job.hasUnreadComments ? (
            <View
              style={styles.unreadDot}
              accessibilityLabel="Ungelesene Kommentare"
            />
          ) : null}
          <View
            style={[
              styles.statusBadge,
              {
                backgroundColor: status.bgColor,
                borderColor: status.borderColor,
              },
            ]}
          >
            <Text style={[styles.statusText, { color: status.textColor }]}>
              {status.label}
            </Text>
          </View>
          {onPress ? (
            <Ionicons
              name="chevron-forward"
              size={16}
              color={theme.colors.outline}
            />
          ) : null}
        </View>
      </View>

      {/* ── Service · Ort (eine Zeile) ── */}
      {subline ? (
        <Text style={styles.subline} numberOfLines={1}>
          {subline}
        </Text>
      ) : null}

      {/* ── Zeit (mit Icon) ── */}
      {scheduleText ? (
        <View style={styles.metaRow}>
          <Ionicons
            name="time-outline"
            size={14}
            color={theme.colors.onSurfaceVariant}
          />
          <Text style={styles.metaText} numberOfLines={1}>
            {scheduleText}
          </Text>
        </View>
      ) : null}

      {/* ── Footer: Mitarbeiter (links) + Quick-Action (rechts) ── */}
      {hasFooter ? (
        <View style={styles.footer}>
          {employeeText ? (
            <View style={styles.employeeRow}>
              <Ionicons
                name="person-outline"
                size={14}
                color={theme.colors.onSurfaceVariant}
              />
              <Text style={styles.metaText} numberOfLines={1}>
                {employeeText}
              </Text>
            </View>
          ) : (
            <View style={styles.footerSpacer} />
          )}

          {showStartAction ? (
            <TouchableOpacity
              style={styles.quickActionPrimary}
              onPress={onStart}
              activeOpacity={0.85}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons
                name="play"
                size={13}
                color={theme.colors.onPrimaryContainer}
              />
              <Text style={styles.quickActionPrimaryText}>Start</Text>
            </TouchableOpacity>
          ) : null}

          {showCompleteAction ? (
            <TouchableOpacity
              style={styles.quickActionSuccess}
              onPress={onComplete}
              activeOpacity={0.85}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons
                name="checkmark"
                size={14}
                color={theme.colors.statusCompleted}
              />
              <Text style={styles.quickActionSuccessText}>Fertig</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </CardRoot>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      gap: 6,
      ...theme.shadows.sm,
    },

    // Header
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    headerRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },

    // Roter Punkt für ungelesene Kommentare
    unreadDot: {
      width: 9,
      height: 9,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.error,
    },
    customerName: {
      flex: 1,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },

    // Status-Badge
    statusBadge: {
      paddingHorizontal: 9,
      paddingVertical: 3,
      borderRadius: theme.radius.full,
      borderWidth: 1,
    },
    statusText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      letterSpacing: theme.typography.letterSpacing.wide,
    },

    // Subline: Service · Ort
    subline: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.sm,
    },

    // Meta-Zeile (Zeit / Mitarbeiter)
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    metaText: {
      flex: 1,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // Footer (Mitarbeiter links + Quick-Action rechts)
    footer: {
      marginTop: 2,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    footerSpacer: {
      flex: 1,
    },
    employeeRow: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },

    // Quick-Action "Start" (primär)
    quickActionPrimary: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primaryContainer,
    },
    quickActionPrimaryText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimaryContainer,
    },

    // Quick-Action "Fertig" (success-Outline)
    quickActionSuccess: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusCompletedBg,
      borderWidth: 1,
      borderColor: theme.colors.statusCompletedBorder,
    },
    quickActionSuccessText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.statusCompleted,
    },
  });
}
