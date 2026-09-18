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
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  summary: TimesheetAbsenceSummary | undefined;
  notices: TimesheetNotice[] | undefined;
};

export function TimesheetAbsenceSection({ summary, notices }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  // "Urlaub" teilt sich die Übersetzung mit absences:types.vacation (gleiches
  // Konzept). "Krank" ist hier bewusst die KÜRZERE Form (Adjektiv) statt
  // absences:types.sickness ("Krankheit") — abweichender deutscher Wortlaut
  // im Original, unverändert übernommen statt stillschweigend vereinheitlicht
  // (siehe i18n-Audit, Abschnitt "inkonsistente Terminologie").
  const typeLabel = (type: "vacation" | "sickness"): string =>
    type === "vacation" ? t("absences:types.vacation") : t("timesheets:absenceSection.typeSickness");

  const hasVacation = !!summary && summary.vacationCalendarDays > 0;
  const hasSickness = !!summary && summary.sicknessCalendarDays > 0;
  const hasNotices = !!notices && notices.length > 0;

  if (!hasVacation && !hasSickness && !hasNotices) return null;

  return (
    <>
      {hasNotices ? (
        <View style={styles.section}>
          <SectionHeader
            title={t("timesheets:absenceSection.noticesTitle")}
            subtitle={t("timesheets:absenceSection.noticesSubtitle")}
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
                  {t(
                    notice.absenceType === "vacation"
                      ? "timesheets:absenceSection.noticeTextVacation"
                      : "timesheets:absenceSection.noticeTextAbsence",
                    { date: formatDayMonth(notice.date), type: typeLabel(notice.absenceType) },
                  )}
                </Text>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {hasVacation || hasSickness ? (
        <View style={styles.section}>
          <SectionHeader
            title={t("timesheets:absenceSection.absencesTitle")}
            subtitle={t("timesheets:absenceSection.absencesSubtitle")}
          />
          <Card padding={0}>
            {hasVacation ? (
              <AbsenceTypeRow
                theme={theme}
                styles={styles}
                label={t("absences:types.vacation")}
                calendarDays={summary!.vacationCalendarDays}
                plannedWorkDays={summary!.vacationPlannedWorkDays}
                plannedMinutes={summary!.vacationPlannedMinutes}
              />
            ) : null}
            {hasSickness ? (
              <AbsenceTypeRow
                theme={theme}
                styles={styles}
                label={t("timesheets:absenceSection.typeSickness")}
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
  const { t } = useTranslation();
  return (
    <View style={[styles.absenceRow, withDivider && styles.rowDivider]}>
      <Text style={styles.absenceLabel}>{label}</Text>
      {plannedWorkDays > 0 ? (
        <Text style={styles.absencePrimary}>
          {t("timesheets:absenceSection.plannedWorkDays", {
            count: plannedWorkDays,
            duration: formatDurationHm(plannedMinutes),
          })}
        </Text>
      ) : (
        <Text style={styles.absencePrimary}>{t("timesheets:absenceSection.noPlannedWork")}</Text>
      )}
      <Text style={styles.absenceSecondary}>
        {t("timesheets:absenceSection.calendarDays", { count: calendarDays })}
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
