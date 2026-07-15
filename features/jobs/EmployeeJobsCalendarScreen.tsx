// features/jobs/EmployeeJobsCalendarScreen.tsx
// Kalender-Ansicht des Employee-Jobs-Tabs (ersetzt die lange Liste für Mitarbeiter).
// Oben: Eigenbau-Monatskalender (MonthCalendar) mit markierten Job-Tagen.
// Darunter: nur die Jobs des ausgewählten Tags, nach Uhrzeit sortiert.
// Start/Complete laufen unverändert über die bestehende JobCard (JobContext).
// Admin nutzt weiterhin JobsListScreen — dieser Screen ist Employee-only.

import { EmptyState, ErrorBanner, LoadingScreen, OfflineBanner } from "@/components/ui";
import JobCard from "@/components/JobCard";
import { MonthCalendar } from "@/features/jobs/components/MonthCalendar";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { formatDateISO } from "@/utils/date";
import { getJobDisplayTime } from "@/utils/jobSchedule";
import type { Job } from "@/types/job";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";

// Datums-Key "YYYY-MM-DD" eines Jobs.
// single hat date; Fallback scheduledStart (Alt-Daten / single ohne date).
function getJobDateKey(job: Job): string | null {
  if (job.date) return job.date.slice(0, 10);
  return formatDateISO(job.scheduledStart ? new Date(job.scheduledStart) : null);
}

// "YYYY-MM-DD" → lokales Date (ohne Zeitzonen-Verschiebung).
function keyToDate(key: string): Date {
  const [y, m, d] = key.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

// Überfällig = (offen ODER in Arbeit) UND Datum vor heute.
// Erledigte (completed) Jobs sind NIEMALS überfällig.
function isOverdue(job: Job, todayKey: string): boolean {
  if (job.status !== "open" && job.status !== "in_progress") return false;
  const key = getJobDateKey(job);
  return key !== null && key < todayKey;
}

export default function EmployeeJobsCalendarScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { jobs, startJob, completeJob, loading, refreshJobs } = useJobs();

  const todayKey = useMemo(() => formatDateISO(new Date()) ?? "", []);
  const [selectedKey, setSelectedKey] = useState<string>(todayKey);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");

  // Einzige Quelle der Wahrheit ist selectedKey — der angezeigte Monat
  // wird daraus abgeleitet. So können Kalender-Monat und Tagesliste
  // niemals auseinanderlaufen.
  const visibleMonth = useMemo(() => keyToDate(selectedKey), [selectedKey]);

  // Monat vor/zurück: Auswahl in den Zielmonat verschieben (gleicher Tag,
  // bei kürzeren Monaten geklemmt). Hält Monat + Auswahl konsistent.
  const handleChangeMonth = useCallback(
    (next: Date) => {
      const day = keyToDate(selectedKey).getDate();
      const y = next.getFullYear();
      const m = next.getMonth();
      const daysInTarget = new Date(y, m + 1, 0).getDate();
      const clamped = Math.min(day, daysInTarget);
      const nextKey = formatDateISO(new Date(y, m, clamped));
      if (nextKey) setSelectedKey(nextKey);
    },
    [selectedKey],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshJobs();
    } finally {
      setRefreshing(false);
    }
  }, [refreshJobs]);

  // Nur konkrete Einzel-Jobs (Occurrences + echte Single-Jobs).
  // Parent-Recurring-Regeln (jobType 'recurring') fallen hier raus —
  // zusätzlich zur server-seitigen RLS als Client-Schutz.
  const singleJobs = useMemo(
    () => jobs.filter((j) => j.jobType === "single"),
    [jobs],
  );

  // Tage mit Jobs → Punkt im Kalender.
  const markedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const job of singleJobs) {
      const key = getJobDateKey(job);
      if (key) set.add(key);
    }
    return set;
  }, [singleJobs]);

  // Tage mit mindestens einem offenen/laufenden Job → primärer Punkt (Handlungsbedarf).
  const activeMarkedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const job of singleJobs) {
      if (job.status === "open" || job.status === "in_progress") {
        const key = getJobDateKey(job);
        if (key) set.add(key);
      }
    }
    return set;
  }, [singleJobs]);

  // Jobs des ausgewählten Tags, sortiert nach Uhrzeit (ohne Zeit ans Ende).
  const dayJobs = useMemo(() => {
    const list = singleJobs.filter((j) => getJobDateKey(j) === selectedKey);
    return list.sort((a, b) => {
      const ta = getJobDisplayTime(a);
      const tb = getJobDisplayTime(b);
      if (!ta && !tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return ta.localeCompare(tb);
    });
  }, [singleJobs, selectedKey]);

  // Überfällig: offene/laufende Jobs mit Datum vor heute (completed nie).
  const overdueJobs = useMemo(
    () => singleJobs.filter((j) => isOverdue(j, todayKey)),
    [singleJobs, todayKey],
  );

  // Frühester überfälliger Tag (für den Tipp-Sprung).
  const firstOverdueKey = useMemo(() => {
    const keys = overdueJobs
      .map((j) => getJobDateKey(j))
      .filter((k): k is string => !!k)
      .sort((a, b) => a.localeCompare(b));
    return keys[0] ?? null;
  }, [overdueJobs]);

  const handleStart = useCallback(
    async (jobId: string) => {
      setActionError("");
      try {
        await startJob(jobId);
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Job konnte nicht gestartet werden.",
        );
      }
    },
    [startJob],
  );

  const handleComplete = useCallback(
    async (jobId: string) => {
      setActionError("");
      try {
        await completeJob(jobId);
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Job konnte nicht abgeschlossen werden.",
        );
      }
    },
    [completeJob],
  );

  // Ersten überfälligen Tag auswählen — der Kalender springt automatisch
  // mit, weil visibleMonth aus selectedKey abgeleitet ist.
  const handleOverduePress = useCallback(() => {
    if (!firstOverdueKey) return;
    setSelectedKey(firstOverdueKey);
  }, [firstOverdueKey]);

  const selectedLabel = useMemo(
    () =>
      keyToDate(selectedKey).toLocaleDateString("de-DE", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
      }),
    [selectedKey],
  );

  if (loading) return <LoadingScreen debugName="EmployeeJobsCalendar" />;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      <FlatList
        data={dayJobs}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <OfflineBanner />

            <Text style={styles.title}>Jobs</Text>

            <MonthCalendar
              visibleMonth={visibleMonth}
              onChangeMonth={handleChangeMonth}
              selectedKey={selectedKey}
              onSelectDay={setSelectedKey}
              markedKeys={markedKeys}
              activeMarkedKeys={activeMarkedKeys}
              todayKey={todayKey}
            />

            {/* ── Überfällig-Hinweis (tippbar → springt zum ersten Tag) ── */}
            {overdueJobs.length > 0 ? (
              <TouchableOpacity
                style={styles.overdueBanner}
                onPress={handleOverduePress}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="alert-circle"
                  size={18}
                  color={theme.colors.statusOpen}
                />
                <Text style={styles.overdueText}>
                  {overdueJobs.length}{" "}
                  {overdueJobs.length === 1
                    ? "überfälliger Job"
                    : "überfällige Jobs"}
                </Text>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={theme.colors.statusOpen}
                  style={styles.overdueChevron}
                />
              </TouchableOpacity>
            ) : null}

            {/* ── Aktionsfehler (Start/Complete) ── */}
            {actionError ? (
              <ErrorBanner
                message={actionError}
                onDismiss={() => setActionError("")}
              />
            ) : null}

            {/* ── Titel: ausgewähltes Datum ── */}
            <Text style={styles.dayTitle}>{selectedLabel}</Text>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title="Keine Jobs für diesen Tag"
            message={
              markedKeys.size > 0
                ? "Wähle einen markierten Tag im Kalender aus."
                : "Keine Jobs in diesem Monat."
            }
            icon="calendar-outline"
          />
        }
        renderItem={({ item }) => (
          <JobCard
            job={item}
            // Start/Fertig sind Employee-Aktionen (RPCs start_own_job/
            // complete_own_job). JobCard zeigt je Status genau eine Action.
            onStart={() => handleStart(item.id)}
            onComplete={() => handleComplete(item.id)}
            onPress={() => router.push(`/jobs/${item.id}`)}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    listContent: {
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: 96,
      flexGrow: 1,
    },
    header: {
      paddingTop: theme.spacing.xl,
      marginBottom: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    title: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },

    // ── Überfällig-Banner (Warn-Farbschema = statusOpen)
    overdueBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.statusOpenBg,
      borderWidth: 1,
      borderColor: theme.colors.statusOpenBorder,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    overdueText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.statusOpen,
    },
    overdueChevron: {
      marginLeft: "auto",
    },

    // ── Titel des ausgewählten Tags
    dayTitle: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      textTransform: "capitalize",
    },

    separator: {
      height: theme.spacing.sm,
    },
  });
}
