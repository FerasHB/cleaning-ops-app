// components/ui/KPICard.tsx
// ─────────────────────────────────────────────────────────────────
// Dashboard-Statistik-Kachel (Key Performance Indicator).
// Großer Wert + kleines Label + optionaler farbiger linker Border.
// Wird im Admin-Dashboard in einem 2×2-Grid genutzt.
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
} from "react-native";

interface KPICardProps {
  /** Kleines Label oben (z.B. "Offene Jobs") */
  label: string;
  /** Großer Zahlenwert (z.B. "12") */
  value: string | number;
  /** Optionale Subzeile unter dem Wert (z.B. "+2 von gestern") */
  subtext?: string;
  /** Farbe des linken Borders und der Subtext-Farbe */
  accentColor?: string;
  /** Optionales Icon oben rechts in der Kachel */
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  /** Tap-Callback (z.B. um Filter zu setzen) */
  onPress?: () => void;
  /** Kachel ist aktiv/selektiert */
  active?: boolean;
  /** Zusätzlicher Container-Style */
  style?: ViewStyle;
}

export function KPICard({
  label,
  value,
  subtext,
  accentColor,
  icon,
  onPress,
  active = false,
  style,
}: KPICardProps) {
  const theme = useAppTheme();
  const styles = useMemo(
    () => createStyles(theme, accentColor),
    [theme, accentColor]
  );

  const Wrapper = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress
    ? { onPress, activeOpacity: 0.75 }
    : {};

  return (
    <Wrapper
      style={[styles.card, accentColor && styles.cardWithBorder, active && styles.cardActive, style]}
      {...wrapperProps}
    >
      {/* Label + Icon als echte Flex-Geschwister in einer Zeile — kein
          absolutes Icon-Overlay mehr (siehe Kopf-Kommentar): so bleibt
          garantiert Platz für beide, unabhängig von Textlänge/-richtung. */}
      <View style={styles.headerRow}>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        {icon && (
          <Ionicons
            name={icon}
            size={18}
            color={accentColor ?? theme.colors.primary}
            style={styles.icon}
          />
        )}
      </View>

      {/* Wert */}
      <Text style={styles.value}>{value}</Text>

      {/* Subtext */}
      {subtext && (
        <Text
          style={[styles.subtext, accentColor && { color: accentColor }]}
          numberOfLines={1}
        >
          {subtext}
        </Text>
      )}
    </Wrapper>
  );
}

function createStyles(
  theme: ReturnType<typeof useAppTheme>,
  accentColor?: string
) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.md,
      minHeight: 100,
      justifyContent: "flex-end",
      gap: 4,
      ...theme.shadows.sm,
    },
    cardWithBorder: {
      borderStartWidth: 4,
      borderStartColor: accentColor ?? theme.colors.primary,
    },
    cardActive: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderColor: accentColor ?? theme.colors.primary,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.xs,
    },
    icon: {
      flexShrink: 0,
    },
    label: {
      flex: 1,
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wider,
      textTransform: "uppercase",
    },
    value: {
      fontSize: theme.typography.size.xxl,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
      lineHeight: theme.typography.lineHeight.xxl,
    },
    subtext: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.medium,
      fontFamily: theme.typography.family.medium,
      color: theme.colors.outline,
    },
  });
}
