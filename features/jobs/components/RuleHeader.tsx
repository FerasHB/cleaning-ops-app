// features/jobs/components/RuleHeader.tsx
// Kopfbereich der Dauerauftrags-Detailansicht.
//
// Beantwortet zuerst „was ist das hier?" — die vorige Ansicht führte mit dem
// Kundennamen und einem Status-Badge, also exakt der Optik eines ausführbaren
// Termins. Eine Regel ist aber eine Vorlage: die Zeile „DAUERAUFTRAG" steht
// deshalb ÜBER dem Namen, und der Zustand kommt aus deriveRuleHealth
// (RuleStatePill) statt aus einem binären Aktiv/Inaktiv-Badge.
//
// Reine Präsentation.

import type { AppTheme } from "@/constants/theme";
import { RuleStatePill } from "@/features/jobs/components/RuleStatePill";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import type { RuleHealth } from "@/utils/recurringRule";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  rule: Pick<Job, "customerName" | "service" | "location">;
  health: RuleHealth;
};

export function RuleHeader({ rule, health }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const subline = [rule.service, rule.location].filter(Boolean).join(" · ");

  return (
    <View style={styles.hero}>
      <View style={styles.eyebrowRow}>
        <Ionicons
          name="repeat-outline"
          size={13}
          color={theme.colors.primary}
        />
        <Text style={styles.eyebrow}>DAUERAUFTRAG</Text>
      </View>

      <View style={styles.titleRow}>
        <Text style={styles.customerName}>{rule.customerName}</Text>
        <RuleStatePill health={health} />
      </View>

      {subline ? (
        <Text style={styles.subline} numberOfLines={2}>
          {subline}
        </Text>
      ) : null}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    hero: {
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    eyebrowRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    eyebrow: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    titleRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      rowGap: 6,
    },
    customerName: {
      flexShrink: 1,
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
      lineHeight: theme.typography.lineHeight.xxl,
    },
    subline: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
