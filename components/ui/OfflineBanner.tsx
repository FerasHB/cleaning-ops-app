// components/ui/OfflineBanner.tsx
// ─────────────────────────────────────────────────────────────────
// Save-Status-Anzeige für Außendienst-Mitarbeiter.
// Zeigt in einfacher Sprache, ob Änderungen gespeichert sind.
// Liest nur vorhandene Offline-/Queue-Werte aus dem JobContext —
// keine eigene Sync-Logik. Sichtbare Texte bewusst ohne
// Fachbegriffe (kein "Sync", "Queue", "pending").
// ─────────────────────────────────────────────────────────────────

import { useJobs } from "@/context/JobContext";
import type { PendingJobAction } from "@/services/offline/jobs.queue";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type SaveState = "offline" | "saving" | "error" | "pending" | "saved";

function pendingLabel(count: number): string {
  return count === 1 ? "1 Änderung wartet" : `${count} Änderungen warten`;
}

function actionLabel(action: PendingJobAction): string {
  switch (action.type) {
    case "start_job":
      return "Job starten wartet";
    case "complete_job":
      return "Job abschließen wartet";
    default:
      return "Änderung wartet";
  }
}

export function OfflineBanner() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const {
    jobs,
    online,
    pendingCount,
    pendingActions,
    isSyncing,
    syncFailed,
    retrySync,
  } = useJobs();

  const [detailsOpen, setDetailsOpen] = useState(false);

  const state: SaveState = !online
    ? "offline"
    : isSyncing
      ? "saving"
      : syncFailed
        ? "error"
        : pendingCount > 0
          ? "pending"
          : "saved";

  // Farb-/Icon-/Text-Konfiguration je Zustand (alles über Theme-Tokens)
  const config = {
    offline: {
      icon: "cloud-offline-outline" as const,
      fg: theme.colors.statusOpen,
      bg: theme.colors.statusOpenBg,
      border: theme.colors.statusOpenBorder,
      title: "Kein Internet — Änderungen gehen nicht verloren",
    },
    saving: {
      icon: "sync-outline" as const,
      fg: theme.colors.statusInProgress,
      bg: theme.colors.statusInProgressBg,
      border: theme.colors.statusInProgressBorder,
      title: "Änderungen werden gespeichert…",
    },
    error: {
      icon: "alert-circle-outline" as const,
      fg: theme.colors.error,
      bg: theme.colors.errorContainer,
      border: theme.colors.error,
      title: "Änderungen konnten nicht gespeichert werden",
    },
    pending: {
      icon: "time-outline" as const,
      fg: theme.colors.statusOpen,
      bg: theme.colors.statusOpenBg,
      border: theme.colors.statusOpenBorder,
      title: pendingLabel(pendingCount),
    },
    saved: {
      icon: "checkmark-circle-outline" as const,
      fg: theme.colors.statusCompleted,
      bg: theme.colors.statusCompletedBg,
      border: theme.colors.statusCompletedBorder,
      title: "Alles gespeichert",
    },
  }[state];

  // Zweite Zeile: offline + wartende Änderungen → Anzahl zeigen
  const subtitle =
    state === "offline" && pendingCount > 0 ? pendingLabel(pendingCount) : null;

  const showDetails = pendingCount > 0;
  const showRetry = state === "error";

  return (
    <>
      <View
        style={[
          styles.banner,
          { backgroundColor: config.bg, borderColor: config.border },
        ]}
      >
        <View style={styles.left}>
          <Ionicons name={config.icon} size={18} color={config.fg} />
          <View style={styles.textBlock}>
            <Text
              style={[styles.title, { color: config.fg }]}
              numberOfLines={2}
            >
              {config.title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle}>{subtitle}</Text>
            ) : null}
          </View>
        </View>

        {showRetry ? (
          <TouchableOpacity
            onPress={retrySync}
            style={[styles.action, { borderColor: config.border }]}
            activeOpacity={0.75}
          >
            <Ionicons name="refresh-outline" size={14} color={config.fg} />
            <Text style={[styles.actionLabel, { color: config.fg }]}>
              Erneut versuchen
            </Text>
          </TouchableOpacity>
        ) : showDetails ? (
          <TouchableOpacity
            onPress={() => setDetailsOpen(true)}
            style={[styles.action, { borderColor: config.border }]}
            activeOpacity={0.75}
          >
            <Text style={[styles.actionLabel, { color: config.fg }]}>
              Details
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <Modal
        visible={detailsOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setDetailsOpen(false)}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => setDetailsOpen(false)}
        >
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />

            <Text style={styles.sheetTitle}>
              {pendingCount > 0
                ? pendingLabel(pendingCount)
                : "Alles gespeichert"}
            </Text>
            <Text style={styles.sheetHint}>
              {online
                ? "Deine Änderungen werden automatisch gespeichert."
                : "Sobald du wieder Internet hast, werden die Änderungen gespeichert."}
            </Text>

            <ScrollView style={styles.sheetList}>
              {pendingActions.map((action) => {
                const job = jobs.find((j) => j.id === action.jobId);
                return (
                  <View key={action.id} style={styles.sheetRow}>
                    <Ionicons
                      name="time-outline"
                      size={16}
                      color={theme.colors.statusOpen}
                    />
                    <View style={styles.sheetRowText}>
                      <Text style={styles.sheetRowLabel}>
                        {actionLabel(action)}
                      </Text>
                      {job ? (
                        <Text style={styles.sheetRowSub} numberOfLines={1}>
                          {job.customerName}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </ScrollView>

            <TouchableOpacity
              onPress={() => setDetailsOpen(false)}
              style={styles.sheetClose}
              activeOpacity={0.8}
            >
              <Text style={styles.sheetCloseLabel}>Schließen</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function createStyles(theme: ReturnType<typeof useAppTheme>) {
  return StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      borderWidth: 1,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 10,
      marginBottom: theme.spacing.sm,
    },
    left: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      flex: 1,
    },
    textBlock: {
      gap: 2,
      flex: 1,
    },
    title: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    subtitle: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    action: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderRadius: theme.radius.sm,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    actionLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },

    // ── Bottom Sheet
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: theme.radius.xl,
      borderTopRightRadius: theme.radius.xl,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.xl,
      gap: theme.spacing.sm,
      maxHeight: "70%",
    },
    sheetHandle: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.outlineVariant,
      marginBottom: theme.spacing.sm,
    },
    sheetTitle: {
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },
    sheetHint: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      marginBottom: theme.spacing.xs,
    },
    sheetList: {
      flexGrow: 0,
    },
    sheetRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
    },
    sheetRowText: {
      flex: 1,
      gap: 2,
    },
    sheetRowLabel: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    sheetRowSub: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    sheetClose: {
      marginTop: theme.spacing.md,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    sheetCloseLabel: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
  });
}
