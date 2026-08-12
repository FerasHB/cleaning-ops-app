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
// Wie viele Job-Zeilen eine Zelle zeigt, ergibt sich AUS der gemessenen
// Zeilenhöhe (siehe `maxVisible`) — nicht aus einer festen Zahl. Nur so
// verhält sich das Raster auf kleinen Telefonen und in 6-Wochen-Monaten
// gleich korrekt.
// ─────────────────────────────────────────────────────────────────

import type { AppTheme } from "@/constants/theme";
import { CalendarDayCell } from "@/features/jobs/components/CalendarDayCell";
import { CALENDAR_JOB_ITEM_HEIGHT } from "@/features/jobs/components/CalendarJobItem";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { buildMonthMatrix } from "@/utils/calendarMonth";
import { WEEKDAYS } from "@/utils/recurrence";
import React, { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";

/** Höhe des Tageszahl-Bereichs einer Zelle (dateRow + Innenabstand). */
const DATE_ROW_HEIGHT = 25;
/** Eintragshöhe inkl. 1 px Abstand zum nächsten Eintrag. */
const ITEM_SLOT_HEIGHT = CALENDAR_JOB_ITEM_HEIGHT + 1;
/** Höhe der „+N weitere"-Zeile inkl. Abstand (schmaler als ein Eintrag). */
const OVERFLOW_SLOT_HEIGHT = 15;
/** Obergrenze: mehr als drei Einträge werden in einer Zelle unleserlich. */
const MAX_ITEMS_PER_CELL = 3;

const EMPTY_JOBS: Job[] = [];

type Props = {
  /** Angezeigter Monat als "YYYY-MM". */
  monthKey: string;
  /** Ausgewählter Tag als "YYYY-MM-DD". */
  selectedKey: string;
  /** Heute als "YYYY-MM-DD". */
  todayKey: string;
  /** Jobs je Kalendertag, bereits nach Uhrzeit sortiert. */
  jobsByDay: Map<string, Job[]>;
  onSelectDay: (key: string) => void;
  onOpenJob: (jobId: string) => void;
};

export function MonthGrid({
  monthKey,
  selectedKey,
  todayKey,
  jobsByDay,
  onSelectDay,
  onOpenJob,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const weeks = useMemo(() => buildMonthMatrix(monthKey), [monthKey]);

  // Gemessene Höhe des Rasterbereichs. 0 = noch nicht gemessen; bis dahin
  // greift der Standardwert unten (ein Frame, danach exakt).
  const [gridHeight, setGridHeight] = useState(0);
  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    setGridHeight(e.nativeEvent.layout.height);
  }, []);

  // Wie viele Einträge passen in eine Zelle dieses Monats?
  //
  // Zwei Werte, weil die „+N weitere"-Zeile selbst Platz kostet:
  //   maxVisible             → wenn ALLE Jobs des Tages passen (keine Zeile nötig)
  //   maxVisibleWithOverflow → wenn zusätzlich die Überlaufzeile stehen muss
  // Ohne diese Trennung würde ein Tag mit 4 Jobs unnötig „2 + weitere 2"
  // zeigen, obwohl 3 Einträge und die Überlaufzeile zusammen hineinpassen.
  const { maxVisible, maxVisibleWithOverflow } = useMemo(() => {
    if (gridHeight <= 0) {
      return {
        maxVisible: MAX_ITEMS_PER_CELL,
        maxVisibleWithOverflow: MAX_ITEMS_PER_CELL,
      };
    }
    const free = gridHeight / weeks.length - DATE_ROW_HEIGHT;
    // Mindestens 1: eine Zelle, die gar nichts zeigt, wäre schlechter als
    // eine, die einen Eintrag zeigt und den Rest als „+N weitere" meldet.
    const fits = Math.min(
      Math.max(Math.floor(free / ITEM_SLOT_HEIGHT), 1),
      MAX_ITEMS_PER_CELL,
    );
    const fitsWithOverflow = Math.min(
      Math.max(Math.floor((free - OVERFLOW_SLOT_HEIGHT) / ITEM_SLOT_HEIGHT), 1),
      fits,
    );
    return { maxVisible: fits, maxVisibleWithOverflow: fitsWithOverflow };
  }, [gridHeight, weeks.length]);

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
      <View style={styles.grid} onLayout={handleLayout}>
        {weeks.map((week, wi) => (
          <View key={week[0].key} style={[styles.weekRow, wi > 0 && styles.weekRowDivider]}>
            {week.map((cell) => (
              <CalendarDayCell
                key={cell.key}
                dayKey={cell.key}
                dayNumber={cell.date.getDate()}
                inMonth={cell.inMonth}
                isToday={cell.key === todayKey}
                isSelected={cell.key === selectedKey}
                jobs={jobsByDay.get(cell.key) ?? EMPTY_JOBS}
                maxVisible={maxVisible}
                maxVisibleWithOverflow={maxVisibleWithOverflow}
                onSelectDay={onSelectDay}
                onOpenJob={onOpenJob}
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
      paddingBottom: 6,
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
      gap: 1,
    },
    // Haarlinie zwischen den Wochen (wie im System-Kalender), statt eines
    // vollen Gitters — das wirkt bei diesen Zellgrößen ruhiger.
    weekRowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.outlineVariant,
    },
  });
}
