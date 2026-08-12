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
//
// PERFORMANCE (wichtig, siehe PR-Nachbesserung):
// Mitarbeiter mit einer langen Auftragshistorie (real beobachtet: 855
// einzelne Aufträge, davon 823 offen über ~360 Kalendertage verteilt)
// erzeugten in der ersten Fassung dieses Screens über 750 gleichzeitig
// gemountete JobCards in einer einzigen ScrollView — mehrere Sekunden
// blockierter JS-/UI-Thread bei jedem Tab-/Filter-Wechsel, auf dem echten
// Gerät reproduziert. `buildJobQueueSections` selbst ist dabei NICHT das
// Problem (gemessen <1ms für 855 Jobs) — das eager gerenderte DOM war es.
// Der Screen rendert deshalb über eine `SectionList` (Virtualisierung statt
// ScrollView + `.map()`): nur die sichtbaren Zeilen (+ Fenster) werden
// tatsächlich gemountet, ein Filter-Wechsel tauscht nur die Datenquelle der
// Liste aus statt hunderte Kartenbäume neu zu bauen.
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
import {
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ListRenderItemInfo,
  type SectionListData,
} from "react-native";

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

// Eine Zeile der SectionList — ein "Auftrags-Tagesblock" ODER eine
// hervorgehobene Einzel-Sektion (Aktiv/Überfällig/Nächstes). `showMoreCount`
// existiert nur auf der Überfällig-Sektion (progressive Anzeige).
type JobListSection = {
  key: string;
  title: string;
  subtitle?: string;
  showMoreCount?: number;
  data: Job[];
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

  // Teure Ableitung (gemessen <1ms selbst bei 855 Jobs — nicht der
  // Engpass, siehe Datei-Kopf) hängt NUR an jobs/now/role/profile/filter,
  // nicht am "Weitere anzeigen"-Toggle — die Sektions-BERECHNUNG bleibt
  // stabil, während `showAllOverdue` nur bestimmt, wie viel davon sichtbar
  // ist (siehe listSections unten).
  const sections = useMemo(
    () => buildJobQueueSections(jobs, now, role, profile?.id, filter),
    [jobs, now, role, profile?.id, filter],
  );

  const visibleOverdue = showAllOverdue
    ? sections.overdue
    : sections.overdue.slice(0, INITIAL_OVERDUE_COUNT);
  const hiddenOverdueCount = sections.overdue.length - visibleOverdue.length;

  const emptyMessage = EMPTY_MESSAGES[filter];

  // ── Flache Sektionsliste für die SectionList ──
  // Jede Karte erscheint hier in GENAU einer Sektion (siehe Dedup-Regeln in
  // buildJobQueueSections). Historie (pastCompleted) nur im "Erledigt"-
  // Filter, damit "Alle" nicht von alten Abschlüssen dominiert wird.
  const listSections = useMemo<JobListSection[]>(() => {
    const result: JobListSection[] = [];

    if (sections.active.length > 0) {
      result.push({ key: "active", title: "In Arbeit", data: sections.active });
    }

    if (sections.overdue.length > 0) {
      result.push({
        key: "overdue",
        title: "Überfällig",
        subtitle:
          sections.overdue.length === 1
            ? "1 überfälliger Auftrag"
            : `${sections.overdue.length} überfällige Aufträge`,
        data: visibleOverdue,
        showMoreCount: hiddenOverdueCount > 0 ? hiddenOverdueCount : undefined,
      });
    }

    if (sections.next) {
      result.push({ key: "next", title: "Als Nächstes", data: [sections.next] });
    }

    if (sections.today) {
      result.push({
        key: `day-${sections.today.key}`,
        title: sections.today.label,
        data: sections.today.jobs,
      });
    }

    for (const group of sections.future) {
      result.push({ key: `day-${group.key}`, title: group.label, data: group.jobs });
    }

    if (filter === "completed") {
      for (const group of sections.pastCompleted) {
        result.push({ key: `past-${group.key}`, title: group.label, data: group.jobs });
      }
    }

    return result;
  }, [sections, visibleOverdue, hiddenOverdueCount, filter]);

  const keyExtractor = useCallback((job: Job) => job.id, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Job>) => (
      <JobCard
        job={item}
        dueToday={isJobToday(item, now)}
        onPress={() => router.push(`/jobs/${item.id}`)}
        onStart={canRunActions(item) ? () => handleStart(item.id) : undefined}
        onComplete={canRunActions(item) ? () => handleComplete(item.id) : undefined}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now, canRunActions, handleStart, handleComplete],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: SectionListData<Job, JobListSection> }) => (
      <View style={styles.sectionHeaderWrap}>
        <SectionHeader title={section.title} subtitle={section.subtitle} />
      </View>
    ),
    [styles],
  );

  const renderSectionFooter = useCallback(
    ({ section }: { section: SectionListData<Job, JobListSection> }) => (
      <View style={styles.sectionFooterWrap}>
        {section.showMoreCount ? (
          <TouchableOpacity
            style={styles.showMoreButton}
            activeOpacity={0.8}
            onPress={() => setShowAllOverdue(true)}
            accessibilityRole="button"
          >
            <Text style={styles.showMoreText}>
              {`Weitere ${section.showMoreCount} anzeigen`}
            </Text>
            <Ionicons name="chevron-down" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
        ) : null}
      </View>
    ),
    [styles, theme.colors.primary],
  );

  const itemSeparator = useCallback(
    () => <View style={styles.itemSeparator} />,
    [styles],
  );

  // ── Kopf: Titel + kompakte Heute-Zusammenfassung + Status-Filter ──
  // Als ListHeaderComponent, damit er mit der Liste scrollt statt eine
  // zweite, verschachtelte Scroll-Fläche zu erzeugen (SectionList/
  // VirtualizedList darf NICHT in eine ScrollView verschachtelt werden —
  // das hebt die Virtualisierung wieder auf).
  const listHeader = (
    <>
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

      {/* Bewusst KEIN eigenes Dashboard — nur so viel, wie beim ersten
          Blick hilft. Zahlen sind klar "Heute" beschriftet, damit sie sich
          nicht mit dem darunterliegenden Status-Filter vermischen. */}
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
    </>
  );

  const listEmpty = (
    <Card>
      <EmptyState
        title={emptyMessage.title}
        message={emptyMessage.message}
        icon="calendar-outline"
      />
    </Card>
  );

  if (loading) return <LoadingScreen />;

  return (
    <ScreenContainer scrollable={false}>
      <SectionList
        style={styles.list}
        sections={listSections}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        renderSectionFooter={renderSectionFooter}
        ItemSeparatorComponent={itemSeparator}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={<View style={{ height: theme.spacing.xl }} />}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
        // Nur so viel initial rendern, wie für den ersten Bildschirm nötig
        // ist — der eigentliche Fix ist die Virtualisierung selbst
        // (SectionList statt ScrollView + .map über alle Jobs), nicht diese
        // Feinjustierung. RN-Defaults für maxToRenderPerBatch/windowSize
        // bleiben bewusst unangetastet (keine Übertunung ohne Messung).
        initialNumToRender={12}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void handleRefresh();
            }}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.surface}
          />
        }
      />
    </ScreenContainer>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    list: {
      flex: 1,
    },
    listContent: {
      flexGrow: 1,
      paddingBottom: 32,
    },
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

    // ── Sektionen (SectionList: Header/Footer statt umschließendem View)
    sectionHeaderWrap: {
      backgroundColor: theme.colors.background,
    },
    sectionFooterWrap: {
      marginBottom: theme.spacing.xl,
    },
    itemSeparator: {
      height: theme.spacing.sm,
    },

    // ── "Weitere N anzeigen" (Überfällig, progressiv)
    showMoreButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      marginTop: theme.spacing.sm,
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
