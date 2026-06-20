// features/jobs/JobsListScreen.tsx
// Gemeinsamer Jobs-Tab für Employee und Admin — vollständige Job-Verwaltung/Liste.
// Employee: eigene Jobs + Suche + Status-Filter.
// Admin: alle Firmen-Jobs + Suche + Status-Filter + Mitarbeiter-Filter + Plus-Button.
// Business-Logik (JobContext) unverändert — nur Lesezugriff + bestehende Quick-Actions.
// Pull-to-Refresh: zieht Jobs + Mitarbeiter neu vom Server (refreshJobs + refreshEmployees).
// Sortierung: Datum ↑↓, Kunde A→Z, Status-Reihenfolge (offen → in Arbeit → erledigt).

import { EmptyState, LoadingScreen, OfflineBanner } from "@/components/ui";
import JobCard from "@/components/JobCard";
import { useJobs } from "@/context/JobContext";
import { useAuth } from "@/context/AuthContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";

type Filter = "all" | "open" | "in_progress" | "completed";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "open", label: "Offen" },
  { key: "in_progress", label: "In Arbeit" },
  { key: "completed", label: "Erledigt" },
];

// ── Sortier-Optionen
type SortKey = "datum_asc" | "datum_desc" | "kunde_az" | "status";

const SORT_OPTIONS: { key: SortKey; label: string; icon: string }[] = [
  { key: "datum_asc", label: "Datum ↑", icon: "calendar-outline" },
  { key: "datum_desc", label: "Datum ↓", icon: "calendar-outline" },
  { key: "kunde_az", label: "Kunde A→Z", icon: "text-outline" },
  { key: "status", label: "Status", icon: "funnel-outline" },
];

// Status-Gewichtung für Sortierung: offen zuerst, dann in Arbeit, dann erledigt
const STATUS_ORDER: Record<string, number> = {
  open: 0,
  in_progress: 1,
  completed: 2,
};

export default function JobsListScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { role } = useAuth();
  const { jobs, employees, startJob, completeJob, loading, refreshJobs, refreshEmployees } = useJobs();

  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [employeeId, setEmployeeId] = useState<string | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("datum_asc");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  const isAdmin = role === "admin";

  // ── Pull-to-Refresh: Jobs + Mitarbeiter neu laden
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshJobs(), refreshEmployees()]);
    } finally {
      setRefreshing(false);
    }
  }, [refreshJobs, refreshEmployees]);

  const filteredJobs = useMemo(() => {
    const query = search.trim().toLowerCase();

    const filtered = jobs.filter((job) => {
      // Status-Filter
      if (filter !== "all" && job.status !== filter) return false;

      // Mitarbeiter-Filter (nur Admin)
      if (isAdmin && employeeId !== "all" && job.employeeId !== employeeId) {
        return false;
      }

      // Suche über Kunde / Service / Ort / (Admin) Mitarbeiter
      if (query) {
        const haystack = [
          job.customerName,
          job.service,
          job.location,
          isAdmin ? job.employeeName : null,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      return true;
    });

    // ── Sortierung anwenden
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "datum_asc":
        case "datum_desc": {
          // Datum aus date (single) oder scheduledStart, fehlende Daten ans Ende
          const da = a.date ?? a.scheduledStart ?? "";
          const db = b.date ?? b.scheduledStart ?? "";
          if (!da && !db) return 0;
          if (!da) return 1;
          if (!db) return -1;
          const cmp = da.localeCompare(db);
          return sortKey === "datum_asc" ? cmp : -cmp;
        }
        case "kunde_az":
          return a.customerName.localeCompare(b.customerName, "de");
        case "status":
          return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        default:
          return 0;
      }
    });
  }, [jobs, filter, search, employeeId, isAdmin, sortKey]);

  if (loading) return <LoadingScreen />;

  const hasActiveQuery =
    !!search.trim() || filter !== "all" || (isAdmin && employeeId !== "all");

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      <FlatList
        data={filteredJobs}
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

            {/* ── Titel + Sort-Button ── */}
            <View style={styles.titleRow}>
              <Text style={styles.title}>Jobs</Text>
              <TouchableOpacity
                style={styles.sortButton}
                onPress={() => setSortMenuOpen(true)}
                activeOpacity={0.75}
              >
                <Ionicons
                  name="swap-vertical-outline"
                  size={16}
                  color={theme.colors.onSurfaceVariant}
                />
                <Text style={styles.sortButtonLabel}>
                  {SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? "Sortieren"}
                </Text>
              </TouchableOpacity>
            </View>

            {/* ── Suchleiste ── */}
            <View style={styles.searchBar}>
              <Ionicons
                name="search"
                size={18}
                color={theme.colors.onSurfaceVariant}
              />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder={
                  isAdmin
                    ? "Kunde, Service, Ort oder Mitarbeiter…"
                    : "Kunde, Service oder Ort…"
                }
                placeholderTextColor={theme.colors.outline}
                style={styles.searchInput}
                autoCapitalize="none"
                returnKeyType="search"
                clearButtonMode="while-editing"
              />
              {search.length > 0 && (
                <TouchableOpacity
                  onPress={() => setSearch("")}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons
                    name="close-circle"
                    size={18}
                    color={theme.colors.outline}
                  />
                </TouchableOpacity>
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
                  >
                    <Text
                      style={[
                        styles.chipText,
                        active && styles.chipTextActive,
                      ]}
                    >
                      {f.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* ── Mitarbeiter-Filter (nur Admin) ── */}
            {isAdmin && employees.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.employeeRow}
                keyboardShouldPersistTaps="handled"
              >
                <EmployeeChip
                  label="Alle Mitarbeiter"
                  active={employeeId === "all"}
                  onPress={() => setEmployeeId("all")}
                  styles={styles}
                />
                {employees.map((emp) => (
                  <EmployeeChip
                    key={emp.id}
                    label={emp.fullName}
                    active={employeeId === emp.id}
                    onPress={() => setEmployeeId(emp.id)}
                    styles={styles}
                  />
                ))}
              </ScrollView>
            )}

            {/* ── Ergebniszähler ── */}
            <Text style={styles.resultCount}>
              {filteredJobs.length}{" "}
              {filteredJobs.length === 1 ? "Job" : "Jobs"}
            </Text>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title={
              hasActiveQuery
                ? "Keine passenden Jobs"
                : "Keine Jobs vorhanden"
            }
            message={
              hasActiveQuery
                ? "Passe Suche oder Filter an."
                : "Sobald ein Job erstellt wird, erscheint er hier."
            }
            icon="briefcase-outline"
          />
        }
        renderItem={({ item }) => (
          <JobCard
            job={item}
            // Start/Fertig sind Employee-Aktionen (RPCs start_own_job/
            // complete_own_job verlangen role='employee' UND assigned_to=auth.uid()).
            // Admins dürfen den Status NICHT über diese RPCs ändern → bei ihnen
            // keine Quick-Action-Buttons zeigen, sonst RPC-Fehler "Job not found
            // or not allowed". (JobCard blendet die Buttons ohne diese Props aus.)
            onStart={isAdmin ? undefined : () => startJob(item.id)}
            onComplete={isAdmin ? undefined : () => completeJob(item.id)}
            onPress={() => router.push(`/jobs/${item.id}`)}
            showEmployeeName={isAdmin}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />

      {/* ── Plus-Button (nur Admin) ── */}
      {isAdmin && (
        <TouchableOpacity
          style={styles.fab}
          activeOpacity={0.85}
          onPress={() => router.push("/jobs/create")}
        >
          <Ionicons
            name="add"
            size={28}
            color={theme.colors.onPrimaryContainer}
          />
        </TouchableOpacity>
      )}

      {/* ── Sortier-Menü ── */}
      <Modal
        visible={sortMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSortMenuOpen(false)}
      >
        <Pressable
          style={styles.sortBackdrop}
          onPress={() => setSortMenuOpen(false)}
        >
          <View style={styles.sortSheet}>
            <Text style={styles.sortSheetTitle}>Sortierung</Text>
            {SORT_OPTIONS.map((opt) => {
              const active = sortKey === opt.key;
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={[styles.sortOption, active && styles.sortOptionActive]}
                  activeOpacity={0.75}
                  onPress={() => {
                    setSortKey(opt.key);
                    setSortMenuOpen(false);
                  }}
                >
                  <Ionicons
                    name={opt.icon as any}
                    size={18}
                    color={
                      active
                        ? theme.colors.onPrimaryContainer
                        : theme.colors.onSurfaceVariant
                    }
                  />
                  <Text
                    style={[
                      styles.sortOptionLabel,
                      active && styles.sortOptionLabelActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                  {active && (
                    <Ionicons
                      name="checkmark"
                      size={16}
                      color={theme.colors.onPrimaryContainer}
                      style={{ marginLeft: "auto" }}
                    />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function EmployeeChip({
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
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    title: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    sortButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.sm,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
    },
    sortButtonLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },

    // ── Suchleiste
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

    // ── Status-Filter
    filterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
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
      paddingVertical: 2,
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

    // ── Ergebniszähler
    resultCount: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wide,
      textTransform: "uppercase",
    },

    separator: {
      height: theme.spacing.sm,
    },
    fab: {
      position: "absolute",
      right: theme.spacing.lg,
      bottom: theme.spacing.xl,
      width: 56,
      height: 56,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
      ...theme.shadows.md,
    },

    // ── Sortier-Modal
    sortBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.35)",
      justifyContent: "center",
      alignItems: "center",
      padding: theme.spacing.xl,
    },
    sortSheet: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.md,
      width: "100%",
      maxWidth: 320,
      gap: theme.spacing.xs,
      ...theme.shadows.lg,
    },
    sortSheetTitle: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      paddingHorizontal: theme.spacing.sm,
      paddingBottom: theme.spacing.xs,
      marginBottom: 4,
    },
    sortOption: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 12,
    },
    sortOptionActive: {
      backgroundColor: theme.colors.primaryContainer,
    },
    sortOptionLabel: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    sortOptionLabelActive: {
      color: theme.colors.onPrimaryContainer,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
  });
}
