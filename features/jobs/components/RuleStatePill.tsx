// features/jobs/components/RuleStatePill.tsx
// EIN Zustands-Chip für eine Dauerauftrags-Regel, gespeist aus dem bereits
// vorhandenen deriveRuleHealth (utils/recurringRule) — hier wird NICHTS neu
// bewertet, nur dargestellt.
//
// WARUM ÜBERHAUPT: die Detailansicht einer Regel zeigte bisher nur ein binäres
// „Aktiv/Inaktiv". Die Liste kennt dagegen sechs Zustände inklusive Warnungen.
// Wer eine Karte mit „Keine Termine" antippte, landete auf einem Screen, der
// „Aktiv" sagte. Dieser Chip macht beide Seiten wieder deckungsgleich.
//
// HINWEIS ZUR DOPPLUNG: AdminRecurringRulesScreen hat aktuell noch eine eigene,
// gleichwertige lokale Zuordnung (Funktion `ruleBadge`). Die Listen-Ansicht ist
// in diesem PR bewusst unangetastet; beide Stellen werden im nachgelagerten
// Listen-PR auf diese Komponente zusammengeführt.

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { RuleHealth } from "@/utils/recurringRule";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type PillTone = "ok" | "neutral" | "warning";

/**
 * Kurzlabel + Tonalität je Zustand. Warnungen haben Vorrang vor dem gesunden
 * Zustand — die Priorisierung selbst passiert bereits in deriveRuleHealth,
 * hier wird sie nur übersetzt.
 */
function pillFor(health: RuleHealth): { label: string; tone: PillTone } {
  switch (health.state) {
    case "completed_rule":
      return { label: "Prüfen", tone: "warning" };
    case "no_occurrences":
      return { label: "Keine Termine", tone: "warning" };
    case "inactive_employee":
      return { label: "MA inaktiv", tone: "warning" };
    case "horizon_expired":
      return { label: "Abgelaufen", tone: "warning" };
    case "inactive":
      return { label: "Inaktiv", tone: "neutral" };
    case "healthy":
      return { label: "Aktiv", tone: "ok" };
  }
}

type Props = {
  health: RuleHealth;
};

export function RuleStatePill({ health }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const pill = pillFor(health);
  const containerStyle = {
    ok: styles.pillOk,
    neutral: styles.pillNeutral,
    warning: styles.pillWarning,
  }[pill.tone];
  const textStyle = {
    ok: styles.textOk,
    neutral: styles.textNeutral,
    warning: styles.textWarning,
  }[pill.tone];

  return (
    <View style={[styles.pill, containerStyle]}>
      <Text style={[styles.text, textStyle]} numberOfLines={1}>
        {pill.label}
      </Text>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    // flexShrink: auf schmalen Screens darf der Chip schrumpfen, damit der
    // Objektname daneben nicht auf wenige Zeichen zusammengedrückt wird.
    pill: {
      flexShrink: 1,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 2,
      borderRadius: theme.radius.full,
      borderWidth: 1,
    },
    text: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    pillOk: {
      backgroundColor: theme.colors.statusCompletedBg,
      borderColor: theme.colors.statusCompletedBorder,
    },
    pillNeutral: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderColor: theme.colors.outlineVariant,
    },
    pillWarning: {
      backgroundColor: theme.colors.statusOpenBg,
      borderColor: theme.colors.statusOpenBorder,
    },
    textOk: { color: theme.colors.statusCompleted },
    textNeutral: { color: theme.colors.onSurfaceVariant },
    textWarning: { color: theme.colors.statusOpen },
  });
}
