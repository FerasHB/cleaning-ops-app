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

import { Card, EmptyState, ErrorBanner } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import { useJobs } from "@/context/JobContext";
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
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
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

  // Aktiv-Status je Mitarbeiter für die „Mitarbeiter inaktiv"-Warnung.
  const employeeActive = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const e of employees) map.set(e.id, e.isActive !== false);
    return map;
  }, [employees]);

  const load = useCallback(async (isRefresh = false) => {
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
      setLoading(false);
      setRefreshing(false);
    }
  }, [todayKey]);

  useEffect(() => {
    load();
  }, [load]);

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

  if (loading) {
    return (
      <View style={styles.centerBox}>
        <ActivityIndicator color={theme.colors.primary} />
        <Text style={styles.centerText}>Daueraufträge werden geladen …</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
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
      {error ? (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      ) : null}

      {rules.length === 0 ? (
        <EmptyState
          title="Keine Daueraufträge"
          message="Sobald du einen wiederkehrenden Auftrag anlegst, erscheint er hier."
          icon="repeat-outline"
        />
      ) : (
        rules.map((rule) => {
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
