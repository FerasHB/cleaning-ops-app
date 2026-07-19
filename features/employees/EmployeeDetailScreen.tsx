// features/employees/EmployeeDetailScreen.tsx
// Admin-Detailansicht eines Mitarbeiters.
// Reines Lesen aus dem JobContext (employees + jobs) — keine Business-Logik.
//
// Hinweis zu Datenquellen:
// - EmployeeOption liefert id, fullName, role, isActive (aus profiles).
// - profiles hat KEINE email-Spalte → email ist immer null, UI zeigt
//   "Nicht hinterlegt". Keine erfundenen Daten.

import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  InfoRow,
  InitialsAvatar,
  KPICard,
  LoadingScreen,
} from "@/components/ui";
import JobCard from "@/components/JobCard";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { resendInvite } from "@/services/employees/resendInvite";
import type { AppTheme } from "@/constants/theme";
import type { Job, JobStatus } from "@/types/job";
import { formatForDisplay } from "@/utils/date";
import { getEmployeeStatus } from "@/utils/employeeStatus";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import React, { useMemo, useState } from "react";
import { Alert, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Reihenfolge für die Job-Liste: laufend → offen → erledigt
const STATUS_ORDER: Record<JobStatus, number> = {
  in_progress: 0,
  open: 1,
  completed: 2,
};

function roleLabel(role?: string | null): string {
  if (role === "admin") return "Admin";
  return "Mitarbeiter";
}

function jobDateValue(job: Job): number {
  const iso = job.completedAt ?? job.startedAt ?? job.scheduledStart;
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

function isSameDay(iso: string | null | undefined, ref: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

export default function EmployeeDetailScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { id } = useLocalSearchParams<{ id: string }>();
  const { employees, jobs, loading, setEmployeeActive } = useJobs();

  // Loading-State für Deaktivieren/Reaktivieren.
  const [updatingActive, setUpdatingActive] = useState(false);
  // Loading-State für "Einladung erneut senden".
  const [resendingInvite, setResendingInvite] = useState(false);

  const employee = useMemo(
    () => employees.find((e) => e.id === id),
    [employees, id],
  );

  // Alle Jobs dieses Mitarbeiters
  const assignedJobs = useMemo(
    () => jobs.filter((j) => j.employeeId === id),
    [jobs, id],
  );

  // Statistiken
  const openCount = assignedJobs.filter((j) => j.status === "open").length;
  const inProgressCount = assignedJobs.filter(
    (j) => j.status === "in_progress",
  ).length;
  const completedCount = assignedJobs.filter(
    (j) => j.status === "completed",
  ).length;
  const totalCount = assignedJobs.length;

  const now = useMemo(() => new Date(), []);
  const todayCount = useMemo(
    () =>
      assignedJobs.filter(
        (j) =>
          isSameDay(j.scheduledStart, now) ||
          isSameDay(j.startedAt, now) ||
          isSameDay(j.completedAt, now),
      ).length,
    [assignedJobs, now],
  );

  // Aktiver Job = erster laufender Job dieses Mitarbeiters
  const activeJob = useMemo(
    () => assignedJobs.find((j) => j.status === "in_progress") ?? null,
    [assignedJobs],
  );

  // Relevante Jobs für die Liste (max. 5, sinnvoll sortiert)
  const visibleJobs = useMemo(
    () =>
      [...assignedJobs]
        .sort((a, b) => {
          const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          if (byStatus !== 0) return byStatus;
          return jobDateValue(b) - jobDateValue(a);
        })
        .slice(0, 5),
    [assignedJobs],
  );

  if (loading) return <LoadingScreen />;

  // ── Mitarbeiter nicht gefunden ──
  if (!employee) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <StatusBar
          barStyle={theme.isDark ? "light-content" : "dark-content"}
          backgroundColor={theme.colors.background}
        />
        <AppHeader title="Mitarbeiter" showBack />
        <View style={styles.emptyWrap}>
          <EmptyState
            title="Mitarbeiter nicht gefunden"
            message="Dieser Mitarbeiter ist nicht (mehr) verfügbar."
            icon="person-outline"
            ctaLabel="Zurück"
            onCta={() => router.back()}
          />
        </View>
      </SafeAreaView>
    );
  }

  // Konto-Status aus profiles.is_active (neutraler Fallback: nicht "inaktiv"
  // behaupten, wenn der Wert fehlt).
  const accountActive = employee.isActive !== false;
  const emailDisplay = employee.email?.trim() ? employee.email : "Nicht hinterlegt";

  // Einladungs-Status (Eingeladen/Aktiv/Inaktiv) — dieselbe Ableitung wie in
  // der Mitarbeiter-Liste, siehe utils/employeeStatus.ts.
  const status = getEmployeeStatus(employee);
  const invitePending = status.variant === "pending";
  const invitedAtText = formatForDisplay(employee.invitedAt);

  const statusPillColors =
    status.variant === "pending"
      ? {
          bg: theme.colors.statusOpenBg,
          border: theme.colors.statusOpenBorder,
          text: theme.colors.statusOpen,
        }
      : status.variant === "active"
        ? {
            bg: theme.colors.statusCompletedBg,
            border: theme.colors.statusCompletedBorder,
            text: theme.colors.statusCompleted,
          }
        : {
            bg: theme.colors.surfaceContainerHigh,
            border: theme.colors.outlineVariant,
            text: theme.colors.onSurfaceVariant,
          };

  const handleAssignJob = () => router.push("/jobs/create");

  // Einladung erneut senden — nur relevant, solange sie noch nicht
  // angenommen wurde (server-seitig ohnehin abgesichert, siehe
  // resend-invite/index.ts).
  const handleResendInvite = async () => {
    if (!employee || resendingInvite) return;
    try {
      setResendingInvite(true);
      await resendInvite(employee.id);
      Alert.alert(
        "Einladung verschickt",
        `${employee.fullName} hat eine neue Einladungs-E-Mail erhalten.`,
      );
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Einladung konnte nicht erneut verschickt werden.";
      Alert.alert("Fehler", message);
    } finally {
      setResendingInvite(false);
    }
  };

  // Deaktivieren/Reaktivieren mit Sicherheitsabfrage. Schreibt is_active und
  // lädt die Mitarbeiterliste neu (passiert in setEmployeeActive).
  const applyActiveChange = async (nextActive: boolean) => {
    if (!employee) return;
    try {
      setUpdatingActive(true);
      await setEmployeeActive(employee.id, nextActive);
      Alert.alert(
        "Erfolg",
        nextActive
          ? "Mitarbeiter wurde reaktiviert."
          : "Mitarbeiter wurde deaktiviert.",
      );
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Status konnte nicht geändert werden.";
      Alert.alert("Fehler", message);
    } finally {
      setUpdatingActive(false);
    }
  };

  const handleToggleActive = () => {
    if (!employee || updatingActive) return;

    if (accountActive) {
      Alert.alert(
        "Mitarbeiter deaktivieren",
        `${employee.fullName} wird deaktiviert und kann keinen neuen Jobs mehr zugewiesen werden. Bestehende Jobs bleiben unverändert.`,
        [
          { text: "Abbrechen", style: "cancel" },
          {
            text: "Deaktivieren",
            style: "destructive",
            onPress: () => applyActiveChange(false),
          },
        ],
      );
    } else {
      Alert.alert(
        "Mitarbeiter reaktivieren",
        `${employee.fullName} wird wieder aktiv und kann erneut Jobs zugewiesen bekommen.`,
        [
          { text: "Abbrechen", style: "cancel" },
          {
            text: "Reaktivieren",
            onPress: () => applyActiveChange(true),
          },
        ],
      );
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <AppHeader title="Mitarbeiter" showBack />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Profil-Header ── */}
        <Card padding={theme.spacing.lg} style={styles.headerCard}>
          <InitialsAvatar name={employee.fullName} size={64} />
          <Text style={styles.name}>{employee.fullName}</Text>

          <View
            style={[
              styles.statusPill,
              {
                backgroundColor: statusPillColors.bg,
                borderColor: statusPillColors.border,
              },
            ]}
          >
            <View style={[styles.statusDot, { backgroundColor: statusPillColors.text }]} />
            <Text style={[styles.statusText, { color: statusPillColors.text }]}>
              {status.label}
            </Text>
          </View>
        </Card>

        {/* ── Stammdaten ── */}
        <Card padding={theme.spacing.lg} style={styles.card}>
          <InfoRow
            label="Rolle"
            value={roleLabel(employee.role)}
            icon="briefcase-outline"
          />
          <View style={styles.rowDivider} />
          <InfoRow label="E-Mail" value={emailDisplay} icon="mail-outline" />
          <View style={styles.rowDivider} />
          <InfoRow label="Konto-Status" value={status.label} icon="pulse-outline" />
          {invitePending && invitedAtText ? (
            <>
              <View style={styles.rowDivider} />
              <InfoRow
                label="Eingeladen am"
                value={invitedAtText}
                icon="mail-unread-outline"
              />
            </>
          ) : null}
        </Card>

        {/* ── Aktueller Job ── */}
        {activeJob ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>AKTUELLER JOB</Text>
            <JobCard
              job={activeJob}
              onPress={() => router.push(`/jobs/${activeJob.id}`)}
            />
          </View>
        ) : null}

        {/* ── Statistiken ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>STATISTIK</Text>
          <View style={styles.kpiGrid}>
            <View style={styles.kpiItem}>
              <KPICard
                label="Heute"
                value={todayCount}
                icon="today-outline"
                accentColor={theme.colors.primary}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label="Offen"
                value={openCount}
                icon="folder-open-outline"
                accentColor={theme.colors.statusOpen}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label="In Arbeit"
                value={inProgressCount}
                icon="time-outline"
                accentColor={theme.colors.statusInProgress}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label="Erledigt"
                value={completedCount}
                icon="checkmark-circle-outline"
                accentColor={theme.colors.statusCompleted}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label="Gesamt"
                value={totalCount}
                icon="layers-outline"
              />
            </View>
          </View>
        </View>

        {/* ── Zugewiesene Jobs ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionLabel}>ZUGEWIESENE JOBS</Text>
            {totalCount > visibleJobs.length ? (
              <Text style={styles.sectionMeta}>
                {visibleJobs.length} von {totalCount}
              </Text>
            ) : null}
          </View>

          {visibleJobs.length === 0 ? (
            <Card padding={theme.spacing.lg}>
              <EmptyState
                title="Keine Jobs zugewiesen"
                message="Diesem Mitarbeiter wurden noch keine Jobs zugewiesen."
                icon="briefcase-outline"
              />
            </Card>
          ) : (
            <View style={styles.jobList}>
              {visibleJobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  showEmployeeName={false}
                  onPress={() => router.push(`/jobs/${job.id}`)}
                />
              ))}
            </View>
          )}
        </View>

        {/* ── Aktionen ── */}
        <View style={styles.actions}>
          <Button
            label="Job zuweisen"
            icon="add"
            onPress={handleAssignJob}
          />
          {invitePending ? (
            <Button
              label="Einladung erneut senden"
              variant="secondary"
              icon="mail-outline"
              loading={resendingInvite}
              onPress={handleResendInvite}
            />
          ) : null}
          <Button
            label={
              accountActive
                ? "Mitarbeiter deaktivieren"
                : "Mitarbeiter reaktivieren"
            }
            variant={accountActive ? "danger" : "secondary"}
            icon={
              accountActive ? "person-remove-outline" : "person-add-outline"
            }
            loading={updatingActive}
            onPress={handleToggleActive}
          />
        </View>

        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    emptyWrap: {
      flex: 1,
    },
    scroll: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.gutter,
      paddingTop: theme.spacing.lg,
      paddingBottom: 32,
      gap: theme.spacing.md,
    },

    // ── Profil-Header
    headerCard: {
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    name: {
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },
    statusPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderWidth: 1,
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 5,
    },
    statusDot: {
      width: 7,
      height: 7,
      borderRadius: theme.radius.full,
    },
    statusText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },

    // ── Karten
    card: {
      gap: theme.spacing.md,
    },
    rowDivider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
    },

    // ── Sections
    section: {
      gap: theme.spacing.sm,
    },
    sectionHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wider,
      textTransform: "uppercase",
    },
    sectionMeta: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.outline,
    },

    // ── KPI-Grid
    kpiGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
    },
    kpiItem: {
      width: "48%",
      flexGrow: 1,
    },

    // ── Job-Liste
    jobList: {
      gap: theme.spacing.sm,
    },

    // ── Aktionen
    actions: {
      gap: theme.spacing.sm,
      marginTop: theme.spacing.sm,
    },
  });
}
