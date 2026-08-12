// components/JobCard.tsx
// Kompakte Übersichts-Karte für Job-Listen.
// Vollständig theme-aware (Light + Dark Mode).
//
// Design-Prinzip:
// - Card ist Navigations-Tile zum DetailScreen — onPress macht ganze Karte tappable
// - Nur die wichtigsten Felder sichtbar, in Feld-Lesereihenfolge:
//   Kunde → Ort → Service → Zeit → Status → Aktion
// - Mitarbeiter-Zeile nur wenn `showEmployeeName` gesetzt ist (i.d.R. nur Admin)
// - Genau EINE kontextuelle Quick-Action: "Start" bei open, "Abschließen" bei in_progress
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
import {
  formatAssigneesFull,
  formatAssigneesShort,
  getAssignees,
} from "@/utils/jobAssignees";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { AppTheme } from "@/constants/theme";
import { confirmCompleteJob } from "@/utils/jobDialogs";
import { getJobStatusMeta } from "@/utils/jobStatus";
import {
  formatDateISO,
  formatDateOnlyDE,
  formatTimeHHmm,
  parseToDate,
} from "@/utils/date";

type Props = {
  job: Job;
  /** Tap auf die Karte (außerhalb der Quick-Action) — i.d.R. Detail-Navigation */
  onPress?: () => void;
  /**
   * Inline-Quick-Action "Start" — wird nur gezeigt, wenn übergeben UND job.status === "open".
   * Wer keine Inline-Action will (z.B. Admin), lässt das Prop einfach weg.
   * Darf ein Promise zurückgeben; die Karte sperrt dann bis zum Abschluss.
   */
  onStart?: () => void | Promise<void>;
  /**
   * Inline-Quick-Action "Abschließen" — wird nur gezeigt, wenn übergeben UND job.status === "in_progress".
   * Darf ein Promise zurückgeben; die Karte sperrt dann bis zum Abschluss.
   */
  onComplete?: () => void | Promise<void>;
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
// Die Karte hatte hier drei eigene Formatter (formatTime/formatDate/
// formatDateOnly), die dasselbe taten wie utils/date.ts. Jetzt werden die
// zentralen Helfer genutzt — gleiche Ausgabe, gleiche lokale Datums-Semantik,
// aber ein Ort für Änderungen. `formatDateOnlyDE` erwartet "YYYY-MM-DD"
// (zeitzonenfrei); ein ISO-Zeitstempel wird vorher lokal auf einen
// Kalendertag reduziert.
function formatIsoDateDE(iso?: string | null): string | null {
  return formatDateOnlyDE(formatDateISO(parseToDate(iso)));
}

function formatIsoTimeDE(iso?: string | null): string | null {
  return formatTimeHHmm(parseToDate(iso));
}

// Ist dieser Job eine Parent-Recurring-Regel (keine konkrete Ausführung)?
// Parent = job_type 'recurring' ohne parentJobId — nur Vorlage, kein startbarer Termin.
function isParentRecurringJob(job: Job): boolean {
  return job.jobType === "recurring" && !job.parentJobId;
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
  // Beschriftung + Farben zentral — dieselbe Quelle wie StatusBadge im Detail.
  const status = getJobStatusMeta(job.status, theme.colors);

  // Doppel-Tap-Schutz für die Quick-Actions. Der Ref sperrt SYNCHRON (setBusy
  // wirkt erst beim nächsten Render, zwei schnelle Taps kämen sonst beide
  // durch); der State steuert nur die sichtbare Deaktivierung.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const runAction = useCallback(
    async (action: () => void | Promise<void>, confirm: boolean) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        // Abschließen ist unumkehrbar — vorher nachfragen. Start bleibt ohne
        // Rückfrage (zeitkritisch und unschädlich).
        if (confirm && !(await confirmCompleteJob())) {
          return;
        }
        await action();
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [],
  );

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
    const date = formatDateOnlyDE(job.date) ?? formatIsoDateDE(job.scheduledStart);
    const endTime = formatIsoTimeDE(job.scheduledEnd);
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

  // Ort · Service (kompakte Einzeiler-Subline).
  // Ort steht ZUERST: im Feld ist „wohin muss ich?" die Frage direkt nach
  // „zu wem?" — der Service beantwortet erst danach „was mache ich dort?".
  // Bewusst weiterhin EINE Zeile statt zwei: die Karte soll nicht wachsen.
  const subline = [job.location, job.service].filter(Boolean).join(" · ");

  // Quick-Action — exakt EINE, abhängig von Status (oder gar keine).
  // Bei Parent-Recurring-Regeln grundsätzlich keine Quick-Actions.
  const showStartAction = !isParentRule && job.status === "open" && !!onStart;
  const showCompleteAction = !isParentRule && job.status === "in_progress" && !!onComplete;
  // Mitarbeiter-Zeile: gekürzt („Anna, Bert +2"), das vollständige Register
  // steckt im Screenreader-Label. Ohne Zuweisung bleibt die Zeile ganz weg —
  // wie bisher, als employeeName schlicht null war.
  const assigneeCount = getAssignees(job).length;
  const employeeText =
    showEmployeeName && assigneeCount > 0 ? formatAssigneesShort(job) : null;
  const employeeA11yLabel =
    showEmployeeName && assigneeCount > 0
      ? `${assigneeCount === 1 ? "Mitarbeiter" : "Mitarbeitende"}: ${formatAssigneesFull(job)}`
      : undefined;

  // Footer wird nur gerendert, wenn Mitarbeiter ODER Action vorhanden
  const hasFooter = !!employeeText || showStartAction || showCompleteAction;

  // ── Root-Style: farbige Statuskante links
  const cardStyle = [
    styles.card,
    {
      borderColor: status.border,
      borderLeftColor: status.border,
      borderLeftWidth: 4,
    },
  ];

  // Inhalt einmal bauen und je nach Navigierbarkeit in TouchableOpacity oder
  // View hängen.
  //
  // Vorher stand hier eine im Render definierte Komponente (`const CardRoot =
  // onPress ? (props) => <TouchableOpacity …/> : …`). Deren Identität war bei
  // JEDEM Render neu → React sah einen anderen Komponententyp, unmountete den
  // kompletten Karten-Teilbaum und baute ihn neu auf. Praktische Folge: der
  // lokale busy-State überlebte zwar (er sitzt im JobCard selbst), aber jeder
  // Render der Liste warf Press-States und Layout der Karte weg. Zwei feste
  // Zweige haben stabile Typen — kein Remount, identisches Verhalten.
  const content = (
    <>
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
                  backgroundColor: status.bg,
                  borderColor: status.border,
                },
              ]}
            >
              <Text style={[styles.statusText, { color: status.text }]}>
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
            <View
              style={styles.employeeRow}
              accessible
              accessibilityLabel={employeeA11yLabel}
            >
              <Ionicons
                name={assigneeCount > 1 ? "people-outline" : "person-outline"}
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
              style={[styles.quickActionPrimary, busy && styles.quickActionBusy]}
              // Fehleranzeige liegt beim Aufrufer (er kennt seine Fehlerfläche);
              // der catch verhindert hier nur eine unbehandelte Promise.
              onPress={() => {
                if (onStart) runAction(onStart, false).catch(() => {});
              }}
              disabled={busy}
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
              style={[styles.quickActionSuccess, busy && styles.quickActionBusy]}
              onPress={() => {
                if (onComplete) runAction(onComplete, true).catch(() => {});
              }}
              disabled={busy}
              activeOpacity={0.85}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons
                name="checkmark"
                size={14}
                color={theme.colors.statusCompleted}
              />
              {/* Verb, nicht Status: „Fertig" stand hier direkt neben dem
                  Status-Badge „Erledigt" und las sich wie ein zweites,
                  abweichendes Statuswort. „Abschließen" ist derselbe Wortlaut
                  wie im Detail-Footer und im Bestätigungsdialog. */}
              <Text style={styles.quickActionSuccessText}>Abschließen</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </>
  );

  if (onPress) {
    return (
      <TouchableOpacity style={cardStyle} activeOpacity={0.85} onPress={onPress}>
        {content}
      </TouchableOpacity>
    );
  }

  return <View style={cardStyle}>{content}</View>;
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

    // Läuft gerade (Bestätigung offen oder Aktion unterwegs) → sichtbar gesperrt.
    quickActionBusy: {
      opacity: 0.5,
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

    // Quick-Action "Abschließen" (success-Outline)
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
