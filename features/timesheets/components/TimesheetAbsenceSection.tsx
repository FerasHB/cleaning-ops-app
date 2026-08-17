// features/timesheets/components/TimesheetAbsenceSection.tsx
// Phase E — Abwesenheiten-Abschnitt im Stundenzettel. Additiv, für Admin- UND
// Mitarbeiter-Sicht identisch (TimesheetScreen übergibt für beide dieselbe
// TimesheetData) — kein separates Admin-/Employee-Bauteil nötig.
//
// WICHTIG (siehe Architektur-Audit Phase E, Abschnitt 4 + CLAUDE.md-Prinzip
// "keine erfundenen Zahlen"): geplante Minuten werden NIE als "Arbeitszeit"/
// "Bezahlte Zeit"/"Entgeltfortzahlung" beschriftet — ausschließlich als
// "Geplante Einsatzzeit". Kalendertage werden NIE als verbrauchte
// Urlaubstage/Urlaubskonto dargestellt, sondern als reine Kalendertag-Zahl,
// getrennt von der Zahl der Tage mit tatsächlich geplanten Einsätzen.

import { Card, SectionHeader } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { TimesheetAbsenceSummary, TimesheetNotice } from "@/types/timesheetAbsence";
import { formatDayMonth } from "@/utils/absenceFormat";
import { formatDurationHm } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  summary: TimesheetAbsenceSummary | undefined;
  notices: TimesheetNotice[] | undefined;
};

function typeLabel(type: "vacation" | "sickness"): string {
  return type === "vacation" ? "Urlaub" : "Krank";
}

export function TimesheetAbsenceSection({ summary, notices }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const hasVacation = !!summary && summary.vacationCalendarDays > 0;
  const hasSickness = !!summary && summary.sicknessCalendarDays > 0;
  const hasNotices = !!notices && notices.length > 0;

  if (!hasVacation && !hasSickness && !hasNotices) return null;

  return (
    <>
      {hasNotices ? (
        <View style={styles.section}>
          <SectionHeader
            title="Hinweise"
            subtitle="Erfordert keine Aktion, nur zur Information"
          />
          <Card padding={0}>
            {notices!.map((notice, idx) => (
              <View
                key={`${notice.date}-${notice.type}`}
                style={[styles.noticeRow, idx > 0 && styles.rowDivider]}
              >
                <Ionicons
                  name="information-circle-outline"
                  size={18}
                  color={theme.colors.onSurfaceVariant}
                  style={styles.noticeIcon}
                />
                <Text style={styles.noticeText}>
                  Arbeit trotz {notice.absenceType === "vacation" ? "Urlaub" : "gemeldeter Abwesenheit"} am{" "}
                  {formatDayMonth(notice.date)} ({typeLabel(notice.absenceType)})
                </Text>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {hasVacation || hasSickness ? (
        <View style={styles.section}>
          <SectionHeader
            title="Abwesenheiten"
            subtitle="Urlaub und Krankheit im gewählten Zeitraum"
          />
          <Card padding={0}>
            {hasVacation ? (
              <AbsenceTypeRow
                theme={theme}
                styles={styles}
                label="Urlaub"
                calendarDays={summary!.vacationCalendarDays}
                plannedWorkDays={summary!.vacationPlannedWorkDays}
                plannedMinutes={summary!.vacationPlannedMinutes}
              />
            ) : null}
            {hasSickness ? (
              <AbsenceTypeRow
                theme={theme}
                styles={styles}
                label="Krank"
                calendarDays={summary!.sicknessCalendarDays}
                plannedWorkDays={summary!.sicknessPlannedWorkDays}
                plannedMinutes={summary!.sicknessPlannedMinutes}
                withDivider={hasVacation}
              />
            ) : null}
          </Card>
        </View>
      ) : null}
    </>
  );
}

function AbsenceTypeRow({
  theme,
  styles,
  label,
  calendarDays,
  plannedWorkDays,
  plannedMinutes,
  withDivider,
}: {
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
  label: string;
  calendarDays: number;
  plannedWorkDays: number;
  plannedMinutes: number;
  withDivider?: boolean;
}) {
  return (
    <View style={[styles.absenceRow, withDivider && styles.rowDivider]}>
      <Text style={styles.absenceLabel}>{label}</Text>
      {plannedWorkDays > 0 ? (
        <Text style={styles.absencePrimary}>
          {plannedWorkDays} geplante{plannedWorkDays === 1 ? "r" : ""} Einsatztag
          {plannedWorkDays === 1 ? "" : "e"} · Geplante Einsatzzeit{" "}
          {formatDurationHm(plannedMinutes)} h
        </Text>
      ) : (
        <Text style={styles.absencePrimary}>Keine geplanten Einsätze</Text>
      )}
      <Text style={styles.absenceSecondary}>
        {calendarDays} Kalendertag{calendarDays === 1 ? "" : "e"}
      </Text>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    section: {
      marginTop: theme.spacing.lg,
    },
    rowDivider: {
      borderTopWidth: 1,
      borderTopColor: theme.colors.outlineVariant,
    },

    // ── Hinweise
    noticeRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.sm,
      padding: theme.spacing.md,
    },
    noticeIcon: {
      marginTop: 2,
    },
    noticeText: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },

    // ── Abwesenheiten
    absenceRow: {
      padding: theme.spacing.md,
      gap: 4,
    },
    absenceLabel: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    absencePrimary: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },
    absenceSecondary: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
