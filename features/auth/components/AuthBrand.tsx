// features/auth/components/AuthBrand.tsx
// Gemeinsamer Logo + App-Name Block für alle Auth-Screens.

import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

interface AuthBrandProps {
  /** Optionale Unterzeile unter dem App-Namen */
  tagline?: string;
  /** Icon-Größe im Logo-Block (Standard: 28) */
  iconSize?: number;
}

export function AuthBrand({ tagline, iconSize = 28 }: AuthBrandProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.wrapper}>
      {/* Logo-Box */}
      <View style={styles.logoBox}>
        <Ionicons name="sparkles" size={iconSize} color={theme.colors.onPrimaryContainer} />
      </View>

      {/* Texte */}
      <View style={styles.textBlock}>
        <Text style={styles.appName}>CleanOps</Text>
        {tagline ? <Text style={styles.tagline}>{tagline}</Text> : null}
      </View>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    wrapper: {
      alignItems: "center",
      gap: theme.spacing.md,
    },
    logoBox: {
      width: 64,
      height: 64,
      borderRadius: theme.radius.xl,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
    },
    textBlock: {
      alignItems: "center",
      gap: 4,
    },
    appName: {
      fontSize: theme.typography.size.xl,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    tagline: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
