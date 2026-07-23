// features/auth/components/AuthBrand.tsx
// Gemeinsamer Logo + App-Name Block für alle Auth-Screens.

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useMemo } from "react";
import { Image, StyleSheet, Text, View } from "react-native";

interface AuthBrandProps {
  /** Optionale Unterzeile unter dem App-Namen */
  tagline?: string;
}

export function AuthBrand({ tagline }: AuthBrandProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.wrapper}>
      {/* App Logo */}
      <Image
        source={require("../../../assets/source/taskops-logo.png")}
        style={styles.logo}
        resizeMode="contain"
      />

      <View style={styles.textBlock}>
        <Text style={styles.appName}>TaskOps Manager</Text>
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

    logo: {
      width: 130,
      height: 130,
      borderRadius: 22,
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
