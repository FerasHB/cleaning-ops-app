// features/jobs/AdminRecurringRulesScreen.tsx
// Daueraufträge (Admin): zeigt AUSSCHLIESSLICH Parent-Regeln
// (job_type='recurring', parent_job_id IS NULL). Generierte Occurrences
// erscheinen hier NIE — die leben im Zeitplan.
//
// Kompakte Regel-Karte (bewusst schmal, damit viele Daueraufträge scanbar
// bleiben): Objekt/Kunde + EIN Zustands-Badge, Service, Ort, Wochentage +
// Uhrzeit, Mitarbeiter, nächster Termin. Der Gültigkeitszeitraum erscheint
// NUR, wenn mindestens ein Datum gesetzt ist (unbegrenzte Regeln zeigten
// vorher die nichtssagende Zeile „Zeitraum: — – —"). Eine separate Zeile
// „Status: Aktiv" gibt es nicht mehr — das Badge sagt dasselbe.
//
// EIN Badge statt Health-Badge + Status-Zeile: Warnungen haben Vorrang vor
// dem gesunden Zustand (siehe ruleBadge weiter unten); die Erklärung zur
// Warnung steht als eine kompakte Hinweiszeile darunter.
//
// Aktionen (Bearbeiten / De-/Aktivieren / Löschen) liegen im Drei-Punkte-Menü
// (ActionMenuSheet — dasselbe Menü wie im JobDetailScreen), die ganze Karte
// öffnet die Job-Detailansicht (/jobs/[id]), die Parent-Regeln inkl.
// generierter Termine darstellt.
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

import {
  ActionMenuSheet,
  Card,
  EmptyState,
  ErrorBanner,
  type ActionMenuItem,
} from "@/components/ui";
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
  Pressable,
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

/**
 * Kompakte Beschriftung des Gültigkeitszeitraums — oder `null`, wenn die
 * Regel unbegrenzt läuft. Dann entfällt die Zeile ganz, statt „— – —" zu
 * zeigen (kein Informationsgewinn, kostet aber Höhe auf jeder Karte).
 */
function formatRangeLabel(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  if (!start && !end) return null;
  if (start && end) return `${formatDateGerman(start)} – ${formatDateGerman(end)}`;
  if (start) return `ab ${formatDateGerman(start)}`;
  return `bis ${formatDateGerman(end!)}`;
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

  // Regel, für die das Drei-Punkte-Menü offen ist (null = geschlossen).
  const [menuRule, setMenuRule] = useState<Job | null>(null);

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

  // Auswahl aus dem Drei-Punkte-Menü. Das Sheet wird zuerst geschlossen und
  // die eigentliche Aktion erst danach ausgelöst: ein Alert (Löschen) oder
  // ein Navigations-Push, der noch während der Schließ-Animation feuert,
  // wird auf iOS vom Modal verschluckt.
  const handleMenuSelect = useCallback(
    (key: string) => {
      const rule = menuRule;
      setMenuRule(null);
      if (!rule) return;
      setTimeout(() => {
        if (key === "edit") {
          router.push(`/jobs/${rule.id}/edit`);
        } else if (key === "toggle") {
          handleToggleActive(rule);
        } else {
          handleDelete(rule);
        }
      }, 250);
    },
    [menuRule, handleToggleActive, handleDelete],
  );

  // Einträge des Drei-Punkte-Menüs — gleiche Aktions-Schlüssel wie im
  // JobDetailScreen, damit beide Menüs identisch zu lesen sind.
  const menuItems: ActionMenuItem[] = useMemo(() => {
    const active = menuRule?.isActive ?? true;
    return [
      { key: "edit", label: "Bearbeiten", icon: "create-outline" },
      {
        key: "toggle",
        label: active ? "Deaktivieren" : "Aktivieren",
        icon: active ? "pause-outline" : "play-outline",
      },
      {
        key: "delete",
        label: "Löschen",
        icon: "trash-outline",
        destructive: true,
      },
    ];
  }, [menuRule]);

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
                onOpen={() => router.push(`/jobs/${rule.id}`)}
                onOpenMenu={() => setMenuRule(rule)}
                styles={styles}
                theme={theme}
              />
            );
          })
        )}
      </ScrollView>

      <RuleFilterSheet
        visible={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        filters={filters}
        onApply={setFilters}
        employees={activeEmployees}
      />

      <ActionMenuSheet
        visible={menuRule !== null}
        title={menuRule?.customerName ?? ""}
        items={menuItems}
        onClose={() => setMenuRule(null)}
        onSelect={handleMenuSelect}
      />
    </View>
  );
}

type BadgeTone = "ok" | "neutral" | "warning";

/**
 * EIN Badge pro Karte. Warnungen haben Vorrang vor dem gesunden Zustand —
 * ein grünes „Aktiv" neben einem Health-Badge sagte zweimal dasselbe, und
 * ein Problem darf nicht hinter „Aktiv" verschwinden.
 *
 * Die Kurzlabels halten den Badge auf schmalen Screens klein; die
 * ausführliche Erklärung steht in `health.hint` unter den Detailzeilen.
 * Die Zustandslogik selbst bleibt unverändert in deriveRuleHealth.
 */
function ruleBadge(health: RuleHealth): { label: string; tone: BadgeTone } {
  switch (health.state) {
    case "completed_rule":
      return { label: "Prüfen", tone: "warning" };
    case "no_occurrences":
      return { label: "Keine Termine", tone: "warning" };
    case "inactive_employee":
      return { label: "MA inaktiv", tone: "warning" };
    case "horizon_expired":
      return { label: "Abgelaufen", tone: "warning" };
    case "inactive":
      return { label: "Inaktiv", tone: "neutral" };
    case "healthy":
      return { label: "Aktiv", tone: "ok" };
  }
}

function RuleCard({
  rule,
  health,
  nextDate,
  busy,
  onOpen,
  onOpenMenu,
  styles,
  theme,
}: {
  rule: Job;
  health: RuleHealth;
  nextDate: string | null;
  busy: boolean;
  onOpen: () => void;
  onOpenMenu: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const days = formatRecurringDays(rule.recurringDays);
  const scheduleText = `${days || "—"}${
    rule.startTime ? ` · ${rule.startTime} Uhr` : ""
  }`;
  const rangeText = formatRangeLabel(
    rule.recurrenceStartDate,
    rule.recurrenceEndDate,
  );
  const badge = ruleBadge(health);
  const badgeStyle = {
    ok: styles.badgeOk,
    neutral: styles.badgeNeutral,
    warning: styles.badgeWarning,
  }[badge.tone];
  const badgeTextStyle = {
    ok: styles.badgeTextOk,
    neutral: styles.badgeTextNeutral,
    warning: styles.badgeTextWarning,
  }[badge.tone];

  return (
    <Pressable
      onPress={onOpen}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`Dauerauftrag ${rule.customerName} öffnen`}
      style={({ pressed }) => (pressed ? styles.cardPressed : undefined)}
    >
      <Card style={styles.ruleCard}>
        {/* Kopf: Objekt/Kunde + EIN Zustands-Badge */}
        <View style={styles.ruleHead}>
          <Text style={styles.ruleCustomer} numberOfLines={1}>
            {rule.customerName}
          </Text>
          <View style={[styles.badge, badgeStyle]}>
            <Text style={[styles.badgeText, badgeTextStyle]} numberOfLines={1}>
              {badge.label}
            </Text>
          </View>
        </View>

        {rule.service ? (
          <Text style={styles.ruleService} numberOfLines={1}>
            {rule.service}
          </Text>
        ) : null}

        <View style={styles.metaBlock}>
          <MetaRow
            icon="location-outline"
            text={rule.location || "—"}
            theme={theme}
            styles={styles}
          />
          <MetaRow
            icon="repeat-outline"
            text={scheduleText}
            theme={theme}
            styles={styles}
          />
          <MetaRow
            icon="person-outline"
            text={rule.employeeName ?? "Nicht zugewiesen"}
            theme={theme}
            styles={styles}
          />
          {/* Zeitraum nur bei gesetztem Start-/Enddatum — unbegrenzte Regeln
              zeigen die Zeile gar nicht (statt „— – —"). */}
          {rangeText ? (
            <MetaRow
              icon="calendar-outline"
              text={rangeText}
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>

        {/* Warnung kompakt: eine Zeile, max. zwei Zeilen Text. */}
        {badge.tone === "warning" && health.hint ? (
          <View style={styles.warnRow}>
            <Ionicons
              name="alert-circle-outline"
              size={14}
              color={theme.colors.statusOpen}
            />
            <Text style={styles.warnText} numberOfLines={2}>
              {health.hint}
            </Text>
          </View>
        ) : null}

        {/* Fuß: nächster Termin + Drei-Punkte-Menü */}
        <View style={styles.footRow}>
          <Text style={styles.nextText} numberOfLines={1}>
            {nextDate
              ? `Nächster Termin: ${formatDateGerman(nextDate)}`
              : "Kein nächster Termin"}
          </Text>
          <TouchableOpacity
            style={styles.menuBtn}
            onPress={onOpenMenu}
            disabled={busy}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={`Aktionen für ${rule.customerName}`}
            accessibilityHint="Öffnet Bearbeiten, Aktivieren/Deaktivieren und Löschen"
          >
            <Ionicons
              name="ellipsis-vertical"
              size={18}
              color={theme.colors.onSurfaceVariant}
            />
          </TouchableOpacity>
        </View>

        {busy ? (
          <View style={styles.busyOverlay}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

function MetaRow({
  icon,
  text,
  theme,
  styles,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  text: string;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.metaRow}>
      <Ionicons name={icon} size={14} color={theme.colors.onSurfaceVariant} />
      <Text style={styles.metaText} numberOfLines={1}>
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
      // Freiraum unter der letzten Karte: der FAB in AdminJobsScreen ist
      // 56 px hoch und sitzt 32 px über der Unterkante (= 88 px), dazu
      // etwas Luft — so verdeckt weder FAB noch Tab-Leiste die letzte Karte.
      paddingBottom: 128,
      gap: theme.spacing.sm,
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
    // ── Kompakte Regel-Karte
    ruleCard: { gap: 3, paddingVertical: 12 },
    cardPressed: { opacity: 0.75 },
    ruleHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
    },
    ruleCustomer: {
      flex: 1,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    // Badge darf auf schmalen Screens schrumpfen, damit der Objektname
    // nicht auf wenige Zeichen zusammengedrückt wird.
    badge: {
      flexShrink: 1,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: theme.radius.full,
      borderWidth: 1,
    },
    badgeText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    badgeOk: {
      backgroundColor: theme.colors.statusCompletedBg,
      borderColor: theme.colors.statusCompletedBorder,
    },
    badgeNeutral: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderColor: theme.colors.outlineVariant,
    },
    badgeWarning: {
      backgroundColor: theme.colors.statusOpenBg,
      borderColor: theme.colors.statusOpenBorder,
    },
    badgeTextOk: { color: theme.colors.statusCompleted },
    badgeTextNeutral: { color: theme.colors.onSurfaceVariant },
    badgeTextWarning: { color: theme.colors.statusOpen },

    ruleService: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    metaBlock: { gap: 2, marginTop: 2 },
    metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    metaText: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },
    warnRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
      marginTop: 4,
    },
    warnText: {
      flex: 1,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      lineHeight: theme.typography.lineHeight.xs,
      color: theme.colors.statusOpen,
    },
    footRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      marginTop: 2,
    },
    nextText: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    // 32×32 sichtbar, per hitSlop (±10) über 44 px Touch-Ziel — die Karte
    // bleibt dadurch flach, ohne das Mindest-Touch-Target zu unterschreiten.
    menuBtn: {
      width: 32,
      height: 32,
      marginVertical: -6,
      marginRight: -6,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
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
