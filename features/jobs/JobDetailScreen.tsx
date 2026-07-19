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
import { JobComments } from "@/features/jobs/components/JobComments";
import { JobPhotos } from "@/features/jobs/components/JobPhotos";
import { getJobOccurrences } from "@/services/jobs/jobs.service";
import { WorkedTimeCard } from "@/features/jobs/components/WorkedTimeCard";
import { formatRecurringDays } from "@/utils/recurrence";
import type { Job } from "@/types/job";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
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

  // Offset für KeyboardAvoidingView: oberer Safe-Area-Inset + Header-Höhe,
  // damit das Input-Feld beim Öffnen der Tastatur sichtbar bleibt (kein Overlap).
  const insets = useSafeAreaInsets();
  const keyboardOffset = insets.top + theme.spacing.tapTarget;

  // Ref auf die ScrollView, um beim Fokus des Kommentarfelds ans Ende zu
  // scrollen (Eingabe + Senden über der Tastatur sichtbar halten).
  const scrollRef = useRef<ScrollView>(null);
  const handleCommentFocus = useCallback(() => {
    // Kurzer Timeout, damit die Tastatur zuerst öffnen kann und scrollToEnd
    // die endgültige Content-Höhe trifft (iOS + Android).
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 250);
  }, []);

  const { id } = useLocalSearchParams<{ id: string }>();
  const { role, profile } = useAuth();
  const { jobs, startJob, completeJob, loading, online, markJobCommentsAsRead } =
    useJobs();

  const job = useMemo(() => jobs.find((j) => j.id === id), [jobs, id]);

  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");

  // Occurrences für Parent-Recurring-Regeln (nur Admin-Ansicht)
  const [occurrences, setOccurrences] = useState<Job[]>([]);
  const [occurrencesLoading, setOccurrencesLoading] = useState(false);

  const isAdmin = role === "admin";

  // Beim Öffnen die Kommentare dieses Jobs als gesehen markieren
  // (entfernt den roten Punkt). Online-only, optimistisch im Context.
  useEffect(() => {
    if (id) {
      markJobCommentsAsRead(id);
    }
  }, [id, markJobCommentsAsRead]);

  // Occurrences für Parent-Recurring-Regeln laden (nur Admin, online-only).
  // job ist hier noch ggf. undefined — Prüfung erfolgt im Effect selbst.
  useEffect(() => {
    if (!job || !isAdmin || job.jobType !== "recurring" || job.parentJobId) return;
    setOccurrencesLoading(true);
    getJobOccurrences(job.id)
      .then(setOccurrences)
      .catch(() => setOccurrences([]))
      .finally(() => setOccurrencesLoading(false));
  }, [job?.id, isAdmin, job?.jobType, job?.parentJobId]);

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
  const isRecurring = job.jobType === "recurring";
  // Parent-Regel: job_type=recurring ohne parentJobId — nur Vorlage, kein startbarer Termin.
  const isParentRule = isRecurring && !job.parentJobId;
  const jobTypeText = isRecurring ? "Wiederkehrend" : "Einmalig";
  const recurringDaysText = formatRecurringDays(job.recurringDays);
  const timeText = job.startTime ? `${job.startTime} Uhr` : "—";
  const scheduledStartText =
    formatDateTime(job.scheduledStart) ?? "Kein Termin geplant";
  const employeeText = job.employeeName ?? "Nicht zugewiesen";

  // Start/Abschluss laufen über die RPCs start_own_job/complete_own_job, die
  // role='employee' UND assigned_to=auth.uid() verlangen. Daher nur dem
  // zugewiesenen Mitarbeiter anbieten — sonst RPC-Fehler "Job not found or not
  // allowed" (z. B. wenn ein Admin den Button drückt). Admins nutzen "Bearbeiten".
  const isAssignedEmployee =
    role === "employee" && job.employeeId === profile?.id;
  // Parent-Recurring-Regeln dürfen niemals gestartet/abgeschlossen werden —
  // nur konkrete Occurrences (job_type='single') sind ausführbare Termine.
  const canStart = !isParentRule && isAssignedEmployee && job.status === "open";
  const canComplete = !isParentRule && isAssignedEmployee && job.status === "in_progress";
  const isDone = job.status === "completed";

  // Foto-Upload: Admin immer; Employee nur wenn diesem Job zugewiesen.
  // isOnline wird separat übergeben — JobPhotos zeigt den Offline-Hinweis selbst.
  const canUploadPhotos =
    role === "admin" ||
    (role === "employee" && job.employeeId === profile?.id);

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

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={keyboardOffset}
      >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
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

        {/* ── Arbeitszeit — prominent, direkt nach dem Hero ── */}
        <WorkedTimeCard job={job} />

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
            label="Auftragstyp"
            value={jobTypeText}
            icon={isRecurring ? "repeat-outline" : "calendar-outline"}
          />
          <View style={styles.rowDivider} />

          {isRecurring ? (
            <>
              <InfoRow
                label="Wochentage"
                value={recurringDaysText}
                icon="calendar-number-outline"
              />
              <View style={styles.rowDivider} />
              <InfoRow label="Uhrzeit" value={timeText} icon="time-outline" />
              <View style={styles.rowDivider} />
              <InfoRow
                label="Status"
                value={job.isActive ? "Aktiv" : "Inaktiv"}
                icon={job.isActive ? "checkmark-circle-outline" : "pause-circle-outline"}
              />
              <View style={styles.rowDivider} />
            </>
          ) : (
            <>
              <InfoRow
                label="Geplanter Start"
                value={scheduledStartText}
                icon="calendar-outline"
              />
              <View style={styles.rowDivider} />
            </>
          )}

          <InfoRow
            label="Mitarbeiter"
            value={employeeText}
            icon="person-outline"
          />
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

        {/* ── Regel-Hinweis + Termine (nur für Admin bei Parent-Recurring-Jobs) ── */}
        {isParentRule && isAdmin ? (
          <>
            {/* Hinweis-Banner: das ist eine Vorlage */}
            <View style={styles.ruleInfoBanner}>
              <Ionicons
                name="repeat-outline"
                size={18}
                color={theme.colors.primary}
              />
              <View style={styles.ruleInfoText}>
                <Text style={styles.ruleInfoTitle}>Wiederkehrende Regel</Text>
                <Text style={styles.ruleInfoBody}>
                  Dies ist eine Vorlage. Die generierten Einzeltermine werden
                  unten angezeigt und können von Mitarbeitern gestartet werden.
                </Text>
              </View>
            </View>

            {/* Generierte Termine (Occurrences) */}
            <Card padding={theme.spacing.lg} style={styles.card}>
              <View style={styles.occurrencesHeader}>
                <Ionicons
                  name="calendar-outline"
                  size={14}
                  color={theme.colors.primary}
                />
                <Text style={styles.occurrencesTitle}>GENERIERTE TERMINE</Text>
              </View>

              {occurrencesLoading ? (
                <Text style={styles.occurrencesEmpty}>Wird geladen …</Text>
              ) : occurrences.length === 0 ? (
                <Text style={styles.occurrencesEmpty}>
                  Keine Termine generiert.
                </Text>
              ) : (
                occurrences.map((occ, index) => (
                  <OccurrenceRow
                    key={occ.id}
                    occurrence={occ}
                    isLast={index === occurrences.length - 1}
                    theme={theme}
                  />
                ))
              )}
            </Card>
          </>
        ) : null}

        {/* ── Fotos (Upload + Anzeige, online-only) ── */}
        <JobPhotos
          jobId={job.id}
          canUpload={canUploadPhotos}
          isOnline={online}
        />

        {/* ── Kommentare (append-only, online-only) ── */}
        <JobComments jobId={job.id} onInputFocus={handleCommentFocus} />

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
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────
// Zeile in der Occurrence-Liste (Admin-Ansicht)
// ─────────────────────────────────────────────
function formatOccurrenceDate(dateStr?: string | null): string {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.slice(0, 10).split("-");
  if (!y || !m || !d) return dateStr;
  const weekdays = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const day = weekdays[new Date(`${y}-${m}-${d}`).getDay()] ?? "";
  return `${day} ${d}.${m}.${y}`;
}

const STATUS_LABELS: Record<string, string> = {
  open: "Offen",
  in_progress: "In Arbeit",
  completed: "Erledigt",
};

function OccurrenceRow({
  occurrence,
  isLast,
  theme,
}: {
  occurrence: Job;
  isLast: boolean;
  theme: AppTheme;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <>
      <View style={styles.occurrenceRow}>
        <View style={styles.occurrenceLeft}>
          <Text style={styles.occurrenceDate}>
            {formatOccurrenceDate(occurrence.date)}
          </Text>
          {occurrence.startTime ? (
            <Text style={styles.occurrenceTime}>{occurrence.startTime} Uhr</Text>
          ) : null}
        </View>
        <View style={styles.occurrenceRight}>
          <Text style={styles.occurrenceStatus}>
            {STATUS_LABELS[occurrence.status] ?? occurrence.status}
          </Text>
          {occurrence.employeeName ? (
            <Text style={styles.occurrenceEmployee} numberOfLines={1}>
              {occurrence.employeeName}
            </Text>
          ) : null}
        </View>
      </View>
      {!isLast ? <View style={styles.rowDivider} /> : null}
    </>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },

    // Wrapper für KeyboardAvoidingView (füllt Platz unter dem Header)
    flex: {
      flex: 1,
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

    // Regel-Hinweis-Banner (Parent-Recurring)
    ruleInfoBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.primaryContainer,
      borderWidth: 1,
      borderColor: theme.colors.primary,
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
    },
    ruleInfoText: {
      flex: 1,
      gap: 4,
    },
    ruleInfoTitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
    },
    ruleInfoBody: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
    },

    // Occurrences-Liste
    occurrencesHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginBottom: theme.spacing.sm,
    },
    occurrencesTitle: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    occurrencesEmpty: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    occurrenceRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: theme.spacing.sm,
      gap: theme.spacing.sm,
    },
    occurrenceLeft: {
      gap: 2,
    },
    occurrenceDate: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    occurrenceTime: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    occurrenceRight: {
      alignItems: "flex-end",
      gap: 2,
    },
    occurrenceStatus: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
    },
    occurrenceEmployee: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      maxWidth: 120,
    },
  });
}
