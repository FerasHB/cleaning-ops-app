// features/jobs/EmployeeSmartJobsScreen.tsx
// ─────────────────────────────────────────────────────────────────
// Mitarbeiter-Jobs-Tab: intelligente operative Warteschlange.
//
// Beantwortet (in dieser Reihenfolge):
//   1. Läuft gerade ein Auftrag?        → "In Arbeit"
//   2. Ist etwas überfällig?            → "Überfällig" (progressiv, siehe unten)
//   3. Was kommt als Nächstes?          → "Als Nächstes"
//   4. Was steht heute sonst noch an?   → "Heute"
//   5. Was kommt danach?                → "Morgen" / Wochentag-Gruppen
//
// Datenquelle bleibt ausschließlich `useJobs().jobs` (Employee: RLS-begrenzt
// auf eigene Aufträge) — keine eigene Query, kein neuer Realtime-Channel.
// Die Gliederung selbst ist reine Ableitung in utils/jobsQueue.ts
// (buildJobQueueSections) und rechnet bei jeder Änderung von `jobs` neu,
// dadurch aktualisiert sich der Screen automatisch über die bestehende
// Realtime-/Offline-Architektur des JobContext.
//
// DEDUPLIZIERUNG: "Als Nächstes" und "Aktiv" werden aus den Tages-/
// Zukunftsgruppen entfernt (siehe buildJobQueueSections) — jeder Auftrag
// erscheint in genau EINER Sektion.
//
// KEIN neuer Kartentyp: alle Sektionen nutzen dieselbe `JobCard` wie
// Übersicht/Kalender. Hervorhebung passiert ausschließlich über
// Sektions-Überschriften, nicht über eine zweite Karten-Implementierung.
// ─────────────────────────────────────────────────────────────────

import {
  Card,
  EmptyState,
  ErrorBanner,
  LoadingScreen,
  OfflineBanner,
  ScreenContainer,
  SectionHeader,
} from "@/components/ui";
import JobCard from "@/components/JobCard";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import type { Job } from "@/types/job";
import { canRunJobActions } from "@/utils/jobAssignees";
import { isJobToday } from "@/utils/jobSchedule";
import { getJobStatusLabel, JOB_STATUS_ORDER } from "@/utils/jobStatus";
import {
  buildJobQueueSections,
  getTodayStatusCounts,
  type JobStatusFilter,
} from "@/utils/jobsQueue";
import { toUserMessage } from "@/utils/userMessages";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

// Gleiche Quelle/Reihenfolge wie die Filter-Chips der Übersicht — Wortlaut
// darf nicht auseinanderlaufen (utils/jobStatus.ts ist kanonisch).
const FILTERS: { key: JobStatusFilter; label: string }[] = [
  { key: "all", label: "Alle" },
  ...JOB_STATUS_ORDER.map((key) => ({ key, label: getJobStatusLabel(key) })),
];

// Wie viele überfällige Aufträge sofort sichtbar sind, bevor "Weitere
// anzeigen" nötig wird — verhindert, dass Historie den Bildschirm vor der
// heutigen Arbeit dominiert (siehe PR-Vorgabe "63 überfällige Aufträge").
const INITIAL_OVERDUE_COUNT = 3;

const EMPTY_MESSAGES: Record<JobStatusFilter, { title: string; message: string }> = {
  all: {
    title: "Keine Aufträge",
    message: "Aktuell sind keine Aufträge für dich geplant.",
  },
  open: {
    title: "Keine offenen Aufträge",
    message: "Aktuell sind dir keine offenen Aufträge zugewiesen.",
  },
  in_progress: {
    title: "Kein Auftrag in Arbeit",
    message: "Aktuell läuft kein Auftrag.",
  },
  completed: {
    title: "Noch keine erledigten Aufträge",
    message: "Abgeschlossene Aufträge erscheinen hier.",
  },
};

export default function EmployeeSmartJobsScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { role, profile } = useAuth();
  const {
    jobs,
    startJob,
    completeJob,
    loading,
    error: dataError,
    refreshJobs,
  } = useJobs();

  const [filter, setFilter] = useState<JobStatusFilter>("all");
  const [showAllOverdue, setShowAllOverdue] = useState(false);

  // ── Pull-to-Refresh (gleiches Muster wie Übersicht/Kalender) ──
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const handleRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await refreshJobs();
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [refreshJobs]);

  // ── Aktions-State für Start/Abschluss ──
  // Nur ein Ref-Lock (keine sichtbare Sperre auf Screen-Ebene): jede JobCard
  // bringt ihren eigenen Doppel-Tap-Schutz + Busy-Anzeige mit. Der Ref
  // verhindert zusätzlich, dass zwei VERSCHIEDENE Karten gleichzeitig
  // auslösen (z.B. Start auf Karte A während Abschluss auf Karte B läuft).
  const [actionError, setActionError] = useState("");
  const actionBusyRef = useRef(false);

  const runJobAction = useCallback(
    async (action: () => Promise<void>, fallbackMessage: string) => {
      if (actionBusyRef.current) return;
      actionBusyRef.current = true;
      setActionError("");
      try {
        await action();
      } catch (err: unknown) {
        setActionError(toUserMessage(err, fallbackMessage));
      } finally {
        actionBusyRef.current = false;
      }
    },
    [],
  );

  const handleStart = useCallback(
    (jobId: string) =>
      runJobAction(() => startJob(jobId), "Job konnte nicht gestartet werden."),
    [runJobAction, startJob],
  );

  const handleComplete = useCallback(
    (jobId: string) =>
      runJobAction(
        () => completeJob(jobId),
        "Job konnte nicht abgeschlossen werden.",
      ),
    [runJobAction, completeJob],
  );

  const canRunActions = useCallback(
    (job: Job) => canRunJobActions(job, role, profile?.id),
    [role, profile?.id],
  );

  // Zeitpunkt beim Render — wie EmployeeOverviewScreen, keine eigene Uhr.
  const now = new Date();

  const todayCounts = useMemo(
    () => getTodayStatusCounts(jobs, now),
    [jobs, now],
  );

  const sections = useMemo(
    () => buildJobQueueSections(jobs, now, role, profile?.id, filter),
    [jobs, now, role, profile?.id, filter],
  );

  const visibleOverdue = showAllOverdue
    ? sections.overdue
    : sections.overdue.slice(0, INITIAL_OVERDUE_COUNT);
  const hiddenOverdueCount = sections.overdue.length - visibleOverdue.length;

  const futureJobCount = sections.future.reduce(
    (sum, group) => sum + group.jobs.length,
    0,
  );
  const pastCompletedJobCount = sections.pastCompleted.reduce(
    (sum, group) => sum + group.jobs.length,
    0,
  );

  const totalVisibleCount =
    sections.active.length +
    sections.overdue.length +
    (sections.next ? 1 : 0) +
    (sections.today?.jobs.length ?? 0) +
    futureJobCount +
    (filter === "completed" ? pastCompletedJobCount : 0);

  const emptyMessage = EMPTY_MESSAGES[filter];

  const renderJobCard = useCallback(
    (job: Job) => (
      <JobCard
        key={job.id}
        job={job}
        dueToday={isJobToday(job, now)}
        onPress={() => router.push(`/jobs/${job.id}`)}
        onStart={canRunActions(job) ? () => handleStart(job.id) : undefined}
        onComplete={canRunActions(job) ? () => handleComplete(job.id) : undefined}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now, canRunActions, handleStart, handleComplete],
  );

  if (loading) return <LoadingScreen />;

  return (
    <ScreenContainer
      refreshing={refreshing}
      onRefresh={() => {
        void handleRefresh();
      }}
    >
      <OfflineBanner />

      {dataError ? (
        <View style={styles.loadErrorWrap}>
          <ErrorBanner
            message={dataError}
            actionLabel="Erneut versuchen"
            onAction={() => {
              void handleRefresh();
            }}
          />
        </View>
      ) : null}

      {actionError ? (
        <ErrorBanner message={actionError} onDismiss={() => setActionError("")} />
      ) : null}

      {/* ── Kopf: Titel + kompakte Heute-Zusammenfassung ──
          Bewusst KEIN eigenes Dashboard — nur so viel, wie beim ersten Blick
          hilft. Zahlen sind klar "Heute" beschriftet, damit sie sich nicht
          mit dem darunterliegenden Status-Filter vermischen. */}
      <View style={styles.header}>
        <Text style={styles.title}>Meine Aufträge</Text>
        {todayCounts.total > 0 ? (
          <View style={styles.summaryRow}>
            <View style={styles.summaryChip}>
              <Text style={styles.summaryChipText}>
                Heute {todayCounts.total}
              </Text>
            </View>
            {todayCounts.open > 0 ? (
              <View style={[styles.summaryChip, styles.summaryChipOpen]}>
                <Text style={[styles.summaryChipText, styles.summaryChipOpenText]}>
                  {getJobStatusLabel("open")} {todayCounts.open}
                </Text>
              </View>
            ) : null}
            {todayCounts.inProgress > 0 ? (
              <View style={[styles.summaryChip, styles.summaryChipProgress]}>
                <Text
                  style={[styles.summaryChipText, styles.summaryChipProgressText]}
                >
                  {getJobStatusLabel("in_progress")} {todayCounts.inProgress}
                </Text>
              </View>
            ) : null}
            {todayCounts.completed > 0 ? (
              <View style={[styles.summaryChip, styles.summaryChipDone]}>
                <Text style={[styles.summaryChipText, styles.summaryChipDoneText]}>
                  {getJobStatusLabel("completed")} {todayCounts.completed}
                </Text>
              </View>
            ) : null}
          </View>
        ) : (
          <Text style={styles.subtitle}>Heute sind keine Aufträge geplant.</Text>
        )}
      </View>

      {/* ── Status-Filter ── */}
      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              onPress={() => setFilter(f.key)}
              activeOpacity={0.8}
              style={[styles.chip, active && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {totalVisibleCount === 0 ? (
        <Card>
          <EmptyState
            title={emptyMessage.title}
            message={emptyMessage.message}
            icon="calendar-outline"
          />
        </Card>
      ) : (
        <>
          {/* ── In Arbeit ── */}
          {sections.active.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader title="In Arbeit" />
              <View style={styles.jobList}>
                {sections.active.map(renderJobCard)}
              </View>
            </View>
          ) : null}

          {/* ── Überfällig (progressiv) ── */}
          {sections.overdue.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader
                title="Überfällig"
                subtitle={
                  sections.overdue.length === 1
                    ? "1 überfälliger Auftrag"
                    : `${sections.overdue.length} überfällige Aufträge`
                }
              />
              <View style={styles.jobList}>
                {visibleOverdue.map(renderJobCard)}
                {hiddenOverdueCount > 0 ? (
                  <TouchableOpacity
                    style={styles.showMoreButton}
                    activeOpacity={0.8}
                    onPress={() => setShowAllOverdue(true)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.showMoreText}>
                      {`Weitere ${hiddenOverdueCount} anzeigen`}
                    </Text>
                    <Ionicons
                      name="chevron-down"
                      size={16}
                      color={theme.colors.primary}
                    />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          ) : null}

          {/* ── Als Nächstes ── */}
          {sections.next ? (
            <View style={styles.section}>
              <SectionHeader title="Als Nächstes" />
              <View style={styles.jobList}>{renderJobCard(sections.next)}</View>
            </View>
          ) : null}

          {/* ── Heute (verbleibend) ── */}
          {sections.today ? (
            <View style={styles.section}>
              <SectionHeader title={sections.today.label} />
              <View style={styles.jobList}>
                {sections.today.jobs.map(renderJobCard)}
              </View>
            </View>
          ) : null}

          {/* ── Morgen / weitere Tage ── */}
          {sections.future.map((group) => (
            <View key={group.key} style={styles.section}>
              <SectionHeader title={group.label} />
              <View style={styles.jobList}>{group.jobs.map(renderJobCard)}</View>
            </View>
          ))}

          {/* ── Historie (nur im "Erledigt"-Filter erreichbar) ──
              Im Standardfall ("Alle") bleibt Vergangenes bewusst draußen,
              damit alte Abschlüsse die aktuelle Arbeit nicht verdrängen. */}
          {filter === "completed" && sections.pastCompleted.length > 0
            ? sections.pastCompleted.map((group) => (
                <View key={group.key} style={styles.section}>
                  <SectionHeader title={group.label} />
                  <View style={styles.jobList}>
                    {group.jobs.map(renderJobCard)}
                  </View>
                </View>
              ))
            : null}
        </>
      )}

      <View style={{ height: theme.spacing.xl }} />
    </ScreenContainer>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    loadErrorWrap: {
      marginBottom: theme.spacing.md,
    },

    // ── Kopf
    header: {
      paddingTop: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    title: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    subtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // ── Zusammenfassungs-Chips
    summaryRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
    },
    summaryChip: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 6,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
    },
    summaryChipText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
    },
    summaryChipOpen: {
      backgroundColor: theme.colors.statusOpenBg,
      borderColor: theme.colors.statusOpenBorder,
    },
    summaryChipOpenText: {
      color: theme.colors.statusOpen,
    },
    summaryChipProgress: {
      backgroundColor: theme.colors.statusInProgressBg,
      borderColor: theme.colors.statusInProgressBorder,
    },
    summaryChipProgressText: {
      color: theme.colors.statusInProgress,
    },
    summaryChipDone: {
      backgroundColor: theme.colors.statusCompletedBg,
      borderColor: theme.colors.statusCompletedBorder,
    },
    summaryChipDoneText: {
      color: theme.colors.statusCompleted,
    },

    // ── Status-Filter (identisches Muster zur Übersicht)
    filterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.lg,
    },
    chip: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
    },
    chipActive: {
      backgroundColor: theme.colors.primaryContainer,
      borderColor: theme.colors.primaryContainer,
    },
    chipText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    chipTextActive: {
      color: theme.colors.onPrimaryContainer,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },

    // ── Sektionen
    section: {
      marginBottom: theme.spacing.xl,
    },
    jobList: {
      gap: theme.spacing.sm,
    },

    // ── "Weitere N anzeigen" (Überfällig, progressiv)
    showMoreButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      marginTop: 2,
      paddingVertical: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
    },
    showMoreText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
    },
  });
}
