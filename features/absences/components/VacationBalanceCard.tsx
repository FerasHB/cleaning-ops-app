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
import { formatDaysLocalized } from "@/utils/vacationBalance";
import { formatDateOnlyLocalized } from "@/utils/date";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  balance: VacationBalance | null;
  pending: Absence[];
};

export function VacationBalanceCard({ balance, pending }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  // Kein Konto / nicht eingerichtet -> gar nichts anzeigen (siehe Kopf).
  if (!balance) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t("absences:balance.title", { year: balance.year })}</Text>

      <View style={styles.row}>
        <Text style={styles.label}>{t("absences:balance.annualEntitlement")}</Text>
        <Text style={styles.value}>
          {t("absences:balance.days", { count: formatDaysLocalized(balance.annualEntitlement) })}
        </Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>{t("absences:balance.used")}</Text>
        <Text style={styles.value}>
          {t("absences:balance.days", { count: formatDaysLocalized(balance.usedDays) })}
        </Text>
      </View>
      {balance.adjustments !== 0 ? (
        <View style={styles.row}>
          <Text style={styles.label}>{t("absences:balance.adjustments")}</Text>
          <Text style={styles.value}>
            {t("absences:balance.days", { count: formatDaysLocalized(balance.adjustments) })}
          </Text>
        </View>
      ) : null}

      <View style={styles.divider} />
      <View style={styles.row}>
        <Text style={styles.strongLabel}>{t("absences:balance.remaining")}</Text>
        <Text style={styles.strongValue}>
          {t("absences:balance.days", { count: formatDaysLocalized(balance.remaining) })}
        </Text>
      </View>

      {pending.length > 0 ? (
        <>
          <View style={styles.divider} />
          <Text style={styles.label}>{t("absences:balance.pendingRequests")}</Text>
          {pending.map((absence) => (
            <Text key={absence.id} style={styles.pendingLine}>
              {formatDateOnlyLocalized(absence.startDate)}
              {absence.endDate ? ` – ${formatDateOnlyLocalized(absence.endDate)}` : ""}
            </Text>
          ))}
          <Text style={styles.footnote}>
            {t("absences:balance.pendingFootnote")}
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
