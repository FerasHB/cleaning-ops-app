// features/jobs/AdminScheduleScreen.tsx
// Zeitplan (Admin): zeigt AUSSCHLIESSLICH ausführbare Jobs — normale
// Single-Jobs und generierte Recurring-Occurrences. Parent-Regeln erscheinen
// hier NIE (job_type='single' schließt sie aus).
//
// Kernpunkte:
// - Gebundene Datumsbereiche pro Filter (Heute/Bevorstehend/Überfällig/
//   Erledigt) statt der unbeschränkten Jobliste → keine 1000-Zeilen-Gefahr.
// - Gruppierung nach Datum (SectionList) mit stabiler Sortierung.
// - Abweichende Termine (PR #43) werden dezent markiert.
// - Loading-/Empty-/Error-States + Pull-to-Refresh.
// - Datenquelle sind eigene Services (getScheduleOccurrences etc.), NICHT das
//   volle JobContext-Array.

import { EmptyState, ErrorBanner } from "@/components/ui";
import JobCard from "@/components/JobCard";
import {
  employeeSelectionLabel,
  type EmployeeSelection,
} from "@/features/jobs/components/EmployeeFilterControl";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import { supabase } from "@/lib/supabase";
import {
  getCompletedOccurrences,
  getOverdueOccurrences,
  getRecurringRules,
  getScheduleOccurrences,
  type EmployeeFilter,
} from "@/services/jobs/jobs.service";
import type { Job } from "@/types/job";
import { formatDateISO } from "@/utils/date";
import { isDetachedOccurrence, type RuleSchedule } from "@/utils/recurringRule";
import {
  SCHEDULE_FILTERS,
  groupByDate,
  matchesSearch,
  type ScheduleFilter,
} from "@/utils/scheduleView";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

// Standard-Fenster für „Bevorstehend": ab morgen bis +60 Tage.
const UPCOMING_DAYS = 60;

type Props = {
  /** Aktuelle Mitarbeiter-Auswahl (liegt im Host, siehe AdminJobsScreen). */
  employeeSel: EmployeeSelection;
  /** Setzt die Auswahl auf „Alle Mitarbeiter" zurück (Chip-Schließen). */
  onClearEmployee: () => void;
};

export default function AdminScheduleScreen({
  employeeSel,
  onClearEmployee,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const todayKey = useMemo(() => formatDateISO(new Date()) ?? "", []);

  // employees nur noch für das Label des Aktiv-Chips;
  // unreadJobIds speist die Ungelesen-Punkte auf den Karten.
  const { employees, unreadJobIds } = useJobs();

  const [filter, setFilter] = useState<ScheduleFilter>("heute");
  // Suchtext bleibt erhalten (eigener State, wird nirgends zurückgesetzt —
  // weder bei Filter-/Mitarbeiterwechsel noch beim Refresh).
  const [search, setSearch] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  // Regel-Terminierung je Parent-ID → für die Abweichender-Termin-Erkennung.
  const [ruleMap, setRuleMap] = useState<Map<string, RuleSchedule>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInProgress = useRef(false);

  // Übersetzt die UI-Auswahl in den serverseitigen Mitarbeiter-Filter.
  const buildEmployeeFilter = useCallback(
    (sel: EmployeeSelection): EmployeeFilter | undefined => {
      if (sel === "all") return undefined;
      if (sel === "unassigned") return { unassigned: true };
      return { employeeId: sel };
    },
    [],
  );

  const fetchForFilter = useCallback(
    async (f: ScheduleFilter, emp?: EmployeeFilter): Promise<Job[]> => {
      switch (f) {
        case "heute":
          return getScheduleOccurrences({
            from: todayKey,
            to: todayKey,
            employee: emp,
          });
        case "bevorstehend": {
          const to = new Date(todayKey);
          to.setDate(to.getDate() + UPCOMING_DAYS);
          const from = new Date(todayKey);
          from.setDate(from.getDate() + 1); // ab morgen
          return getScheduleOccurrences({
            from: formatDateISO(from) ?? todayKey,
            to: formatDateISO(to) ?? todayKey,
            statuses: ["open", "in_progress"],
            employee: emp,
          });
        }
        case "ueberfaellig":
          return getOverdueOccurrences(todayKey, emp);
        case "erledigt":
          return getCompletedOccurrences(undefined, emp);
      }
    },
    [todayKey],
  );

  const load = useCallback(
    async (f: ScheduleFilter, sel: EmployeeSelection, isRefresh = false) => {
      if (loadInProgress.current) return;
      loadInProgress.current = true;
      if (!isRefresh) setLoading(true);
      setError(null);
      try {
        const emp = buildEmployeeFilter(sel);
        // Regeln parallel laden (wenige Zeilen) für die Abweichungs-Erkennung.
        const [items, rules] = await Promise.all([
          fetchForFilter(f, emp),
          getRecurringRules(),
        ]);
        const map = new Map<string, RuleSchedule>();
        for (const r of rules) {
          map.set(r.id, {
            recurringDays: r.recurringDays,
            startTime: r.startTime,
            recurrenceStartDate: r.recurrenceStartDate,
            recurrenceEndDate: r.recurrenceEndDate,
          });
        }
        setRuleMap(map);
        setJobs(items);
      } catch (err: any) {
        setError(err?.message ?? "Zeitplan konnte nicht geladen werden.");
      } finally {
        loadInProgress.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [fetchForFilter, buildEmployeeFilter],
  );

  // Bei Filter- ODER Mitarbeiter-Wechsel neu laden (Auswahl bleibt erhalten).
  useEffect(() => {
    load(filter, employeeSel);
  }, [filter, employeeSel, load]);

  // Realtime: nur die aktuelle Ansicht (aktueller Filter + Mitarbeiter) neu
  // laden, keine vollständige Historie. Firmen-Scoping erfolgt über RLS.
  useEffect(() => {
    const channel = supabase
      .channel("admin-schedule-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "jobs" },
        () => {
          // Aktuellen Filter + Mitarbeiter leise neu laden (bounded).
          load(filter, employeeSel, true);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [filter, employeeSel, load]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    load(filter, employeeSel, true);
  }, [filter, employeeSel, load]);

  // Ungelesene Kommentare auf die (gebundenen) Zeitplan-Zeilen mergen.
  // Quelle ist die bereits geladene, gebündelte Unread-Liste aus dem Context —
  // kein zusätzlicher Request. mapJob setzt hasUnreadComments bewusst nicht.
  const jobsWithUnread = useMemo(() => {
    if (unreadJobIds.length === 0) return jobs;
    const unread = new Set(unreadJobIds);
    return jobs.map((j) =>
      unread.has(j.id) ? { ...j, hasUnreadComments: true } : j,
    );
  }, [jobs, unreadJobIds]);

  // Suche: rein clientseitig auf dem BEREITS begrenzten Ergebnis (nie ein
  // Voll-Fetch). ODER-Semantik über Kunde/Objekt, Service, Adresse und
  // Mitarbeitername; kombiniert per UND mit Status- und Mitarbeiter-Filter.
  const visibleJobs = useMemo(
    () => jobsWithUnread.filter((job) => matchesSearch(job, search)),
    [jobsWithUnread, search],
  );

  const sections = useMemo(() => {
    const direction = filter === "erledigt" ? "desc" : "asc";
    return groupByDate(visibleJobs, todayKey, direction);
  }, [visibleJobs, todayKey, filter]);

  // Ist gerade irgendein Filter/Suchbegriff aktiv? (für den Empty-State)
  const hasActiveQuery = !!search.trim() || employeeSel !== "all";

  // Anzeigename der aktiven Mitarbeiter-Auswahl (für den Chip).
  const employeeLabel = useMemo(
    () => employeeSelectionLabel(employeeSel, employees),
    [employeeSel, employees],
  );

  return (
    <View style={styles.container}>
      {/* ── 1. Suche ── */}
      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Ionicons
            name="search"
            size={18}
            color={theme.colors.onSurfaceVariant}
          />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Objekt, Kunde, Adresse, Service, Mitarbeiter …"
            placeholderTextColor={theme.colors.outline}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="never"
          />
          {search.length > 0 ? (
            <TouchableOpacity
              onPress={() => setSearch("")}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Suche löschen"
            >
              <Ionicons
                name="close-circle"
                size={18}
                color={theme.colors.outline}
              />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* ── 2. Status-/Zeit-Filter ── */}
      <View style={styles.filterRow}>
        {SCHEDULE_FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              onPress={() => setFilter(f.key)}
              activeOpacity={0.8}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── 3. Aktiver Mitarbeiter-Filter: EIN entfernbarer Chip ──
          Nur sichtbar, wenn wirklich gefiltert wird — bei „Alle Mitarbeiter"
          bleibt der Header schlank. */}
      {employeeSel !== "all" ? (
        <View style={styles.activeFilterRow}>
          <View style={styles.activeFilterChip}>
            <Ionicons
              name="people"
              size={13}
              color={theme.colors.onPrimaryContainer}
            />
            <Text style={styles.activeFilterText} numberOfLines={1}>
              Mitarbeiter: {employeeLabel}
            </Text>
            <TouchableOpacity
              onPress={onClearEmployee}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel={`Mitarbeiter-Filter ${employeeLabel} entfernen`}
            >
              <Ionicons
                name="close"
                size={14}
                color={theme.colors.onPrimaryContainer}
              />
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {error ? (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      ) : null}

      {/* Ergebniszähler (nur wenn Treffer vorhanden) */}
      {!loading && visibleJobs.length > 0 ? (
        <Text style={styles.resultCount}>
          {visibleJobs.length} {visibleJobs.length === 1 ? "Termin" : "Termine"}
        </Text>
      ) : null}

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={styles.centerText}>Zeitplan wird geladen …</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          // Taps auf Karten/Chips funktionieren auch bei offener Tastatur.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
              colors={[theme.colors.primary]}
            />
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionHeaderText}>{section.title}</Text>
              <Text style={styles.sectionCount}>{section.data.length}</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <View style={styles.cardWrap}>
              <JobCard
                job={item}
                showEmployeeName
                detached={isDetachedOccurrence(
                  item,
                  item.parentJobId
                    ? ruleMap.get(item.parentJobId)
                    : undefined,
                )}
                onPress={() => router.push(`/jobs/${item.id}`)}
              />
            </View>
          )}
          ListEmptyComponent={
            hasActiveQuery ? (
              <EmptyState
                title="Keine passenden Termine"
                message="Passe Suche oder Mitarbeiter-Filter an."
                icon="search-outline"
              />
            ) : (
              <EmptyState
                title="Keine Termine"
                message={emptyMessageFor(filter)}
                icon="calendar-outline"
              />
            )
          }
        />
      )}
    </View>
  );
}

function emptyMessageFor(filter: ScheduleFilter): string {
  switch (filter) {
    case "heute":
      return "Für heute sind keine Termine geplant.";
    case "bevorstehend":
      return "In den nächsten Wochen sind keine Termine geplant.";
    case "ueberfaellig":
      return "Es gibt keine überfälligen Termine. 👍";
    case "erledigt":
      return "Noch keine abgeschlossenen Termine.";
  }
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    // ── Suchleiste (gleiche Optik wie in der früheren Admin-Jobliste)
    searchWrap: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
    },
    searchBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 10,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },
    resultCount: {
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.xs,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wide,
      textTransform: "uppercase",
    },
    filterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.sm,
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
    // ── Aktiver Mitarbeiter-Filter (ein entfernbarer Chip)
    activeFilterRow: {
      flexDirection: "row",
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.sm,
    },
    activeFilterChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      maxWidth: "100%",
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 6,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primaryContainer,
    },
    activeFilterText: {
      flexShrink: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onPrimaryContainer,
    },
    listContent: {
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: 120,
      flexGrow: 1,
    },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.xs,
    },
    sectionHeaderText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      textTransform: "capitalize",
    },
    sectionCount: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    cardWrap: { marginBottom: theme.spacing.sm },
    centerBox: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
    },
    centerText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
