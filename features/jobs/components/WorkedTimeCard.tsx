// features/jobs/components/WorkedTimeCard.tsx
// Premium-Karte für die Arbeitszeit eines Jobs — Start/Ende + große
// Gesamtdauer als visueller Fokus. Ersetzt die schlichte "Arbeitszeit"-
// InfoRow im JobDetailScreen.
//
// Reine Präsentationskomponente: die gesamte Berechnung/Ticking-Logik
// kommt aus useJobWorkedTime (derselbe Hook, den auch JobCard nutzt) —
// hier wird nichts dupliziert.

import { Card, StatusBadge } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useJobWorkedTime } from "@/hooks/useJobWorkedTime";
import type { Job } from "@/types/job";
import { formatTimeHHmm } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

type Props = {
  job: Pick<Job, "status" | "startedAt" | "completedAt">;
};

// Datum als "18.07.2026" (ohne Uhrzeit) — für die Start-/Ende-Blöcke.
function formatBlockDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function WorkedTimeCard({ job }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { minutes, label, isRunning } = useJobWorkedTime(job);

  // Sanfte Puls-Animation, wenn sich das Label ändert (jede Minute während
  // der Job läuft) — überspringt den ersten Render, damit die Karte nicht
  // beim Öffnen "hereinspringt".
  const pulse = useRef(new Animated.Value(1)).current;
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    Animated.sequence([
      Animated.timing(pulse, {
        toValue: 1.06,
        duration: 160,
        useNativeDriver: true,
      }),
      Animated.timing(pulse, {
        toValue: 1,
        duration: 160,
        useNativeDriver: true,
      }),
    ]).start();
  }, [label, pulse]);

  if (!job.startedAt || !label) {
    return null;
  }

  const startedDate = formatBlockDate(job.startedAt);
  const startedTime = formatTimeHHmm(new Date(job.startedAt));
  const completedDate = formatBlockDate(job.completedAt);
  const completedTime = job.completedAt
    ? formatTimeHHmm(new Date(job.completedAt))
    : null;

  const accentColor = isRunning
    ? theme.colors.statusInProgress
    : theme.colors.statusCompleted;
  const accentBg = isRunning
    ? theme.colors.statusInProgressBg
    : theme.colors.statusCompletedBg;
  const accentBorder = isRunning
    ? theme.colors.statusInProgressBorder
    : theme.colors.statusCompletedBorder;

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="time-outline" size={16} color={theme.colors.primary} />
          </View>
          <Text style={styles.headerTitle}>Arbeitszeit</Text>
        </View>
        <StatusBadge
          status={isRunning ? "in_progress" : "completed"}
          labels={{ in_progress: "In Arbeit", completed: "Abgeschlossen" }}
        />
      </View>

      <View style={styles.divider} />

      {/* ── Start & Ende ── */}
      <View style={styles.timeRow}>
        <View style={styles.timeBlock}>
          <Text style={styles.timeBlockLabel}>GESTARTET</Text>
          <Text style={styles.timeBlockDate}>{startedDate ?? "—"}</Text>
          <Text style={styles.timeBlockValue}>{startedTime ?? "—:—"}</Text>
        </View>

        <View style={styles.timeBlockDivider} />

        <View style={styles.timeBlock}>
          <Text style={styles.timeBlockLabel}>ERLEDIGT</Text>
          {isRunning ? (
            <Text style={[styles.timeBlockRunning, { color: accentColor }]}>
              Läuft…
            </Text>
          ) : (
            <>
              <Text style={styles.timeBlockDate}>{completedDate ?? "—"}</Text>
              <Text style={styles.timeBlockValue}>{completedTime ?? "—:—"}</Text>
            </>
          )}
        </View>
      </View>

      {/* ── Highlight: Gesamtdauer ── */}
      <View
        style={[
          styles.highlight,
          { backgroundColor: accentBg, borderColor: accentBorder },
        ]}
      >
        <Animated.Text
          style={[
            styles.highlightValue,
            { color: accentColor, transform: [{ scale: pulse }] },
          ]}
        >
          {label}
        </Animated.Text>
        <Text style={styles.highlightSubtitle}>{minutes} Minuten</Text>
      </View>

      {/* ── Hinweis ── */}
      <View style={styles.infoBox}>
        <Ionicons
          name="information-circle-outline"
          size={14}
          color={theme.colors.outline}
        />
        <Text style={styles.infoText}>
          Die Arbeitszeit wird automatisch aus Start- und Endzeit berechnet.
        </Text>
      </View>
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.md,
      ...theme.shadows.md,
    },

    // Header — flexWrap, damit der Badge bei großer Schrift/schmalen Geräten
    // in eine neue Zeile fällt statt horizontal überzulaufen.
    header: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      rowGap: 6,
    },
    headerLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      flexShrink: 1,
    },
    headerIconWrap: {
      width: 28,
      height: 28,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    headerTitle: {
      flexShrink: 1,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },

    divider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
    },

    // Start/Ende
    timeRow: {
      flexDirection: "row",
      alignItems: "stretch",
    },
    timeBlock: {
      flex: 1,
      gap: 4,
    },
    timeBlockDivider: {
      width: 1,
      backgroundColor: theme.colors.outlineVariant,
      marginHorizontal: theme.spacing.md,
    },
    timeBlockLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    timeBlockDate: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    timeBlockValue: {
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    timeBlockRunning: {
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      marginTop: 2,
    },

    // Highlight
    highlight: {
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      paddingVertical: theme.spacing.lg,
    },
    highlightValue: {
      // Bewusst über der xxl-Skala — die Gesamtdauer ist der visuelle Fokus
      // der Karte, proportional aus dem xxl-Token abgeleitet statt eines
      // freistehenden Magic Numbers.
      fontSize: Math.round(theme.typography.size.xxl * 1.4),
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.extrabold,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    highlightSubtitle: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },

    // Info-Hinweis
    infoBox: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
      backgroundColor: theme.colors.surfaceContainer,
      borderRadius: theme.radius.md,
      padding: theme.spacing.sm,
    },
    infoText: {
      flex: 1,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      // Kein festes lineHeight: RN skaliert lineHeight nicht automatisch mit
      // der Systemschrift-Größe — bei großer Accessibility-Schrift würde ein
      // fixer Wert den Text abschneiden. Ohne lineHeight nutzt RN die
      // Font-Metriken, die mit fontSize mitskalieren.
    },
  });
}
