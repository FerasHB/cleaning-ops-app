// features/jobs/components/JobStatusOverview.tsx
// Hero-Bereich des Job-Detail-Screens: beantwortet auf den ersten Blick
// "Wo arbeite ich? Was ist zu tun? Wann? Welcher Status?"
//
// Genau EIN Status-Indikator (StatusBadge) — keine Duplikate. Reine
// Präsentationskomponente, keine eigene Datenlogik: alle Werte kommen fertig
// aufbereitet vom Screen bzw. aus den bestehenden Formatier-Helfern.
//
// NUR NOCH AUSFÜHRBARE TERMINE: Parent-Regeln haben eine eigene Ansicht
// (RecurringRuleDetailScreen) und erreichen diese Komponente nicht mehr. Der
// frühere Zweig mit Aktiv/Inaktiv-Badge und Wochentagszeile ist damit
// entfallen. Ebenso der Hinweis-Chip „Teil eines Dauerauftrags": er sagte
// dasselbe wie der Hinweis in der Terminierungs-Karte, ohne irgendwohin zu
// führen. Beides ersetzt jetzt EIN antippbares Element im Screen
// (OccurrenceOriginLink).

import { StatusBadge } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { formatDateTimeDE } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  job: Pick<Job, "customerName" | "status" | "service" | "scheduledStart">;
};

export function JobStatusOverview({ job }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  // Kompakte Terminzeile — deckt Einzeltermine UND generierte Occurrences ab
  // (beide tragen scheduledStart).
  const scheduleSummary =
    formatDateTimeDE(job.scheduledStart) ?? "Kein Termin geplant";

  return (
    <View style={styles.hero}>
      <View style={styles.titleRow}>
        <Text style={styles.customerName}>{job.customerName}</Text>
        <StatusBadge status={job.status} />
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
  });
}
