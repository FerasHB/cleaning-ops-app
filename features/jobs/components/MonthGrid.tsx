// features/jobs/components/MonthGrid.tsx
// ─────────────────────────────────────────────────────────────────
// Vollflächiges Monatsraster (Mo–So) — das Herz der Mitarbeiter-
// Kalenderansicht. Reine Präsentation, hält keinen fachlichen State.
//
// KEINE externe Kalender-Library, keine neue Abhängigkeit: das Raster ist
// simples Flexbox — sieben gleich breite Spalten, 4–6 Wochenzeilen, die sich
// die verfügbare Höhe teilen (`flex: 1`). Dadurch passt jeder Monat ohne
// Scrollen auf den Bildschirm; ein 6-Wochen-Monat hat einfach flachere
// Zeilen als ein 5-Wochen-Monat.
//
// Die Zellen bekommen nur noch eine verdichtete `DaySummary` (Anzahl +
// vorkommende Zustände), nicht mehr die Jobliste des Tages. Damit entfällt
// auch die frühere Höhenmessung: sie existierte einzig, um auszurechnen, wie
// viele Auftragszeilen in eine Zelle passen. Eine Zusammenfassung hat feste
// Höhe und passt in jede Zeilenhöhe — das Raster ist dadurch spürbar
// einfacher und billiger geworden.
// ─────────────────────────────────────────────────────────────────

import type { AppTheme } from "@/constants/theme";
import { CalendarDayCell } from "@/features/jobs/components/CalendarDayCell";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AbsenceType } from "@/types/absence";
import { buildMonthMatrix, type DaySummary } from "@/utils/calendarMonth";
import { WEEKDAYS } from "@/utils/recurrence";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  /** Angezeigter Monat als "YYYY-MM". */
  monthKey: string;
  /** Ausgewählter Tag als "YYYY-MM-DD". */
  selectedKey: string;
  /** Heute als "YYYY-MM-DD". */
  todayKey: string;
  /** Verdichtete Tagesinfo je Kalendertag (fehlt = keine Aufträge). */
  summaries: Map<string, DaySummary>;
  /**
   * Phase D — vorkommende Abwesenheits-TYPEN je Kalendertag (fehlt = keine
   * aktive Abwesenheit). Additiv: Aufrufer ohne diese Prop verhalten sich
   * unverändert (Employee-Kalender kann sie weglassen).
   */
  absenceMarkers?: Map<string, AbsenceType[]>;
  onSelectDay: (key: string) => void;
};

export function MonthGrid({
  monthKey,
  selectedKey,
  todayKey,
  summaries,
  absenceMarkers,
  onSelectDay,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const weeks = useMemo(() => buildMonthMatrix(monthKey), [monthKey]);

  return (
    <View style={styles.container}>
      {/* ── Wochentags-Kopf Mo–So ── */}
      <View style={styles.weekHeader}>
        {WEEKDAYS.map((w) => (
          <Text key={w.key} style={styles.weekHeaderCell} maxFontSizeMultiplier={1.2}>
            {w.short}
          </Text>
        ))}
      </View>

      {/* ── Wochenzeilen ── */}
      <View style={styles.grid}>
        {weeks.map((week, wi) => (
          <View
            key={week[0].key}
            style={[styles.weekRow, wi > 0 && styles.weekRowDivider]}
          >
            {week.map((cell) => (
              <CalendarDayCell
                key={cell.key}
                dayKey={cell.key}
                dayNumber={cell.date.getDate()}
                inMonth={cell.inMonth}
                isToday={cell.key === todayKey}
                isSelected={cell.key === selectedKey}
                summary={summaries.get(cell.key)}
                absenceTypes={absenceMarkers?.get(cell.key)}
                onSelectDay={onSelectDay}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
    },

    // ── Wochentags-Kopf
    weekHeader: {
      flexDirection: "row",
      paddingBottom: theme.spacing.sm,
    },
    weekHeaderCell: {
      flex: 1,
      textAlign: "center",
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      textTransform: "uppercase",
      letterSpacing: theme.typography.letterSpacing.wide,
    },

    // ── Raster
    grid: {
      flex: 1,
    },
    // Jede Woche bekommt denselben Anteil der Resthöhe → 4-, 5- und
    // 6-Wochen-Monate füllen den Bildschirm gleichermaßen aus.
    weekRow: {
      flex: 1,
      flexDirection: "row",
      gap: 2,
    },
    // Haarlinie zwischen den Wochen (wie im System-Kalender), statt eines
    // vollen Gitters — das wirkt bei diesen Zellgrößen ruhiger.
    weekRowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.outlineVariant,
    },
  });
}
