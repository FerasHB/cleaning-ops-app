// components/ui/SkeletonCard.tsx
// ─────────────────────────────────────────────────────────────────
// Animierter Lade-Platzhalter für Job-Karten.
// Ersetzt den ActivityIndicator-Spinner beim ersten App-Load.
// Pulsierendes Opacity-Animation (kein Gradient-Library nötig).
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

interface SkeletonCardProps {
  /** Anzahl der Skeleton-Zeilen im Card-Body (Standard: 3) */
  lines?: number;
}

function SkeletonLine({
  width,
  height = 12,
  style,
}: {
  width: string | number;
  height?: number;
  style?: object;
}) {
  const theme = useAppTheme();
  return (
    <View
      style={[
        {
          width,
          height,
          borderRadius: 6,
          backgroundColor: theme.colors.surfaceContainerHigh,
        },
        style,
      ]}
    />
  );
}

export function SkeletonCard({ lines = 3 }: SkeletonCardProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.4,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View style={[styles.card, { opacity }]}>
      {/* Header-Zeile: Titel + Badge-Platzhalter */}
      <View style={styles.headerRow}>
        <SkeletonLine width="55%" height={14} />
        <SkeletonLine width={60} height={24} style={{ borderRadius: 12 }} />
      </View>

      {/* Info-Zeilen */}
      {Array.from({ length: lines }).map((_, i) => (
        <View key={i} style={styles.lineGroup}>
          <SkeletonLine width="30%" height={10} />
          <SkeletonLine width={i === 0 ? "80%" : i === 1 ? "65%" : "50%"} />
        </View>
      ))}

      {/* Button-Platzhalter */}
      <View style={styles.buttonRow}>
        <SkeletonLine width="48%" height={40} style={{ borderRadius: 10 }} />
        <SkeletonLine width="48%" height={40} style={{ borderRadius: 10 }} />
      </View>
    </Animated.View>
  );
}

function createStyles(theme: ReturnType<typeof useAppTheme>) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.md,
      gap: theme.spacing.md,
      // Dark Mode: kein Shadow nötig
      ...theme.shadows.sm,
    },
    headerRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    lineGroup: {
      gap: 6,
    },
    buttonRow: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
  });
}
