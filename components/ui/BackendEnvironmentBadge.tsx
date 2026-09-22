// components/ui/BackendEnvironmentBadge.tsx
// Rein beobachtender Hinweis, welches Supabase-Backend diese Laufzeit gerade
// verwendet (PROD/STAGING/UNKNOWN) — verhindert stille Umgebungs-
// Verwechslungen bei internen/QA-Builds. Ableitungs-/Sichtbarkeitslogik in
// utils/backendEnvironment.ts (dort auch die Begründung, warum das NICHT an
// APP_VARIANT/IS_DEV hängt).
//
// Long-press opens work timing only in Development/Staging builds. The
// production release renders no badge or diagnostic modal. Neither surface
// shows keys or the backend URL.

import { useAppTheme } from "@/hooks/useAppTheme";
import {
  deriveBackendEnvironmentLabel,
  shouldShowBackendEnvironmentIndicator,
} from "@/utils/backendEnvironment";
import { shouldEnableWorkTiming } from "@/utils/workTimingGate";
import { getWorkTimingTrace, subscribeWorkTiming } from "@/utils/workTiming";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import React, { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function BackendEnvironmentBadge() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState(getWorkTimingTrace);
  const label = deriveBackendEnvironmentLabel(
    process.env.EXPO_PUBLIC_SUPABASE_URL,
  );
  const diagnosticsEnabled = shouldEnableWorkTiming(__DEV__, label, Constants.expoConfig?.name);
  useEffect(() => subscribeWorkTiming(() => setTrace(getWorkTimingTrace())), []);

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

  return <>
    <Pressable
      pointerEvents={diagnosticsEnabled ? "auto" : "none"}
      onLongPress={diagnosticsEnabled ? () => setOpen(true) : undefined}
      delayLongPress={600}
      accessibilityLabel={diagnosticsEnabled ? `${label} work timing, long press to open` : label}
      style={[styles.wrap, { backgroundColor: tone.bg, top: insets.top + 4 }]}
    >
      <Text style={[styles.text, { color: tone.text }]}>{label}</Text>
    </Pressable>
    {diagnosticsEnabled ? <Modal visible={open} transparent animationType="fade"
      onRequestClose={() => setOpen(false)}>
      <View style={[styles.backdrop, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <View style={[styles.panel, { backgroundColor: theme.colors.surface }]}>
          <Text style={[styles.title, { color: theme.colors.onSurface }]}>Staging work timing</Text>
          <Text style={[styles.meta, { color: theme.colors.onSurfaceVariant }]}>
            Update: {Updates.updateId ?? "embedded"}{"\n"}
            Runtime: {Updates.runtimeVersion ?? "unknown"}{"\n"}
            Channel: {Updates.channel ?? "unknown"}
          </Text>
          <ScrollView style={styles.traceScroll}>
            <Text selectable style={[styles.trace, { color: theme.colors.onSurface }]}>{trace}</Text>
          </ScrollView>
          <Text style={[styles.meta, { color: theme.colors.onSurfaceVariant }]}>
            Hold trace text to copy, or take a screenshot.
          </Text>
          <Pressable onPress={() => setOpen(false)} accessibilityRole="button"
            style={[styles.close, { backgroundColor: theme.colors.primary }]}>
            <Text style={{ color: theme.colors.onPrimary }}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal> : null}
  </>;
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
  backdrop: { flex: 1, justifyContent: "center", paddingHorizontal: 18,
    backgroundColor: "rgba(0,0,0,0.55)" },
  panel: { borderRadius: 12, padding: 16, maxHeight: "90%", gap: 12 },
  title: { fontSize: 18, fontWeight: "700" },
  meta: { fontSize: 12 },
  traceScroll: { maxHeight: 420 },
  trace: { fontFamily: "monospace", fontSize: 12, lineHeight: 18 },
  close: { alignSelf: "flex-end", paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 },
});
