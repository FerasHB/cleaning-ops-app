// Visible only for non-Production backends. On Staging, a normal tap opens
// current OTA and work-control diagnostics plus a manual update check.

import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import {
  deriveBackendEnvironmentLabel,
  shouldShowBackendEnvironmentIndicator,
} from "@/utils/backendEnvironment";
import { canReloadStagingUpdate, shouldEnableWorkTiming } from "@/utils/workTimingGate";
import {
  getWorkTimingTrace,
  getWorkUiDiagnostic,
  subscribeWorkTiming,
} from "@/utils/workTiming";
import { nativeApplicationVersion, nativeBuildVersion } from "expo-application";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import React, { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type UpdateStatus = "idle" | "checking" | "current" | "downloaded" | "error" | "blocked";

const UPDATE_LABELS: Record<UpdateStatus, string> = {
  idle: "",
  checking: "Update wird gesucht …",
  current: "Kein Update verfügbar.",
  downloaded: "Update heruntergeladen. Neustart erforderlich.",
  error: "Update-Prüfung fehlgeschlagen.",
  blocked: "Neustart blockiert: lokale Arbeitsaktion zuerst sicher synchronisieren.",
};

const bool = (value: boolean | undefined) => value == null ? "—" : value ? "true" : "false";

export function BackendEnvironmentBadge() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { workOperations, pendingActions, isSyncing } = useJobs();
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState(getWorkTimingTrace);
  const [workUi, setWorkUi] = useState(getWorkUiDiagnostic);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateError, setUpdateError] = useState("");
  const label = deriveBackendEnvironmentLabel(process.env.EXPO_PUBLIC_SUPABASE_URL);
  const diagnosticsEnabled = shouldEnableWorkTiming(__DEV__, label, Constants.expoConfig?.name);
  const mayReload = canReloadStagingUpdate({ workOperationCount: workOperations.length,
    pendingActionCount: pendingActions.length, isSyncing });
  const hasLocalWork = !mayReload;

  useEffect(() => subscribeWorkTiming(() => {
    setTrace(getWorkTimingTrace());
    setWorkUi(getWorkUiDiagnostic());
  }), []);

  if (!shouldShowBackendEnvironmentIndicator(label, __DEV__)) return null;

  const tone = label === "PROD"
    ? { bg: theme.colors.errorContainer, text: theme.colors.error }
    : label === "STAGING"
      ? { bg: theme.colors.statusOpenBg, text: theme.colors.statusOpen }
      : { bg: theme.colors.surfaceContainerHigh, text: theme.colors.onSurfaceVariant };

  const checkForUpdate = async () => {
    setUpdateStatus("checking");
    setUpdateError("");
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        setUpdateStatus("current");
        return;
      }
      const fetched = await Updates.fetchUpdateAsync();
      if (fetched.isNew || fetched.isRollBackToEmbedded) setUpdateStatus("downloaded");
      else {
        setUpdateError("Update konnte nicht geladen werden.");
        setUpdateStatus("error");
      }
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : "Unbekannter Fehler");
      setUpdateStatus("error");
    }
  };

  const reloadUpdate = async () => {
    if (!mayReload) {
      setUpdateStatus("blocked");
      return;
    }
    try {
      await Updates.reloadAsync();
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : "Unbekannter Fehler");
      setUpdateStatus("error");
    }
  };

  const canStart = workUi?.footerCanStart ?? workUi?.canStart;
  const canPause = workUi?.footerCanPause ?? workUi?.canPause;
  const canResume = workUi?.footerCanResume ?? workUi?.canResume;
  const canComplete = workUi?.footerCanComplete ?? workUi?.canComplete;
  const manifestMetadata = (Updates.manifest as { metadata?: Record<string, unknown> })?.metadata;
  const metadataSource = manifestMetadata?.gitCommitHash ?? manifestMetadata?.branchName;
  const sourceIdentifier = (Constants.expoConfig?.extra?.sourceRevision as string | undefined) ??
    (typeof metadataSource === "string" ? metadataSource : "unavailable");

  return <>
    <Pressable
      pointerEvents={diagnosticsEnabled ? "auto" : "none"}
      onPress={diagnosticsEnabled ? () => setOpen(true) : undefined}
      hitSlop={12}
      accessibilityRole={diagnosticsEnabled ? "button" : undefined}
      accessibilityLabel={diagnosticsEnabled ? "STAGING Diagnostik öffnen" : label}
      style={[styles.wrap, { backgroundColor: tone.bg, top: insets.top + 4 }]}
    >
      <Text style={[styles.badgeText, { color: tone.text }]}>{label}</Text>
    </Pressable>

    {diagnosticsEnabled ? <Modal visible={open} transparent animationType="fade"
      onRequestClose={() => setOpen(false)}>
      <View style={[styles.backdrop, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <View style={[styles.panel, { backgroundColor: theme.colors.surface }]}>
          <Text style={[styles.title, { color: theme.colors.onSurface }]}>Staging-Diagnostik</Text>
          <ScrollView style={styles.content}>
            <Text selectable style={[styles.mono, { color: theme.colors.onSurface }]}>
              Update ID: {Updates.updateId ?? "embedded"}{"\n"}
              Runtime: {Updates.runtimeVersion ?? "unknown"}{"\n"}
              Channel: {Updates.channel ?? "unknown"}{"\n"}
              Startquelle: {Updates.isEmbeddedLaunch ? "embedded" : "OTA"}{"\n"}
              App: {nativeApplicationVersion ?? Constants.expoConfig?.version ?? "unknown"}{"\n"}
              Build: {nativeBuildVersion ?? "unknown"}{"\n"}
              Source: {sourceIdentifier}{"\n\n"}
              State: {workUi?.state ?? "none"}{"\n"}
              Pending: {workUi?.pending ?? "none"}{"\n"}
              canStart: {bool(canStart)}{"\n"}
              canPause: {bool(canPause)}{"\n"}
              canResume: {bool(canResume)}{"\n"}
              canComplete: {bool(canComplete)}{"\n"}
              hasPending: {bool(workUi ? workUi.pending !== "none" : undefined)}{"\n"}
              reconciliationRequired: {bool(workUi ? workUi.blockReason === "reconciliation" : undefined)}{"\n"}
              isMutating: {bool(workUi?.isMutating)}{"\n"}
              isSyncing: {bool((workUi?.isSyncing ?? false) || isSyncing)}{"\n"}
              offline: {bool(workUi ? !workUi.online : undefined)}{"\n"}
              blockReason: {workUi?.blockReason ?? "none"}{"\n"}
              footerShown: {bool(workUi?.footerShown)}{"\n"}
              footerEnabled: {bool(workUi?.footerEnabled)}
            </Text>
            <Text selectable style={[styles.trace, { color: theme.colors.onSurface }]}>{trace}</Text>
          </ScrollView>

          {hasLocalWork ? <Text style={[styles.warning, { color: theme.colors.error }]}>
            Lokale Arbeitsaktion vorhanden. Update darf geladen werden; Neustart bleibt bis zur Synchronisierung gesperrt.
          </Text> : null}
          {UPDATE_LABELS[updateStatus] ? <Text style={[styles.status, { color: theme.colors.onSurfaceVariant }]}>
            {UPDATE_LABELS[updateStatus]}{updateError ? ` ${updateError}` : ""}
          </Text> : null}

          <View style={styles.actions}>
            <Pressable onPress={checkForUpdate} disabled={updateStatus === "checking"}
              accessibilityRole="button" style={[styles.action, { backgroundColor: theme.colors.primary }]}>
              <Text style={{ color: theme.colors.onPrimary }}>Nach Update suchen</Text>
            </Pressable>
            {updateStatus === "downloaded" || updateStatus === "blocked" ?
              <Pressable onPress={reloadUpdate} accessibilityRole="button"
                style={[styles.action, { backgroundColor: theme.colors.primary }]}>
                <Text style={{ color: theme.colors.onPrimary }}>Update neu laden</Text>
              </Pressable> : null}
            <Pressable onPress={() => setOpen(false)} accessibilityRole="button"
              style={[styles.action, { backgroundColor: theme.colors.surfaceContainerHigh }]}>
              <Text style={{ color: theme.colors.onSurface }}>Schließen</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal> : null}
  </>;
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute", right: 6, zIndex: 9999, elevation: 24,
    paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, opacity: 0.94,
  },
  badgeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  backdrop: { flex: 1, justifyContent: "center", paddingHorizontal: 18,
    backgroundColor: "rgba(0,0,0,0.55)" },
  panel: { borderRadius: 12, padding: 16, maxHeight: "92%", gap: 10 },
  title: { fontSize: 18, fontWeight: "700" },
  content: { maxHeight: 440 },
  mono: { fontFamily: "monospace", fontSize: 12, lineHeight: 18 },
  trace: { marginTop: 14, fontFamily: "monospace", fontSize: 11, lineHeight: 17 },
  warning: { fontSize: 12, lineHeight: 17, fontWeight: "600" },
  status: { fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 },
  action: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
});
