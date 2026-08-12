// features/jobs/components/CalendarDayCell.tsx
// ─────────────────────────────────────────────────────────────────
// EINE Tageszelle des Monatsrasters.
//
// Aufbau (von oben):
//   [ Tageszahl ]           — bei „heute" in gefülltem Kreis
//   [ 08:00 Müller ]        — kompakte Job-Zeilen (CalendarJobItem)
//   [ +2 weitere ]          — sobald mehr Jobs existieren als Platz haben
//
// HEUTE vs. AUSGEWÄHLT sind zwei getrennte, gleichzeitig lesbare Signale:
//   heute      → gefüllter Kreis um die Tageszahl (dauerhaft, wandert nie)
//   ausgewählt → getönte Zelle mit Primär-Rahmen (folgt dem Tippen)
// Ist der heutige Tag ausgewählt, bleiben beide sichtbar und widersprechen
// sich nicht (Kreis IM gerahmten Feld).
//
// Nichts wird still unterschlagen: `hiddenCount` zeigt exakt, wie viele
// Aufträge die Zelle nicht mehr darstellen konnte.
// ─────────────────────────────────────────────────────────────────

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CalendarJobItem } from "@/features/jobs/components/CalendarJobItem";

type Props = {
  /** Tageszahl (1–31). */
  dayNumber: number;
  /** Datums-Schlüssel "YYYY-MM-DD" — nur für Labels/Keys. */
  dayKey: string;
  /** Gehört der Tag zum angezeigten Monat? */
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  /** Bereits nach Uhrzeit sortierte Jobs dieses Tages (vollständig). */
  jobs: Job[];
  /** Wie viele Einträge passen, wenn KEINE „+N weitere"-Zeile nötig ist. */
  maxVisible: number;
  /** Wie viele Einträge passen, wenn die „+N weitere"-Zeile mitmuss. */
  maxVisibleWithOverflow: number;
  onSelectDay: (key: string) => void;
  onOpenJob: (jobId: string) => void;
};

function CalendarDayCellBase({
  dayNumber,
  dayKey,
  inMonth,
  isToday,
  isSelected,
  jobs,
  maxVisible,
  maxVisibleWithOverflow,
  onSelectDay,
  onOpenJob,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  // Passen alle Aufträge des Tages, werden alle gezeigt. Sonst wird auf die
  // (ggf. kleinere) Kapazität MIT Überlaufzeile gekürzt — und der Rest wird
  // beziffert, nie stillschweigend weggelassen.
  const visible =
    jobs.length <= maxVisible ? jobs.length : maxVisibleWithOverflow;
  const hiddenCount = jobs.length - visible;

  const a11yLabel = `${dayNumber}.${isToday ? " Heute." : ""} ${
    jobs.length === 0
      ? "Keine Aufträge"
      : jobs.length === 1
        ? "1 Auftrag"
        : `${jobs.length} Aufträge`
  }`;

  return (
    <TouchableOpacity
      style={[styles.cell, isSelected && styles.cellSelected]}
      activeOpacity={0.7}
      onPress={() => onSelectDay(dayKey)}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ selected: isSelected }}
    >
      {/* ── Tageszahl (heute im gefüllten Kreis) ── */}
      <View style={styles.dateRow}>
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
      </View>

      {/* ── Job-Zeilen + Überlauf ── */}
      <View style={styles.jobs}>
        {jobs.slice(0, visible).map((job) => (
          <CalendarJobItem
            key={job.id}
            job={job}
            muted={!inMonth}
            onPress={() => onOpenJob(job.id)}
          />
        ))}

        {/* Kein Touchable: der Tap fällt auf die Zelle durch und öffnet die
            vollständige Tages-Agenda — genau das, was hier gemeint ist. */}
        {hiddenCount > 0 ? (
          <Text style={styles.more} numberOfLines={1} maxFontSizeMultiplier={1.2}>
            +{hiddenCount} weitere
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

/**
 * Memoisiert: beim Blättern/Selektieren rendert sonst jede der bis zu 42
 * Zellen neu, obwohl sich meist nur zwei ändern (alte + neue Auswahl).
 * Die `jobs`-Arrays sind pro Tag stabile Referenzen aus `groupJobsByDateKey`.
 */
export const CalendarDayCell = React.memo(CalendarDayCellBase);

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    cell: {
      flex: 1,
      // Gleiche Breite für alle sieben Spalten, egal wie lang der Inhalt ist:
      // ohne minWidth:0 dehnt ein langer Kundenname die Spalte auf Kosten der
      // Nachbarn (Flexbox-Standard: min-width = auto).
      minWidth: 0,
      paddingHorizontal: 2,
      paddingBottom: 2,
      borderRadius: theme.radius.sm,
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
    dateRow: {
      alignItems: "center",
      paddingTop: 2,
      paddingBottom: 1,
    },
    dateBubble: {
      minWidth: 20,
      height: 20,
      paddingHorizontal: 4,
      borderRadius: theme.radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    // Heute: dauerhafter gefüllter Kreis.
    dateBubbleToday: {
      backgroundColor: theme.colors.primary,
    },
    dateText: {
      fontSize: 12,
      lineHeight: 15,
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

    // ── Job-Bereich
    jobs: {
      flex: 1,
      gap: 1,
      overflow: "hidden",
    },
    // Niedriger als ein Job-Eintrag: die Überlaufzeile belegt zwar einen
    // Slot in der Kapazitätsrechnung, braucht aber nur eine Textzeile.
    more: {
      height: 14,
      fontSize: 9,
      lineHeight: 14,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
      paddingLeft: 2,
    },
  });
}
