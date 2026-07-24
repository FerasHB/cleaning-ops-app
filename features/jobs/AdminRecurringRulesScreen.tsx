// features/jobs/AdminRecurringRulesScreen.tsx
// Daueraufträge (Admin): zeigt AUSSCHLIESSLICH Parent-Regeln
// (job_type='recurring', parent_job_id IS NULL). Generierte Occurrences
// erscheinen hier NIE — die leben im Zeitplan.
//
// Pro Regel: Kunde/Objekt, Service, Ort, Wochentage, Uhrzeit, Zuweisung,
// Zeitraum, Aktiv/Inaktiv, nächster generierter Termin, Gesundheitszustand
// (Badge) sowie Aktionen Bearbeiten / (De-)Aktivieren / Löschen.
//
// Datenquelle: eigene gebundene Queries (getRecurringRules +
// getUpcomingOccurrenceSummaries), NICHT das volle JobContext-Array.
//
// Lädt bei jedem Fokussieren neu (useFocusEffect), nicht nur beim Mounten —
// app/jobs/[id]/edit ist ein eigener Root-Stack-Screen, der diesen Screen
// beim Zurücknavigieren NICHT neu mountet (siehe Kommentar bei `load`).
//
// Verwaltungsansicht statt operativer Zeitplan: bewusst KEINE permanenten
// Status-/Mitarbeiter-Chip-Reihen (siehe Zeitplan). Stattdessen ein
// Suchfeld + ein kompakter Filter-Button (Sliders-Icon), der ein
// Bottom-Sheet mit Status/Mitarbeiter/Wochentage öffnet. Aktive Filter
// erscheinen als EIN entfernbarer Zusammenfassungs-Chip, sonst nichts.
// Filterlogik (Suche + Status + Mitarbeiter + Wochentage) läuft clientseitig
// über die bereits serverseitig kleine, gebundene Regel-Liste — siehe
// utils/recurringRuleFilter.ts.

import { Card, EmptyState, ErrorBanner } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import { useJobs } from "@/context/JobContext";
import { employeeSelectionLabel } from "@/features/jobs/components/EmployeeFilterControl";
import { RuleFilterSheet } from "@/features/jobs/components/RuleFilterSheet";
import {
  getRecurringRules,
  getUpcomingOccurrenceSummaries,
  setRecurringRuleActive,
  type RuleOccurrenceSummaryRow,
} from "@/services/jobs/jobs.service";
import type { Job } from "@/types/job";
import { formatDateISO } from "@/utils/date";
import { formatRecurringDays } from "@/utils/recurrence";
import {
  deriveRuleHealth,
  type RuleHealth,
} from "@/utils/recurringRule";
import {
  DEFAULT_RULE_FILTERS,
  isRuleFiltersActive,
  matchesRuleSearchAndFilters,
  ruleFilterSummaryParts,
  type RuleFilters,
} from "@/utils/recurringRuleFilter";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { router } from "expo-router";
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

function formatDateGerman(key: string | null): string {
  if (!key) return "—";
  const [y, m, d] = key.split("-");
  if (!y || !m || !d) return "—";
  return `${d}.${m}.${y}`;
}

export default function AdminRecurringRulesScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { employees, deleteJob } = useJobs();

  const todayKey = useMemo(() => formatDateISO(new Date()) ?? "", []);

  const [rules, setRules] = useState<Job[]>([]);
  const [summaries, setSummaries] = useState<
    Map<string, RuleOccurrenceSummaryRow>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Suche + strukturierte Filter: eigener, unabhängiger State. Keiner der
  // beiden setzt den anderen zurück, und beide bleiben über Refresh/Realtime
  // erhalten (sie wirken rein clientseitig auf dem geladenen `rules`-Array).
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<RuleFilters>(DEFAULT_RULE_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  const activeEmployees = useMemo(
    () => employees.filter((e) => e.isActive !== false),
    [employees],
  );

  // Aktiv-Status je Mitarbeiter für die „Mitarbeiter inaktiv"-Warnung.
  const employeeActive = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const e of employees) map.set(e.id, e.isActive !== false);
    return map;
  }, [employees]);

  // Verhindert überlappende Fetches (z. B. Fokus-Rückkehr UND ein noch
  // laufender Pull-to-Refresh treffen fast gleichzeitig ein) — gleiches
  // Muster wie loadInProgress im Zeitplan (AdminScheduleScreen).
  const loadInProgressRef = useRef(false);

  const load = useCallback(async (isRefresh = false) => {
    if (loadInProgressRef.current) return;
    loadInProgressRef.current = true;
    if (!isRefresh) setLoading(true);
    setError(null);
    try {
      const list = await getRecurringRules();
      setRules(list);
      const sums = await getUpcomingOccurrenceSummaries(
        list.map((r) => r.id),
        todayKey,
      );
      setSummaries(sums);
    } catch (err: any) {
      setError(err?.message ?? "Daueraufträge konnten nicht geladen werden.");
    } finally {
      loadInProgressRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [todayKey]);

  // BUGFIX: `app/jobs/[id]/edit` ist ein eigener Root-Stack-Screen (siehe
  // app/_layout.tsx), kein verschachtelter Tab-Screen — er wird ÜBER
  // (admin-tabs) gepusht, ohne diesen Screen zu unmounten. Ein reiner
  // Mount-Effect (früher: `useEffect(() => { load(); }, [load])`) feuert
  // beim Zurücknavigieren daher NIE erneut, und ohne Realtime-Abo auf
  // Parent-Regel-Änderungen blieb `rules` nach einer Bearbeitung dauerhaft
  // veraltet — sichtbar wurde die bereits gespeicherte Änderung bislang nur
  // zufällig über (De-)Aktivieren, weil das der einzige Code-Pfad war, der
  // `load(true)` explizit erneut aufrief.
  //
  // Fix: `useFocusEffect` lädt bei JEDEM Fokussieren neu — beim ersten Mal
  // mit vollem Spinner (Liste ist noch leer), danach still im Hintergrund
  // (isRefresh=true, sichtbar über den bestehenden RefreshControl). Suche
  // und Filter sind unabhängiger State und bleiben davon unberührt.
  const hasLoadedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      load(hasLoadedOnceRef.current);
      hasLoadedOnceRef.current = true;
    }, [load]),
  );

  const handleToggleActive = useCallback(
    async (rule: Job) => {
      setBusyId(rule.id);
      try {
        await setRecurringRuleActive(rule.id, !(rule.isActive ?? true));
        await load(true);
      } catch (err: any) {
        setError(err?.message ?? "Aktion fehlgeschlagen.");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const handleDelete = useCallback(
    (rule: Job) => {
      Alert.alert(
        "Dauerauftrag löschen",
        "Regeln mit bereits gestarteten oder abgeschlossenen Terminen können aus Sicherheitsgründen nicht gelöscht werden. Fortfahren?",
        [
          { text: "Abbrechen", style: "cancel" },
          {
            text: "Löschen",
            style: "destructive",
            onPress: async () => {
              setBusyId(rule.id);
              try {
                await deleteJob(rule.id);
                await load(true);
              } catch (err: any) {
                // Der DB-Guard (PR #42) lehnt unsichere Löschungen ab —
                // Meldung sichtbar machen statt still zu scheitern.
                setError(
                  err?.message ??
                    "Löschen nicht möglich (geschützte Historie).",
                );
              } finally {
                setBusyId(null);
              }
            },
          },
        ],
      );
    },
    [deleteJob, load],
  );

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    load(true);
  }, [load]);

  // Kombinierte Anwendung von Suche UND Status UND Mitarbeiter UND
  // Wochentage auf die bereits geladene, kleine Regel-Liste.
  const visibleRules = useMemo(
    () =>
      rules.filter((rule) => matchesRuleSearchAndFilters(rule, search, filters)),
    [rules, search, filters],
  );

  const filtersActive = isRuleFiltersActive(filters);
  const hasActiveQuery = !!search.trim() || filtersActive;

  // Zusammenfassungs-Chip-Text, z. B. „Aktiv • Lena Brandt • Mo Mi Fr".
  const filterSummary = useMemo(() => {
    if (!filtersActive) return "";
    const employeeLabel = employeeSelectionLabel(filters.employee, employees);
    return ruleFilterSummaryParts(filters, employeeLabel).join(" • ");
  }, [filters, filtersActive, employees]);

  const clearFilters = useCallback(() => {
    setFilters(DEFAULT_RULE_FILTERS);
  }, []);

  return (
    <View style={styles.screen}>
      {/* ── Suche + kompakter Filter-Button ── */}
      <View style={styles.searchRow}>
        <View style={styles.searchBar}>
          <Ionicons
            name="search"
            size={18}
            color={theme.colors.onSurfaceVariant}
          />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Objekt, Kunde, Service, Adresse …"
            placeholderTextColor={theme.colors.outline}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
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

        <TouchableOpacity
          style={[styles.filterButton, filtersActive && styles.filterButtonActive]}
          onPress={() => setFilterSheetOpen(true)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Daueraufträge filtern"
          accessibilityValue={
            filtersActive ? { text: filterSummary } : undefined
          }
          accessibilityHint="Öffnet Status-, Mitarbeiter- und Wochentag-Filter"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons
            name="options-outline"
            size={18}
            color={
              filtersActive
                ? theme.colors.onPrimaryContainer
                : theme.colors.onSurfaceVariant
            }
          />
          {filtersActive ? <View style={styles.filterActiveDot} /> : null}
        </TouchableOpacity>
      </View>

      {/* ── Aktive Filter: EIN entfernbarer Zusammenfassungs-Chip ── */}
      {filtersActive ? (
        <View style={styles.activeFilterRow}>
          <View style={styles.activeFilterChip}>
            <Ionicons
              name="options"
              size={13}
              color={theme.colors.onPrimaryContainer}
            />
            <Text style={styles.activeFilterText} numberOfLines={1}>
              {filterSummary}
            </Text>
            <TouchableOpacity
              onPress={clearFilters}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Alle Filter entfernen"
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

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
          />
        }
      >
        {error ? (
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        ) : null}

        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={styles.centerText}>Daueraufträge werden geladen …</Text>
          </View>
        ) : visibleRules.length === 0 ? (
          hasActiveQuery ? (
            <EmptyState
              title="Keine passenden Daueraufträge"
              message="Passe Suche oder Filter an."
              icon="search-outline"
            />
          ) : (
            <EmptyState
              title="Keine Daueraufträge"
              message="Sobald du einen wiederkehrenden Auftrag anlegst, erscheint er hier."
              icon="repeat-outline"
            />
          )
        ) : (
          visibleRules.map((rule) => {
            const summary = summaries.get(rule.id) ?? {
              parentJobId: rule.id,
              nextOccurrenceDate: null,
              hasOccurrences: false,
            };
            const assigneeActive = rule.employeeId
              ? employeeActive.get(rule.employeeId) ?? null
              : null;
            const health = deriveRuleHealth(
              rule,
              {
                hasOccurrences: summary.hasOccurrences,
                nextOccurrenceDate: summary.nextOccurrenceDate,
              },
              assigneeActive,
              todayKey,
            );
            return (
              <RuleCard
                key={rule.id}
                rule={rule}
                health={health}
                nextDate={summary.nextOccurrenceDate}
                busy={busyId === rule.id}
                onEdit={() => router.push(`/jobs/${rule.id}/edit`)}
                onToggleActive={() => handleToggleActive(rule)}
                onDelete={() => handleDelete(rule)}
                styles={styles}
                theme={theme}
              />
            );
          })
        )}
        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>

      <RuleFilterSheet
        visible={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        filters={filters}
        onApply={setFilters}
        employees={activeEmployees}
      />
    </View>
  );
}

function healthColor(theme: AppTheme, severity: RuleHealth["severity"]): string {
  switch (severity) {
    case "warning":
      return theme.colors.statusOpen;
    case "info":
      return theme.colors.onSurfaceVariant;
    case "ok":
      return theme.colors.statusCompleted;
  }
}

function RuleCard({
  rule,
  health,
  nextDate,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
  styles,
  theme,
}: {
  rule: Job;
  health: RuleHealth;
  nextDate: string | null;
  busy: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const days = formatRecurringDays(rule.recurringDays);
  const active = rule.isActive ?? true;
  const badgeColor = healthColor(theme, health.severity);

  return (
    <Card style={styles.ruleCard}>
      {/* Kopf: Kunde + Health-Badge */}
      <View style={styles.ruleHead}>
        <Text style={styles.ruleCustomer} numberOfLines={1}>
          {rule.customerName}
        </Text>
        <View style={[styles.healthBadge, { borderColor: badgeColor }]}>
          <View style={[styles.healthDot, { backgroundColor: badgeColor }]} />
          <Text style={[styles.healthText, { color: badgeColor }]}>
            {health.label}
          </Text>
        </View>
      </View>

      {rule.service ? (
        <Text style={styles.ruleService} numberOfLines={1}>
          {rule.service}
        </Text>
      ) : null}

      {/* Detail-Zeilen */}
      <View style={styles.detailBlock}>
        <DetailRow icon="location-outline" text={rule.location || "—"} theme={theme} styles={styles} />
        <DetailRow
          icon="calendar-outline"
          text={`${days || "—"}${rule.startTime ? ` · ${rule.startTime} Uhr` : ""}`}
          theme={theme}
          styles={styles}
        />
        <DetailRow
          icon="person-outline"
          text={rule.employeeName ?? "Nicht zugewiesen"}
          theme={theme}
          styles={styles}
        />
        <DetailRow
          icon="time-outline"
          text={`Zeitraum: ${formatDateGerman(rule.recurrenceStartDate ?? null)} – ${formatDateGerman(rule.recurrenceEndDate ?? null)}`}
          theme={theme}
          styles={styles}
        />
        <DetailRow
          icon="play-forward-outline"
          text={`Nächster Termin: ${formatDateGerman(nextDate)}`}
          theme={theme}
          styles={styles}
        />
        {/* Status separat von Health-Badge: eine Regel kann aktiv UND
            zugleich „ungesund" sein (z. B. aktiv + keine Termine generiert) —
            der Health-Badge allein würde dann die Grundinformation
            „läuft die Regel überhaupt?" verdecken. */}
        <DetailRow
          icon={active ? "checkmark-circle-outline" : "pause-circle-outline"}
          text={active ? "Status: Aktiv" : "Status: Inaktiv"}
          theme={theme}
          styles={styles}
        />
      </View>

      {health.hint ? (
        <Text style={styles.hintText}>{health.hint}</Text>
      ) : null}

      {/* Aktionen */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={onEdit}
          disabled={busy}
          activeOpacity={0.8}
        >
          <Ionicons name="create-outline" size={16} color={theme.colors.primary} />
          <Text style={[styles.actionText, { color: theme.colors.primary }]}>
            Bearbeiten
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={onToggleActive}
          disabled={busy}
          activeOpacity={0.8}
        >
          <Ionicons
            name={active ? "pause-outline" : "play-outline"}
            size={16}
            color={theme.colors.onSurfaceVariant}
          />
          <Text style={[styles.actionText, { color: theme.colors.onSurfaceVariant }]}>
            {active ? "Deaktivieren" : "Aktivieren"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={onDelete}
          disabled={busy}
          activeOpacity={0.8}
        >
          <Ionicons name="trash-outline" size={16} color={theme.colors.error} />
          <Text style={[styles.actionText, { color: theme.colors.error }]}>
            Löschen
          </Text>
        </TouchableOpacity>
      </View>

      {busy ? (
        <View style={styles.busyOverlay}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : null}
    </Card>
  );
}

function DetailRow({
  icon,
  text,
  theme,
  styles,
}: {
  icon: any;
  text: string;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.detailRow}>
      <Ionicons name={icon} size={14} color={theme.colors.onSurfaceVariant} />
      <Text style={styles.detailText} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.background },

    // ── Suche + Filter-Button
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
    },
    searchBar: {
      flex: 1,
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
    filterButton: {
      width: theme.spacing.tapTarget,
      height: theme.spacing.tapTarget,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    filterButtonActive: {
      backgroundColor: theme.colors.primaryContainer,
      borderColor: theme.colors.primaryContainer,
    },
    filterActiveDot: {
      position: "absolute",
      top: 6,
      right: 6,
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.colors.primary,
      borderWidth: 1,
      borderColor: theme.colors.surface,
    },

    // ── Aktive Filter (ein entfernbarer Zusammenfassungs-Chip)
    activeFilterRow: {
      flexDirection: "row",
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
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

    container: { flex: 1, backgroundColor: theme.colors.background },
    content: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: 120,
      gap: theme.spacing.md,
      flexGrow: 1,
    },
    centerBox: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.background,
    },
    centerText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    ruleCard: { gap: 6 },
    ruleHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
    },
    ruleCustomer: {
      flex: 1,
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },
    healthBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 9,
      paddingVertical: 3,
      borderRadius: theme.radius.full,
      borderWidth: 1,
    },
    healthDot: { width: 7, height: 7, borderRadius: 4 },
    healthText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    ruleService: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    detailBlock: { gap: 4, marginTop: 4 },
    detailRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    detailText: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },
    hintText: {
      marginTop: 4,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.statusOpen,
    },
    actionRow: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      marginTop: theme.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.outlineVariant,
      paddingTop: theme.spacing.sm,
    },
    actionBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingVertical: 4,
    },
    actionText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
    },
    busyOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surface + "cc",
      borderRadius: theme.radius.lg,
    },
  });
}
