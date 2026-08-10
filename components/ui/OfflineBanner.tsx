// components/ui/OfflineBanner.tsx
// ─────────────────────────────────────────────────────────────────
// Save-Status-Anzeige für Außendienst-Mitarbeiter.
// Zeigt in einfacher Sprache, ob Änderungen gespeichert sind.
// Liest nur vorhandene Offline-/Queue-Werte aus dem JobContext —
// keine eigene Sync-Logik. Sichtbare Texte bewusst ohne
// Fachbegriffe (kein "Sync", "Queue", "pending").
//
// NUR AUSSAGEKRÄFTIGE ZUSTÄNDE: Das Banner erscheint ausschließlich bei
// offline / wartenden Änderungen / Speichern / Fehler. Der Normalfall
// ("saved") zeigt NICHTS.
//
// Vorher lief nach JEDER erfolgreichen Speicherung ein „Alles gespeichert"-
// Banner an: es montierte sich in den Layout-Fluss (Inhalt darunter sprang
// ~46 px nach unten), blieb 1500 ms stehen und demontierte sich dann wieder
// (Inhalt sprang zurück). Zwei Layout-Sprünge pro Aktion für eine Information,
// die niemand braucht — der Normalzustand ist genau das, was der Nutzer
// ohnehin erwartet. Es gab zusätzlich einen dauerhaften „Online"-Badge im
// Header (SaveStatusBadge), der dasselbe „saved" anders benannte und beim
// Statuswechsel die Begrüßung neu umbrach; er ist ersatzlos entfallen.
//
// Beim Übergang zurück nach "saved" blendet das Banner den ZULETZT
// aussagekräftigen Zustand sauber aus (displayState), statt vorher noch auf
// Grün umzuspringen.
// ─────────────────────────────────────────────────────────────────

import { useJobs } from "@/context/JobContext";
import type { PendingJobAction } from "@/services/offline/jobs.queue";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type SaveState = "offline" | "saving" | "error" | "pending" | "saved";

// Zustände, die dem Nutzer tatsächlich etwas sagen. "saved" ist der stille
// Normalfall und wird bewusst NICHT dargestellt.
type InformativeSaveState = Exclude<SaveState, "saved">;

// Leitet den Speicher-/Verbindungszustand aus den Offline-/Queue-Werten ab.
// Unverändert — die Queue-/Sync-Logik selbst liegt im JobContext, hier wird
// sie nur gelesen und in eine Darstellung übersetzt.
function deriveSaveState(args: {
  online: boolean;
  isSyncing: boolean;
  syncFailed: boolean;
  pendingCount: number;
}): SaveState {
  const { online, isSyncing, syncFailed, pendingCount } = args;
  if (!online) return "offline";
  if (isSyncing) return "saving";
  if (syncFailed) return "error";
  if (pendingCount > 0) return "pending";
  return "saved";
}

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

// Für Screenreader: derselbe Text, der auch sichtbar im Banner steht (siehe
// `config.title` unten) — als eigene Funktion, damit die Animations-Effect
// den Text kennt, ohne `config` (das von der aktuellen Theme-Farbe abhängt)
// vorziehen zu müssen.
function stateAnnouncement(
  state: InformativeSaveState,
  pendingCount: number,
): string {
  switch (state) {
    case "offline":
      return "Kein Internet. Änderungen gehen nicht verloren.";
    case "saving":
      return "Änderungen werden gespeichert.";
    case "error":
      return "Änderungen konnten nicht gespeichert werden.";
    case "pending":
      return pendingLabel(pendingCount);
  }
}

// ── Animation: Timing für das Ein-/Ausblenden des Banners ─────────────────
const ENTER_DURATION_MS = 220;
const EXIT_DURATION_MS = 250;

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

  const state = deriveSaveState({ online, isSyncing, syncFailed, pendingCount });
  const informativeState: InformativeSaveState | null =
    state === "saved" ? null : state;

  // ── Animation: sanftes Ein-/Ausblenden bei Statuswechsel ──────────────
  // Banner ist gemountet, solange es einen aussagekräftigen Zustand gibt ODER
  // die Ausblend-Animation noch läuft. Erreicht der Zustand "saved", blendet
  // es SOFORT aus (kein Halten, keine Erfolgsmeldung) und demontiert sich.
  const [mounted, setMounted] = useState(informativeState !== null);
  // Zuletzt dargestellter aussagekräftiger Zustand. Bleibt während der
  // Ausblend-Animation stehen, damit z. B. „Änderungen werden gespeichert…"
  // ruhig ausblendet, statt vorher noch auf einen Erfolgszustand umzuspringen.
  const [displayState, setDisplayState] = useState<InformativeSaveState | null>(
    informativeState,
  );
  const animProgress = useRef(
    new Animated.Value(informativeState !== null ? 1 : 0),
  ).current;
  const runningAnim = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    runningAnim.current?.stop();

    if (informativeState !== null) {
      // iOS: VoiceOver bekommt Statuswechsel nicht zuverlässig über
      // accessibilityRole="alert" bei Prop-Updates mit — explizit ansagen.
      // Android: übernimmt accessibilityLiveRegion="polite" auf dem Banner
      // selbst (siehe unten), daher hier nicht doppelt ansagen.
      // Der Normalfall ("saved") wird bewusst NICHT angesagt — es gibt nichts
      // zu melden, und eine Ansage bei jedem gespeicherten Job wäre Lärm.
      if (Platform.OS === "ios") {
        AccessibilityInfo.announceForAccessibility(
          stateAnnouncement(informativeState, pendingCount),
        );
      }

      setDisplayState(informativeState);
      setMounted(true);
      runningAnim.current = Animated.timing(animProgress, {
        toValue: 1,
        duration: ENTER_DURATION_MS,
        useNativeDriver: true,
      });
      runningAnim.current.start();
    } else {
      runningAnim.current = Animated.timing(animProgress, {
        toValue: 0,
        duration: EXIT_DURATION_MS,
        useNativeDriver: true,
      });
      runningAnim.current.start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // animProgress ist ein stabiler Ref-Wert, absichtlich nicht in den Deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [informativeState, pendingCount]);

  // Läuft eine Animation noch, wenn die Komponente verschwindet (z. B. Navi-
  // gation weg vom Screen mitten im Ausblenden) — sauber stoppen.
  useEffect(() => {
    return () => {
      runningAnim.current?.stop();
    };
  }, []);

  // Nichts zu melden → nichts rendern. Kein Platzhalter, keine Erfolgsmeldung.
  if (!mounted || !displayState) return null;

  const animatedStyle = {
    opacity: animProgress,
    transform: [
      {
        translateY: animProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [-12, 0],
        }),
      },
    ],
  };

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
  }[displayState];

  // Zweite Zeile: offline + wartende Änderungen → Anzahl zeigen
  const subtitle =
    displayState === "offline" && pendingCount > 0
      ? pendingLabel(pendingCount)
      : null;

  const showDetails = pendingCount > 0;
  const showRetry = displayState === "error";

  return (
    <>
      <Animated.View
        style={[
          styles.banner,
          { backgroundColor: config.bg, borderColor: config.border },
          animatedStyle,
        ]}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
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
      </Animated.View>

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

            {/* Das Sheet ist nur bei wartenden Änderungen erreichbar. Fällt der
                Zähler auf 0, während es offen ist, bleibt eine sachliche
                Angabe stehen — keine Erfolgsmeldung. */}
            <Text style={styles.sheetTitle}>
              {pendingCount > 0
                ? pendingLabel(pendingCount)
                : "Keine wartenden Änderungen"}
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
