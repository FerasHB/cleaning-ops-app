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
// und PDF-Aufbau sind unverändert, und RLS liefert Mitarbeitenden ohnehin nur
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
import { useTimesheet } from "@/features/timesheets/hooks/useTimesheet";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { TimesheetGap } from "@/types/timesheet";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
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

export default function TimesheetScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { role, profile } = useAuth();
  const isAdmin = role === "admin";

  // Mitarbeiter-Sicht: fest auf die eigene Person gebunden (keine Auswahl).
  const selfEmployee = useMemo(
    () =>
      !isAdmin && profile?.id
        ? { id: profile.id, fullName: profile.full_name?.trim() || "Ich" }
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
        title={isAdmin ? "Stundenzettel" : "Meine Arbeitszeit"}
        showBack
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
      {/* ── Mitarbeiter wählen (nur Admin) ──
          In der Eigen-Sicht gibt es nichts zu wählen: der Stundenzettel ist
          fest an die angemeldete Person gebunden. */}
      {isAdmin ? (
        <View style={styles.section}>
          <SectionHeader
            title="Mitarbeiter"
            subtitle="Für wen soll der Nachweis erstellt werden?"
          />
          {employees.length === 0 ? (
            <Card>
              <EmptyState
                title="Keine Mitarbeiter"
                message="Lege zuerst Mitarbeiter an, um einen Nachweis zu erstellen."
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
                        <Text style={styles.empInactive}>Inaktiv</Text>
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
        <SectionHeader title="Monat" subtitle="Abrechnungszeitraum" />
        <Card>
          <View style={styles.monthRow}>
            <TouchableOpacity
              onPress={goToPrevMonth}
              style={styles.monthBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.7}
            >
              <Ionicons
                name="chevron-back"
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
                name="chevron-forward"
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

      {/* ── Zeitkorrekturen erforderlich (nur Admin) ──
          Bewusst ÜBER der Vorschau: diese Zuweisungen erzeugen keinen Eintrag
          und fehlen daher in der Summe darunter. Wer erst die Summe sieht,
          hält sie für vollständig. */}
      {isAdmin && gaps.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader
            title="Zeitkorrekturen erforderlich"
            subtitle="Diese Aufträge zählen noch nicht zur Arbeitszeit"
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
                <TouchableOpacity
                  style={styles.gapButton}
                  onPress={() => openCorrection(gap)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.gapButtonText}>Zeit korrigieren</Text>
                </TouchableOpacity>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {/* ── Vorschau ── */}
      <View style={styles.section}>
        <SectionHeader
          title={isAdmin ? "Vorschau" : "Deine Zeiten"}
          subtitle="Abgeschlossene Aufträge im Zeitraum"
        />

        {!selectedEmployeeId ? (
          <Card>
            <EmptyState
              title="Mitarbeiter wählen"
              message="Bitte zuerst einen Mitarbeiter auswählen."
              icon="person-outline"
            />
          </Card>
        ) : loading ? (
          <Card>
            <View style={styles.loadingBox}>
              <ActivityIndicator color={theme.colors.primary} />
              <Text style={styles.muted}>Lade Stundenzettel…</Text>
            </View>
          </Card>
        ) : error ? (
          <ErrorBanner message={error} />
        ) : !hasEntries ? (
          <Card>
            <EmptyState
              title="Keine Einträge"
              message={
                isAdmin
                  ? "Keine abgeschlossenen Jobs in diesem Zeitraum"
                  : "In diesem Monat hast du noch keinen Auftrag abgeschlossen."
              }
              icon="calendar-clear-outline"
            />
          </Card>
        ) : (
          <Card padding={0}>
            {/* Tabellenkopf */}
            <View style={[styles.tableRow, styles.tableHead]}>
              <Text style={[styles.cell, styles.cellDay, styles.headText]}>
                Tag
              </Text>
              <Text style={[styles.cell, styles.cellTime, styles.headText]}>
                Beginn
              </Text>
              <Text style={[styles.cell, styles.cellTime, styles.headText]}>
                Ende
              </Text>
              <Text style={[styles.cell, styles.cellDur, styles.headText]}>
                Dauer
              </Text>
            </View>

            {data!.entries.map((entry, idx) => (
              <View
                key={entry.jobId}
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
                </Text>
              </View>
            ))}

            {/* Summenzeile */}
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>
                Summe · {data!.jobCount} Job{data!.jobCount === 1 ? "" : "s"}
              </Text>
              <Text style={styles.summaryValue}>{data!.totalLabel} h</Text>
            </View>
          </Card>
        )}
      </View>

      {exportError && <ErrorBanner message={exportError} />}

      {/* ── Export ── */}
      <Button
        label="PDF exportieren"
        icon="document-text-outline"
        onPress={exportPdf}
        loading={exporting}
        disabled={!hasEntries || loading}
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
function formatDayShort(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return isoDate;
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString("de-DE", { weekday: "short" });
  return `${weekday} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.`;
}

function createStyles(theme: AppTheme) {
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
      textAlign: "right",
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
