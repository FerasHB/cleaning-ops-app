// features/jobs/components/RuleOccurrences.tsx
// Generierte Termine einer Dauerauftrags-Regel (Admin-Ansicht im JobDetail).
//
// Vorher war das EINE lange chronologische Liste ab dem ältesten Termin —
// bei einer alten Regel stehen dort hunderte Zeilen (erledigte Occurrences
// bleiben dauerhaft erhalten, der rollierende Horizont reicht bis 730 Tage).
// Die Frage „läuft die Regel und was kommt als Nächstes?" war damit unter
// Historie begraben.
//
// Jetzt: kommende Termine zuerst (nächster oben) in einem eigenen, in der
// Höhe begrenzten Scrollbereich — wie in einer Kalender-App direkt sichtbar
// und scrollbar, ohne „Mehr anzeigen"-Zwischenschritt. Vergangenes bleibt
// eingeklappt.
//
// SKALIERUNG — bewusst KEINE FlatList: diese Karte hängt im vertikalen
// ScrollView des JobDetailScreen. Eine gleichachsige, scrollbare
// VirtualizedList darin meldet in __DEV__ zuverlässig
// `console.error("VirtualizedLists should never be nested inside plain
// ScrollViews with the same orientation …")` — auch mit fester Höhe, denn
// die Prüfung in VirtualizedList kennt nur ScrollView-Context + Orientierung
// (react-native/…/VirtualizedList.js). Die kommenden Termine sind durch den
// rollierenden Generierungs-Horizont ohnehin begrenzt (~90 Tage) und liegen
// bereits vollständig im Speicher, deshalb reicht hier ein ScrollView mit
// maxHeight. Die unbegrenzt wachsende Historie bleibt seitenweise.

import { StatusBadge } from "@/components/ui";
import {
  formatAssigneesShort,
  isUnassigned,
} from "@/utils/jobAssignees";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { formatDateISO } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const INITIAL_PAST = 5;
const PAGE_SIZE = 10;

// Höhe des Scrollbereichs für kommende Termine: gut 4 Zeilen — genug, damit
// die Liste als eigener Bereich erkennbar ist und scrollbar wirkt, ohne die
// darunterliegenden Abschnitte (Vergangenes, Fotos, Kommentare) zu verdrängen.
// maxHeight statt height: kurze Listen bleiben in ihrer natürlichen Höhe und
// zeigen dann gar keinen Scrollbalken.
const UPCOMING_MAX_HEIGHT = 360;

const WEEKDAY_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function formatOccurrenceDate(dateStr?: string | null): string {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.slice(0, 10).split("-");
  if (!y || !m || !d) return dateStr;
  const day = WEEKDAY_SHORT[new Date(`${y}-${m}-${d}`).getDay()] ?? "";
  return `${day} ${d}.${m}.${y}`;
}

type Props = {
  occurrences: Job[];
  loading: boolean;
  /** Öffnet den konkreten Termin (eigene Detailansicht). */
  onOpen: (occurrence: Job) => void;
};

export function RuleOccurrences({ occurrences, loading, onOpen }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const todayKey = useMemo(() => formatDateISO(new Date()) ?? "", []);

  const [pastOpen, setPastOpen] = useState(false);
  const [pastLimit, setPastLimit] = useState(INITIAL_PAST);

  // Die Query (getJobOccurrences) liefert aufsteigend nach Datum — der Split
  // passiert rein clientseitig, ohne zusätzliche Abfrage.
  const { upcoming, past } = useMemo(() => {
    const up: Job[] = [];
    const old: Job[] = [];
    for (const occ of occurrences) {
      const key = occ.date?.slice(0, 10) ?? "";
      if (key && key < todayKey) old.push(occ);
      else up.push(occ);
    }
    // Vergangenes: neueste zuerst — relevanter als der allererste Termin.
    old.reverse();
    return { upcoming: up, past: old };
  }, [occurrences, todayKey]);

  const visiblePast = pastOpen ? past.slice(0, pastLimit) : [];
  const morePast = past.length - visiblePast.length;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons
          name="calendar-outline"
          size={14}
          color={theme.colors.primary}
        />
        <Text style={styles.headerTitle}>TERMINE</Text>
        {!loading && occurrences.length > 0 ? (
          <Text style={styles.headerCount}>{occurrences.length}</Text>
        ) : null}
      </View>

      {loading ? (
        <Text style={styles.emptyText}>Wird geladen …</Text>
      ) : occurrences.length === 0 ? (
        <Text style={styles.emptyText}>Keine Termine generiert.</Text>
      ) : (
        <>
          {/* ── Kommende Termine (nächster zuerst) ── */}
          <Text style={styles.sectionLabel}>
            Kommende Termine ({upcoming.length})
          </Text>

          {upcoming.length === 0 ? (
            <Text style={styles.emptyText}>
              Keine kommenden Termine im generierten Zeitraum.
            </Text>
          ) : (
            // Eigener Scrollbereich: alle kommenden Termine sind sofort da,
            // gescrollt wird direkt in der Liste. `nestedScrollEnabled` ist
            // auf Android nötig, damit die innere Liste die Geste bekommt;
            // iOS macht das von Haus aus. Die Seite darum scrollt weiter
            // normal, sobald der innere Bereich am Ende ist.
            <ScrollView
              style={styles.upcomingScroll}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
            >
              {upcoming.map((occ) => (
                <OccurrenceRow
                  key={occ.id}
                  occurrence={occ}
                  isToday={(occ.date?.slice(0, 10) ?? "") === todayKey}
                  past={false}
                  onPress={() => onOpen(occ)}
                  styles={styles}
                  theme={theme}
                />
              ))}
            </ScrollView>
          )}

          {/* ── Vergangene Termine (eingeklappt) ── */}
          {past.length > 0 ? (
            <>
              <TouchableOpacity
                style={styles.pastToggle}
                onPress={() => setPastOpen((open) => !open)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityState={{ expanded: pastOpen }}
                accessibilityLabel={`Vergangene Termine, ${past.length}`}
              >
                <Ionicons
                  name={pastOpen ? "chevron-down" : "chevron-forward"}
                  size={16}
                  color={theme.colors.onSurfaceVariant}
                />
                <Text style={styles.pastToggleText}>
                  Vergangene Termine ({past.length})
                </Text>
              </TouchableOpacity>

              {visiblePast.map((occ) => (
                <OccurrenceRow
                  key={occ.id}
                  occurrence={occ}
                  isToday={false}
                  past
                  onPress={() => onOpen(occ)}
                  styles={styles}
                  theme={theme}
                />
              ))}

              {pastOpen && morePast > 0 ? (
                <MoreButton
                  label={`Mehr anzeigen (${morePast} weitere)`}
                  onPress={() => setPastLimit((n) => n + PAGE_SIZE)}
                  styles={styles}
                  theme={theme}
                />
              ) : null}
            </>
          ) : null}
        </>
      )}
    </View>
  );
}

function MoreButton({
  label,
  onPress,
  styles,
  theme,
}: {
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  return (
    <TouchableOpacity
      style={styles.moreBtn}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name="chevron-down" size={14} color={theme.colors.primary} />
      <Text style={styles.moreText}>{label}</Text>
    </TouchableOpacity>
  );
}

function OccurrenceRow({
  occurrence,
  isToday,
  past,
  onPress,
  styles,
  theme,
}: {
  occurrence: Job;
  isToday: boolean;
  past: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Termin ${formatOccurrenceDate(occurrence.date)} öffnen`}
      style={({ pressed }) => [
        styles.row,
        isToday && styles.rowToday,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={styles.rowLeft}>
        <View style={styles.rowDateLine}>
          {isToday ? (
            <View style={styles.todayChip}>
              <Text style={styles.todayChipText}>Heute</Text>
            </View>
          ) : null}
          <Text
            style={[styles.rowDate, past && styles.rowMuted]}
            numberOfLines={1}
          >
            {formatOccurrenceDate(occurrence.date)}
          </Text>
        </View>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {occurrence.startTime ? `${occurrence.startTime} Uhr` : "—"}
          {isUnassigned(occurrence)
            ? ""
            : ` · ${formatAssigneesShort(occurrence)}`}
        </Text>
      </View>

      <View style={styles.rowRight}>
        <StatusBadge status={occurrence.status} />
        <Ionicons
          name="chevron-forward"
          size={14}
          color={theme.colors.outline}
        />
      </View>
    </Pressable>
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
      ...theme.shadows.sm,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginBottom: theme.spacing.sm,
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
    sectionLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      marginBottom: 2,
    },
    emptyText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      paddingVertical: 4,
    },
    // flexGrow: 0 verhindert, dass der ScrollView bei wenigen Zeilen auf die
    // maxHeight aufgeblasen wird — kurze Listen bleiben kompakt.
    upcomingScroll: {
      maxHeight: UPCOMING_MAX_HEIGHT,
      flexGrow: 0,
    },

    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      paddingVertical: 10,
      paddingHorizontal: theme.spacing.xs,
      borderRadius: theme.radius.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
      minHeight: theme.spacing.tapTarget,
    },
    // Heute: farbige Kante links — der einzige Termin, der gerade zählt.
    rowToday: {
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.primary,
      backgroundColor: theme.colors.primaryContainer,
    },
    rowPressed: { opacity: 0.6 },
    rowLeft: { flex: 1, gap: 2 },
    rowDateLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    rowDate: {
      flexShrink: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    // Vergangenes bewusst leiser — vorhanden, aber nicht konkurrierend.
    rowMuted: { color: theme.colors.onSurfaceVariant },
    rowMeta: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    rowRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      flexShrink: 0,
    },
    todayChip: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primary,
    },
    todayChipText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimary,
    },

    pastToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 10,
      marginTop: 4,
      minHeight: theme.spacing.tapTarget,
    },
    pastToggleText: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    moreBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      paddingVertical: 10,
      marginTop: 4,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      minHeight: theme.spacing.tapTarget,
    },
    moreText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
    },
  });
}
