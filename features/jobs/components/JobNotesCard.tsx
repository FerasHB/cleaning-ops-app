// features/jobs/components/JobNotesCard.tsx
// Notizen-Sektion — nur gerendert, wenn Notizen vorhanden sind (Gating bleibt
// beim aufrufenden Screen, wie zuvor). Langer Text bricht korrekt um.

import { Card } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  notes: string;
};

export function JobNotesCard({ notes }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <View style={styles.labelRow}>
        <Ionicons
          name="document-text-outline"
          size={12}
          color={theme.colors.primary}
        />
        <Text style={styles.label}>NOTIZEN</Text>
      </View>
      <Text style={styles.text}>{notes}</Text>
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.sm,
    },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    label: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    text: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
      flexWrap: "wrap",
    },
  });
}
