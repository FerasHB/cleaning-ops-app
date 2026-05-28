// features/employees/EmployeeDetailScreen.tsx
// Admin-Detailansicht eines Mitarbeiters.
// Reines Lesen aus dem JobContext (employees + jobs) — keine Business-Logik.
//
// Hinweis zu Datenquellen:
// - EmployeeOption liefert nur { id, fullName }. E-Mail/Rolle sind pro
//   Mitarbeiter NICHT verfügbar → Rolle wird statisch als "Mitarbeiter"
//   gezeigt, E-Mail als "Nicht hinterlegt". Keine erfundenen Daten.

import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  InfoRow,
  InitialsAvatar,
  KPICard,
  LoadingScreen,
} from "@/components/ui";
import JobCard from "@/components/JobCard";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import type { Job, JobStatus } from "@/types/job";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import React, { useMemo } from "react";
import { Alert, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Reihenfolge für die Job-Liste: laufend → offen → erledigt
const STATUS_ORDER: Record<JobStatus, number> = {
  in_progress: 0,
  open: 1,
  completed: 2,
};

function jobDateValue(job: Job): number {
  const iso = job.completedAt ?? job.startedAt ?? job.scheduledStart;
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

function isSameDay(iso: string | null | undefined, ref: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

export default function EmployeeDetailScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { id } = useLocalSearchParams<{ id: string }>();
  const { employees, jobs, loading } = useJobs();

  const employee = useMemo(
    () => employees.find((e) => e.id === id),
    [employees, id],
  );

  // Alle Jobs dieses Mitarbeiters
  const assignedJobs = useMemo(
    () => jobs.filter((j) => j.employeeId === id),
    [jobs, id],
  );

  // Statistiken
  const openCount = assignedJobs.filter((j) => j.status === "open").length;
  const inProgressCount = assignedJobs.filter(
    (j) => j.status === "in_progress",
  ).length;
  const completedCount = assignedJobs.filter(
    (j) => j.status === "completed",
  ).length;
  const totalCount = assignedJobs.length;

  const now = useMemo(() => new Date(), []);
  const todayCount = useMemo(
    () =>
      assignedJobs.filter(
        (j) =>
          isSameDay(j.scheduledStart, now) ||
          isSameDay(j.startedAt, now) ||
          isSameDay(j.completedAt, now),
      ).length,
    [assignedJobs, now],
  );

  // Aktiver Job = erster laufender Job dieses Mitarbeiters
  const activeJob = useMemo(
    () => assignedJobs.find((j) => j.status === "in_progress") ?? null,
    [assignedJobs],
  );

  // Relevante Jobs für die Liste (max. 5, sinnvoll sortiert)
  const visibleJobs = useMemo(
    () =>
      [...assignedJobs]
        .sort((a, b) => {
          const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          if (byStatus !== 0) return byStatus;
          return jobDateValue(b) - jobDateValue(a);
        })
        .slice(0, 5),
    [assignedJobs],
  );

  if (loading) return <LoadingScreen />;

  // ── Mitarbeiter nicht gefunden ──
  if (!employee) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <StatusBar
          barStyle={theme.isDark ? "light-content" : "dark-content"}
          backgroundColor={theme.colors.background}
        />
        <AppHeader title="Mitarbeiter" showBack />
        <View style={styles.emptyWrap}>
          <EmptyState
            title="Mitarbeiter nicht gefunden"
            message="Dieser Mitarbeiter ist nicht (mehr) verfügbar."
            icon="person-outline"
            ctaLabel="Zurück"
            onCta={() => router.back()}
          />
        </View>
      </SafeAreaView>
    );
  }

  const isActive = !!activeJob;

  const handleAssignJob = () => router.push("/jobs/create");
  const handleDeactivate = () =>
    Alert.alert("Bald verfügbar", "Diese Funktion kommt später.");

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <AppHeader title="Mitarbeiter" showBack />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Profil-Header ── */}
        <Card padding={theme.spacing.lg} style={styles.headerCard}>
          <InitialsAvatar name={employee.fullName} size={64} />
          <Text style={styles.name}>{employee.fullName}</Text>

          <View
            style={[
              styles.statusPill,
              {
                backgroundColor: isActive
                  ? theme.colors.statusInProgressBg
                  : theme.colors.surfaceContainerHigh,
                borderColor: isActive
                  ? theme.colors.statusInProgressBorder
                  : theme.colors.outlineVariant,
              },
            ]}
          >
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor: isActive
                    ? theme.colors.statusInProgress
                    : theme.colors.onSurfaceVariant,
                },
              ]}
            />
            <Text
              style={[
                styles.statusText,
                {
                  color: isActive
                    ? theme.colors.statusInProgress
                    : theme.colors.onSurfaceVariant,
                },
              ]}
            >
              {isActive ? "Aktiv" : "Kein aktiver Job"}
            </Text>
          </View>
        </Card>

        {/* ── Stammdaten ── */}
        <Card padding={theme.spacing.lg} style={styles.card}>
          <InfoRow label="Rolle" value="Mitarbeiter" icon="briefcase-outline" />
          <View style={styles.rowDivider} />
          <InfoRow
            label="E-Mail"
            value="Nicht hinterlegt"
            icon="mail-outline"
          />
        </Card>

        {/* ── Aktueller Job ── */}
        {activeJob ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>AKTUELLER JOB</Text>
            <JobCard
              job={activeJob}
              onPress={() => router.push(`/jobs/${activeJob.id}`)}
            />
          </View>
        ) : null}

        {/* ── Statistiken ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>STATISTIK</Text>
          <View style={styles.kpiGrid}>
            <View style={styles.kpiItem}>
              <KPICard
                label="Heute"
                value={todayCount}
                icon="today-outline"
                accentColor={theme.colors.primary}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label="Offen"
                value={openCount}
                icon="folder-open-outline"
                accentColor={theme.colors.statusOpen}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label="In Arbeit"
                value={inProgressCount}
                icon="time-outline"
                accentColor={theme.colors.statusInProgress}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label="Erledigt"
                value={completedCount}
                icon="checkmark-circle-outline"
                accentColor={theme.colors.statusCompleted}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label="Gesamt"
                value={totalCount}
                icon="layers-outline"
              />
            </View>
          </View>
        </View>

        {/* ── Zugewiesene Jobs ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionLabel}>ZUGEWIESENE JOBS</Text>
            {totalCount > visibleJobs.length ? (
              <Text style={styles.sectionMeta}>
                {visibleJobs.length} von {totalCount}
              </Text>
            ) : null}
          </View>

          {visibleJobs.length === 0 ? (
            <Card padding={theme.spacing.lg}>
              <EmptyState
                title="Keine Jobs zugewiesen"
                message="Diesem Mitarbeiter wurden noch keine Jobs zugewiesen."
                icon="briefcase-outline"
              />
            </Card>
          ) : (
            <View style={styles.jobList}>
              {visibleJobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  showEmployeeName={false}
                  onPress={() => router.push(`/jobs/${job.id}`)}
                />
              ))}
            </View>
          )}
        </View>

        {/* ── Aktionen ── */}
        <View style={styles.actions}>
          <Button
            label="Job zuweisen"
            icon="add"
            onPress={handleAssignJob}
          />
          <Button
            label="Mitarbeiter deaktivieren"
            variant="secondary"
            icon="person-remove-outline"
            onPress={handleDeactivate}
          />
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
    emptyWrap: {
      flex: 1,
    },
    scroll: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.gutter,
      paddingTop: theme.spacing.lg,
      paddingBottom: 32,
      gap: theme.spacing.md,
    },

    // ── Profil-Header
    headerCard: {
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    name: {
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },
    statusPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderWidth: 1,
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 5,
    },
    statusDot: {
      width: 7,
      height: 7,
      borderRadius: theme.radius.full,
    },
    statusText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },

    // ── Karten
    card: {
      gap: theme.spacing.md,
    },
    rowDivider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
    },

    // ── Sections
    section: {
      gap: theme.spacing.sm,
    },
    sectionHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wider,
      textTransform: "uppercase",
    },
    sectionMeta: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.outline,
    },

    // ── KPI-Grid
    kpiGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
    },
    kpiItem: {
      width: "48%",
      flexGrow: 1,
    },

    // ── Job-Liste
    jobList: {
      gap: theme.spacing.sm,
    },

    // ── Aktionen
    actions: {
      gap: theme.spacing.sm,
      marginTop: theme.spacing.sm,
    },
  });
}
