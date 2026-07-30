// features/jobs/components/JobActionFooter.tsx
// Primäre/sekundäre Aktionen des Job-Detail-Screens (Start/Abschluss/
// Bearbeiten/abgeschlossen-Hinweis). Reine Präsentationskomponente: alle
// Handler, Berechtigungs-Booleans (canStart/canComplete/isDone) und der
// submitting-State kommen unverändert vom Screen — hier wird nichts davon
// neu berechnet oder verändert.

import { Button } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  canStart: boolean;
  canComplete: boolean;
  isDone: boolean;
  submitting: boolean;
  onStart: () => void;
  onComplete: () => void;
  showEdit: boolean;
  onEdit: () => void;
};

export function JobActionFooter({
  canStart,
  canComplete,
  isDone,
  submitting,
  onStart,
  onComplete,
  showEdit,
  onEdit,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.actions}>
      {canStart ? (
        <Button
          label="Job starten"
          icon="play"
          loading={submitting}
          disabled={submitting}
          onPress={onStart}
          accessibilityRole="button"
          accessibilityLabel="Job starten"
        />
      ) : null}

      {canComplete ? (
        <Button
          label="Job abschließen"
          icon="checkmark"
          loading={submitting}
          disabled={submitting}
          onPress={onComplete}
          accessibilityRole="button"
          accessibilityLabel="Job abschließen"
        />
      ) : null}

      {isDone ? (
        <View style={styles.doneInfo}>
          <Ionicons
            name="checkmark-circle"
            size={20}
            color={theme.colors.statusCompleted}
          />
          <Text style={styles.doneInfoText}>Dieser Job ist abgeschlossen.</Text>
        </View>
      ) : null}

      {showEdit ? (
        <Button
          label="Bearbeiten"
          variant="secondary"
          icon="create-outline"
          disabled={submitting}
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel="Job bearbeiten"
        />
      ) : null}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    actions: {
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
    doneInfo: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.statusCompletedBg,
      borderWidth: 1,
      borderColor: theme.colors.statusCompletedBorder,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    doneInfoText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.statusCompleted,
    },
  });
}
