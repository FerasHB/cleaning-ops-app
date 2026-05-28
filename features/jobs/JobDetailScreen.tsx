// features/jobs/JobDetailScreen.tsx
// Detail-Ansicht eines Jobs mit allen Infos und kontextabhängigen Aktionen.
// Aktionen (Start/Complete/Edit) nutzen weiter den bestehenden JobContext —
// keine Änderungen an Supabase-/Offline-Sync-Logik.

import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  InfoRow,
  LoadingScreen,
  OfflineBanner,
  StatusBadge,
} from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  Linking,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";

// ─────────────────────────────────────────────
// Datums-/Zeit-Formatierung
// ─────────────────────────────────────────────
function formatDateTime(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;

  const datePart = date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${datePart} um ${timePart}`;
}

// ─────────────────────────────────────────────
// JobDetailScreen
// ─────────────────────────────────────────────
export default function JobDetailScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { id } = useLocalSearchParams<{ id: string }>();
  const { role } = useAuth();
  const { jobs, startJob, completeJob, loading } = useJobs();

  const job = useMemo(() => jobs.find((j) => j.id === id), [jobs, id]);

  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");

  const isAdmin = role === "admin";

  // ── Loading-Zustand (JobContext lädt noch)
  if (loading) {
    return <LoadingScreen />;
  }

  // ── Job nicht gefunden
  if (!job) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <StatusBar
          barStyle={theme.isDark ? "light-content" : "dark-content"}
          backgroundColor={theme.colors.background}
        />
        <AppHeader title="Job-Details" showBack />
        <View style={styles.emptyWrap}>
          <EmptyState
            title="Job nicht gefunden"
            message="Der gesuchte Job ist nicht (mehr) verfügbar."
            icon="alert-circle-outline"
            ctaLabel="Zurück"
            onCta={() => router.back()}
          />
        </View>
      </SafeAreaView>
    );
  }

  // ── Aktionen (nutzen weiter JobContext → Offline-Sync bleibt intakt)
  const handleStart = async () => {
    setActionError("");
    try {
      setSubmitting(true);
      await startJob(job.id);
    } catch (err: unknown) {
      setActionError(
        err instanceof Error ? err.message : "Job konnte nicht gestartet werden."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleComplete = async () => {
    setActionError("");
    try {
      setSubmitting(true);
      await completeJob(job.id);
    } catch (err: unknown) {
      setActionError(
        err instanceof Error
          ? err.message
          : "Job konnte nicht abgeschlossen werden."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = () => {
    router.push(`/jobs/${job.id}/edit`);
  };

  // ── Maps öffnen (plattform-spezifischer URL-Schema)
  const handleOpenInMaps = () => {
    setActionError("");
    if (!job.location?.trim()) {
      setActionError("Keine Adresse zum Öffnen vorhanden.");
      return;
    }
    const query = encodeURIComponent(job.location.trim());
    const url = Platform.select({
      ios: `http://maps.apple.com/?q=${query}`,
      android: `https://www.google.com/maps/search/?api=1&query=${query}`,
      default: `https://www.google.com/maps/search/?api=1&query=${query}`,
    });
    Linking.openURL(url!).catch(() => {
      setActionError("Maps-App konnte nicht geöffnet werden.");
    });
  };

  // ── Formatierte Werte
  const scheduledStartText =
    formatDateTime(job.scheduledStart) ?? "Kein Termin geplant";
  const startedAtText = formatDateTime(job.startedAt);
  const completedAtText = formatDateTime(job.completedAt);
  const employeeText = job.employeeName ?? "Nicht zugewiesen";

  const canStart = job.status === "open";
  const canComplete = job.status === "in_progress";
  const isDone = job.status === "completed";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      {/* ── Sticky-Header ── */}
      <AppHeader
        title="Job-Details"
        showBack
        right={
          isAdmin ? (
            <View style={styles.headerRoleBadge}>
              <View style={styles.headerRoleDot} />
              <Text style={styles.headerRoleText}>Admin</Text>
            </View>
          ) : undefined
        }
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Hero: Kunden-Name + Status ── */}
        <View style={styles.hero}>
          <Text style={styles.customerName}>{job.customerName}</Text>
          <StatusBadge status={job.status} />
        </View>

        {/* ── Save-Status ── */}
        <OfflineBanner />

        {/* ── Fehler-Banner (Aktionen) ── */}
        {actionError ? (
          <ErrorBanner
            message={actionError}
            onDismiss={() => setActionError("")}
          />
        ) : null}

        {/* ── Details-Karte ── */}
        <Card padding={theme.spacing.lg} style={styles.card}>
          <InfoRow label="Service" value={job.service} icon="construct-outline" />
          <View style={styles.rowDivider} />

          <InfoRow
            label="Adresse"
            value={job.location || "—"}
            icon="location-outline"
          />
          {job.location ? (
            <View style={styles.mapsBtnRow}>
              <Button
                label="In Maps öffnen"
                variant="secondary"
                icon="map-outline"
                fullWidth={false}
                onPress={handleOpenInMaps}
                style={{ paddingHorizontal: theme.spacing.lg }}
              />
            </View>
          ) : null}
          <View style={styles.rowDivider} />

          <InfoRow
            label="Geplanter Start"
            value={scheduledStartText}
            icon="calendar-outline"
          />
          <View style={styles.rowDivider} />

          <InfoRow
            label="Mitarbeiter"
            value={employeeText}
            icon="person-outline"
          />

          {/* Optionale Zeitstempel — nur wenn vorhanden */}
          {startedAtText ? (
            <>
              <View style={styles.rowDivider} />
              <InfoRow
                label="Gestartet"
                value={startedAtText}
                icon="play-circle-outline"
              />
            </>
          ) : null}

          {completedAtText ? (
            <>
              <View style={styles.rowDivider} />
              <InfoRow
                label="Erledigt"
                value={completedAtText}
                icon="checkmark-circle-outline"
              />
            </>
          ) : null}
        </Card>

        {/* ── Notizen ── */}
        {job.notes ? (
          <Card padding={theme.spacing.lg} style={styles.card}>
            <View style={styles.notesLabelRow}>
              <Ionicons
                name="document-text-outline"
                size={12}
                color={theme.colors.primary}
              />
              <Text style={styles.notesLabel}>NOTIZEN</Text>
            </View>
            <Text style={styles.notesText}>{job.notes}</Text>
          </Card>
        ) : null}

        {/* ── Aktionen ── */}
        <View style={styles.actions}>
          {canStart ? (
            <Button
              label="Job starten"
              icon="play"
              loading={submitting}
              disabled={submitting}
              onPress={handleStart}
            />
          ) : null}

          {canComplete ? (
            <Button
              label="Job abschließen"
              icon="checkmark"
              loading={submitting}
              disabled={submitting}
              onPress={handleComplete}
            />
          ) : null}

          {isDone ? (
            <View style={styles.doneInfo}>
              <Ionicons
                name="checkmark-circle"
                size={20}
                color={theme.colors.statusCompleted}
              />
              <Text style={styles.doneInfoText}>
                Dieser Job ist abgeschlossen.
              </Text>
            </View>
          ) : null}

          {isAdmin ? (
            <Button
              label="Bearbeiten"
              variant="secondary"
              icon="create-outline"
              disabled={submitting}
              onPress={handleEdit}
            />
          ) : null}
        </View>

        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },

    // Empty-Variante
    emptyWrap: {
      flex: 1,
    },

    // Scroll-Container
    scroll: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.gutter,
      paddingTop: theme.spacing.lg,
      paddingBottom: 32,
      gap: theme.spacing.md,
    },

    // Header rechts: Role-Pill
    headerRoleBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: theme.colors.statusInProgressBg,
      borderWidth: 1,
      borderColor: theme.colors.statusInProgressBorder,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: theme.radius.full,
    },
    headerRoleDot: {
      width: 5,
      height: 5,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusInProgress,
    },
    headerRoleText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.statusInProgress,
    },

    // Hero-Bereich
    hero: {
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    customerName: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
      lineHeight: theme.typography.lineHeight.xxl,
    },

    // Cards
    card: {
      gap: theme.spacing.md,
    },
    rowDivider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
    },
    mapsBtnRow: {
      flexDirection: "row",
      marginTop: 4,
    },

    // Notizen
    notesLabelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginBottom: 6,
    },
    notesLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    notesText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
    },

    // Aktionen
    actions: {
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
    doneInfo: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.statusCompletedBg,
      borderWidth: 1,
      borderColor: theme.colors.statusCompletedBorder,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    doneInfoText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.statusCompleted,
    },
  });
}
