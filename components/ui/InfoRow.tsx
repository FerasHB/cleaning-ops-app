// components/ui/InfoRow.tsx
// ─────────────────────────────────────────────────────────────────
// Label + Wert-Zeile für Detail-Screens und Karten.
// Konsistentes Darstellungsmuster für strukturierte Informationen.
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

interface InfoRowProps {
  /** Kleines Label oben (z.B. "SERVICE", "ORT") */
  label: string;
  /** Haupt-Wert (z.B. "Büroreinigung", "Musterstraße 12") */
  value: string;
  /** Optionales Icon (Ionicons-Name) links neben dem Label */
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  /** Macht den Wert tappable (z.B. für Maps-Links) */
  onPress?: () => void;
  /** Trennlinie unter der Zeile anzeigen */
  divider?: boolean;
}

export function InfoRow({
  label,
  value,
  icon,
  onPress,
  divider = false,
}: InfoRowProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const content = (
    <View style={styles.row}>
      {/* Label-Zeile mit optionalem Icon */}
      <View style={styles.labelRow}>
        {icon && (
          <Ionicons
            name={icon}
            size={12}
            color={theme.colors.primary}
            style={styles.icon}
          />
        )}
        <Text style={styles.label}>{label.toUpperCase()}</Text>
      </View>

      {/* Wert-Zeile */}
      <Text style={[styles.value, onPress && styles.valueLink]} numberOfLines={2}>
        {value}
      </Text>

      {divider && <View style={styles.divider} />}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        {content}
      </TouchableOpacity>
    );
  }

  return content;
}

function createStyles(theme: ReturnType<typeof useAppTheme>) {
  return StyleSheet.create({
    row: {
      gap: 4,
    },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    icon: {
      marginTop: 1,
    },
    label: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    value: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.medium,
      fontFamily: theme.typography.family.medium,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
    },
    valueLink: {
      color: theme.colors.primary,
      textDecorationLine: "underline",
    },
    divider: {
      marginTop: theme.spacing.md,
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
    },
  });
}
