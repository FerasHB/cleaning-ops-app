// components/ui/WeekdayDots.tsx
// Wochentags-Visualisierung Mo–So für wiederkehrende Aufträge.
//
// WARUM: die Wiederholung wurde bisher überall nur als Textkürzel gezeigt
// ("Mo, Do"). Zwei Regeln zu unterscheiden hieß lesen statt sehen — bei
// "Mo, Di, Mi, Do, Fr" gegen "Mo, Mi, Fr" kostet das spürbar Zeit. Diese
// Komponente zeigt stattdessen ALLE sieben Tage in fester Position und hebt
// nur die aktiven hervor: die Form der Woche wird auf einen Blick erkennbar.
//
// Reine Präsentation: Reihenfolge kommt aus utils/recurrence (WEEKDAYS,
// Montag zuerst), die Kürzel selbst sind sprachabhängig (siehe
// localizedWeekdayShort unten, Phase D). Für Screenreader wird NICHT jeder
// Punkt einzeln vorgelesen, sondern eine zusammengefasste Textform als ein
// Label.

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { INTL_LOCALE_TAGS, type AppLocale } from "@/i18n";
import { WEEKDAYS, type WeekdayKey } from "@/utils/recurrence";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

// Lokaler, locale-abhängiger Wochentags-Kürzel-Helfer statt WEEKDAYS.short
// (fest Deutsch) zu verändern — dieselbe Referenz-Montag-Technik wie in
// utils/recurringRuleFilter.ts, da WEEKDAYS auch in der Wochentag-Auswahl der
// Job-Formulare (JobFormFields.tsx) verankert ist.
const WEEKDAY_ORDER: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const REFERENCE_MONDAY = new Date(2024, 0, 1); // 1. Januar 2024 ist ein Montag

function localizedWeekdayShort(key: WeekdayKey, localeTag: string): string {
  const dayIndex = WEEKDAY_ORDER.indexOf(key);
  const d = new Date(REFERENCE_MONDAY);
  d.setDate(d.getDate() + dayIndex);
  return new Intl.DateTimeFormat(localeTag, { weekday: "short" }).format(d);
}

type Props = {
  /** Aktive Wochentage als Kurzcodes ("mon" … "sun"). */
  days: string[] | null | undefined;
  /** sm = kompakt (Listen), md = Detailansicht. Default: md. */
  size?: "sm" | "md";
};

export function WeekdayDots({ days, size = "md" }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t, i18n } = useTranslation();
  const localeTag = INTL_LOCALE_TAGS[i18n.language as AppLocale] ?? "de-DE";

  const active = useMemo(() => new Set(days ?? []), [days]);
  const compact = size === "sm";

  const activeShortLabel = useMemo(() => {
    const set = new Set(days ?? []);
    const short = WEEKDAYS.filter((w) => set.has(w.key)).map((w) =>
      localizedWeekdayShort(w.key, localeTag),
    );
    return short.length > 0 ? short.join(", ") : "—";
  }, [days, localeTag]);

  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={t("admin:recurringRules.weekdaysA11yLabel", {
        days: activeShortLabel,
      })}
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
              {localizedWeekdayShort(weekday.key, localeTag)}
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
