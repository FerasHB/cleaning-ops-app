// features/jobs/components/JobActionFooter.tsx
// Primäre/sekundäre Aktionen des Job-Detail-Screens (Start/Abschluss/
// Bearbeiten/abgeschlossen-Hinweis). Reine Präsentationskomponente: alle
// Handler, Berechtigungs-Booleans (canStart/canComplete/isDone) und der
// submitting-State kommen unverändert vom Screen — hier wird nichts davon
// neu berechnet oder verändert.
//
// FIXIERTE LEISTE: Diese Komponente liegt NICHT mehr im Scroll-Fluss, sondern
// als Geschwister der ScrollView am unteren Rand (siehe JobDetailScreen). Vorher
// stand sie am Ende eines langen Inhalts — hinter Foto-Raster und Kommentar-
// Verlauf. Bei einem Auftrag mit mehreren Fotos und Kommentaren musste ein
// Mitarbeiter im Feld mehrere Bildschirmhöhen scrollen, um „Starten“ oder
// „Abschließen“ überhaupt zu erreichen. Jetzt ist die wichtigste Aktion immer
// ohne Scrollen erreichbar.
//
// Die Leiste bringt ihr eigenes Chrome mit (Hintergrund, obere Trennlinie,
// Safe-Area-Abstand unten), damit der Screen selbst schlank bleibt. Gibt es
// nichts zu tun UND nichts zu melden, rendert sie gar nichts — dann bleibt der
// volle Bildschirm dem Inhalt.

import { Button } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
  const insets = useSafeAreaInsets();

  // Nichts anzuzeigen (z. B. Mitarbeiter ohne Zuweisung auf einem offenen
  // Auftrag) → keine leere Leiste am Bildschirmrand stehen lassen.
  const hasContent = canStart || canComplete || isDone || showEdit;
  if (!hasContent) {
    return null;
  }

  return (
    <View
      style={[
        styles.bar,
        // Home-Indikator / Gestennavigation freihalten. Der Screen selbst nutzt
        // edges={["top"]}, der untere Inset ist hier also noch offen.
        { paddingBottom: Math.max(insets.bottom, theme.spacing.md) },
      ]}
    >
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
    // Fixierte Leiste am unteren Rand — abgesetzt vom Inhalt darüber.
    bar: {
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.gutter,
      paddingTop: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      borderTopWidth: 1,
      borderTopColor: theme.colors.outlineVariant,
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
