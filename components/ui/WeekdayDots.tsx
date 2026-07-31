// components/ui/WeekdayDots.tsx
// Wochentags-Visualisierung Mo–So für wiederkehrende Aufträge.
//
// WARUM: die Wiederholung wurde bisher überall nur als Textkürzel gezeigt
// ("Mo, Do"). Zwei Regeln zu unterscheiden hieß lesen statt sehen — bei
// "Mo, Di, Mi, Do, Fr" gegen "Mo, Mi, Fr" kostet das spürbar Zeit. Diese
// Komponente zeigt stattdessen ALLE sieben Tage in fester Position und hebt
// nur die aktiven hervor: die Form der Woche wird auf einen Blick erkennbar.
//
// Reine Präsentation: keine eigene Wochentags-Logik, die Reihenfolge und die
// Kürzel kommen unverändert aus utils/recurrence (WEEKDAYS, Montag zuerst).
// Für Screenreader wird NICHT jeder Punkt einzeln vorgelesen, sondern die
// bestehende Textform (formatRecurringDays) als ein Label.

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { WEEKDAYS, formatRecurringDays } from "@/utils/recurrence";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  /** Aktive Wochentage als Kurzcodes ("mon" … "sun"). */
  days: string[] | null | undefined;
  /** sm = kompakt (Listen), md = Detailansicht. Default: md. */
  size?: "sm" | "md";
};

export function WeekdayDots({ days, size = "md" }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const active = useMemo(() => new Set(days ?? []), [days]);
  const compact = size === "sm";

  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`Wochentage: ${formatRecurringDays(days)}`}
    >
      {WEEKDAYS.map((weekday) => {
        const isActive = active.has(weekday.key);
        return (
          <View
            key={weekday.key}
            style={[
              styles.day,
              compact && styles.dayCompact,
              isActive ? styles.dayActive : styles.dayInactive,
            ]}
            // Die Punkte selbst sind für Screenreader unsichtbar — das Label
            // der Zeile oben sagt bereits alles.
            importantForAccessibility="no"
          >
            <Text
              style={[
                styles.label,
                compact && styles.labelCompact,
                isActive ? styles.labelActive : styles.labelInactive,
              ]}
            >
              {weekday.short}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.xs,
    },
    day: {
      minWidth: 34,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
      borderRadius: theme.radius.sm,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    dayCompact: {
      minWidth: 28,
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: theme.spacing.xs,
    },
    // Aktiv: gefüllt in der Primärfarbe — Text dazu ist onPrimaryContainer,
    // das ist das für diesen Hintergrund vorgesehene Vordergrund-Token.
    dayActive: {
      backgroundColor: theme.colors.primaryContainer,
      borderColor: theme.colors.primaryContainer,
    },
    // Inaktiv: nur Umriss auf der Kartenfläche, bewusst leise.
    dayInactive: {
      backgroundColor: theme.colors.surfaceContainer,
      borderColor: theme.colors.outlineVariant,
    },
    label: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    labelCompact: {
      fontSize: theme.typography.size.xs,
    },
    labelActive: {
      color: theme.colors.onPrimaryContainer,
    },
    labelInactive: {
      color: theme.colors.onSurfaceVariant,
    },
  });
}
