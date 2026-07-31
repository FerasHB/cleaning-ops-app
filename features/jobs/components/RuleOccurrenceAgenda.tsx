// features/jobs/components/RuleOccurrenceAgenda.tsx
// Termin-Agenda einer Dauerauftrags-Regel — Nachfolger von RuleOccurrences.
//
// PROBLEM DER VORVERSION: alle kommenden Termine lagen in einem eigenen
// ScrollView mit fester maxHeight (360 px) INNERHALB des Seiten-ScrollViews.
// Das ergab eine Scroll-Falle ohne sichtbare Affordanz, auf Android zwei
// konkurrierende Gesten — und trotzdem waren alle Zeilen gleichzeitig
// eingehängt. Vergangenes wurde in Zehnerschritten nachgeladen, ohne
// Gruppierung: ein Quartal durchzusehen kostete rund neun Taps.
//
// JETZT — progressive Offenlegung statt Scroll-im-Scroll:
//   • „Als Nächstes": die nächsten fünf Termine, immer sichtbar
//   • restliche Zukunft: nach Monaten gruppiert, eingeklappt
//   • Vergangenes: nach Monaten gruppiert, neuester Monat zuerst, eingeklappt
//
// SKALIERUNG: die Aufteilung/Zählung passiert in der reinen Funktion
// buildOccurrenceAgenda über das VOLLE Array (billig, nur Schleifen), aber
// eingehängt werden ausschließlich die Zeilen aufgeklappter Gruppen. Bei einer
// Regel mit mehreren hundert Terminen sind das anfangs fünf statt hunderte
// Zeilen — ohne den Datensatz zu beschneiden: jeder Termin bleibt über genau
// eine Gruppe erreichbar (Invariante von buildOccurrenceAgenda).
//
// KEIN verschachtelter ScrollView und KEINE feste Höhe mehr — die Karte wächst
// mit dem, was aufgeklappt ist, und scrollt mit der Seite.

import { EmptyState } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { OccurrenceRow } from "@/features/jobs/components/OccurrenceRow";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { getAssignees, isUnassigned } from "@/utils/jobAssignees";
import {
  buildOccurrenceAgenda,
  type OccurrenceMonthGroup,
} from "@/utils/occurrenceAgenda";
import { formatDateISO } from "@/utils/date";
import { isDetachedOccurrence, type RuleSchedule } from "@/utils/recurringRule";
import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

/** Anzahl der immer sichtbaren nächsten Termine. */
const NEXT_UP_COUNT = 5;

/** Vergleichbarer Schlüssel der Zuweisungsmenge (Reihenfolge-unabhängig). */
function assigneeKey(job: Pick<Job, "assignees">): string {
  const assignees = getAssignees(job);
  const ids = assignees
    .map((a) => a.employeeId)
    .filter((id): id is string => !!id)
    .sort();
  const deleted = assignees.length - ids.length;
  return `${ids.join("|")}#${deleted}`;
}

type Props = {
  /** Termine wie von getJobOccurrences geliefert (unverändert). */
  occurrences: Job[];
  loading: boolean;
  /**
   * Der letzte Ladeversuch ist gescheitert. MUSS getrennt vom leeren Ergebnis
   * behandelt werden: ein Abbruch liefert ebenfalls ein leeres Array, darf
   * aber nicht als „keine Termine erzeugt" erscheinen.
   */
  error: boolean;
  /** Lädt über denselben Lesepfad erneut (kein eigener Service-Aufruf). */
  onRetry: () => void;
  /** Die Regel selbst — für Abweichungs-Erkennung und Zuweisungs-Vergleich. */
  rule: Job;
  onOpen: (occurrence: Job) => void;
};

export function RuleOccurrenceAgenda({
  occurrences,
  loading,
  error,
  onRetry,
  rule,
  onOpen,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const todayKey = useMemo(() => formatDateISO(new Date()) ?? "", []);

  const agenda = useMemo(
    () => buildOccurrenceAgenda(occurrences, todayKey, NEXT_UP_COUNT),
    [occurrences, todayKey],
  );

  // Terminierung der Regel für die „abweichender Termin"-Erkennung.
  const ruleSchedule = useMemo<RuleSchedule>(
    () => ({
      recurringDays: rule.recurringDays,
      startTime: rule.startTime,
      recurrenceStartDate: rule.recurrenceStartDate,
      recurrenceEndDate: rule.recurrenceEndDate,
    }),
    [
      rule.recurringDays,
      rule.startTime,
      rule.recurrenceStartDate,
      rule.recurrenceEndDate,
    ],
  );

  const ruleAssigneeKey = useMemo(() => assigneeKey(rule), [rule]);

  // Aufgeklappte Monatsgruppen (Key aus buildOccurrenceAgenda). Alles, was
  // hier nicht steht, bleibt eingeklappt und wird gar nicht erst gerendert.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pastOpen, setPastOpen] = useState(false);

  const toggleGroup = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const renderRow = useCallback(
    (occurrence: Job, past: boolean) => (
      <OccurrenceRow
        key={occurrence.id}
        occurrence={occurrence}
        todayKey={todayKey}
        past={past}
        detached={isDetachedOccurrence(occurrence, ruleSchedule)}
        showAssignees={
          !isUnassigned(occurrence) &&
          assigneeKey(occurrence) !== ruleAssigneeKey
        }
        onPress={() => onOpen(occurrence)}
      />
    ),
    [todayKey, ruleSchedule, ruleAssigneeKey, onOpen],
  );

  const renderGroups = useCallback(
    (groups: OccurrenceMonthGroup[], past: boolean) =>
      groups.map((group) => {
        const isOpen = expanded.has(group.key);
        return (
          <View key={group.key}>
            <GroupToggle
              label={group.label}
              count={group.occurrences.length}
              open={isOpen}
              onPress={() => toggleGroup(group.key)}
              styles={styles}
              theme={theme}
            />
            {isOpen
              ? group.occurrences.map((occurrence) => renderRow(occurrence, past))
              : null}
          </View>
        );
      }),
    [expanded, toggleGroup, renderRow, styles, theme],
  );

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons
          name="calendar-outline"
          size={14}
          color={theme.colors.primary}
        />
        <Text style={styles.headerTitle}>TERMINE</Text>
        {!loading && agenda.counts.total > 0 ? (
          <Text style={styles.headerCount}>{agenda.counts.total}</Text>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      ) : error ? (
        // Ladefehler ≠ „keine Termine". Der Zustand sagt genau das, was
        // passiert ist, und bietet denselben Lesepfad erneut an.
        <View style={styles.errorWrap}>
          <View style={styles.errorRow}>
            <Ionicons
              name="cloud-offline-outline"
              size={16}
              color={theme.colors.onSurfaceVariant}
            />
            <Text style={styles.errorText}>
              Termine konnten nicht geladen werden.
            </Text>
          </View>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={onRetry}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Termine erneut laden"
          >
            <Ionicons name="refresh" size={14} color={theme.colors.primary} />
            <Text style={styles.retryText}>Erneut versuchen</Text>
          </TouchableOpacity>
        </View>
      ) : agenda.counts.total === 0 ? (
        <EmptyState
          compact
          icon="calendar-outline"
          title="Keine Termine erzeugt"
          message="Für diese Regel liegen noch keine konkreten Termine vor."
        />
      ) : (
        <>
          {/* Zähl-Leiste: beantwortet „wie steht die Regel da?" ohne Scrollen */}
          <View style={styles.stats}>
            <Stat
              label="kommend"
              value={agenda.counts.upcoming}
              styles={styles}
            />
            <Stat
              label="erledigt"
              value={agenda.counts.completed}
              styles={styles}
            />
            <Stat label="offen" value={agenda.counts.open} styles={styles} />
            {agenda.counts.inProgress > 0 ? (
              <Stat
                label="in Arbeit"
                value={agenda.counts.inProgress}
                styles={styles}
              />
            ) : null}
          </View>

          {/* ── Als Nächstes (immer sichtbar) ── */}
          <Text style={styles.sectionLabel}>ALS NÄCHSTES</Text>
          {agenda.nextUp.length === 0 ? (
            <EmptyState
              compact
              icon="time-outline"
              title="Keine kommenden Termine"
              message="Der erzeugte Zeitraum enthält keine zukünftigen Termine mehr."
            />
          ) : (
            agenda.nextUp.map((occurrence) => renderRow(occurrence, false))
          )}

          {/* ── Weitere Zukunft, nach Monaten ── */}
          {agenda.upcomingGroups.length > 0 ? (
            <View style={styles.groupBlock}>
              <Text style={styles.sectionLabel}>WEITERE TERMINE</Text>
              {renderGroups(agenda.upcomingGroups, false)}
            </View>
          ) : null}

          {/* ── Vergangenes, nach Monaten (neuester zuerst) ── */}
          {agenda.pastGroups.length > 0 ? (
            <View style={styles.groupBlock}>
              <GroupToggle
                label="Vergangene Termine"
                count={agenda.counts.past}
                open={pastOpen}
                onPress={() => setPastOpen((open) => !open)}
                styles={styles}
                theme={theme}
                emphasized
              />
              {pastOpen ? renderGroups(agenda.pastGroups, true) : null}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────
// Auf-/Zuklappen einer Gruppe
// ─────────────────────────────────────────────
function GroupToggle({
  label,
  count,
  open,
  onPress,
  styles,
  theme,
  emphasized = false,
}: {
  label: string;
  count: number;
  open: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
  emphasized?: boolean;
}) {
  return (
    <TouchableOpacity
      style={styles.groupToggle}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${label}, ${count} ${count === 1 ? "Termin" : "Termine"}`}
      accessibilityHint={open ? "Zum Einklappen antippen" : "Zum Aufklappen antippen"}
    >
      <Ionicons
        name={open ? "chevron-down" : "chevron-forward"}
        size={16}
        color={theme.colors.onSurfaceVariant}
      />
      <Text
        style={[styles.groupLabel, emphasized && styles.groupLabelEmphasized]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text style={styles.groupCount}>{count}</Text>
    </TouchableOpacity>
  );
}

function Stat({
  label,
  value,
  styles,
}: {
  label: string;
  value: number;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
      ...theme.shadows.sm,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    headerTitle: {
      flex: 1,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    headerCount: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    loadingWrap: {
      paddingVertical: theme.spacing.md,
      alignItems: "center",
    },

    // Ladefehler (bewusst ruhig: kein Alarm-Rot, es ist ein Verbindungs-
    // problem und kein Datenbefund)
    errorWrap: {
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    errorRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    errorText: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      lineHeight: theme.typography.lineHeight.sm,
      color: theme.colors.onSurfaceVariant,
    },
    retryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.xs,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      minHeight: theme.spacing.tapTarget,
    },
    retryText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
    },

    // Zähl-Leiste
    stats: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.md,
      paddingVertical: theme.spacing.xs,
    },
    stat: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: theme.spacing.xs,
    },
    statValue: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    statLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    sectionLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wide,
    },
    groupBlock: {
      marginTop: theme.spacing.xs,
    },

    groupToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      paddingVertical: theme.spacing.sm,
      minHeight: theme.spacing.tapTarget,
    },
    groupLabel: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    groupLabelEmphasized: {
      color: theme.colors.onSurfaceVariant,
    },
    groupCount: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
