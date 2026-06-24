// features/timesheets/TimesheetScreen.tsx
// Stundenzettel-Screen (nur Admin): Mitarbeiter + Monat wählen, Vorschau der
// abgeschlossenen Jobs, Summe und PDF-Export (expo-print + expo-sharing).
// Vollständig theme-aware (Light + Dark Mode).

import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  ScreenContainer,
  SectionHeader,
} from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { useTimesheet } from "@/features/timesheets/hooks/useTimesheet";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export default function TimesheetScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { role } = useAuth();
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
  } = useTimesheet();

  // Route ist Teil des authed-Stacks (Admin + Employee). Stundenzettel ist aber
  // ein reines Admin-Feature → Mitarbeiter sehen einen klaren Hinweis.
  if (role !== "admin") {
    return (
      <ScreenContainer scrollable={false}>
        <AppHeader title="Stundenzettel" showBack />
        <EmptyState
          title="Nur für Admins"
          message="Stundenzettel können nur von Administratoren erstellt werden."
          icon="lock-closed-outline"
        />
      </ScreenContainer>
    );
  }

  const hasEntries = !!data && data.entries.length > 0;

  return (
    <ScreenContainer>
      <AppHeader title="Stundenzettel" showBack />

      {/* ── Mitarbeiter wählen ── */}
      <View style={styles.section}>
        <SectionHeader
          title="Mitarbeiter"
          subtitle="Für wen soll der Nachweis erstellt werden?"
        />
        {employees.length === 0 ? (
          <Card>
            <Text style={styles.muted}>Keine Mitarbeiter vorhanden.</Text>
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

      {/* ── Vorschau ── */}
      <View style={styles.section}>
        <SectionHeader
          title="Vorschau"
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
              message="Keine abgeschlossenen Jobs in diesem Zeitraum"
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
    </ScreenContainer>
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
  });
}
