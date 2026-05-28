// features/home/components/HomeHeader.tsx
// Header der Home/Dashboard-Seite: nur Begrüßung.
// Navigation läuft jetzt über die Bottom-Tabs (Profile-Tab statt Header-Button).
// Vollständig theme-aware (Light + Dark Mode).

import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useMemo } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

type HomeHeaderProps = {
  firstName: string;
  headerAnim: {
    opacity: Animated.Value;
    transform: { translateY: Animated.Value }[];
  };
};

export default function HomeHeader({ firstName, headerAnim }: HomeHeaderProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Animated.View style={[styles.header, headerAnim]}>
      <View style={styles.headerLeft}>
        <View style={styles.greetingRow}>
          <View style={styles.onlineDot} />
          <Text style={styles.greetingHint}>Willkommen zurück</Text>
        </View>

        <Text style={styles.greeting}>{firstName} 👋</Text>
        <Text style={styles.subtitle}>Hier ist dein aktueller Überblick</Text>
      </View>
    </Animated.View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      paddingTop: theme.spacing.xl,
      marginBottom: theme.spacing.xxl,
    },
    headerLeft: {
      flex: 1,
      gap: 4,
    },
    greetingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginBottom: 2,
    },
    onlineDot: {
      width: 6,
      height: 6,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusCompleted,
    },
    greetingHint: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wide,
    },
    greeting: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
      lineHeight: theme.typography.lineHeight.xxl,
    },
    subtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      marginTop: 2,
    },
  });
}
