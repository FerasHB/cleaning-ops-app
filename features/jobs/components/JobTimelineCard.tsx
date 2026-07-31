// features/jobs/components/JobTimelineCard.tsx
// Zeitlicher Verlauf eines Auftrags. Sobald der Job gestartet wurde, kommt
// die gesamte Berechnung/Anzeige unverändert aus WorkedTimeCard (Start/Ende,
// Akteure, Dauer) — hier wird NICHTS von dieser Logik dupliziert oder
// verändert. Vor dem Start zeigt diese Karte stattdessen den geplanten
// Termin (bereits vorhandenes scheduledStart, keine neue Abfrage), damit
// Mitarbeitende auch dann sehen, worauf sich der Auftrag bezieht.
//
// WICHTIG — die Arbeitszeit-Anzeige hängt NICHT an isParentRule: sobald
// startedAt gesetzt ist, rendert WorkedTimeCard, genau wie vor der
// 2.0-Aufteilung. Eine Parent-Regel mit Start-/Abschlusszeiten ist eine
// Datenanomalie (eine Regel wird nie ausgeführt) — dann muss der Wert
// sichtbar bleiben statt still verborgen zu werden. Nur der „noch nicht
// gestartet"-Platzhalter ist auf ausführbare Termine begrenzt
// (`showPlaceholder`), weil er für eine Regel-Vorlage bedeutungslos wäre.

import { Card } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { WorkedTimeCard } from "@/features/jobs/components/WorkedTimeCard";
import type { Job } from "@/types/job";
import { formatDateTimeDE } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  job: Pick<
    Job,
    | "status"
    | "startedAt"
    | "completedAt"
    | "startedBy"
    | "completedBy"
    | "assignees"
    | "scheduledStart"
  >;
  /**
   * Darf der „noch nicht gestartet"-Platzhalter erscheinen? Nur für
   * ausführbare Termine — bei Parent-Regeln false. Beeinflusst NICHT die
   * WorkedTimeCard (siehe Kopfkommentar).
   */
  showPlaceholder: boolean;
};

export function JobTimelineCard({ job, showPlaceholder }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (job.startedAt) {
    return <WorkedTimeCard job={job} />;
  }

  if (!showPlaceholder) return null;

  const scheduledText = formatDateTimeDE(job.scheduledStart);

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <View style={styles.row}>
        <View style={styles.iconWrap}>
          <Ionicons
            name="hourglass-outline"
            size={16}
            color={theme.colors.onSurfaceVariant}
          />
        </View>
        <View style={styles.textBlock}>
          <Text style={styles.title}>Noch nicht gestartet</Text>
          <Text style={styles.subtitle}>
            {scheduledText
              ? `Geplant für ${scheduledText}.`
              : "Für diesen Auftrag ist noch kein Termin geplant."}
          </Text>
        </View>
      </View>
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.sm,
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.sm,
    },
    iconWrap: {
      width: 28,
      height: 28,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surfaceContainer,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    textBlock: {
      flex: 1,
      gap: 2,
    },
    title: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    subtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.sm,
    },
  });
}
