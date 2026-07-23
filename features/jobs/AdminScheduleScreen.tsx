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
  type ScheduleFilter,
} from "@/utils/scheduleView";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// Auswahl im Mitarbeiter-Filter: alle, unzugewiesen, oder eine Mitarbeiter-ID.
type EmployeeSelection = "all" | "unassigned" | string;

// Standard-Fenster für „Bevorstehend": ab morgen bis +60 Tage.
const UPCOMING_DAYS = 60;

export default function AdminScheduleScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const todayKey = useMemo(() => formatDateISO(new Date()) ?? "", []);

  // Aktive Mitarbeiter für den Filter (Nicht-zugewiesen-Option zusätzlich).
  const { employees } = useJobs();
  const activeEmployees = useMemo(
    () => employees.filter((e) => e.isActive !== false),
    [employees],
  );

  const [filter, setFilter] = useState<ScheduleFilter>("heute");
  // Mitarbeiter-Auswahl bleibt über Filterwechsel/Refresh/Realtime erhalten.
  const [employeeSel, setEmployeeSel] = useState<EmployeeSelection>("all");
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

  const sections = useMemo(() => {
    const direction = filter === "erledigt" ? "desc" : "asc";
    return groupByDate(jobs, todayKey, direction);
  }, [jobs, todayKey, filter]);

  return (
    <View style={styles.container}>
      {/* ── Filter-Chips ── */}
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

      {/* ── Mitarbeiter-Filter (serverseitig, bleibt über Filterwechsel) ── */}
      {activeEmployees.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.employeeRow}
          keyboardShouldPersistTaps="handled"
        >
          <EmpChip
            label="Alle Mitarbeiter"
            active={employeeSel === "all"}
            onPress={() => setEmployeeSel("all")}
            styles={styles}
          />
          <EmpChip
            label="Nicht zugewiesen"
            active={employeeSel === "unassigned"}
            onPress={() => setEmployeeSel("unassigned")}
            styles={styles}
          />
          {activeEmployees.map((emp) => (
            <EmpChip
              key={emp.id}
              label={emp.fullName}
              active={employeeSel === emp.id}
              onPress={() => setEmployeeSel(emp.id)}
              styles={styles}
            />
          ))}
        </ScrollView>
      ) : null}

      {error ? (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
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
            <EmptyState
              title="Keine Termine"
              message={emptyMessageFor(filter)}
              icon="calendar-outline"
            />
          }
        />
      )}
    </View>
  );
}

// Mitarbeiter-Filter-Chip (gleiches Muster wie die frühere Admin-Jobliste).
function EmpChip({
  label,
  active,
  onPress,
  styles,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={[styles.empChip, active && styles.empChipActive]}
    >
      <Text
        style={[styles.empChipText, active && styles.empChipTextActive]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
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
    // ── Mitarbeiter-Filter
    employeeRow: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.sm,
    },
    empChip: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
      maxWidth: 180,
    },
    empChipActive: {
      backgroundColor: theme.colors.statusInProgressBg,
      borderColor: theme.colors.statusInProgressBorder,
    },
    empChipText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    empChipTextActive: {
      color: theme.colors.statusInProgress,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
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
