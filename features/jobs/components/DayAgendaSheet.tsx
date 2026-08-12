// features/jobs/components/DayAgendaSheet.tsx
// ─────────────────────────────────────────────────────────────────
// Tages-Agenda des ausgewählten Kalendertags als Bottom-Sheet.
//
// WARUM ein Sheet und keine Liste unter dem Kalender: der Monat soll die
// volle Fläche behalten. Eine dauerhafte Liste darunter würde das Raster auf
// wenige Zentimeter drücken — genau die Bauform, die dieser Screen ersetzt.
//
// KEINE neue Abhängigkeit: dasselbe Muster wie `components/ui/ActionMenuSheet`
// (React-Native-`Modal` + Backdrop-Pressable). Kein Gesten-Sheet, kein
// Carousel, kein `GestureHandlerRootView` — das Projekt hat keinen
// Gesture-Root montiert, ein Gesten-Sheet wäre eine Infrastruktur-Änderung.
//
// Hier steht die VOLLSTÄNDIGE Tagesliste (die Zelle im Raster kürzt, dieses
// Sheet nie) mit den gewohnten JobCards: Zeit, Kunde, Ort, Service,
// kanonischer Status — und den unveränderten Start/Abschließen-Aktionen.
// ─────────────────────────────────────────────────────────────────

import JobCard from "@/components/JobCard";
import { ErrorBanner } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { formatDayLabel } from "@/utils/calendarMonth";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type Props = {
  visible: boolean;
  /** Ausgewählter Tag als "YYYY-MM-DD". */
  dayKey: string;
  /** Vollständige, nach Uhrzeit sortierte Tagesliste. */
  jobs: Job[];
  onClose: () => void;
  onOpenJob: (jobId: string) => void;
  /**
   * Darf dieser Nutzer für diesen Job Start/Abschließen auslösen?
   * Die Entscheidung bleibt beim Screen (`canRunJobActions`) — das Sheet
   * baut bewusst KEIN eigenes Gating.
   */
  canRunActions: (job: Job) => boolean;
  onStart: (jobId: string) => void | Promise<void>;
  onComplete: (jobId: string) => void | Promise<void>;
  /** Fehler der letzten Aktion — im Sheet sichtbar, weil er hier entsteht. */
  errorMessage?: string;
  onDismissError?: () => void;
  /**
   * Mitarbeiter-Zeile auf jeder Karte zeigen (`JobCard.showEmployeeName`).
   * Default `false` — die bestehende Mitarbeiter-Ansicht bleibt unverändert.
   * Für den Admin-Kalender: Admin sieht IMMER, wer zugewiesen ist.
   */
  showEmployeeName?: boolean;
  /**
   * Text für einen leeren Tag. Default ist der bisherige Mitarbeiter-Text
   * ("dir keine Aufträge zugewiesen") — unverändert, wenn nicht übergeben.
   */
  emptyMessage?: string;
};

export function DayAgendaSheet({
  visible,
  dayKey,
  jobs,
  onClose,
  onOpenJob,
  canRunActions,
  onStart,
  onComplete,
  errorMessage,
  onDismissError,
  showEmployeeName = false,
  emptyMessage = "Für diesen Tag sind dir keine Aufträge zugewiesen.",
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const dayLabel = useMemo(() => (dayKey ? formatDayLabel(dayKey) : ""), [dayKey]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Innerer Pressable fängt Taps ab, damit das Sheet beim Tippen auf
            den Inhalt nicht zugeht. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.grabber} />

          <View style={styles.headerRow}>
            <View style={styles.headerText}>
              <Text style={styles.title} numberOfLines={2}>
                {dayLabel}
              </Text>
              <Text style={styles.subtitle}>
                {jobs.length === 1 ? "1 Auftrag" : `${jobs.length} Aufträge`}
              </Text>
            </View>

            <TouchableOpacity
              style={styles.closeBtn}
              onPress={onClose}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Tagesansicht schließen"
            >
              <Ionicons name="close" size={20} color={theme.colors.onSurfaceVariant} />
            </TouchableOpacity>
          </View>

          {errorMessage ? (
            <ErrorBanner message={errorMessage} onDismiss={onDismissError} />
          ) : null}

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Kann eintreten, wenn der letzte Auftrag des Tages bei offenem
                Sheet per Realtime verschwindet — dann hier eine ruhige Zeile
                statt einer leeren Fläche. */}
            {jobs.length === 0 ? (
              <Text style={styles.emptyHint}>{emptyMessage}</Text>
            ) : null}

            {jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onPress={() => onOpenJob(job.id)}
                showEmployeeName={showEmployeeName}
                // Start/Abschließen laufen unverändert über den JobContext;
                // das Gating kommt vom Screen (canRunJobActions).
                onStart={canRunActions(job) ? () => onStart(job.id) : undefined}
                onComplete={canRunActions(job) ? () => onComplete(job.id) : undefined}
              />
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "flex-end",
    },
    sheet: {
      // Deckelt die Höhe: der Kalender bleibt oben sichtbar, das Sheet wirkt
      // als Ebene darüber statt als Vollbild-Wechsel.
      maxHeight: "78%",
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: theme.radius.lg,
      borderTopRightRadius: theme.radius.lg,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    grabber: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.colors.outlineVariant,
    },

    headerRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.sm,
    },
    headerText: {
      flex: 1,
    },
    title: {
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    subtitle: {
      marginTop: 2,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: theme.radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surfaceContainerHigh,
    },

    scroll: {
      flexGrow: 0,
    },
    scrollContent: {
      gap: theme.spacing.sm,
      paddingBottom: theme.spacing.xs,
    },
    emptyHint: {
      paddingVertical: theme.spacing.md,
      textAlign: "center",
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
