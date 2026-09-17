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
import { useIsRTL } from "@/hooks/useIsRTL";
import type { AppTheme } from "@/constants/theme";
import type { Absence } from "@/types/absence";
import { formatAbsenceDateRange } from "@/utils/absenceFormat";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";

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
  const isRTL = useIsRTL();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  const isVacation = absence.type === "vacation";
  const typeLabel = t(
    isVacation ? "absences:types.vacation" : "timesheets:absenceSection.typeSickness",
  );

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={0.7}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={
        onPress
          ? t("admin:absenceAdmin.openEmployeeA11y", {
              name: absence.employeeName,
              type: typeLabel,
            })
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
          {typeLabel} · {formatAbsenceDateRange(absence)}
        </Text>
      </View>

      {onPress ? (
        <Ionicons name={isRTL ? "chevron-back" : "chevron-forward"} size={16} color={theme.colors.outline} />
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
