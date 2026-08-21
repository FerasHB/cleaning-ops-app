// features/absences/components/VacationBalanceCard.tsx
// Kompakte Urlaubskonto-Anzeige für den Mitarbeiter (nur Lesen).
//
// RENDERT BEWUSST NICHTS, solange nicht beides gilt: Urlaubskonto aktiv UND
// Jahr initialisiert. Ein "Resturlaub: 0" nur weil die Buchhaltung aus oder
// noch nicht eingerichtet ist, wäre schlicht falsch — der Mitarbeiter hätte
// gesetzlich sehr wohl Anspruch. Lieber gar keine Zahl als eine erfundene.
//
// "Offene Anträge" zeigt absichtlich nur die ZEITRÄUME, keine Tagessumme:
// wie viele Tage ein Antrag verbraucht, steht erst mit der Bestätigung des
// Admins bei der Genehmigung fest.

import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import type { Absence } from "@/types/absence";
import type { VacationBalance } from "@/types/vacationLedger";
import { formatDays } from "@/utils/vacationBalance";
import { formatDateOnlyDE } from "@/utils/date";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  balance: VacationBalance | null;
  pending: Absence[];
};

export function VacationBalanceCard({ balance, pending }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  // Kein Konto / nicht eingerichtet -> gar nichts anzeigen (siehe Kopf).
  if (!balance) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Urlaub {balance.year}</Text>

      <View style={styles.row}>
        <Text style={styles.label}>Jahresanspruch</Text>
        <Text style={styles.value}>{formatDays(balance.annualEntitlement)} Tage</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Verbraucht</Text>
        <Text style={styles.value}>{formatDays(balance.usedDays)} Tage</Text>
      </View>
      {balance.adjustments !== 0 ? (
        <View style={styles.row}>
          <Text style={styles.label}>Korrekturen</Text>
          <Text style={styles.value}>{formatDays(balance.adjustments)} Tage</Text>
        </View>
      ) : null}

      <View style={styles.divider} />
      <View style={styles.row}>
        <Text style={styles.strongLabel}>Resturlaub</Text>
        <Text style={styles.strongValue}>{formatDays(balance.remaining)} Tage</Text>
      </View>

      {pending.length > 0 ? (
        <>
          <View style={styles.divider} />
          <Text style={styles.label}>Offene Anträge</Text>
          {pending.map((absence) => (
            <Text key={absence.id} style={styles.pendingLine}>
              {formatDateOnlyDE(absence.startDate)}
              {absence.endDate ? ` – ${formatDateOnlyDE(absence.endDate)}` : ""}
            </Text>
          ))}
          <Text style={styles.footnote}>
            Die angerechneten Tage stehen erst mit der Genehmigung fest.
          </Text>
        </>
      ) : null}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.md,
      gap: 2,
      marginBottom: theme.spacing.md,
    },
    title: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      marginBottom: theme.spacing.xs,
    },
    row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
    label: { fontSize: theme.typography.size.sm, color: theme.colors.onSurfaceVariant },
    value: { fontSize: theme.typography.size.sm, color: theme.colors.onSurface },
    strongLabel: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    strongValue: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },
    divider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
      marginVertical: theme.spacing.xs,
    },
    pendingLine: { fontSize: theme.typography.size.sm, color: theme.colors.onSurface },
    footnote: {
      fontSize: theme.typography.size.xs,
      color: theme.colors.onSurfaceVariant,
      marginTop: 2,
    },
  });
}
