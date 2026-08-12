// features/jobs/EmployeeJobsCalendarScreen.tsx
// ─────────────────────────────────────────────────────────────────
// Mitarbeiter-Jobs-Tab: VOLLFLÄCHIGER Monatskalender.
//
// Vorher war das ein kleiner Kalender-Block über einer Tagesliste — der
// Monat bekam ein Drittel des Bildschirms, die Zellen trugen nur einen Punkt
// („irgendwas ist an dem Tag"), und wer wissen wollte, wann und bei wem er
// arbeitet, musste jeden Tag einzeln antippen.
//
// Jetzt ist der Monat der Bildschirm: jede Zelle zeigt die konkreten
// Aufträge des Tages mit Uhrzeit und Kunde. Ein Blick beantwortet „welche
// Tage sind belegt, wie voll, ab wann und bei wem".
//
// Rollen-/Datenlage unverändert:
// - Datenquelle bleibt `useJobs().jobs` (Employee: RLS-begrenzt auf eigene
//   Aufträge, keine Firmen-Abfrage, keine eigene Query in diesem Screen).
// - Es werden weiterhin ausschließlich `jobType === "single"` gezeigt, also
//   echte Einzelaufträge UND materialisierte Occurrences von Daueraufträgen.
//   Parent-Regeln haben keinen Kalendertag und bleiben draußen.
// - Start/Abschließen laufen unverändert über den JobContext; das Gating
//   bleibt `canRunJobActions` (nicht neu gebaut, nicht gelockert).
//
// Aufbau:
//   Kopf   → Monat + Jahr, „Heute", Monat vor/zurück
//   Raster → MonthGrid (füllt die Restfläche, 4–6 Wochenzeilen)
//   Sheet  → DayAgendaSheet mit der VOLLSTÄNDIGEN Tagesliste
// ─────────────────────────────────────────────────────────────────

import { LoadingScreen, OfflineBanner } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { DayAgendaSheet } from "@/features/jobs/components/DayAgendaSheet";
import { MonthGrid } from "@/features/jobs/components/MonthGrid";
import { useAppTheme } from "@/hooks/useAppTheme";
import {
  addMonths,
  formatMonthLabel,
  getJobDateKey,
  groupJobsByDateKey,
  monthKeyOf,
} from "@/utils/calendarMonth";
import { formatDateISO } from "@/utils/date";
import { canRunJobActions } from "@/utils/jobAssignees";
import { toUserMessage } from "@/utils/userMessages";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const EMPTY_JOBS: never[] = [];

export default function EmployeeJobsCalendarScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { role, profile } = useAuth();
  const { jobs, startJob, completeJob, loading, refreshJobs } = useJobs();

  const todayKey = useMemo(() => formatDateISO(new Date()) ?? "", []);
  const todayMonthKey = useMemo(() => monthKeyOf(new Date()), []);

  // Angezeigter Monat und ausgewählter Tag sind BEWUSST getrennter State.
  // In der alten Ansicht war der Monat aus der Auswahl abgeleitet — dadurch
  // verschob Blättern zwangsweise auch die Auswahl. In einer Vollbild-Ansicht
  // will man einen Monat ansehen können, ohne die Auswahl zu verlieren.
  const [monthKey, setMonthKey] = useState(todayMonthKey);
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");

  // Merkt sich, dass wir selbst in ein Job-Detail navigiert haben. Beim
  // Zurückkommen bleibt der betrachtete Monat dann stehen (sonst wäre der
  // Weg „Tag im Dezember → Job öffnen → zurück" jedes Mal zurückgesetzt).
  // Kommt der Fokus dagegen von einem anderen Tab — etwa über „alle
  // anzeigen" aus der Übersicht —, startet der Kalender wieder auf heute.
  const cameFromDetailRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (cameFromDetailRef.current) {
        cameFromDetailRef.current = false;
        return;
      }
      setMonthKey(todayMonthKey);
      setSelectedKey(todayKey);
      setSheetOpen(false);
    }, [todayMonthKey, todayKey]),
  );

  // ── Daten ────────────────────────────────────────────────────
  // Nur konkrete Einzeltermine (echte Single-Jobs + Occurrences).
  // Parent-Recurring-Regeln fallen raus — zusätzlich zur serverseitigen RLS
  // als Client-Schutz, unverändert zur bisherigen Ansicht.
  const singleJobs = useMemo(
    () => jobs.filter((j) => j.jobType === "single"),
    [jobs],
  );

  // Einmal gruppieren statt 42-mal filtern (siehe utils/calendarMonth).
  const jobsByDay = useMemo(() => groupJobsByDateKey(singleJobs), [singleJobs]);

  const selectedJobs = useMemo(
    () => jobsByDay.get(selectedKey) ?? EMPTY_JOBS,
    [jobsByDay, selectedKey],
  );

  // Hat der angezeigte Monat überhaupt Aufträge? Nur für den dezenten
  // Hinweis unter dem Raster — das Raster selbst bleibt IMMER stehen.
  const monthHasJobs = useMemo(() => {
    for (const key of jobsByDay.keys()) {
      if (key.startsWith(monthKey)) return true;
    }
    return false;
  }, [jobsByDay, monthKey]);

  // Überfällig = offen/in Arbeit UND Datum vor heute. Erledigte nie.
  const overdueKeys = useMemo(() => {
    const keys: string[] = [];
    for (const job of singleJobs) {
      if (job.status !== "open" && job.status !== "in_progress") continue;
      const key = getJobDateKey(job);
      if (key && key < todayKey) keys.push(key);
    }
    return keys.sort((a, b) => a.localeCompare(b));
  }, [singleJobs, todayKey]);

  // ── Navigation ───────────────────────────────────────────────
  const goPrevMonth = useCallback(
    () => setMonthKey((m) => addMonths(m, -1)),
    [],
  );
  const goNextMonth = useCallback(() => setMonthKey((m) => addMonths(m, 1)), []);

  const goToday = useCallback(() => {
    setMonthKey(todayMonthKey);
    setSelectedKey(todayKey);
  }, [todayMonthKey, todayKey]);

  // Tag auswählen. Ein Tag mit Aufträgen öffnet zusätzlich die vollständige
  // Tages-Agenda — für einen leeren Tag wäre ein Sheet nur ein Klick, den
  // man wieder wegtippen muss, deshalb bleibt es dort aus.
  const handleSelectDay = useCallback(
    (key: string) => {
      setSelectedKey(key);
      // Tag aus einem Nachbarmonat angetippt → in diesen Monat wechseln.
      const keyMonth = key.slice(0, 7);
      if (keyMonth !== monthKey) setMonthKey(keyMonth);
      if ((jobsByDay.get(key)?.length ?? 0) > 0) setSheetOpen(true);
    },
    [jobsByDay, monthKey],
  );

  const handleOpenJob = useCallback((jobId: string) => {
    cameFromDetailRef.current = true;
    router.push(`/jobs/${jobId}`);
  }, []);

  // Zum frühesten überfälligen Tag springen (Monat + Auswahl + Agenda).
  const handleOverduePress = useCallback(() => {
    const first = overdueKeys[0];
    if (!first) return;
    handleSelectDay(first);
  }, [overdueKeys, handleSelectDay]);

  // ── Aktionen (unverändert über den JobContext) ───────────────
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshJobs();
    } finally {
      setRefreshing(false);
    }
  }, [refreshJobs]);

  const handleStart = useCallback(
    async (jobId: string) => {
      setActionError("");
      try {
        await startJob(jobId);
      } catch (err: unknown) {
        setActionError(toUserMessage(err, "Job konnte nicht gestartet werden."));
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
          toUserMessage(err, "Job konnte nicht abgeschlossen werden."),
        );
      }
    },
    [completeJob],
  );

  const canRunActions = useCallback(
    (job: Parameters<typeof canRunJobActions>[0]) =>
      canRunJobActions(job, role, profile?.id),
    [role, profile?.id],
  );

  const isOnTodayMonth = monthKey === todayMonthKey;

  if (loading) return <LoadingScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      {/* Der Kalender scrollt nicht (er füllt genau den Bildschirm) — die
          ScrollView ist ausschließlich Träger des Pull-to-Refresh, das die
          bisherige Listenansicht hatte. */}
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
          />
        }
      >
        <OfflineBanner />

        {/* ── Kopf: Monat + Jahr, Heute, Blättern ── */}
        <View style={styles.header}>
          <Text style={styles.monthLabel} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {formatMonthLabel(monthKey)}
          </Text>

          <TouchableOpacity
            style={[styles.todayBtn, isOnTodayMonth && styles.todayBtnQuiet]}
            onPress={goToday}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Zu heute springen"
          >
            <Text style={styles.todayBtnText} maxFontSizeMultiplier={1.3}>
              Heute
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.navBtn}
            onPress={goPrevMonth}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel="Vorheriger Monat"
          >
            <Ionicons name="chevron-back" size={20} color={theme.colors.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.navBtn}
            onPress={goNextMonth}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Nächster Monat"
          >
            <Ionicons name="chevron-forward" size={20} color={theme.colors.primary} />
          </TouchableOpacity>
        </View>

        {/* ── Überfällig-Hinweis (springt zum frühesten offenen Tag) ── */}
        {overdueKeys.length > 0 ? (
          <TouchableOpacity
            style={styles.overdueBanner}
            onPress={handleOverduePress}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            <Ionicons name="alert-circle" size={16} color={theme.colors.statusOpen} />
            <Text style={styles.overdueText} numberOfLines={1}>
              {overdueKeys.length === 1
                ? "1 überfälliger Auftrag"
                : `${overdueKeys.length} überfällige Aufträge`}
            </Text>
            <Ionicons
              name="chevron-forward"
              size={14}
              color={theme.colors.statusOpen}
            />
          </TouchableOpacity>
        ) : null}

        {/* ── Monatsraster (füllt die Restfläche) ── */}
        <MonthGrid
          monthKey={monthKey}
          selectedKey={selectedKey}
          todayKey={todayKey}
          jobsByDay={jobsByDay}
          onSelectDay={handleSelectDay}
          onOpenJob={handleOpenJob}
        />

        {/* Leerer Monat: der Kalender bleibt stehen, es kommt nur eine
            ruhige Zeile dazu — kein EmptyState, der das Raster ersetzt. */}
        {!monthHasJobs ? (
          <Text style={styles.emptyMonthHint} numberOfLines={2}>
            In diesem Monat sind dir keine Aufträge zugewiesen.
          </Text>
        ) : null}
      </ScrollView>

      <DayAgendaSheet
        visible={sheetOpen}
        dayKey={selectedKey}
        jobs={selectedJobs}
        onClose={() => setSheetOpen(false)}
        onOpenJob={handleOpenJob}
        canRunActions={canRunActions}
        onStart={handleStart}
        onComplete={handleComplete}
        errorMessage={actionError}
        onDismissError={() => setActionError("")}
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
    flex: {
      flex: 1,
    },
    // flexGrow statt fester Höhe: der Inhalt füllt mindestens den Bildschirm,
    // damit MonthGrid seine `flex: 1`-Restfläche bekommt.
    scrollContent: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.sm,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.sm,
      gap: theme.spacing.sm,
    },

    // ── Kopfzeile
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.xs,
    },
    monthLabel: {
      flex: 1,
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
      textTransform: "capitalize",
    },
    todayBtn: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.primary,
    },
    // Auf dem aktuellen Monat bleibt „Heute" bedienbar (es setzt dann noch
    // die Auswahl zurück), tritt optisch aber zurück.
    todayBtnQuiet: {
      borderColor: theme.colors.outlineVariant,
    },
    todayBtnText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
    },
    navBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceContainerHigh,
    },

    // ── Überfällig-Banner (Warn-Farbschema = statusOpen)
    overdueBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      backgroundColor: theme.colors.statusOpenBg,
      borderWidth: 1,
      borderColor: theme.colors.statusOpenBorder,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
    },
    overdueText: {
      flex: 1,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.statusOpen,
    },

    emptyMonthHint: {
      textAlign: "center",
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
