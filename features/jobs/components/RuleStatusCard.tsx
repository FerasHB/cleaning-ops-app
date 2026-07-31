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
function explanationFor(state: RuleHealthState): string | null {
  switch (state) {
    case "no_occurrences":
      return "Für den kommenden Zeitraum liegen keine Termine vor. Termine entstehen beim Anlegen sowie beim Speichern oder Aktivieren der Regel — öffne „Bearbeiten“ und speichere die Regel, um den Zeitraum aufzufrischen.";
    case "horizon_expired":
      return "Das Enddatum der Regel liegt in der Vergangenheit. Setze unter „Bearbeiten“ ein neues Enddatum, damit wieder Termine erzeugt werden.";
    case "inactive":
      return "Diese Regel ist deaktiviert: Sie erzeugt keine neuen Termine und erscheint Mitarbeitenden nicht. Über das Menü oben rechts lässt sie sich wieder aktivieren.";
    case "inactive_employee":
      return "Mindestens eine zugewiesene Person ist deaktiviert. Weise die Regel unter „Bearbeiten“ einer aktiven Person zu, damit die erzeugten Termine sichtbar bleiben.";
    case "completed_rule":
      return "Der Status dieser Regel steht auf „erledigt“. Eine Regel wird nie erledigt — das deutet auf einen Altbestand hin und sollte geprüft werden.";
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

  // Gesunde Regeln brauchen keine Erklärung.
  if (health.state === "healthy") return null;

  const isWarning = health.severity === "warning";
  const accent = isWarning ? theme.colors.statusOpen : theme.colors.onSurfaceVariant;
  // Zustandsspezifischer Text hat Vorrang; `hint` ist nur der Rückfall, falls
  // je ein neuer Zustand ohne eigene Erklärung dazukommt.
  const body = explanationFor(health.state) ?? health.hint ?? null;

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
