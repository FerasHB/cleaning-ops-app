// features/jobs/components/MonthYearPickerSheet.tsx
// ─────────────────────────────────────────────────────────────────
// Kompakte Monats-/Jahresauswahl für den Kalender-Kopf.
//
// WOFÜR: Pfeile bewegen den Kalender um genau einen Monat. Wer von Juli 2026
// nach März 2027 will, tippt achtmal. Diese Auswahl macht daraus zwei Tipper.
//
// KEINE neue Abhängigkeit, KEIN Date-Picker-Paket: dasselbe Modal-Muster wie
// `components/ui/ActionMenuSheet` und `DayAgendaSheet` — Modal + Backdrop-
// Pressable, darin ein Jahres-Schrittschalter und ein Raster aus zwölf
// Monatsnamen.
//
// Die Monatsnamen kommen aus `MONTH_NAMES_DE` (utils/calendarMonth) — also
// aus derselben Quelle wie der Titel im Kalender-Kopf.
//
// Auswahl wirkt SOFORT: ein Tipp auf den Monat übernimmt Monat + eingestelltes
// Jahr und schließt. Ein zusätzlicher „Übernehmen"-Schritt wäre bei einer
// Auswahl ohne Freitexteingabe nur ein Tipp mehr ohne Gewinn.
// ─────────────────────────────────────────────────────────────────

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import {
  MONTH_NAMES_DE,
  monthIndexOfMonthKey,
  monthKeyOfParts,
  yearOfMonthKey,
} from "@/utils/calendarMonth";
import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

/**
 * Wählbarer Jahresbereich um das laufende Jahr. Bewusst begrenzt: ein
 * unbegrenzter Schrittschalter lädt dazu ein, versehentlich in Jahre zu
 * wandern, in denen es nie Aufträge geben wird.
 */
const YEAR_SPAN = 5;

type Props = {
  visible: boolean;
  /** Aktuell angezeigter Monat als "YYYY-MM". */
  monthKey: string;
  /** Liefert den gewählten Monat als "YYYY-MM". */
  onSelect: (monthKey: string) => void;
  onClose: () => void;
};

export function MonthYearPickerSheet({
  visible,
  monthKey,
  onSelect,
  onClose,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const currentYear = useMemo(() => new Date().getFullYear(), []);
  const minYear = currentYear - YEAR_SPAN;
  const maxYear = currentYear + YEAR_SPAN;

  // Im Schrittschalter eingestelltes Jahr — nur Entwurf, bis ein Monat
  // getippt wird.
  const [year, setYear] = useState(() => yearOfMonthKey(monthKey));

  // Beim Öffnen immer auf dem gerade angezeigten Monat starten (und nicht
  // auf dem Jahr, das beim letzten Öffnen stehen geblieben ist).
  useEffect(() => {
    if (visible) setYear(yearOfMonthKey(monthKey));
  }, [visible, monthKey]);

  const activeYear = yearOfMonthKey(monthKey);
  const activeMonthIndex = monthIndexOfMonthKey(monthKey);

  const handlePick = useCallback(
    (monthIndex: number) => {
      onSelect(monthKeyOfParts(year, monthIndex));
      onClose();
    },
    [year, onSelect, onClose],
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Innerer Pressable fängt Taps ab, damit die Auswahl beim Tippen auf
            den Inhalt nicht zugeht. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Monat und Jahr</Text>
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={onClose}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Auswahl schließen"
            >
              <Ionicons name="close" size={20} color={theme.colors.onSurfaceVariant} />
            </TouchableOpacity>
          </View>

          {/* ── Jahres-Schrittschalter ── */}
          <View style={styles.yearRow}>
            <TouchableOpacity
              style={[styles.yearBtn, year <= minYear && styles.yearBtnDisabled]}
              onPress={() => setYear((y) => Math.max(y - 1, minYear))}
              disabled={year <= minYear}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Vorheriges Jahr"
            >
              <Ionicons name="chevron-back" size={18} color={theme.colors.primary} />
            </TouchableOpacity>

            <Text style={styles.yearLabel} accessibilityLabel={`Jahr ${year}`}>
              {year}
            </Text>

            <TouchableOpacity
              style={[styles.yearBtn, year >= maxYear && styles.yearBtnDisabled]}
              onPress={() => setYear((y) => Math.min(y + 1, maxYear))}
              disabled={year >= maxYear}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Nächstes Jahr"
            >
              <Ionicons name="chevron-forward" size={18} color={theme.colors.primary} />
            </TouchableOpacity>
          </View>

          {/* ── Monatsraster (3 je Zeile) ── */}
          <View style={styles.monthGrid}>
            {MONTH_NAMES_DE.map((name, index) => {
              const isActive = year === activeYear && index === activeMonthIndex;
              return (
                <TouchableOpacity
                  key={name}
                  style={[styles.monthCell, isActive && styles.monthCellActive]}
                  onPress={() => handlePick(index)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={`${name} ${year}`}
                  accessibilityState={{ selected: isActive }}
                >
                  <Text
                    style={[styles.monthText, isActive && styles.monthTextActive]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.2}
                  >
                    {name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      alignItems: "center",
      justifyContent: "center",
      padding: theme.spacing.lg,
    },
    // Mittig statt am unteren Rand: das ist eine Auswahl, kein Aktionsmenü —
    // und sie steht dadurch näher am Titel, von dem aus sie geöffnet wurde.
    sheet: {
      width: "100%",
      maxWidth: 420,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
      ...theme.shadows.lg,
    },

    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    title: {
      flex: 1,
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: theme.radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surfaceContainerHigh,
    },

    // ── Jahr
    yearRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: theme.colors.surfaceContainer,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
    },
    yearBtn: {
      width: 36,
      height: 36,
      borderRadius: theme.radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surfaceContainerHigh,
    },
    // Am Rand des Bereichs: sichtbar gesperrt statt unsichtbar.
    yearBtnDisabled: {
      opacity: 0.35,
    },
    yearLabel: {
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },

    // ── Monate
    // flexBasis 28 % + flexGrow: es passen genau drei Zellen je Zeile, und
    // sie füllen die Restbreite gleichmäßig aus — ohne Prozentrechnung, die
    // sich mit `gap` beißt.
    monthGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
    },
    monthCell: {
      flexGrow: 1,
      flexBasis: "28%",
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 12,
      paddingHorizontal: 4,
      minHeight: theme.spacing.tapTarget,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surfaceContainer,
    },
    monthCellActive: {
      backgroundColor: theme.colors.primary,
    },
    monthText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    monthTextActive: {
      color: theme.colors.onPrimary,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
    },
  });
}
