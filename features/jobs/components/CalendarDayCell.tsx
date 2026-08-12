// features/jobs/components/CalendarDayCell.tsx
// ─────────────────────────────────────────────────────────────────
// EINE Tageszelle des Monatsrasters — bewusst eine ZUSAMMENFASSUNG,
// keine Miniatur-Jobliste.
//
// Aufbau (von oben):
//   [ Tageszahl ]     — bei „heute" in gefülltem Kreis
//   [ 3  ● ● ]        — Auftragszahl + vorkommende Zustände
//
// WARUM NUR EINE ZAHL (und nicht „3 Aufträge"):
// Eine Rasterspalte ist auf dem schmalsten gängigen Gerät (375 pt) rund
// 46 pt breit. „3 Aufträge" braucht bei 9 px schon ~47 pt und wäre damit
// schon am Anschlag — „12 Aufträge" liefe über. Und 9 px ist genau die
// Größe, bei der eine Zahl nicht mehr „auf einen Blick" lesbar ist. Die
// nackte Zahl passt dagegen bei 13 px bequem und ist sofort scanbar.
//
// WARUM ZAHL UND PUNKTE IN EINER ZEILE:
// Untereinander stünden zwei nackte Zahlen direkt übereinander (Tageszahl
// und Anzahl) — das liest sich wie zwei Datumsangaben. Neben den farbigen
// Punkten ist sofort klar, dass die zweite Zahl zu den Aufträgen gehört.
// Nebenbei spart es eine Zeile Höhe, was dem Raster Luft gibt.
//
// STATUS-PUNKTE: ein Punkt je VORKOMMENDEM Zustand (nicht je Auftrag) —
// also höchstens drei. Die Farben kommen aus `utils/jobStatus.ts`
// (getJobStatusMeta); es gibt bewusst KEINE zweite Status-Farbtabelle.
//
// Leere Tage bleiben absichtlich still: nur die Tageszahl, keine „0".
// ─────────────────────────────────────────────────────────────────

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { DaySummary } from "@/utils/calendarMonth";
import { getJobStatusMeta } from "@/utils/jobStatus";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Props = {
  /** Tageszahl (1–31). */
  dayNumber: number;
  /** Datums-Schlüssel "YYYY-MM-DD". */
  dayKey: string;
  /** Gehört der Tag zum angezeigten Monat? */
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  /** Verdichtete Tagesinfo — `undefined` = keine Aufträge. */
  summary: DaySummary | undefined;
  onSelectDay: (key: string) => void;
};

// Screenreader bekommt die Verteilung ausgeschrieben, die die Punkte nur
// andeuten. Genau dafür trägt DaySummary die einzelnen Zähler.
function buildA11yLabel(
  dayNumber: number,
  isToday: boolean,
  summary: DaySummary | undefined,
): string {
  const head = `${dayNumber}.${isToday ? " Heute." : ""}`;
  if (!summary) return `${head} Keine Aufträge`;

  const parts: string[] = [];
  if (summary.open > 0) parts.push(`${summary.open} offen`);
  if (summary.inProgress > 0) parts.push(`${summary.inProgress} in Arbeit`);
  if (summary.completed > 0) parts.push(`${summary.completed} erledigt`);

  const total = summary.total === 1 ? "1 Auftrag" : `${summary.total} Aufträge`;
  return `${head} ${total}: ${parts.join(", ")}`;
}

function CalendarDayCellBase({
  dayNumber,
  dayKey,
  inMonth,
  isToday,
  isSelected,
  summary,
  onSelectDay,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <TouchableOpacity
      style={[styles.cell, isSelected && styles.cellSelected]}
      activeOpacity={0.7}
      onPress={() => onSelectDay(dayKey)}
      accessibilityRole="button"
      accessibilityLabel={buildA11yLabel(dayNumber, isToday, summary)}
      accessibilityState={{ selected: isSelected }}
    >
      {/* ── Tageszahl (heute im gefüllten Kreis) ── */}
      <View style={[styles.dateBubble, isToday && styles.dateBubbleToday]}>
        <Text
          style={[
            styles.dateText,
            !inMonth && styles.dateTextMuted,
            isToday && styles.dateTextToday,
          ]}
          // Sehr große Systemschrift darf das Raster nicht sprengen.
          maxFontSizeMultiplier={1.3}
        >
          {dayNumber}
        </Text>
      </View>

      {/* ── Zusammenfassung: Anzahl + vorkommende Zustände ── */}
      {summary ? (
        <View style={[styles.summaryRow, !inMonth && styles.summaryMuted]}>
          <Text style={styles.countText} maxFontSizeMultiplier={1.2}>
            {summary.total}
          </Text>
          <View style={styles.dots}>
            {summary.statuses.map((status) => (
              <View
                key={status}
                style={[
                  styles.dot,
                  { backgroundColor: getJobStatusMeta(status, theme.colors).text },
                ]}
              />
            ))}
          </View>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

/**
 * Memoisiert: beim Blättern/Selektieren rendert sonst jede der bis zu 42
 * Zellen neu, obwohl sich meist nur zwei ändern (alte + neue Auswahl).
 * `summary` ist pro Tag eine stabile Referenz aus `buildDaySummaries`.
 */
export const CalendarDayCell = React.memo(CalendarDayCellBase);

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    cell: {
      flex: 1,
      // Gleiche Breite für alle sieben Spalten, egal wie lang der Inhalt ist:
      // ohne minWidth:0 dehnt ein breiter Inhalt die Spalte auf Kosten der
      // Nachbarn (Flexbox-Standard: min-width = auto).
      minWidth: 0,
      alignItems: "center",
      // Inhalt sitzt oben, der Rest der Zelle ist bewusst Luft — das ist der
      // sichtbare Unterschied zur alten, randvoll gefüllten Zelle.
      paddingTop: 6,
      gap: 5,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      // Unsichtbarer Rahmen im Normalzustand — so springt das Layout beim
      // Auswählen nicht um 1 px.
      borderColor: theme.colors.transparent,
    },
    // Ausgewählt: getönte Fläche + Primär-Rahmen (unabhängig vom Heute-Kreis).
    cellSelected: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderColor: theme.colors.primary,
    },

    // ── Tageszahl
    dateBubble: {
      minWidth: 26,
      height: 26,
      paddingHorizontal: 5,
      borderRadius: theme.radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    // Heute: dauerhafter gefüllter Kreis.
    dateBubbleToday: {
      backgroundColor: theme.colors.primary,
    },
    dateText: {
      fontSize: 15,
      lineHeight: 19,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    // Nachbarmonats-Tage: sichtbar, aber zurückgenommen.
    dateTextMuted: {
      color: theme.colors.outline,
    },
    dateTextToday: {
      color: theme.colors.onPrimary,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
    },

    // ── Zusammenfassung
    summaryRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    summaryMuted: {
      opacity: 0.45,
    },
    countText: {
      fontSize: 13,
      lineHeight: 16,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
    },
    dots: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
    },
    dot: {
      width: 5,
      height: 5,
      borderRadius: theme.radius.full,
    },
  });
}
