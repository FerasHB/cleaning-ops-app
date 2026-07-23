// components/JobCard.tsx
// Kompakte Übersichts-Karte für Job-Listen.
// Vollständig theme-aware (Light + Dark Mode).
//
// Design-Prinzip:
// - Card ist Navigations-Tile zum DetailScreen — onPress macht ganze Karte tappable
// - Nur die wichtigsten Felder sichtbar (Kunde, Service, Ort, Zeit)
// - Mitarbeiter-Zeile nur wenn `showEmployeeName` gesetzt ist (i.d.R. nur Admin)
// - Genau EINE kontextuelle Quick-Action: "Start" bei open, "Fertig" bei in_progress
// - Notizen, Edit, ausführliche Felder → leben im DetailScreen
//
// Tap-Verhalten:
// - Tap auf Card-Fläche → onPress (Detail)
// - Tap auf Quick-Action-Button → onStart/onComplete (Inner-Touch gewinnt in RN)

import { useAppTheme } from "@/hooks/useAppTheme";
import { useJobWorkedTime } from "@/hooks/useJobWorkedTime";
import { Ionicons } from "@expo/vector-icons";
import { Job } from "@/types/job";
import { getJobDisplayTime, getRecurringDaysLabel } from "@/utils/jobSchedule";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

type Props = {
  job: Job;
  /** Tap auf die Karte (außerhalb der Quick-Action) — i.d.R. Detail-Navigation */
  onPress?: () => void;
  /**
   * Inline-Quick-Action "Start" — wird nur gezeigt, wenn übergeben UND job.status === "open".
   * Wer keine Inline-Action will (z.B. Admin), lässt das Prop einfach weg.
   */
  onStart?: () => void;
  /**
   * Inline-Quick-Action "Fertig" — wird nur gezeigt, wenn übergeben UND job.status === "in_progress".
   */
  onComplete?: () => void;
  /** Soll der Name des zugewiesenen Mitarbeiters in der Card stehen? (Default: false) */
  showEmployeeName?: boolean;
  /**
   * Heute-Kontext (Employee-Übersicht): zeigt einfache Hinweise wie
   * "Heute fällig", "Startet um HH:mm" und "Noch nicht gestartet".
   * Admin-Listen lassen das Prop weg → keine Hinweise.
   */
  dueToday?: boolean;
  /**
   * Abweichender Termin: diese Occurrence passt nach einer Regeländerung nicht
   * mehr zur aktuellen Dauerauftrags-Regel, wurde aber wegen Historie bewahrt
   * (PR #43). Zeigt ein dezentes „Abweichender Termin"-Badge. Historische
   * Daten bleiben unverändert.
   */
  detached?: boolean;
};

// ─────────────────────────────────────────────
// Zeit-Formatierung
// ─────────────────────────────────────────────
function formatTime(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// Formatiert "YYYY-MM-DD" → "dd.mm.yyyy" (ohne Zeitzonen-Verschiebung).
function formatDateOnly(value?: string | null): string | null {
  if (!value) return null;
  const [y, m, d] = value.slice(0, 10).split("-");
  if (!y || !m || !d) return null;
  return `${d}.${m}.${y}`;
}

// Ist dieser Job eine Parent-Recurring-Regel (keine konkrete Ausführung)?
// Parent = job_type 'recurring' ohne parentJobId — nur Vorlage, kein startbarer Termin.
function isParentRecurringJob(job: Job): boolean {
  return job.jobType === "recurring" && !job.parentJobId;
}

// ── Status-Farben aus Theme (jeder Status hat sein Farbtripel)
function getStatusConfig(theme: AppTheme, status: Job["status"]) {
  switch (status) {
    case "open":
      return {
        label: "Offen",
        textColor: theme.colors.statusOpen,
        bgColor: theme.colors.statusOpenBg,
        borderColor: theme.colors.statusOpenBorder,
      };
    case "in_progress":
      return {
        label: "In Arbeit",
        textColor: theme.colors.statusInProgress,
        bgColor: theme.colors.statusInProgressBg,
        borderColor: theme.colors.statusInProgressBorder,
      };
    case "completed":
      return {
        label: "Erledigt",
        textColor: theme.colors.statusCompleted,
        bgColor: theme.colors.statusCompletedBg,
        borderColor: theme.colors.statusCompletedBorder,
      };
  }
}

export default function JobCard({
  job,
  onPress,
  onStart,
  onComplete,
  showEmployeeName = false,
  dueToday = false,
  detached = false,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const status = getStatusConfig(theme, job.status);

  // Parent-Recurring-Regeln dürfen weder gestartet noch abgeschlossen werden.
  const isParentRule = isParentRecurringJob(job);

  // Anzeige-Uhrzeit (zentral): start_time mit Fallback auf scheduledStart.
  const startTime = getJobDisplayTime(job);

  // Arbeitszeit — nur bei gestarteten/laufenden/abgeschlossenen Jobs vorhanden.
  const { label: workedLabel } = useJobWorkedTime(job);

  // Zeit-Zeile je nach Auftragstyp
  let scheduleText: string | null = null;
  if (job.jobType === "recurring") {
    const days = getRecurringDaysLabel(job);
    scheduleText = startTime ? `${days} · ${startTime} Uhr` : days;
  } else {
    const date = formatDateOnly(job.date) ?? formatDate(job.scheduledStart);
    const endTime = formatTime(job.scheduledEnd);
    if (date && startTime && endTime) {
      scheduleText = `${date} · ${startTime} – ${endTime} Uhr`;
    } else if (date && startTime) {
      scheduleText = `${date} · ${startTime} Uhr`;
    } else if (date) {
      scheduleText = date;
    } else if (startTime) {
      scheduleText = `${startTime} Uhr`;
    }
  }

  // Einfache Hinweise (nur im Heute-Kontext der Employee-Übersicht)
  const hints: string[] = [];
  if (dueToday) {
    hints.push("Heute fällig");
    if (startTime) hints.push(`Startet um ${startTime}`);
    if (job.status === "open") hints.push("Noch nicht gestartet");
  }

  // Service · Ort (kompakte Einzeiler-Subline)
  const subline = [job.service, job.location].filter(Boolean).join(" · ");

  // Quick-Action — exakt EINE, abhängig von Status (oder gar keine).
  // Bei Parent-Recurring-Regeln grundsätzlich keine Quick-Actions.
  const showStartAction = !isParentRule && job.status === "open" && !!onStart;
  const showCompleteAction = !isParentRule && job.status === "in_progress" && !!onComplete;
  const employeeText = showEmployeeName ? job.employeeName : null;

  // Footer wird nur gerendert, wenn Mitarbeiter ODER Action vorhanden
  const hasFooter = !!employeeText || showStartAction || showCompleteAction;

  // ── Root: TouchableOpacity wenn navigierbar, sonst stiller View
  const CardRoot: React.ComponentType<{
    style: any;
    children: React.ReactNode;
  }> = onPress
    ? (props) => (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={onPress}
          {...props}
        />
      )
    : (props) => <View {...props} />;

  return (
    <CardRoot
      style={[
        styles.card,
        {
          borderColor: status.borderColor,
          borderLeftColor: status.borderColor,
          borderLeftWidth: 4,
        },
      ]}
    >
      {/* ── Header: Kunde + Status + Chevron ── */}
      <View style={styles.header}>
        <Text style={styles.customerName} numberOfLines={1}>
          {job.customerName}
        </Text>

        <View style={styles.headerRight}>
          {job.hasUnreadComments ? (
            <View
              style={styles.unreadDot}
              accessibilityLabel="Ungelesene Kommentare"
            />
          ) : null}
          {isParentRule ? (
            // Parent-Recurring-Regeln bekommen ein neutrales "Regel"-Badge
            // statt des Status-Badges, damit Admins auf einen Blick erkennen:
            // das ist eine Vorlage, kein konkreter Termin.
            <View style={styles.ruleBadge}>
              <Ionicons
                name="repeat-outline"
                size={11}
                color={theme.colors.primary}
              />
              <Text style={styles.ruleBadgeText}>Regel</Text>
            </View>
          ) : (
            <View
              style={[
                styles.statusBadge,
                {
                  backgroundColor: status.bgColor,
                  borderColor: status.borderColor,
                },
              ]}
            >
              <Text style={[styles.statusText, { color: status.textColor }]}>
                {status.label}
              </Text>
            </View>
          )}
          {onPress ? (
            <Ionicons
              name="chevron-forward"
              size={16}
              color={theme.colors.outline}
            />
          ) : null}
        </View>
      </View>

      {/* ── Abweichender Termin (dezent) ── */}
      {detached ? (
        <View style={styles.detachedChip}>
          <Ionicons
            name="git-branch-outline"
            size={11}
            color={theme.colors.onSurfaceVariant}
          />
          <Text style={styles.detachedChipText}>Abweichender Termin</Text>
        </View>
      ) : null}

      {/* ── Service · Ort (eine Zeile) ── */}
      {subline ? (
        <Text style={styles.subline} numberOfLines={1}>
          {subline}
        </Text>
      ) : null}

      {/* ── Zeit (mit Icon) ── */}
      {scheduleText ? (
        <View style={styles.metaRow}>
          <Ionicons
            name="time-outline"
            size={14}
            color={theme.colors.onSurfaceVariant}
          />
          <Text style={styles.metaText} numberOfLines={1}>
            {scheduleText}
          </Text>
        </View>
      ) : null}

      {/* ── Arbeitszeit (live während in_progress, final bei completed) ── */}
      {workedLabel ? (
        <View style={styles.metaRow}>
          <Ionicons
            name="hourglass-outline"
            size={14}
            color={theme.colors.onSurfaceVariant}
          />
          <Text style={styles.metaText} numberOfLines={1}>
            {workedLabel}
          </Text>
        </View>
      ) : null}

      {/* ── Hinweise (Heute-Kontext) ── */}
      {hints.length > 0 ? (
        <View style={styles.hintRow}>
          {hints.map((hint) => (
            <View key={hint} style={styles.hintChip}>
              <Text style={styles.hintText}>{hint}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* ── Footer: Mitarbeiter (links) + Quick-Action (rechts) ── */}
      {hasFooter ? (
        <View style={styles.footer}>
          {employeeText ? (
            <View style={styles.employeeRow}>
              <Ionicons
                name="person-outline"
                size={14}
                color={theme.colors.onSurfaceVariant}
              />
              <Text style={styles.metaText} numberOfLines={1}>
                {employeeText}
              </Text>
            </View>
          ) : (
            <View style={styles.footerSpacer} />
          )}

          {showStartAction ? (
            <TouchableOpacity
              style={styles.quickActionPrimary}
              onPress={onStart}
              activeOpacity={0.85}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons
                name="play"
                size={13}
                color={theme.colors.onPrimaryContainer}
              />
              <Text style={styles.quickActionPrimaryText}>Start</Text>
            </TouchableOpacity>
          ) : null}

          {showCompleteAction ? (
            <TouchableOpacity
              style={styles.quickActionSuccess}
              onPress={onComplete}
              activeOpacity={0.85}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons
                name="checkmark"
                size={14}
                color={theme.colors.statusCompleted}
              />
              <Text style={styles.quickActionSuccessText}>Fertig</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </CardRoot>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      gap: 6,
      ...theme.shadows.sm,
    },

    // Header
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    headerRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },

    // Roter Punkt für ungelesene Kommentare
    unreadDot: {
      width: 9,
      height: 9,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.error,
    },
    customerName: {
      flex: 1,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },

    // Status-Badge
    statusBadge: {
      paddingHorizontal: 9,
      paddingVertical: 3,
      borderRadius: theme.radius.full,
      borderWidth: 1,
    },
    statusText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      letterSpacing: theme.typography.letterSpacing.wide,
    },

    // "Regel"-Badge für Parent-Recurring-Jobs (neutrales Farb-Schema)
    ruleBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 9,
      paddingVertical: 3,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.primaryContainer,
    },
    ruleBadgeText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
      letterSpacing: theme.typography.letterSpacing.wide,
    },

    // Abweichender Termin: bewusst dezent (neutrale Outline, kein Alarm)
    detachedChip: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 4,
      marginTop: 6,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surfaceContainerHigh,
    },
    detachedChipText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },

    // Subline: Service · Ort
    subline: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.sm,
    },

    // Meta-Zeile (Zeit / Mitarbeiter)
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },

    // Hinweis-Chips (Heute fällig / Startet um … / Noch nicht gestartet)
    hintRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      marginTop: 2,
    },
    hintChip: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusInProgressBg,
      borderWidth: 1,
      borderColor: theme.colors.statusInProgressBorder,
    },
    hintText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.statusInProgress,
    },
    metaText: {
      flex: 1,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // Footer (Mitarbeiter links + Quick-Action rechts)
    footer: {
      marginTop: 2,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    footerSpacer: {
      flex: 1,
    },
    employeeRow: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },

    // Quick-Action "Start" (primär)
    quickActionPrimary: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primaryContainer,
    },
    quickActionPrimaryText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimaryContainer,
    },

    // Quick-Action "Fertig" (success-Outline)
    quickActionSuccess: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusCompletedBg,
      borderWidth: 1,
      borderColor: theme.colors.statusCompletedBorder,
    },
    quickActionSuccessText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.statusCompleted,
    },
  });
}
