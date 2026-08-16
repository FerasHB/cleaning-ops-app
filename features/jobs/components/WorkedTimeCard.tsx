// features/jobs/components/WorkedTimeCard.tsx
// Premium-Karte für die GESAMTZEIT DES AUFTRAGS — Start/Ende + große
// Gesamtdauer als visueller Fokus.
//
// TITEL UND TEXT SIND BEWUSST EINDEUTIG (Phase B1): diese Karte zeigt die
// GETEILTE Job-Uhr (jobs.started_at/completed_at), also wie lange der Auftrag
// insgesamt lief — NICHT die individuelle Arbeitszeit einer Person. Seit der
// Admin-Zeitkorrektur können beide auseinanderfallen: der Stundenzettel
// rechnet mit job_assignments.employee_started_at/employee_completed_at, und
// eine Korrektur ändert nur diese. Hieß die Karte weiterhin nur
// „Arbeitszeit", läse ein Mitarbeiter hier eine andere Zahl als in seinem
// eigenen Stundenzettel — ohne Erklärung.
//
// SICHTEN:
//  • Admin        — zusätzlich die individuellen Zeiten je zugewiesener Person.
//  • Mitarbeiter  — nur die Auftrags-Gesamtzeit (plus ggf. die EIGENE Zeit).
//    Fremde Individualzeiten sind Personaldaten und werden nicht angezeigt.
//
// Reine Präsentationskomponente: die gesamte Berechnung/Ticking-Logik
// kommt aus useJobWorkedTime (derselbe Hook, den auch JobCard nutzt) —
// hier wird nichts dupliziert.

import { Card, StatusBadge } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useJobWorkedTime } from "@/hooks/useJobWorkedTime";
import type { Job } from "@/types/job";
import { formatTimeHHmm } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

type Props = {
  job: Pick<
    Job,
    | "status"
    | "startedAt"
    | "completedAt"
    | "startedBy"
    | "completedBy"
    | "assignees"
  >;
  /**
   * Admin-Sicht: individuelle Arbeitszeiten aller Zugewiesenen einblenden.
   * Default false — Mitarbeitende sehen nur die Auftrags-Gesamtzeit und
   * höchstens ihre eigene Zeit (siehe Kopf-Kommentar).
   */
  isAdmin?: boolean;
};

/**
 * Name des Akteurs eines Übergangs — oder null, wenn kein Hinweis nötig ist.
 *
 * Zeigt bewusst NUR fremde Akteure: „von Ahmed" erklärt einem Mitarbeiter,
 * warum er Arbeitszeit erhält, die er selbst nicht gestartet hat (geteilte
 * Job-Uhr, Phase 7). „von mir" wäre reines Rauschen.
 *
 * Kein Hinweis in drei Fällen — alle bewusst still:
 *  - kein Akteur gespeichert (Alt-Daten vor Phase 7, oder Konto gelöscht:
 *    ON DELETE SET NULL),
 *  - der Akteur ist der aktuelle Nutzer,
 *  - der Akteur ist in `assignees` nicht auflösbar (z. B. inzwischen aus dem
 *    Auftrag entfernt). Ein erfundener Platzhaltername wäre schlechter als
 *    kein Hinweis.
 */
function actorName(
  actorId: string | null | undefined,
  assignees: Job["assignees"] | undefined,
  currentUserId: string | null | undefined,
): string | null {
  if (!actorId || actorId === currentUserId) return null;
  const match = (assignees ?? []).find((a) => a.employeeId === actorId);
  return match?.fullName ?? null;
}

// Datum als "18.07.2026" (ohne Uhrzeit) — für die Start-/Ende-Blöcke.
function formatBlockDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function WorkedTimeCard({ job, isAdmin = false }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { profile } = useAuth();
  const { minutes, label, isRunning } = useJobWorkedTime(job);

  // Sanfte Puls-Animation, wenn sich das Label ändert (jede Minute während
  // der Job läuft) — überspringt den ersten Render, damit die Karte nicht
  // beim Öffnen "hereinspringt".
  const pulse = useRef(new Animated.Value(1)).current;
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    Animated.sequence([
      Animated.timing(pulse, {
        toValue: 1.06,
        duration: 160,
        useNativeDriver: true,
      }),
      Animated.timing(pulse, {
        toValue: 1,
        duration: 160,
        useNativeDriver: true,
      }),
    ]).start();
  }, [label, pulse]);

  if (!job.startedAt || !label) {
    return null;
  }

  const startedDate = formatBlockDate(job.startedAt);
  const startedTime = formatTimeHHmm(new Date(job.startedAt));
  const completedDate = formatBlockDate(job.completedAt);
  const completedTime = job.completedAt
    ? formatTimeHHmm(new Date(job.completedAt))
    : null;

  // Mehrfachzuweisung = geteilte Job-Uhr. Nur dann ist der Zusatzhinweis
  // unten relevant; bei einem einzigen Mitarbeiter wäre er Ballast.
  const isShared = (job.assignees ?? []).length > 1;

  // Individuelle Zeiten: Admin sieht alle, Mitarbeiter ausschließlich sich
  // selbst. Zeilen ohne jede eigene Zeit erscheinen mit klarem Hinweis statt
  // mit einer erfundenen Zahl — die geteilte Uhr wird hier NIE eingesetzt.
  const individualRows = (job.assignees ?? [])
    .filter((a) => (isAdmin ? true : !!profile?.id && a.employeeId === profile.id))
    .map((a) => {
      const start = a.employeeStartedAt
        ? formatTimeHHmm(new Date(a.employeeStartedAt))
        : null;
      const end = a.employeeCompletedAt
        ? formatTimeHHmm(new Date(a.employeeCompletedAt))
        : null;
      const complete = !!start && !!end;
      return {
        assignmentId: a.assignmentId,
        fullName: a.fullName,
        complete,
        timeLabel: complete
          ? `${start} – ${end}`
          : start
            ? `ab ${start} · unvollständig`
            : end
              ? `bis ${end} · unvollständig`
              : "nicht erfasst",
      };
    });

  const startedByName = actorName(job.startedBy, job.assignees, profile?.id);
  const completedByName = actorName(
    job.completedBy,
    job.assignees,
    profile?.id,
  );

  const accentColor = isRunning
    ? theme.colors.statusInProgress
    : theme.colors.statusCompleted;
  const accentBg = isRunning
    ? theme.colors.statusInProgressBg
    : theme.colors.statusCompletedBg;
  const accentBorder = isRunning
    ? theme.colors.statusInProgressBorder
    : theme.colors.statusCompletedBorder;

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="time-outline" size={16} color={theme.colors.primary} />
          </View>
          <Text style={styles.headerTitle}>Gesamtzeit Auftrag</Text>
        </View>
        {/* Kanonischer Wortlaut (Offen/In Arbeit/Erledigt). Die frühere
            labels-Prop beschriftete `completed` hier als „Abgeschlossen" —
            direkt über der Spalte „ERLEDIGT" und abweichend von jeder
            Job-Karte. Siehe utils/jobStatus.ts. */}
        <StatusBadge status={isRunning ? "in_progress" : "completed"} />
      </View>

      <View style={styles.divider} />

      {/* ── Start & Ende ── */}
      <View style={styles.timeRow}>
        <View style={styles.timeBlock}>
          <Text style={styles.timeBlockLabel}>GESTARTET</Text>
          <Text style={styles.timeBlockDate}>{startedDate ?? "—"}</Text>
          <Text style={styles.timeBlockValue}>{startedTime ?? "—:—"}</Text>
          {startedByName ? (
            <Text style={styles.timeBlockActor} numberOfLines={2}>
              von {startedByName}
            </Text>
          ) : null}
        </View>

        <View style={styles.timeBlockDivider} />

        <View style={styles.timeBlock}>
          <Text style={styles.timeBlockLabel}>ERLEDIGT</Text>
          {isRunning ? (
            <Text style={[styles.timeBlockRunning, { color: accentColor }]}>
              Läuft…
            </Text>
          ) : (
            <>
              <Text style={styles.timeBlockDate}>{completedDate ?? "—"}</Text>
              <Text style={styles.timeBlockValue}>{completedTime ?? "—:—"}</Text>
              {completedByName ? (
                <Text style={styles.timeBlockActor} numberOfLines={2}>
                  von {completedByName}
                </Text>
              ) : null}
            </>
          )}
        </View>
      </View>

      {/* ── Highlight: Gesamtdauer ── */}
      <View
        style={[
          styles.highlight,
          { backgroundColor: accentBg, borderColor: accentBorder },
        ]}
      >
        <Animated.Text
          style={[
            styles.highlightValue,
            { color: accentColor, transform: [{ scale: pulse }] },
          ]}
        >
          {label}
        </Animated.Text>
        <Text style={styles.highlightSubtitle}>{minutes} Minuten</Text>
      </View>

      {/* ── Individuelle Zeiten ──
          Admin: alle Zugewiesenen. Mitarbeiter: nur die EIGENE Zeile —
          fremde Individualzeiten sind Personaldaten (siehe Kopf-Kommentar). */}
      {individualRows.length > 0 ? (
        <View style={styles.individualBox}>
          <Text style={styles.individualHeading}>
            {isAdmin ? "INDIVIDUELLE ARBEITSZEIT" : "DEINE ARBEITSZEIT"}
          </Text>
          {individualRows.map((row) => (
            <View key={row.assignmentId} style={styles.individualRow}>
              <Text style={styles.individualName} numberOfLines={1}>
                {row.fullName}
              </Text>
              <Text
                style={row.complete ? styles.individualTime : styles.individualMissing}
              >
                {row.timeLabel}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* ── Hinweis ── */}
      <View style={styles.infoBox}>
        <Ionicons
          name="information-circle-outline"
          size={14}
          color={theme.colors.outline}
        />
        <Text style={styles.infoText}>
          Dies ist die Gesamtlaufzeit des Auftrags — sie kann von der
          individuellen Arbeitszeit einzelner Mitarbeitender abweichen.
          {isShared
            ? " Sie wird aus Start und Abschluss des Auftrags berechnet, unabhängig davon, wer sie gedrückt hat."
            : ""}
        </Text>
      </View>
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.md,
      ...theme.shadows.md,
    },

    // Header — flexWrap, damit der Badge bei großer Schrift/schmalen Geräten
    // in eine neue Zeile fällt statt horizontal überzulaufen.
    header: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      rowGap: 6,
    },
    headerLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      flexShrink: 1,
    },
    headerIconWrap: {
      width: 28,
      height: 28,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    headerTitle: {
      flexShrink: 1,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },

    divider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
    },

    // Start/Ende
    timeRow: {
      flexDirection: "row",
      alignItems: "stretch",
    },
    timeBlock: {
      flex: 1,
      gap: 4,
    },
    timeBlockDivider: {
      width: 1,
      backgroundColor: theme.colors.outlineVariant,
      marginHorizontal: theme.spacing.md,
    },
    timeBlockLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    timeBlockDate: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    timeBlockValue: {
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    // „von <Name>" unter der Uhrzeit — nur bei fremdem Akteur (siehe
    // actorName). Bewusst dezent: der Akteur ist ein Hinweis, keine
    // Kennzahl.
    timeBlockActor: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    timeBlockRunning: {
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      marginTop: 2,
    },

    // Highlight
    highlight: {
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      paddingVertical: theme.spacing.lg,
    },
    highlightValue: {
      // Bewusst über der xxl-Skala — die Gesamtdauer ist der visuelle Fokus
      // der Karte, proportional aus dem xxl-Token abgeleitet statt eines
      // freistehenden Magic Numbers.
      fontSize: Math.round(theme.typography.size.xxl * 1.4),
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.extrabold,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    highlightSubtitle: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },

    // Individuelle Arbeitszeiten (Phase B1)
    individualBox: {
      gap: 6,
      backgroundColor: theme.colors.surfaceContainer,
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
    },
    individualHeading: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    individualRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
    },
    individualName: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },
    individualTime: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    individualMissing: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.error,
    },

    // Info-Hinweis
    infoBox: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
      backgroundColor: theme.colors.surfaceContainer,
      borderRadius: theme.radius.md,
      padding: theme.spacing.sm,
    },
    infoText: {
      flex: 1,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      // Kein festes lineHeight: RN skaliert lineHeight nicht automatisch mit
      // der Systemschrift-Größe — bei großer Accessibility-Schrift würde ein
      // fixer Wert den Text abschneiden. Ohne lineHeight nutzt RN die
      // Font-Metriken, die mit fontSize mitskalieren.
    },
  });
}
