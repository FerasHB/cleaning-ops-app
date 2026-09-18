// features/jobs/components/RuleStatusCard.tsx
// Erklärt den Zustand einer Regel, sobald er erklärungsbedürftig ist.
//
// WARUM: deriveRuleHealth kennt sechs Zustände samt Hinweistext, aber nur die
// Listen-Ansicht zeigte sie. Wer eine Karte mit „Keine Termine" antippte,
// landete auf einer Detailansicht, die nur „Aktiv" sagte — die Warnung war
// beim Hineinnavigieren verschwunden.
//
// Diese Karte rendert NUR bei Zuständen ungleich „healthy". Zusätzlich zum
// vorhandenen `hint` steht hier ein konkreter nächster Schritt: der Hinweis
// allein beschreibt das Symptom, nicht die Handlung.
//
// KEINE eigene Zustandslogik — `health` kommt fertig vom Screen.

import { Card } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { RuleHealth, RuleHealthState } from "@/utils/recurringRule";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

/**
 * GENAU EIN Erklärungstext je Zustand — Symptom und nächster Schritt in einem.
 *
 * Vorher standen hier zwei Absätze übereinander: der generische `hint` aus
 * deriveRuleHealth und zusätzlich ein Handlungshinweis. Bei „keine Termine"
 * widersprachen sie sich sogar („Für diese Regel wurden keine Termine erzeugt."
 * gefolgt von „Der erzeugte Zeitraum kann abgelaufen sein"), bei anderen
 * Zuständen sagten sie schlicht zweimal dasselbe.
 *
 * Bewusst zurückhaltend formuliert: die Termin-Erzeugung läuft ausschließlich
 * über die bestehenden Wege (Anlegen, Speichern, Aktivieren) — dieser Text
 * beschreibt sie, er löst nichts aus.
 */
function explanationFor(
  state: RuleHealthState,
  t: (key: string) => string,
): string | null {
  switch (state) {
    case "no_occurrences":
      return t("admin:recurringRules.explanation.noOccurrences");
    case "horizon_expired":
      return t("admin:recurringRules.explanation.horizonExpired");
    case "inactive":
      return t("admin:recurringRules.explanation.inactive");
    case "inactive_employee":
      return t("admin:recurringRules.explanation.inactiveEmployee");
    case "completed_rule":
      return t("admin:recurringRules.explanation.completedRule");
    case "healthy":
      return null;
  }
}

type Props = {
  health: RuleHealth;
};

export function RuleStatusCard({ health }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  // Gesunde Regeln brauchen keine Erklärung.
  if (health.state === "healthy") return null;

  const isWarning = health.severity === "warning";
  const accent = isWarning ? theme.colors.statusOpen : theme.colors.onSurfaceVariant;
  // Zustandsspezifischer Text hat Vorrang; `hint` ist nur der Rückfall, falls
  // je ein neuer Zustand ohne eigene Erklärung dazukommt.
  const body = explanationFor(health.state, t) ?? health.hint ?? null;

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <View style={styles.row}>
        <Ionicons
          name={isWarning ? "alert-circle-outline" : "information-circle-outline"}
          size={18}
          color={accent}
        />
        <View style={styles.textBlock}>
          <Text style={[styles.title, { color: accent }]}>{health.label}</Text>
          {body ? <Text style={styles.body}>{body}</Text> : null}
        </View>
      </View>
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.sm,
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.sm,
    },
    textBlock: {
      flex: 1,
      gap: theme.spacing.xs,
    },
    title: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    body: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      lineHeight: theme.typography.lineHeight.sm,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
