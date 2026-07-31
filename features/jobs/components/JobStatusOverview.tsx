// features/jobs/components/JobStatusOverview.tsx
// Hero-Bereich des Job-Detail-Screens: beantwortet auf den ersten Blick
// "Wo arbeite ich? Was ist zu tun? Wann? Welcher Status?"
//
// Genau EIN Status-Indikator (StatusBadge für echte Termine, Aktiv/Inaktiv-
// Badge für Parent-Regeln) — keine Duplikate. Reine Präsentationskomponente,
// keine eigene Datenlogik: alle Werte kommen fertig aufbereitet vom Screen
// bzw. aus den bestehenden Formatier-Helfern (utils/date, utils/recurrence).

import { Badge, StatusBadge } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { formatDateTimeDE } from "@/utils/date";
import { formatRecurringDays } from "@/utils/recurrence";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  job: Pick<
    Job,
    | "customerName"
    | "status"
    | "isActive"
    | "jobType"
    | "service"
    | "startTime"
    | "recurringDays"
    | "scheduledStart"
    | "isOccurrence"
  >;
  isParentRule: boolean;
};

export function JobStatusOverview({ job, isParentRule }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  // Kompakte Terminzeile: Wochentage+Uhrzeit für Parent-Regeln, sonst der
  // formatierte geplante Termin (deckt Einzeltermine UND generierte
  // Occurrences ab — beide tragen scheduledStart).
  const scheduleSummary = isParentRule
    ? `${formatRecurringDays(job.recurringDays)} · ${
        job.startTime ? `${job.startTime} Uhr` : "—"
      }`
    : formatDateTimeDE(job.scheduledStart) ?? "Kein Termin geplant";

  return (
    <View style={styles.hero}>
      <View style={styles.titleRow}>
        <Text style={styles.customerName}>{job.customerName}</Text>
        {isParentRule ? (
          <Badge
            label={job.isActive ? "Aktiv" : "Inaktiv"}
            variant={job.isActive ? "success" : "default"}
          />
        ) : (
          <StatusBadge status={job.status} />
        )}
      </View>

      <View style={styles.metaRow}>
        <Ionicons
          name="construct-outline"
          size={14}
          color={theme.colors.onSurfaceVariant}
        />
        <Text style={styles.metaText} numberOfLines={1}>
          {job.service}
        </Text>
        <Text style={styles.metaDot}>·</Text>
        <Ionicons
          name="time-outline"
          size={14}
          color={theme.colors.onSurfaceVariant}
        />
        <Text style={styles.metaText} numberOfLines={1}>
          {scheduleSummary}
        </Text>
      </View>

      {isParentRule ? (
        <View style={styles.typeChip}>
          <Ionicons
            name="repeat-outline"
            size={14}
            color={theme.colors.primary}
          />
          <Text style={styles.typeChipText}>Wiederkehrender Auftrag</Text>
        </View>
      ) : job.isOccurrence ? (
        // Unterscheidung generierte Occurrence vs. eigenständiger Einzeltermin
        // (neu — nutzt nur das bereits vorhandene isOccurrence-Feld, keine
        // zusätzliche Abfrage).
        <View style={styles.typeChip}>
          <Ionicons
            name="repeat-outline"
            size={14}
            color={theme.colors.onSurfaceVariant}
          />
          <Text style={[styles.typeChipText, styles.typeChipTextMuted]}>
            Teil eines Dauerauftrags
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    hero: {
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    titleRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      rowGap: 6,
    },
    customerName: {
      flexShrink: 1,
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
      lineHeight: theme.typography.lineHeight.xxl,
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexWrap: "wrap",
    },
    metaText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
      flexShrink: 1,
    },
    metaDot: {
      fontSize: theme.typography.size.sm,
      color: theme.colors.outline,
    },
    typeChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
    },
    typeChipText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.primary,
    },
    typeChipTextMuted: {
      color: theme.colors.onSurfaceVariant,
    },
  });
}
