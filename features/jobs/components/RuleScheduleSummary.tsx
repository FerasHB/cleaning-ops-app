// features/jobs/components/RuleScheduleSummary.tsx
// Die Wiederholung einer Regel in EINER Karte: Wochentage, Uhrzeit,
// Gültigkeitszeitraum und die Grenze des bereits erzeugten Zeitraums.
//
// Ersetzt zwei Darstellungen, die vorher dasselbe sagten: die Kopfzeile
// („Mo, Do · 08:00 Uhr") und die vierzeilige Terminierungs-Karte darunter.
//
// NEU: „Termine erzeugt bis …". Die Termine einer Regel werden nur beim
// Anlegen, beim Speichern und beim (De-)Aktivieren erzeugt — es gibt keinen
// Hintergrundlauf, der laufend nachlegt. Bisher war nirgends sichtbar, wie
// weit eine Regel überhaupt gefüllt ist; eine Regel ohne kommende Termine sah
// aus wie ein Defekt. Der Wert kommt aus den bereits geladenen Terminen
// (Maximum ihrer Datumswerte), NICHT aus einer zusätzlichen Abfrage.

import { Card } from "@/components/ui";
import { WeekdayDots } from "@/components/ui/WeekdayDots";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { formatDateOnlyDE } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  rule: Pick<
    Job,
    "recurringDays" | "startTime" | "recurrenceStartDate" | "recurrenceEndDate"
  >;
  /**
   * Letztes erzeugtes Termindatum ("YYYY-MM-DD") oder null. null blendet die
   * Zeile aus — etwa solange die Termine laden oder wenn der Aufrufer sie gar
   * nicht lädt (Mitarbeiter-Ansicht).
   */
  horizonDate: string | null;
};

export function RuleScheduleSummary({ rule, horizonDate }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const timeLabel = rule.startTime ? `${rule.startTime} Uhr` : "Keine Uhrzeit";

  const rangeLabel = useMemo(() => {
    const start = formatDateOnlyDE(rule.recurrenceStartDate);
    const end = formatDateOnlyDE(rule.recurrenceEndDate);
    if (start && end) return `${start} – ${end}`;
    if (start) return `ab ${start}`;
    if (end) return `bis ${end}`;
    return "Kein Zeitraum hinterlegt";
  }, [rule.recurrenceStartDate, rule.recurrenceEndDate]);

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <View style={styles.labelRow}>
        <Ionicons name="repeat-outline" size={12} color={theme.colors.primary} />
        <Text style={styles.label}>WIEDERHOLUNG</Text>
      </View>

      <WeekdayDots days={rule.recurringDays} />

      <View style={styles.metaBlock}>
        <MetaRow
          icon="time-outline"
          text={timeLabel}
          styles={styles}
          theme={theme}
        />
        <MetaRow
          icon="calendar-outline"
          text={rangeLabel}
          styles={styles}
          theme={theme}
        />
        {horizonDate ? (
          <MetaRow
            icon="flag-outline"
            text={`Termine erzeugt bis ${formatDateOnlyDE(horizonDate)}`}
            styles={styles}
            theme={theme}
          />
        ) : null}
      </View>
    </Card>
  );
}

function MetaRow({
  icon,
  text,
  styles,
  theme,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  text: string;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  return (
    <View style={styles.metaRow}>
      <Ionicons name={icon} size={14} color={theme.colors.onSurfaceVariant} />
      <Text style={styles.metaText} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.sm,
    },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    label: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    metaBlock: {
      gap: theme.spacing.xs,
      marginTop: theme.spacing.xs,
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    metaText: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },
  });
}
