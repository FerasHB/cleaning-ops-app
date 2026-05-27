// components/ui/InitialsAvatar.tsx
// ─────────────────────────────────────────────────────────────────
// Avatar aus den Initialen eines Namens.
// Kein Profilbild nötig — die ersten zwei Buchstaben des Namens
// werden auf einer farbigen Fläche angezeigt.
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

interface InitialsAvatarProps {
  /** Vollständiger Name ("Max Mustermann" → "MM") */
  name: string;
  /** Größe des Avatars in px (Standard: 40) */
  size?: number;
  /** Font-Größe der Initialen (Standard: automatisch) */
  fontSize?: number;
}

/** Extrahiert max. 2 Initialen aus einem Namen */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (
    parts[0].charAt(0).toUpperCase() +
    parts[parts.length - 1].charAt(0).toUpperCase()
  );
}

/**
 * Deterministisch eine Akzentfarbe aus dem Namen ableiten.
 * Damit hat jeder Mitarbeiter immer die gleiche Avatar-Farbe.
 */
function getAvatarColor(name: string, isDark: boolean): string {
  const COLORS_DARK = [
    '#4D8EFF', // Blau
    '#22C55E', // Grün
    '#F59E0B', // Amber
    '#A855F7', // Lila
    '#EF4444', // Rot
    '#14B8A6', // Teal
    '#F97316', // Orange
    '#6366F1', // Indigo
  ];
  const COLORS_LIGHT = [
    '#2563EB',
    '#16A34A',
    '#D97706',
    '#9333EA',
    '#DC2626',
    '#0D9488',
    '#EA580C',
    '#4F46E5',
  ];
  const palette = isDark ? COLORS_DARK : COLORS_LIGHT;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return palette[Math.abs(hash) % palette.length];
}

export function InitialsAvatar({ name, size = 40, fontSize }: InitialsAvatarProps) {
  const theme = useAppTheme();
  const initials = useMemo(() => getInitials(name), [name]);
  const bgColor = useMemo(
    () => getAvatarColor(name, theme.isDark),
    [name, theme.isDark]
  );
  const computedFontSize = fontSize ?? Math.round(size * 0.38);

  return (
    <View
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bgColor + (theme.isDark ? '26' : '22'), // ~15% opacity bg
          borderWidth: 1,
          borderColor: bgColor + '55',
        },
      ]}
    >
      <Text
        style={[
          styles.text,
          {
            fontSize: computedFontSize,
            color: theme.isDark ? theme.colors.onSurface : bgColor,
          },
        ]}
      >
        {initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  text: {
    fontWeight: "700",
    letterSpacing: 0.5,
  },
});
