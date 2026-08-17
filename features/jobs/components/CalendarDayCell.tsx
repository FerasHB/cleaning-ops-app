// features/jobs/components/CalendarDayCell.tsx
// ─────────────────────────────────────────────────────────────────
// EINE Tageszelle des Monatsrasters — bewusst eine ZUSAMMENFASSUNG,
// keine Miniatur-Jobliste.
//
// Aufbau (von oben):
//   [ Tageszahl ]     — bei „heute" in gefülltem Kreis
//   [ 3 Jobs ] ● ●    — Anzahl als Pille + vorkommende Zustände
//
// WARUM EINE PILLE MIT WORT (und nicht die nackte Zahl):
// Vorher stand hier nur die Ziffer. Auf dem Gerät las sich „22" über „3"
// wie zwei Datumsangaben untereinander — die Anzahl war nicht als Anzahl
// erkennbar. Die Pille nimmt der Zahl diese Mehrdeutigkeit: eigener
// Hintergrund, eigenes Wort, klar abgesetzt von der Tageszahl darüber.
//
// WARUM „Jobs" UND NICHT „Aufträge":
// Eine Rasterspalte ist auf dem schmalsten gängigen Gerät (375 pt) rund
// 46 pt nutzbar. „3 Aufträge" braucht dort schon bei 9 px ~47 pt und
// „12 Aufträge" läuft über. „12 Jobs" bleibt mit Pillen-Polsterung bei
// 10 px unter 44 pt — die Pille kann also nie in die Nachbarzelle laufen.
//
// WARUM DIE PUNKTE UMBRECHEN DÜRFEN:
// Neben der Pille bleiben je nach Beschriftung nur ein bis zwei Punkte
// Platz. Statt Punkte wegzulassen (= Bedeutungsverlust) darf die Zeile
// umbrechen: passende Punkte stehen neben der Pille, sonst rutschen sie in
// die Zeile darunter. Höhe ist in diesen Zellen reichlich vorhanden,
// Breite nicht.
//
// STATUS-PUNKTE: ein Punkt je VORKOMMENDEM Zustand (nicht je Auftrag) —
// also höchstens drei. Die Farben kommen aus `utils/jobStatus.ts`
// (getJobStatusMeta); es gibt bewusst KEINE zweite Status-Farbtabelle.
//
// Leere Tage bleiben absichtlich still: nur die Tageszahl, keine „0".
// ─────────────────────────────────────────────────────────────────

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AbsenceType } from "@/types/absence";
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
  /**
   * Phase D — vorkommende Abwesenheits-TYPEN dieses Tages (höchstens
   * ["vacation","sickness"], nie ein Eintrag je Mitarbeiter). `undefined`/
   * leer = keine aktive Abwesenheit an diesem Tag. Additiv: Aufrufer, die
   * das nicht übergeben (z. B. bestehende Tests), verhalten sich unverändert.
   */
  absenceTypes?: AbsenceType[];
  onSelectDay: (key: string) => void;
};

/**
 * Beschriftung der Zähl-Pille: „1 Job" / „2 Jobs".
 * Bewusst kurz gehalten — siehe Breiten-Begründung im Dateikopf. Die
 * ausgeschriebene deutsche Form steht im Screenreader-Label.
 */
function formatJobCountLabel(total: number): string {
  return total === 1 ? "1 Job" : `${total} Jobs`;
}

// Screenreader bekommt die Verteilung ausgeschrieben, die die Punkte nur
// andeuten. Genau dafür trägt DaySummary die einzelnen Zähler.
function buildA11yLabel(
  dayNumber: number,
  isToday: boolean,
  summary: DaySummary | undefined,
  absenceTypes: AbsenceType[] | undefined,
): string {
  const head = `${dayNumber}.${isToday ? " Heute." : ""}`;
  const absenceSuffix = absenceTypes?.length
    ? ` ${absenceTypes.map((t) => (t === "vacation" ? "Urlaub" : "Krank")).join(", ")}.`
    : "";

  if (!summary) return `${head} Keine Aufträge.${absenceSuffix}`;

  const parts: string[] = [];
  if (summary.open > 0) parts.push(`${summary.open} offen`);
  if (summary.inProgress > 0) parts.push(`${summary.inProgress} in Arbeit`);
  if (summary.completed > 0) parts.push(`${summary.completed} erledigt`);

  const total = summary.total === 1 ? "1 Auftrag" : `${summary.total} Aufträge`;
  return `${head} ${total}: ${parts.join(", ")}.${absenceSuffix}`;
}

function CalendarDayCellBase({
  dayNumber,
  dayKey,
  inMonth,
  isToday,
  isSelected,
  summary,
  absenceTypes,
  onSelectDay,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const hasAbsence = !!absenceTypes?.length;

  return (
    <TouchableOpacity
      style={[styles.cell, isSelected && styles.cellSelected]}
      activeOpacity={0.7}
      onPress={() => onSelectDay(dayKey)}
      accessibilityRole="button"
      accessibilityLabel={buildA11yLabel(dayNumber, isToday, summary, absenceTypes)}
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
          <View style={styles.countPill}>
            <Text
              style={styles.countPillText}
              numberOfLines={1}
              // Große Systemschrift darf die Pille nicht über die Spalte
              // hinaus wachsen lassen.
              maxFontSizeMultiplier={1.15}
            >
              {formatJobCountLabel(summary.total)}
            </Text>
          </View>

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

      {/* ── Phase D: Abwesenheits-Marker ── unabhängig von `summary`, ein
          Tag kann Abwesenheiten OHNE Aufträge haben. Höchstens zwei Punkte
          (Urlaub, Krank) — nie einer je Mitarbeiter. */}
      {hasAbsence ? (
        <View style={[styles.absenceRow, !inMonth && styles.summaryMuted]}>
          {absenceTypes!.map((type) => (
            <View
              key={type}
              style={[
                styles.absenceDot,
                {
                  backgroundColor:
                    type === "vacation" ? theme.colors.primary : theme.colors.statusOpen,
                },
              ]}
            />
          ))}
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
    // flexWrap: passen die Punkte nicht mehr neben die Pille, rutschen sie
    // in die Zeile darunter, statt die Spalte zu sprengen.
    summaryRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "center",
      // Bewusst knapp (vorher 4): jeder Punkt Abstand entscheidet mit, ob
      // die Statuspunkte noch neben der Pille Platz finden.
      gap: 2,
    },
    summaryMuted: {
      opacity: 0.45,
    },

    // Zähl-Pille: rein tonal — kein Rahmen, kein Schatten, keine
    // Akzentfarbe. Sie soll die Zahl von der Tageszahl trennen, nicht wie
    // ein Button aussehen.
    countPill: {
      // surfaceContainerHighest steht eine Stufe über der Tönung der
      // ausgewählten Zelle (surfaceContainerHigh) — die Pille bleibt damit
      // auch auf dem ausgewählten Tag sichtbar, ohne dass die Auswahl-
      // Gestaltung angefasst werden muss.
      backgroundColor: theme.colors.surfaceContainerHighest,
      borderRadius: theme.radius.full,
      paddingHorizontal: 4,
      paddingVertical: 1,
      // Schützt die Nachbarspalte, falls die Beschriftung wider Erwarten
      // doch breiter wird als die Zelle.
      maxWidth: "100%",
    },
    countPillText: {
      fontSize: 10,
      lineHeight: 13,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
    },

    dots: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
    },
    dot: {
      width: 4.5,
      height: 4.5,
      borderRadius: theme.radius.full,
    },

    // ── Phase D: Abwesenheits-Marker (eigene Zeile, unabhängig von `summary`)
    absenceRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 3,
    },
    // Etwas größer als die Status-Punkte: sie stehen ohne Pille daneben und
    // sollen trotzdem als eigenes Signal erkennbar bleiben, nicht als
    // vierter Status-Punkt missverstanden werden.
    absenceDot: {
      width: 5.5,
      height: 5.5,
      borderRadius: theme.radius.full,
    },
  });
}
