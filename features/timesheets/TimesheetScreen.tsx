// features/timesheets/TimesheetScreen.tsx
// Stundenzettel-Screen: Monat wählen, Vorschau der abgeschlossenen Jobs, Summe
// und PDF-Export (expo-print + expo-sharing). Vollständig theme-aware.
//
// ZWEI SICHTEN, EINE BERECHNUNG:
//  • Admin      — "Stundenzettel": Mitarbeiter frei wählbar (unverändert).
//  • Mitarbeiter— "Meine Arbeitszeit": fest auf die EIGENE Person gebunden,
//                 ohne Auswahlliste.
//
// Vorher stand hier für Mitarbeitende eine Sperre ("Nur für Admins"). Damit
// hatte ein Mitarbeiter KEINE Möglichkeit, die eigene erfasste Arbeitszeit zu
// sehen — obwohl genau diese Zeit aus seinen eigenen Aufträgen stammt.
// Geändert hat sich nur die Sichtbarkeit: Abfrage (getTimesheet), Berechnung
// und PDF-Aufbau nutzen dieselben Daten, und RLS liefert Mitarbeitenden ohnehin nur
// die eigenen zugewiesenen Aufträge ("employee read own assigned jobs").

import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  SectionHeader,
} from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import {
  TimeCorrectionSheet,
  type TimeCorrectionTarget,
} from "@/features/timesheets/components/TimeCorrectionSheet";
import { TimesheetAbsenceSection } from "@/features/timesheets/components/TimesheetAbsenceSection";
import { useTimesheet } from "@/features/timesheets/hooks/useTimesheet";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useIsRTL } from "@/hooks/useIsRTL";
import type { TimesheetGap } from "@/types/timesheet";
import { i18next, INTL_LOCALE_TAGS, type AppLocale } from "@/i18n";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/** "H:mm" aus Minuten — reine Anzeige, nie Teil einer Summenbildung. */
function formatMinutesLabel(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function formatSignedMinutesLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : minutes > 0 ? "+" : "";
  return `${sign}${formatMinutesLabel(Math.abs(minutes))}`;
}

export default function TimesheetScreen() {
  const theme = useAppTheme();
  const isRTL = useIsRTL();
  const styles = useMemo(() => createStyles(theme, isRTL), [theme, isRTL]);
  const { t } = useTranslation();

  const { role, profile } = useAuth();
  const isAdmin = role === "admin";

  // Mitarbeiter-Sicht: fest auf die eigene Person gebunden (keine Auswahl).
  const selfEmployee = useMemo(
    () =>
      !isAdmin && profile?.id
        ? { id: profile.id, fullName: profile.full_name?.trim() || t("timesheets:selfNameFallback") }
        : null,
    [isAdmin, profile?.id, profile?.full_name],
  );

  const {
    employees,
    selectedEmployeeId,
    setSelectedEmployeeId,
    goToPrevMonth,
    goToNextMonth,
    monthLabel,
    isCurrentMonth,
    data,
    loading,
    error,
    exporting,
    exportError,
    canExportPdf,
    exportPdf,
    reload,
  } = useTimesheet(selfEmployee);

  const hasEntries = !!data && data.entries.length > 0;

  // Korrektur-Ziel des offenen Sheets. Nur Admins bekommen die Liste
  // überhaupt zu sehen (siehe unten) — die RPC prüft die Rolle zusätzlich
  // serverseitig und lehnt Mitarbeitende mit 42501 ab.
  const [correctionTarget, setCorrectionTarget] =
    useState<TimeCorrectionTarget | null>(null);

  const gaps: TimesheetGap[] = isAdmin ? (data?.needsAttention ?? []) : [];

  const openCorrection = (gap: TimesheetGap) => {
    setCorrectionTarget({
      assignmentId: gap.assignmentId,
      employeeName: gap.employeeName,
      customerName: gap.customerName,
      remark: gap.remark,
      employeeStartedAt: gap.employeeStartedAt,
      employeeCompletedAt: gap.employeeCompletedAt,
      sharedStartedAt: gap.sharedStartedAt,
      sharedCompletedAt: gap.sharedCompletedAt,
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <AppHeader
        title={isAdmin ? t("timesheets:titleAdmin") : t("timesheets:titleMine")}
        showBack
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
      {/* ── Firmenweite Prüfliste (nur Admin) ──
          Bewusst ein eigener Einstieg: die Lückenliste weiter unten ist an
          Mitarbeiter UND Monat gebunden und kann hängende Arbeit deshalb nicht
          zuverlässig zeigen. */}
      {isAdmin ? (
        <View style={styles.section}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t("timesheets:recovery.entry")}
            onPress={() => router.push("/timesheets/recovery")}
          >
            <Card>
              <View style={styles.recoveryRow}>
                <Ionicons
                  name="alert-circle-outline"
                  size={20}
                  color={theme.colors.statusInProgress}
                />
                <View style={styles.recoveryText}>
                  <Text style={styles.recoveryTitle}>
                    {t("timesheets:recovery.entry")}
                  </Text>
                  <Text style={styles.recoverySubtitle}>
                    {t("timesheets:recovery.subtitle")}
                  </Text>
                </View>
                <Ionicons
                  name={isRTL ? "chevron-back" : "chevron-forward"}
                  size={18}
                  color={theme.colors.onSurfaceVariant}
                />
              </View>
            </Card>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ── Mitarbeiter wählen (nur Admin) ──
          In der Eigen-Sicht gibt es nichts zu wählen: der Stundenzettel ist
          fest an die angemeldete Person gebunden. */}
      {isAdmin ? (
        <View style={styles.section}>
          <SectionHeader
            title={t("timesheets:employeeSection.title")}
            subtitle={t("timesheets:employeeSection.subtitle")}
          />
          {employees.length === 0 ? (
            <Card>
              <EmptyState
                title={t("timesheets:employeeSection.emptyTitle")}
                message={t("timesheets:employeeSection.emptyMessage")}
                icon="people-outline"
                compact
              />
            </Card>
          ) : (
            <Card padding={0}>
              {employees.map((emp, idx) => {
                const selected = emp.id === selectedEmployeeId;
                return (
                  <TouchableOpacity
                    key={emp.id}
                    activeOpacity={0.7}
                    onPress={() => setSelectedEmployeeId(emp.id)}
                    style={[styles.empRow, idx > 0 && styles.rowDivider]}
                  >
                    <View style={styles.empInfo}>
                      <Text style={styles.empName} numberOfLines={1}>
                        {emp.fullName}
                      </Text>
                      {emp.isActive === false && (
                        <Text style={styles.empInactive}>{t("timesheets:employeeSection.inactive")}</Text>
                      )}
                    </View>
                    <Ionicons
                      name={selected ? "radio-button-on" : "radio-button-off"}
                      size={22}
                      color={
                        selected ? theme.colors.primary : theme.colors.outline
                      }
                    />
                  </TouchableOpacity>
                );
              })}
            </Card>
          )}
        </View>
      ) : null}

      {/* ── Monat wählen ── */}
      <View style={styles.section}>
        <SectionHeader title={t("timesheets:monthSection.title")} subtitle={t("timesheets:monthSection.subtitle")} />
        <Card>
          <View style={styles.monthRow}>
            <TouchableOpacity
              onPress={goToPrevMonth}
              style={styles.monthBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isRTL ? "chevron-forward" : "chevron-back"}
                size={22}
                color={theme.colors.onSurface}
              />
            </TouchableOpacity>

            <Text style={styles.monthLabel}>{monthLabel}</Text>

            <TouchableOpacity
              onPress={goToNextMonth}
              disabled={isCurrentMonth}
              style={styles.monthBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isRTL ? "chevron-back" : "chevron-forward"}
                size={22}
                color={
                  isCurrentMonth
                    ? theme.colors.outlineVariant
                    : theme.colors.onSurface
                }
              />
            </TouchableOpacity>
          </View>
        </Card>
      </View>

      {/* ── Zeitlücken und Sitzungsprüfung (nur Admin) ──
          Bewusst ÜBER der Vorschau: Legacy-Lücken fehlen in der Summe;
          überprüfungsbedürftige Sitzungszeit kann darin enthalten sein. */}
      {isAdmin && gaps.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader
            title={t("admin:timesheet.gapsSectionTitle")}
            subtitle={gaps.some((gap) => gap.source === "sessions")
              ? undefined : t("admin:timesheet.gapsSectionSubtitle")}
          />
          <Card padding={0}>
            {gaps.map((gap, idx) => (
              <View
                key={gap.assignmentId}
                style={[styles.gapRow, idx > 0 && styles.rowDivider]}
              >
                <View style={styles.gapIconWrap}>
                  <Ionicons
                    name="alert-circle-outline"
                    size={18}
                    color={theme.colors.error}
                  />
                </View>
                <View style={styles.gapInfo}>
                  <Text style={styles.gapCustomer} numberOfLines={1}>
                    {formatDayShort(gap.date)} · {gap.customerName}
                  </Text>
                  <Text style={styles.gapProblem}>{gap.reasonLabel}</Text>
                  {gap.remark ? (
                    <Text style={styles.gapMeta} numberOfLines={1}>
                      {gap.remark}
                    </Text>
                  ) : null}
                </View>
                {gap.source !== "sessions" ? (
                  <TouchableOpacity
                    style={styles.gapButton}
                    onPress={() => openCorrection(gap)}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.gapButtonText}>
                      {t("admin:timesheet.correctTimeButton")}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {/* ── Hinweise + Abwesenheiten (Phase E) ──
          Für Admin und Mitarbeiter identisch — beide sehen die
          Abwesenheiten/Hinweise des gewählten Mitarbeiters (in der
          Eigen-Sicht immer die eigenen). Rendert nichts, solange kein
          Mitarbeiter/Monat mit Daten geladen ist. */}
      {data ? (
        <TimesheetAbsenceSection summary={data.absenceSummary} notices={data.notices} />
      ) : null}

      {/* ── Vorschau ── */}
      <View style={styles.section}>
        <SectionHeader
          title={isAdmin ? t("timesheets:previewSection.titleAdmin") : t("timesheets:previewSection.titleMine")}
          subtitle={t("timesheets:previewSection.subtitle")}
        />

        {!selectedEmployeeId ? (
          <Card>
            <EmptyState
              title={t("timesheets:previewSection.selectEmployeeTitle")}
              message={t("timesheets:previewSection.selectEmployeeMessage")}
              icon="person-outline"
            />
          </Card>
        ) : loading ? (
          <Card>
            <View style={styles.loadingBox}>
              <ActivityIndicator color={theme.colors.primary} />
              <Text style={styles.muted}>{t("timesheets:previewSection.loading")}</Text>
            </View>
          </Card>
        ) : error ? (
          <ErrorBanner message={error} />
        ) : !hasEntries ? (
          <Card>
            <EmptyState
              title={t("timesheets:previewSection.emptyTitle")}
              message={
                isAdmin
                  ? t("timesheets:previewSection.emptyMessageAdmin")
                  : t("timesheets:previewSection.emptyMessageMine")
              }
              icon="calendar-clear-outline"
            />
          </Card>
        ) : (
          <Card padding={0}>
            {/* Tabellenkopf */}
            <View style={[styles.tableRow, styles.tableHead]}>
              <Text style={[styles.cell, styles.cellDay, styles.headText]}>
                {t("timesheets:table.day")}
              </Text>
              <Text style={[styles.cell, styles.cellTime, styles.headText]}>
                {t("timesheets:table.begin")}
              </Text>
              <Text style={[styles.cell, styles.cellTime, styles.headText]}>
                {t("timesheets:table.end")}
              </Text>
              <Text style={[styles.cell, styles.cellDur, styles.headText]}>
                {t("timesheets:table.duration")}
              </Text>
            </View>

            {data!.entries.map((entry, idx) => (
              <View
                key={entry.entryId ?? entry.jobId}
                style={[styles.entryWrap, idx > 0 && styles.rowDivider]}
              >
                <View style={styles.tableRow}>
                  <Text style={[styles.cell, styles.cellDay]}>
                    {formatDayShort(entry.date)}
                  </Text>
                  <Text style={[styles.cell, styles.cellTime]}>
                    {entry.beginLabel}
                  </Text>
                  <Text style={[styles.cell, styles.cellTime]}>
                    {entry.endLabel}
                  </Text>
                  <Text style={[styles.cell, styles.cellDur, styles.durText]}>
                    {entry.durationLabel}
                  </Text>
                </View>
                <Text style={styles.entryMeta} numberOfLines={1}>
                  {entry.customerName}
                  {entry.remark ? ` · ${entry.remark}` : ""}
                  {entry.reviewRequired ? ` · ⚠ ${t("jobs:work.reviewRequired")}` : ""}
                </Text>
                {/* NEUTRALER Marker — auch für Mitarbeitende. Er nennt weder
                    einen Grund noch einen Akteur, keine Warnfarbe. */}
                {entry.reviewed ? (
                  <Text style={styles.entryMeta} numberOfLines={1}>
                    {t("jobs:work.reviewedByAdmin")}
                  </Text>
                ) : null}
                {/* Prüf-Metadaten existieren NUR im Admin-Stundenzettel:
                    getTimesheet holt die Kette ausschließlich mit includeAudit,
                    ein Mitarbeiter-Datensatz trägt diese Felder gar nicht. */}
                {isAdmin && entry.correctionReason ? (
                  <Text style={styles.entryMeta}>
                    {entry.recordedMinutes === null || entry.recordedMinutes === undefined
                      ? t("timesheets:recovery.recordedMissing")
                      : t("timesheets:recovery.recorded", {
                          time: formatMinutesLabel(entry.recordedMinutes),
                        })}
                    {` · ${t("timesheets:recovery.effective", { time: entry.durationLabel })}`}
                    {entry.correctionMinutes !== null && entry.correctionMinutes !== undefined
                      ? ` · ${t("timesheets:recovery.correction", {
                          time: formatSignedMinutesLabel(entry.correctionMinutes),
                        })}`
                      : ""}
                    {entry.correctionOrigin === "admin_raised"
                      ? ` · ${t("timesheets:recovery.auditRaised")}` : ""}
                    {` · ${entry.correctionReason}`}
                  </Text>
                ) : null}
              </View>
            ))}

            {/* Summenzeile */}
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>
                {t("timesheets:summary", { count: data!.jobCount })}
              </Text>
              <Text style={styles.summaryValue}>{data!.totalLabel} h</Text>
            </View>
          </Card>
        )}
      </View>

      {exportError && <ErrorBanner message={exportError} />}

      {/* ── Export ── */}
      <Button
        label={t("timesheets:exportButton")}
        icon="document-text-outline"
        onPress={exportPdf}
        loading={exporting}
        disabled={!hasEntries || loading || !canExportPdf}
        style={styles.exportBtn}
      />

      <View style={{ height: theme.spacing.xxl }} />
      </ScrollView>

      <TimeCorrectionSheet
        visible={!!correctionTarget}
        target={correctionTarget}
        onClose={() => setCorrectionTarget(null)}
        onCorrected={reload}
      />
    </SafeAreaView>
  );
}

// "YYYY-MM-DD" → "Mo 03.06." für die Vorschau (ohne Zeitzonen-Drift).
// Wochentags-Kürzel sprachabhängig (i18next.language statt fest "de-DE") —
// das Zahlenformat (TT.MM.) selbst bleibt unverändert (Datumsformat-Phase,
// siehe i18n-Audit).
function formatDayShort(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return isoDate;
  const date = new Date(y, m - 1, d);
  const localeTag = INTL_LOCALE_TAGS[i18next.language as AppLocale] ?? "de-DE";
  const weekday = date.toLocaleDateString(localeTag, { weekday: "short" });
  return `${weekday} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.`;
}

function createStyles(theme: AppTheme, isRTL: boolean) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    scroll: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.gutter,
      paddingBottom: 32,
    },
    recoveryRow: {
      flexDirection: isRTL ? "row-reverse" : "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    recoveryText: { flex: 1 },
    recoveryTitle: {
      fontFamily: theme.typography.family.medium,
      fontSize: theme.typography.size.md,
      color: theme.colors.onSurface,
      textAlign: isRTL ? "right" : "left",
    },
    recoverySubtitle: {
      fontSize: theme.typography.size.sm,
      color: theme.colors.onSurfaceVariant,
      textAlign: isRTL ? "right" : "left",
    },
    section: {
      marginTop: theme.spacing.lg,
    },
    muted: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // ── Mitarbeiter-Zeile
    empRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      padding: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    rowDivider: {
      borderTopWidth: 1,
      borderTopColor: theme.colors.outlineVariant,
    },
    empInfo: {
      flex: 1,
    },
    empName: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    empInactive: {
      marginTop: 2,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // ── Monat
    monthRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    monthBtn: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceContainerHigh,
    },
    monthLabel: {
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      textTransform: "capitalize",
    },

    // ── Vorschau
    loadingBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    entryWrap: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    tableRow: {
      flexDirection: "row",
      alignItems: "center",
    },
    tableHead: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderTopLeftRadius: theme.radius.lg,
      borderTopRightRadius: theme.radius.lg,
    },
    cell: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },
    cellDay: {
      flex: 1.4,
    },
    cellTime: {
      flex: 1,
      textAlign: "center",
    },
    cellDur: {
      flex: 1,
      // Letzte Spalte der Zeile — Text bleibt am ZEILENENDE ausgerichtet
      // (rechts in LTR, links in RTL), nicht physisch fix rechts.
      textAlign: isRTL ? "left" : "right",
    },
    headText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      textTransform: "uppercase",
      letterSpacing: theme.typography.letterSpacing.wide,
    },
    durText: {
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    entryMeta: {
      marginTop: 2,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // ── Summe
    summaryRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      borderTopWidth: 1,
      borderTopColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderBottomLeftRadius: theme.radius.lg,
      borderBottomRightRadius: theme.radius.lg,
    },
    summaryLabel: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    summaryValue: {
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },

    exportBtn: {
      marginTop: theme.spacing.lg,
    },

    // ── Zeitkorrekturen erforderlich (Phase B1)
    gapRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      padding: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    gapIconWrap: {
      width: 28,
      alignItems: "center",
    },
    gapInfo: {
      flex: 1,
      gap: 2,
    },
    gapCustomer: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    gapProblem: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.error,
    },
    gapMeta: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    gapButton: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 8,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primaryContainer,
      minHeight: 36,
      justifyContent: "center",
    },
    gapButtonText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimaryContainer,
    },
  });
}
