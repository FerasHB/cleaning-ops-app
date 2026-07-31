// features/jobs/components/OccurrenceRow.tsx
// Eine Zeile der Termin-Agenda einer Dauerauftrags-Regel.
//
// Aus der abgelösten RuleOccurrences-Karte übernommen, mit drei Korrekturen:
//
//  1. HEUTE-HERVORHEBUNG IST JETZT TONAL. Vorher lag auf der Heute-Zeile
//     `backgroundColor: primaryContainer` — das ist das gefüllte
//     Button-Token (#1E40AF hell / #4D8EFF dunkel), während die Texte der
//     Zeile weiterhin onSurface/onSurfaceVariant benutzten. Im Hellmodus
//     stand damit fast schwarze Schrift auf dunklem Blau (~1,5:1), im
//     Dunkelmodus helle Schrift auf hellem Blau (~2,3:1) — beides deutlich
//     unter WCAG AA. Jetzt: ruhige Fläche (surfaceContainerHigh) plus
//     farbige Kante links; die Textfarben bleiben unverändert lesbar.
//  2. Datum nutzt formatSectionTitle aus utils/scheduleView — dieselbe
//     „Heute/Morgen/Gestern"-Sprache wie im Zeitplan, statt eines eigenen
//     Wochentags-Arrays.
//  3. Abweichende Termine werden hier ebenfalls markiert. Die Erkennung
//     (isDetachedOccurrence) gab es schon, sie lief bisher aber nur im
//     Zeitplan — ausgerechnet in der Ansicht, in der Regel und Termin
//     gemeinsam vorliegen, fehlte der Hinweis.
//
// Reine Präsentation: keine Datenbeschaffung, keine Statuslogik.

import { StatusBadge } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { formatAssigneesShort } from "@/utils/jobAssignees";
import { formatSectionTitle } from "@/utils/scheduleView";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

type Props = {
  occurrence: Job;
  /** Heutiger Kalendertag "YYYY-MM-DD" — für Datumslabel und Heute-Zustand. */
  todayKey: string;
  /** Vergangener Termin: bewusst leiser dargestellt. */
  past: boolean;
  /** Passt nicht mehr zur aktuellen Regel (PR #43). */
  detached: boolean;
  /**
   * Mitarbeiter-Zeile anzeigen? Nur wenn die Zuweisung dieses Termins von der
   * Zuweisung der Regel abweicht — sonst stünde auf jeder der u. U. hunderten
   * Zeilen dieselbe Namensliste wie oben im Mitarbeiter-Abschnitt.
   */
  showAssignees: boolean;
  onPress: () => void;
};

export function OccurrenceRow({
  occurrence,
  todayKey,
  past,
  detached,
  showAssignees,
  onPress,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const dateKey = occurrence.date?.slice(0, 10) ?? "";
  const isToday = !!dateKey && dateKey === todayKey;
  const dateLabel = dateKey ? formatSectionTitle(dateKey, todayKey) : "Ohne Datum";
  const timeLabel = occurrence.startTime ? `${occurrence.startTime} Uhr` : "—";

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Termin ${dateLabel}, ${timeLabel} öffnen`}
      style={({ pressed }) => [
        styles.row,
        isToday && styles.rowToday,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={styles.left}>
        <View style={styles.dateLine}>
          {isToday ? (
            <View style={styles.todayChip}>
              <Text style={styles.todayChipText}>Heute</Text>
            </View>
          ) : null}
          <Text
            style={[styles.date, past && styles.muted]}
            numberOfLines={1}
          >
            {dateLabel}
          </Text>
        </View>

        <Text style={styles.meta} numberOfLines={1}>
          {timeLabel}
          {showAssignees ? ` · ${formatAssigneesShort(occurrence)}` : ""}
        </Text>

        {detached ? (
          <View style={styles.detachedChip}>
            <Ionicons
              name="git-branch-outline"
              size={11}
              color={theme.colors.onSurfaceVariant}
            />
            <Text style={styles.detachedText}>Abweichender Termin</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.right}>
        <StatusBadge status={occurrence.status} />
        <Ionicons
          name="chevron-forward"
          size={14}
          color={theme.colors.outline}
        />
      </View>
    </Pressable>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.xs,
      borderRadius: theme.radius.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
      minHeight: theme.spacing.tapTarget,
    },
    // Tonal statt gefüllt — siehe Kopfkommentar (Kontrast).
    rowToday: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.primary,
    },
    rowPressed: { opacity: 0.6 },

    left: { flex: 1, gap: 2 },
    dateLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    date: {
      flexShrink: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    // Vergangenes bewusst leiser — vorhanden, aber nicht konkurrierend.
    muted: { color: theme.colors.onSurfaceVariant },
    meta: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    detachedChip: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: theme.spacing.xs,
      marginTop: 2,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 2,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surfaceContainer,
    },
    detachedText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },

    right: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      flexShrink: 0,
    },
    todayChip: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primary,
    },
    todayChipText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimary,
    },
  });
}
