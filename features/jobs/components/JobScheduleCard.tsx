// features/jobs/components/JobScheduleCard.tsx
// Terminierungs-Details: Wochentage/Uhrzeit + Gültigkeitszeitraum für
// Parent-Regeln, geplanter Start/Ende für Einzeltermine und generierte
// Occurrences. Zeigt zusätzlich scheduledEnd, recurrenceStartDate/EndDate
// und einen Hinweis auf die Herkunft einer Occurrence — alles bereits
// vorhandene Felder auf Job, die der bisherige Screen nicht anzeigte.
// Keine neue Abfrage, keine geänderte Terminierungs-Logik.

import { Card, InfoRow } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { formatDateOnlyDE, formatDateTimeDE } from "@/utils/date";
import { formatRecurringDays } from "@/utils/recurrence";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  job: Pick<
    Job,
    | "recurringDays"
    | "startTime"
    | "scheduledStart"
    | "scheduledEnd"
    | "recurrenceStartDate"
    | "recurrenceEndDate"
    | "isOccurrence"
  >;
  isParentRule: boolean;
};

export function JobScheduleCard({ job, isParentRule }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      {isParentRule ? (
        <>
          <InfoRow
            label="Wochentage"
            value={formatRecurringDays(job.recurringDays)}
            icon="calendar-number-outline"
          />
          <View style={styles.rowDivider} />
          <InfoRow
            label="Uhrzeit"
            value={job.startTime ? `${job.startTime} Uhr` : "—"}
            icon="time-outline"
          />
          <View style={styles.rowDivider} />
          <InfoRow
            label="Gültig ab"
            value={formatDateOnlyDE(job.recurrenceStartDate) ?? "—"}
            icon="play-forward-outline"
          />
          <View style={styles.rowDivider} />
          <InfoRow
            label="Gültig bis"
            value={formatDateOnlyDE(job.recurrenceEndDate) ?? "Kein Enddatum"}
            icon="flag-outline"
          />
        </>
      ) : (
        <>
          <InfoRow
            label="Auftragstyp"
            value="Einmalig"
            icon="calendar-outline"
          />
          <View style={styles.rowDivider} />
          <InfoRow
            label="Geplanter Start"
            value={formatDateTimeDE(job.scheduledStart) ?? "Kein Termin geplant"}
            icon="calendar-outline"
          />
          {job.scheduledEnd ? (
            <>
              <View style={styles.rowDivider} />
              <InfoRow
                label="Geplantes Ende"
                value={formatDateTimeDE(job.scheduledEnd) ?? "—"}
                icon="calendar-outline"
              />
            </>
          ) : null}
          {job.isOccurrence ? (
            <View style={styles.originHint}>
              <Ionicons
                name="repeat-outline"
                size={14}
                color={theme.colors.onSurfaceVariant}
              />
              <Text style={styles.originHintText}>
                Generierter Termin eines Dauerauftrags.
              </Text>
            </View>
          ) : null}
        </>
      )}
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.md,
    },
    rowDivider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
    },
    originHint: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: -theme.spacing.xs,
    },
    originHintText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      flexShrink: 1,
    },
  });
}
