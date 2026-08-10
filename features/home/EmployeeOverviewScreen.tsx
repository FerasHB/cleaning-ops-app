// features/home/EmployeeOverviewScreen.tsx
// Employee-Startseite (Tab "Übersicht") im Field-Service-Stil.
// Vollständig theme-aware (Light + Dark Mode). Nur Lesezugriff auf Context
// (+ startJob/completeJob für Quick-Actions, die bereits Teil von JobContext sind).
//
// Hinweise:
// - "Heute"/"Monat" basieren auf job.scheduledStart bzw. job.completedAt.
//   Falls KEIN Job ein Datum hat, fällt die Anzeige auf alle eigenen Jobs zurück.

import {
  Card,
  EmptyState,
  ErrorBanner,
  KPICard,
  LoadingScreen,
  OfflineBanner,
  ScreenContainer,
  SectionHeader,
} from "@/components/ui";
import JobCard from "@/components/JobCard";
import { useAuth } from "@/context/AuthContext";
import { canRunJobActions } from "@/utils/jobAssignees";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import type { Job, JobStatus } from "@/types/job";
import { isJobToday } from "@/utils/jobSchedule";
import { confirmCompleteJob } from "@/utils/jobDialogs";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Filter = "all" | JobStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "open", label: "Offen" },
  { key: "in_progress", label: "In Arbeit" },
  { key: "completed", label: "Erledigt" },
];

// Sortier-Priorität für "Heute anstehend": offen zuerst, dann in Arbeit, dann erledigt
const STATUS_ORDER: Record<JobStatus, number> = {
  open: 0,
  in_progress: 1,
  completed: 2,
};

function getGreeting(date: Date): string {
  const h = date.getHours();
  if (h < 11) return "Guten Morgen";
  if (h < 18) return "Guten Tag";
  return "Guten Abend";
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function isSameMonth(iso: string | null | undefined, ref: Date): boolean {
  const d = parse(iso);
  if (!d) return false;
  return (
    d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth()
  );
}

function formatTime(iso: string | null | undefined): string | null {
  const d = parse(iso);
  if (!d) return null;
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

export default function EmployeeOverviewScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { profile, role } = useAuth();
  const { jobs, startJob, completeJob, loading } = useJobs();

  const [filter, setFilter] = useState<Filter>("all");

  // ── Aktions-State für Start/Abschluss ─────────────────────────────────────
  // Vorher liefen diese Aufrufe als Fire-and-Forget: nicht awaited, kein
  // try/catch, keine Sperre. Eine abgelehnte RPC (offline, fehlende Rechte)
  // erzeugte eine unbehandelte Promise und NULL sichtbares Feedback — der
  // Mitarbeiter tippte dann erneut. Gleiches Muster wie im Kalender-Screen.
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  // Sperrt synchron; setActionBusy wirkt erst beim nächsten Render.
  const actionBusyRef = useRef(false);

  const runJobAction = useCallback(
    async (action: () => Promise<void>, fallbackMessage: string) => {
      if (actionBusyRef.current) return;
      actionBusyRef.current = true;
      setActionBusy(true);
      setActionError("");
      try {
        await action();
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : fallbackMessage);
      } finally {
        actionBusyRef.current = false;
        setActionBusy(false);
      }
    },
    [],
  );

  // JobCard bringt Bestätigung und eigenen Doppel-Tap-Schutz mit — hier nur
  // noch ausführen und Fehler anzeigen.
  const handleStart = useCallback(
    (jobId: string) =>
      runJobAction(
        () => startJob(jobId),
        "Job konnte nicht gestartet werden.",
      ),
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

  // Aktiver-Job-Karte: eigener Button ohne JobCard → Bestätigung hier.
  const handleCompleteActiveJob = useCallback(
    async (jobId: string) => {
      if (actionBusyRef.current) return;
      if (!(await confirmCompleteJob())) return;
      await handleComplete(jobId);
    },
    [handleComplete],
  );

  // Zeitpunkt beim Render. Header zeigt nur das Datum (keine Live-Uhrzeit).
  const now = new Date();
  const firstName = (profile?.full_name?.trim() || "Hey").split(/\s+/)[0];

  const dateLabel = useMemo(
    () =>
      now.toLocaleDateString("de-DE", {
        weekday: "long",
        day: "2-digit",
        month: "long",
      }),
    [now],
  );

  // ── Heutige Jobs: single mit heutigem Datum + recurring mit heutigem
  // Wochentag, jeweils nur aktive. Siehe isJobToday().
  // Defensiv: Parent-Recurring-Regeln (job_type='recurring', kein parentJobId)
  // filtern wir heraus — Employees sollten sie via RLS nie sehen, aber sicher ist sicher.
  const todayJobs = useMemo(
    () =>
      jobs
        .filter((j) => j.jobType === "single")
        .filter((j) => isJobToday(j, now)),
    [jobs, now],
  );

  // Für die Monats-KPIs unten: gibt es überhaupt terminierte (single) Jobs?
  const anyScheduled = useMemo(
    () => jobs.some((j) => !!j.scheduledStart),
    [jobs],
  );

  // ── Heute-KPIs
  const todayTotal = todayJobs.length;
  const todayOpen = todayJobs.filter((j) => j.status === "open").length;
  const todayInProgress = todayJobs.filter(
    (j) => j.status === "in_progress",
  ).length;
  const todayCompleted = todayJobs.filter(
    (j) => j.status === "completed",
  ).length;

  // ── Aktiver Job (erster in_progress über alle eigenen Jobs)
  // Seit Phase 7 („Shared Job Time") gehört die Abschluss-Karte JEDEM
  // Zugewiesenen: hat eine Kollegin den Auftrag gestartet, darf ihn auch der
  // Mitarbeiter abschließen, der Start nie gedrückt hat — beide erhalten
  // dieselbe geteilte Arbeitszeit. canRunJobActions kapselt genau das.
  const activeJob = useMemo(
    () =>
      jobs.find(
        (j) =>
          j.status === "in_progress" && canRunJobActions(j, role, profile?.id),
      ),
    [jobs, role, profile?.id],
  );

  // ── "Heute anstehend": gefiltert + nach Status sortiert, max. 5
  const upcomingJobs = useMemo(() => {
    const base =
      filter === "all"
        ? todayJobs
        : todayJobs.filter((j) => j.status === filter);
    return [...base]
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
      .slice(0, 5);
  }, [todayJobs, filter]);

  // ── Monatsaktivität (mit Datum-Fallback)
  const monthJobs = useMemo(() => {
    if (!anyScheduled) return jobs;
    return jobs.filter(
      (j) => isSameMonth(j.scheduledStart, now) || isSameMonth(j.completedAt, now),
    );
  }, [jobs, anyScheduled, now]);

  const monthCompleted = monthJobs.filter(
    (j) => j.status === "completed",
  ).length;
  const monthInProgress = monthJobs.filter(
    (j) => j.status === "in_progress",
  ).length;
  const monthOpen = monthJobs.filter((j) => j.status === "open").length;
  const monthTotal = monthJobs.length;

  if (loading) return <LoadingScreen />;

  return (
    <ScreenContainer>
      {/* ── Save-Status ── */}
      <OfflineBanner />

      {/* ── Fehler aus Start/Abschluss — oben, ohne Scrollen sichtbar ── */}
      {actionError ? (
        <ErrorBanner
          message={actionError}
          onDismiss={() => setActionError("")}
        />
      ) : null}

      {/* ── Header ──
          Die Begrüßung nimmt immer die volle Breite ein. Vorher saß rechts
          daneben ein Save-Status-Badge, der nur im Normalfall gerendert wurde:
          bei jedem Speichern verschwand er und die Begrüßung wurde breiter
          (anderer Zeilenumbruch/Abschnitt) — sichtbares Zappeln im Kopfbereich.
          Der Badge ist entfallen; aussagekräftige Zustände zeigt das Banner. */}
      <View style={styles.header}>
        <Text style={styles.greeting} numberOfLines={1}>
          {getGreeting(now)}, {firstName}
        </Text>
        <Text style={styles.dateText}>{dateLabel}</Text>
      </View>

      {/* ── Heute-Übersicht (2×2) ── */}
      <View style={styles.section}>
        <SectionHeader title="Heute" subtitle="Dein Tag auf einen Blick" />
        <View style={styles.kpiGrid}>
          <View style={styles.kpiItem}>
            <KPICard
              label="Jobs heute"
              value={todayTotal}
              icon="briefcase-outline"
              accentColor={theme.colors.primary}
              onPress={() => router.push("/(employee-tabs)/jobs")}
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="Offen"
              value={todayOpen}
              icon="folder-open-outline"
              accentColor={theme.colors.statusOpen}
              onPress={() => router.push("/(employee-tabs)/jobs")}
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="In Arbeit"
              value={todayInProgress}
              icon="time-outline"
              accentColor={theme.colors.statusInProgress}
              onPress={() => router.push("/(employee-tabs)/jobs")}
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="Erledigt"
              value={todayCompleted}
              icon="checkmark-done-outline"
              accentColor={theme.colors.statusCompleted}
              onPress={() => router.push("/(employee-tabs)/jobs")}
            />
          </View>
        </View>
      </View>

      {/* ── Aktiver Job (nur wenn vorhanden) ──
          Karte ist ein View, KEIN TouchableOpacity: der Abschließen-Button lag
          vorher INNERHALB der Karten-Touchable. Beide Press-Highlights
          überlagerten sich und ein Tap knapp neben dem Button navigierte
          stillschweigend, statt abzuschließen. Jetzt zwei klar getrennte
          Geschwister: oben der Navigations-Bereich, unten die Aktion. */}
      {activeJob && (
        <View style={styles.section}>
          <SectionHeader title="Aktiver Job" />
          <View style={styles.activeCard}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => router.push(`/jobs/${activeJob.id}`)}
              style={styles.activeNavArea}
            >
              <View style={styles.activeTopRow}>
                <View style={styles.activeBadge}>
                  <View style={styles.activePulse} />
                  <Text style={styles.activeBadgeText}>Läuft</Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={18}
                  color={theme.colors.onPrimaryContainer}
                />
              </View>

              <Text style={styles.activeCustomer} numberOfLines={1}>
                {activeJob.customerName}
              </Text>
              {activeJob.service ? (
                <Text style={styles.activeService} numberOfLines={1}>
                  {activeJob.service}
                </Text>
              ) : null}

              <View style={styles.activeMetaRow}>
                {activeJob.location ? (
                  <View style={styles.activeMetaItem}>
                    <Ionicons
                      name="location-outline"
                      size={14}
                      color={theme.colors.onPrimaryContainer}
                    />
                    <Text style={styles.activeMetaText} numberOfLines={1}>
                      {activeJob.location}
                    </Text>
                  </View>
                ) : null}
                {activeJob.startTime ?? formatTime(activeJob.scheduledStart) ? (
                  <View style={styles.activeMetaItem}>
                    <Ionicons
                      name="time-outline"
                      size={14}
                      color={theme.colors.onPrimaryContainer}
                    />
                    <Text style={styles.activeMetaText}>
                      {activeJob.startTime ?? formatTime(activeJob.scheduledStart)}
                    </Text>
                  </View>
                ) : null}
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.completeBtn, actionBusy && styles.completeBtnBusy]}
              activeOpacity={0.85}
              disabled={actionBusy}
              onPress={() => {
                handleCompleteActiveJob(activeJob.id).catch(() => {});
              }}
            >
              <Ionicons
                name="checkmark"
                size={16}
                color={theme.colors.statusCompleted}
              />
              <Text style={styles.completeBtnText}>Job abschließen</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Heute anstehend ── */}
      <View style={styles.section}>
        <SectionHeader
          title="Heute anstehend"
          subtitle="Deine wichtigsten Aufträge"
        />

        {/* Filter-Chips (wirken nur auf diese Liste) */}
        <View style={styles.filterRow}>
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setFilter(f.key)}
                activeOpacity={0.8}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text
                  style={[styles.chipText, active && styles.chipTextActive]}
                >
                  {f.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {upcomingJobs.length === 0 ? (
          <Card>
            <EmptyState
              title="Keine Jobs für heute"
              message="Du hast heute keine geplanten Aufträge."
              icon="calendar-outline"
            />
          </Card>
        ) : (
          <View style={styles.jobList}>
            {upcomingJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                dueToday
                onPress={() => router.push(`/jobs/${job.id}`)}
                onStart={
                  canRunJobActions(job, role, profile?.id)
                    ? () => handleStart(job.id)
                    : undefined
                }
                onComplete={
                  canRunJobActions(job, role, profile?.id)
                    ? () => handleComplete(job.id)
                    : undefined
                }
              />
            ))}
          </View>
        )}
      </View>

      {/* ── Monatsaktivität ── */}
      <View style={styles.section}>
        <SectionHeader
          title="Diesen Monat"
          subtitle="Deine persönliche Aktivität"
        />
        <View style={styles.kpiGrid}>
          <View style={styles.kpiItem}>
            <KPICard
              label="Erledigt"
              value={monthCompleted}
              icon="checkmark-done-outline"
              accentColor={theme.colors.statusCompleted}
              onPress={() => router.push("/(employee-tabs)/jobs")}
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="In Arbeit"
              value={monthInProgress}
              icon="time-outline"
              accentColor={theme.colors.statusInProgress}
              onPress={() => router.push("/(employee-tabs)/jobs")}
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="Offen"
              value={monthOpen}
              icon="folder-open-outline"
              accentColor={theme.colors.statusOpen}
              onPress={() => router.push("/(employee-tabs)/jobs")}
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="Gesamt"
              value={monthTotal}
              icon="albums-outline"
              accentColor={theme.colors.primary}
              onPress={() => router.push("/(employee-tabs)/jobs")}
            />
          </View>
        </View>
      </View>

      <View style={{ height: theme.spacing.xl }} />
    </ScreenContainer>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    // ── Header
    header: {
      paddingTop: theme.spacing.md,
      marginBottom: theme.spacing.xl,
    },
    greeting: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    dateText: {
      marginTop: 2,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textTransform: "capitalize",
    },
    // ── Sections
    section: {
      marginBottom: theme.spacing.xl,
    },

    // ── KPI Grid
    kpiGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
    },
    kpiItem: {
      width: "48.5%",
    },

    // ── Aktiver Job (hervorgehoben)
    // Container ist nicht mehr tappbar — die beiden Interaktionen liegen als
    // Geschwister darin (Navigations-Bereich oben, Abschließen-Button unten).
    activeCard: {
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      gap: 6,
      ...theme.shadows.md,
    },
    // Tappbarer Bereich für die Detail-Navigation (alles außer dem Button).
    activeNavArea: {
      gap: 6,
    },
    activeTopRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    activeBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 4,
      borderRadius: theme.radius.full,
    },
    activePulse: {
      width: 7,
      height: 7,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusInProgress,
    },
    activeBadgeText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.statusInProgress,
      letterSpacing: theme.typography.letterSpacing.wide,
    },
    activeCustomer: {
      marginTop: theme.spacing.sm,
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onPrimaryContainer,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    activeService: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onPrimaryContainer,
      opacity: 0.85,
    },
    activeMetaRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.md,
      marginTop: theme.spacing.sm,
    },
    activeMetaItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
    },
    activeMetaText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onPrimaryContainer,
      opacity: 0.9,
    },
    completeBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      marginTop: theme.spacing.md,
      backgroundColor: theme.colors.statusCompletedBg,
      borderWidth: 1,
      borderColor: theme.colors.statusCompletedBorder,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    completeBtnBusy: {
      opacity: 0.5,
    },
    completeBtnText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.statusCompleted,
    },

    // ── Filter-Chips
    filterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.md,
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

    // ── Job-Liste
    jobList: {
      gap: theme.spacing.sm,
    },
  });
}
