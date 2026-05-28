// features/home/EmployeeOverviewScreen.tsx
// Employee-Startseite (Tab "Übersicht") im Field-Service-Stil.
// Vollständig theme-aware (Light + Dark Mode). Nur Lesezugriff auf Context
// (+ startJob/completeJob für Quick-Actions, die bereits Teil von JobContext sind).
//
// Hinweise zu Platzhaltern:
// - Wetter "18°C · Leicht bewölkt": fixer Platzhalter, keine Wetter-API.
// - Sync/Online-Status "Synchronisiert": statische Anzeige, keine echte NetInfo-Abfrage.
// - "Heute"/"Monat" basieren auf job.scheduledStart bzw. job.completedAt.
//   Falls KEIN Job ein Datum hat, fällt die Anzeige auf alle eigenen Jobs zurück.

import {
  Card,
  EmptyState,
  KPICard,
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
import type { Job, JobStatus } from "@/types/job";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

const WEATHER_PLACEHOLDER = "18°C · Leicht bewölkt";

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

function isSameDay(iso: string | null | undefined, ref: Date): boolean {
  const d = parse(iso);
  if (!d) return false;
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
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

  const { profile } = useAuth();
  const { jobs, startJob, completeJob, loading } = useJobs();

  const [filter, setFilter] = useState<Filter>("all");

  const now = useMemo(() => new Date(), []);
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

  // Hat überhaupt irgendein Job ein Datum? Sonst Fallback auf alle Jobs.
  const anyScheduled = useMemo(
    () => jobs.some((j) => !!j.scheduledStart),
    [jobs],
  );

  // ── Heutige Jobs (mit Datum-Fallback)
  const todayJobs = useMemo(() => {
    if (!anyScheduled) return jobs;
    return jobs.filter((j) => isSameDay(j.scheduledStart, now));
  }, [jobs, anyScheduled, now]);

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
  const activeJob = useMemo(
    () => jobs.find((j) => j.status === "in_progress"),
    [jobs],
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

      {/* ── Header ── */}
      <View style={styles.header}>
        <Text style={styles.greeting}>
          {getGreeting(now)}, {firstName}
        </Text>
        <Text style={styles.dateText}>{dateLabel}</Text>

        <View style={styles.weatherRow}>
          <Ionicons
            name="partly-sunny-outline"
            size={16}
            color={theme.colors.onSurfaceVariant}
          />
          <Text style={styles.weatherText}>{WEATHER_PLACEHOLDER}</Text>
        </View>
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
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="Offen"
              value={todayOpen}
              icon="folder-open-outline"
              accentColor={theme.colors.statusOpen}
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="In Arbeit"
              value={todayInProgress}
              icon="time-outline"
              accentColor={theme.colors.statusInProgress}
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="Erledigt"
              value={todayCompleted}
              icon="checkmark-done-outline"
              accentColor={theme.colors.statusCompleted}
            />
          </View>
        </View>
      </View>

      {/* ── Aktiver Job (nur wenn vorhanden) ── */}
      {activeJob && (
        <View style={styles.section}>
          <SectionHeader title="Aktiver Job" />
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => router.push(`/jobs/${activeJob.id}`)}
            style={styles.activeCard}
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
              {formatTime(activeJob.scheduledStart) ? (
                <View style={styles.activeMetaItem}>
                  <Ionicons
                    name="time-outline"
                    size={14}
                    color={theme.colors.onPrimaryContainer}
                  />
                  <Text style={styles.activeMetaText}>
                    {formatTime(activeJob.scheduledStart)}
                  </Text>
                </View>
              ) : null}
            </View>

            <TouchableOpacity
              style={styles.completeBtn}
              activeOpacity={0.85}
              onPress={() => completeJob(activeJob.id)}
            >
              <Ionicons
                name="checkmark"
                size={16}
                color={theme.colors.statusCompleted}
              />
              <Text style={styles.completeBtnText}>Job abschließen</Text>
            </TouchableOpacity>
          </TouchableOpacity>
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
                onPress={() => router.push(`/jobs/${job.id}`)}
                onStart={() => startJob(job.id)}
                onComplete={() => completeJob(job.id)}
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
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="In Arbeit"
              value={monthInProgress}
              icon="time-outline"
              accentColor={theme.colors.statusInProgress}
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="Offen"
              value={monthOpen}
              icon="folder-open-outline"
              accentColor={theme.colors.statusOpen}
            />
          </View>
          <View style={styles.kpiItem}>
            <KPICard
              label="Gesamt"
              value={monthTotal}
              icon="albums-outline"
              accentColor={theme.colors.primary}
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
    weatherRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: theme.spacing.sm,
    },
    weatherText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
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
    activeCard: {
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      gap: 6,
      ...theme.shadows.md,
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
