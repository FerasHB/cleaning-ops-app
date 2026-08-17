// features/absences/admin/components/AbsentTodayRow.tsx
// Eine Zeile im "Abwesend"-Reiter von AdminAbsencesScreen: wer ist HEUTE
// aktiv abwesend (genehmigter Urlaub / gemeldete Krankheit)?
//
// Bewusst KEINE Wiederverwendung von AdminAbsenceRow: dieser Reiter ist rein
// lesend (kein Genehmigen/Ablehnen — "Abwesend" ist keine Review-Warteschlange,
// sondern eine Momentaufnahme) UND tippbar (→ Employee Detail), wofür
// AdminAbsenceRow keinen Vertrag hat (reine Card, kein onPress). Gleiches
// Formatierungs-/Farb-Vokabular wie überall sonst: `formatAbsenceDateRange`
// (utils/absenceFormat.ts, liefert "Krank seit DD.MM." für offen-endige
// Krankheit) und Urlaub=primary/Krankheit=statusOpen (wie AbsenceCard,
// AdminAbsenceRow, DayAgendaSheet).

import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import type { Absence } from "@/types/absence";
import { formatAbsenceDateRange } from "@/utils/absenceFormat";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Props = {
  absence: Absence;
  /**
   * Fehlt (kein employeeId → gelöschtes Konto): Zeile bleibt lesbar, aber
   * nicht antippbar — kein kaputtes Navigationsziel.
   */
  onPress?: () => void;
};

export function AbsentTodayRow({ absence, onPress }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const isVacation = absence.type === "vacation";

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={0.7}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={
        onPress
          ? `${absence.employeeName}, ${isVacation ? "Urlaub" : "Krank"}, Mitarbeiterdetails öffnen`
          : undefined
      }
    >
      <View
        style={[
          styles.icon,
          {
            backgroundColor: isVacation
              ? theme.colors.primaryContainer
              : theme.colors.statusOpenBg,
          },
        ]}
      >
        <Ionicons
          name={isVacation ? "sunny-outline" : "medkit-outline"}
          size={16}
          color={isVacation ? theme.colors.primary : theme.colors.statusOpen}
        />
      </View>

      <View style={styles.textWrap}>
        <Text style={styles.name} numberOfLines={1}>
          {absence.employeeName}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {isVacation ? "Urlaub" : "Krank"} · {formatAbsenceDateRange(absence)}
        </Text>
      </View>

      {onPress ? (
        <Ionicons name="chevron-forward" size={16} color={theme.colors.outline} />
      ) : null}
    </TouchableOpacity>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.md,
      ...theme.shadows.sm,
    },
    icon: {
      width: 32,
      height: 32,
      borderRadius: theme.radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    textWrap: {
      flex: 1,
    },
    name: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    meta: {
      marginTop: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
