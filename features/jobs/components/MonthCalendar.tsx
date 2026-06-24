// features/jobs/components/MonthCalendar.tsx
// Eigenbau-Monatskalender (KEINE externe Library).
// Reine Präsentations-Komponente — hält keinen eigenen State:
// - zeigt einen Monat als Mo–So-Grid
// - markiert Tage mit offenen/laufenden Jobs (primärer Punkt) oder
//   ausschließlich erledigten Jobs (gedämpfter Punkt)
// - hebt "heute" (Container-Tönnung) und den ausgewählten Tag (primäre Füllung) hervor
// - Monat vor/zurück über die Pfeile (onChangeMonth)
// Theme-aware (Light + Dark) über useAppTheme().

import { useAppTheme } from "@/hooks/useAppTheme";
import { formatDateISO } from "@/utils/date";
import { WEEKDAYS } from "@/utils/recurrence";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

export type MonthCalendarProps = {
  /** Irgendein Tag im aktuell angezeigten Monat. */
  visibleMonth: Date;
  /** Einen Monat zurück/vor blättern (liefert den 1. des Zielmonats). */
  onChangeMonth: (next: Date) => void;
  /** Aktuell ausgewählter Tag als "YYYY-MM-DD". */
  selectedKey: string;
  /** Tag auswählen (liefert "YYYY-MM-DD"). */
  onSelectDay: (key: string) => void;
  /** Tage mit Jobs (beliebiger Status) — zeigen einen Punkt. */
  markedKeys: Set<string>;
  /** Tage mit mindestens einem offenen oder laufenden Job — primärer Punkt. */
  activeMarkedKeys: Set<string>;
  /** Heute als "YYYY-MM-DD". */
  todayKey: string;
};

type Cell = { date: Date; key: string; inMonth: boolean };

export function MonthCalendar({
  visibleMonth,
  onChangeMonth,
  selectedKey,
  onSelectDay,
  markedKeys,
  activeMarkedKeys,
  todayKey,
}: MonthCalendarProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();

  // Monats-Grid in Wochen-Zeilen (Mo–So) aufbauen.
  const weeks = useMemo<Cell[][]>(() => {
    const firstOfMonth = new Date(year, month, 1);
    // JS getDay(): So=0 … Sa=6 → wir wollen Mo=0 … So=6
    const leading = (firstOfMonth.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;

    const cells: Cell[] = [];
    for (let i = 0; i < totalCells; i++) {
      // Negative/überlaufende Tage normalisiert JS Date automatisch.
      const d = new Date(year, month, 1 - leading + i);
      cells.push({
        date: d,
        key: formatDateISO(d) ?? "",
        inMonth: d.getMonth() === month,
      });
    }

    const rows: Cell[][] = [];
    for (let i = 0; i < cells.length; i += 7) {
      rows.push(cells.slice(i, i + 7));
    }
    return rows;
  }, [year, month]);

  const monthLabel = visibleMonth.toLocaleDateString("de-DE", {
    month: "long",
    year: "numeric",
  });

  const goPrev = () => onChangeMonth(new Date(year, month - 1, 1));
  const goNext = () => onChangeMonth(new Date(year, month + 1, 1));

  return (
    <View style={styles.container}>
      {/* ── Kopf: Monat + Navigation ── */}
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={goPrev}
          style={styles.navBtn}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Vorheriger Monat"
        >
          <Ionicons
            name="chevron-back"
            size={20}
            color={theme.colors.primary}
          />
        </TouchableOpacity>

        <Text style={styles.monthLabel}>{monthLabel}</Text>

        <TouchableOpacity
          onPress={goNext}
          style={styles.navBtn}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Nächster Monat"
        >
          <Ionicons
            name="chevron-forward"
            size={20}
            color={theme.colors.primary}
          />
        </TouchableOpacity>
      </View>

      {/* ── Wochentags-Kopf Mo–So ── */}
      <View style={styles.weekHeader}>
        {WEEKDAYS.map((w) => (
          <Text key={w.key} style={styles.weekHeaderCell}>
            {w.short}
          </Text>
        ))}
      </View>

      {/* ── Tage-Grid ── */}
      {weeks.map((week, wi) => (
        <View key={wi} style={styles.weekRow}>
          {week.map((cell) => {
            const isSelected = cell.key === selectedKey;
            const isToday = cell.key === todayKey;
            const isMarked = cell.inMonth && markedKeys.has(cell.key);
            const isActiveMarked = cell.inMonth && activeMarkedKeys.has(cell.key);

            return (
              <TouchableOpacity
                key={cell.key}
                style={styles.dayCell}
                activeOpacity={0.7}
                disabled={!cell.inMonth}
                onPress={() => onSelectDay(cell.key)}
              >
                <View
                  style={[
                    styles.dayInner,
                    // Heute (nicht ausgewählt): dezente Container-Tönnung
                    isToday && !isSelected && styles.dayToday,
                    // Ausgewählt: kräftige primäre Füllung (stärker als Heute-Tint)
                    isSelected && styles.daySelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.dayText,
                      !cell.inMonth && styles.dayTextMuted,
                      isToday && !isSelected && styles.dayTextToday,
                      isSelected && styles.dayTextSelected,
                    ]}
                  >
                    {cell.date.getDate()}
                  </Text>
                </View>

                {/* Punkt-Slot (immer reserviert → Zeilen bleiben gleich hoch) */}
                <View style={styles.dotSlot}>
                  {isMarked ? (
                    <View
                      style={[
                        styles.dot,
                        // Ausschließlich erledigte Jobs → gedämpfte Farbe
                        !isActiveMarked && styles.dotCompleted,
                        // Auf ausgewähltem (gefülltem) Tag → sichtbare Kontrastfarbe
                        isSelected && styles.dotOnSelected,
                      ]}
                    />
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.md,
      ...theme.shadows.sm,
    },

    // ── Kopf
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: theme.spacing.sm,
    },
    navBtn: {
      width: 36,
      height: 36,
      borderRadius: theme.radius.full,
      alignItems: "center",
      justifyContent: "center",
      // Container-Hintergrund macht Pfeile als Buttons erkennbar
      backgroundColor: theme.colors.primaryContainer,
    },
    monthLabel: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },

    // ── Wochentags-Kopf
    weekHeader: {
      flexDirection: "row",
      marginBottom: theme.spacing.xs,
    },
    weekHeaderCell: {
      flex: 1,
      textAlign: "center",
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
      textTransform: "uppercase",
      letterSpacing: theme.typography.letterSpacing.wide,
    },

    // ── Tages-Grid
    weekRow: {
      flexDirection: "row",
    },
    dayCell: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 3,
    },
    dayInner: {
      width: 34,
      height: 34,
      borderRadius: theme.radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    // Heute (nicht ausgewählt): dezente Container-Tönnung — gut sichtbar,
    // ohne den ausgewählten Tag zu konkurrieren.
    dayToday: {
      backgroundColor: theme.colors.primaryContainer,
    },
    // Ausgewählt: kräftige primäre Füllung (sofort erkennbar, welcher Tag aktiv ist)
    daySelected: {
      backgroundColor: theme.colors.primary,
    },
    dayText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    dayTextMuted: {
      color: theme.colors.outline,
    },
    dayTextToday: {
      color: theme.colors.onPrimaryContainer,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    dayTextSelected: {
      color: theme.colors.onPrimary,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
    },

    // ── Job-Punkt
    dotSlot: {
      height: 6,
      marginTop: 2,
      alignItems: "center",
      justifyContent: "center",
    },
    // Tage mit offenen/laufenden Jobs: primäre Akzentfarbe (Handlungsbedarf)
    dot: {
      width: 5,
      height: 5,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primary,
    },
    // Tage mit ausschließlich erledigten Jobs: gedämpfte Farbe (kein Handlungsbedarf)
    dotCompleted: {
      backgroundColor: theme.colors.outline,
    },
    // Punkt auf ausgewähltem Tag: auf primärem Hintergrund sichtbar bleiben
    dotOnSelected: {
      backgroundColor: theme.colors.onPrimary,
    },
  });
}
