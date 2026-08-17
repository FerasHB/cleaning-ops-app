// features/jobs/components/AbsenceFilterRow.tsx
// ─────────────────────────────────────────────────────────────────
// Phase D — Abwesenheits-Filter für den Admin-Kalender: „Alle" / „Urlaub" /
// „Krank". Gleiches Bauprinzip wie StatusFilterRow (reine Präsentation,
// Chips, horizontal scrollbar) — bewusst eine eigene, kleine Zeile statt
// StatusFilterRow zu verallgemeinern, weil die Semantik eine andere ist:
// dieser Filter blendet NIE Aufträge aus, er steuert ausschließlich, welche
// Abwesenheits-MARKER/-Agenda-Zeilen sichtbar sind (siehe AdminJobsCalendarScreen).
//
// Farben: dieselben Tokens wie in features/absences/components/AbsenceCard.tsx
// (Urlaub → theme.colors.primary, Krankheit → theme.colors.statusOpen) — keine
// zweite Abwesenheits-Farbtabelle.
// ─────────────────────────────────────────────────────────────────

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";

export type AbsenceSelection = "all" | "vacation" | "sickness";

export const ALL_ABSENCE_LABEL = "Alle";

const ABSENCE_LABELS: Record<Exclude<AbsenceSelection, "all">, string> = {
  vacation: "Urlaub",
  sickness: "Krank",
};

/** Lesbares Label der aktuellen Auswahl (für Chip/Accessibility). */
export function absenceSelectionLabel(selection: AbsenceSelection): string {
  return selection === "all" ? ALL_ABSENCE_LABEL : ABSENCE_LABELS[selection];
}

type Props = {
  value: AbsenceSelection;
  onChange: (next: AbsenceSelection) => void;
};

export function AbsenceFilterRow({ value, onChange }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      <Chip
        label={ALL_ABSENCE_LABEL}
        active={value === "all"}
        onPress={() => onChange("all")}
        activeBg={theme.colors.primaryContainer}
        activeBorder={theme.colors.primaryContainer}
        activeText={theme.colors.onPrimaryContainer}
        styles={styles}
      />
      <Chip
        label={ABSENCE_LABELS.vacation}
        active={value === "vacation"}
        onPress={() => onChange("vacation")}
        activeBg={theme.colors.primaryContainer}
        activeBorder={theme.colors.primary}
        activeText={theme.colors.primary}
        styles={styles}
      />
      <Chip
        label={ABSENCE_LABELS.sickness}
        active={value === "sickness"}
        onPress={() => onChange("sickness")}
        activeBg={theme.colors.statusOpenBg}
        activeBorder={theme.colors.statusOpen}
        activeText={theme.colors.statusOpen}
        styles={styles}
      />
    </ScrollView>
  );
}

function Chip({
  label,
  active,
  onPress,
  activeBg,
  activeBorder,
  activeText,
  styles,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  activeBg: string;
  activeBorder: string;
  activeText: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.chip,
        active && { backgroundColor: activeBg, borderColor: activeBorder },
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Abwesenheits-Filter: ${label}`}
    >
      <Text
        style={[
          styles.chipText,
          active && styles.chipTextActive,
          active && { color: activeText },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    chip: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
    },
    chipText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    chipTextActive: {
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
  });
}
