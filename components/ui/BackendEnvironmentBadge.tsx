// components/ui/BackendEnvironmentBadge.tsx
// Rein beobachtender Hinweis, welches Supabase-Backend diese Laufzeit gerade
// verwendet (PROD/STAGING/UNKNOWN) — verhindert stille Umgebungs-
// Verwechslungen bei internen/QA-Builds. Ableitungs-/Sichtbarkeitslogik in
// utils/backendEnvironment.ts (dort auch die Begründung, warum das NICHT an
// APP_VARIANT/IS_DEV hängt).
//
// KEIN Effekt auf App-Verhalten: reines Text-Overlay, pointerEvents="none"
// (blockiert nie Taps/Routing), rendert null sobald
// shouldShowBackendEnvironmentIndicator() false liefert — in jedem echten
// Produktions-Release also immer null. Zeigt niemals den anon-/publishable-
// Key oder die volle URL, ausschließlich das Label.

import { useAppTheme } from "@/hooks/useAppTheme";
import {
  deriveBackendEnvironmentLabel,
  shouldShowBackendEnvironmentIndicator,
} from "@/utils/backendEnvironment";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function BackendEnvironmentBadge() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const label = deriveBackendEnvironmentLabel(
    process.env.EXPO_PUBLIC_SUPABASE_URL,
  );

  if (!shouldShowBackendEnvironmentIndicator(label, __DEV__)) {
    return null;
  }

  const tone =
    label === "PROD"
      ? { bg: theme.colors.errorContainer, text: theme.colors.error }
      : label === "STAGING"
        ? { bg: theme.colors.statusOpenBg, text: theme.colors.statusOpen }
        : {
            bg: theme.colors.surfaceContainerHigh,
            text: theme.colors.onSurfaceVariant,
          };

  return (
    <View
      pointerEvents="none"
      style={[
        styles.wrap,
        { backgroundColor: tone.bg, top: insets.top + 4 },
      ]}
    >
      <Text style={[styles.text, { color: tone.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    right: 6,
    zIndex: 9999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    opacity: 0.92,
  },
  text: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
});
