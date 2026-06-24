// features/admin/AdminDashboardScreen.tsx
// Admin-Dashboard (Tab "Dashboard") im SaaS-/Field-Service-Stil.
// Vollständig theme-aware (Light + Dark Mode), nur Lesezugriff auf JobContext/AuthContext.
//
// Hinweise:
// - Firmenname: profile liefert nur company_id (keinen Namen) → neutraler Titel "Dashboard"
//   (bewusst kein company.name-Fetch im MVP).
// - "Heute fällig": isJobToday() aus utils/jobSchedule (single per date/scheduledStart,
//   recurring per Wochentag, nur aktive) — gleiche Logik wie EmployeeOverviewScreen.

import {
  Card,
  EmptyState,
  InitialsAvatar,
  KPICard,
  LoadingScreen,
  OfflineBanner,
  SaveStatusBadge,
  ScreenContainer,
  SectionHeader,
} from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import type { Job } from "@/types/job";
import { isJobToday } from "@/utils/jobSchedule";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

const COMPANY_NAME = "Dashboard";

// ── Tageszeit-abhängige Begrüßung
function getGreeting(date: Date): string {
  const h = date.getHours();
  if (h < 11) return "Guten Morgen";
  if (h < 18) return "Guten Tag";
  return "Guten Abend";
}

// ── Aktivitäts-Mapping pro Status
function activityConfig(theme: AppTheme, status: Job["status"]) {
  switch (status) {
    case "completed":
      return {
        label: "Job abgeschlossen",
        icon: "checkmark-circle-outline" as const,
        color: theme.colors.statusCompleted,
      };
    case "in_progress":
      return {
        label: "Job gestartet",
        icon: "play-circle-outline" as const,
        color: theme.colors.statusInProgress,
      };
    case "open":
      return {
        label: "Neuer Job offen",
        icon: "ellipse-outline" as const,
        color: theme.colors.statusOpen,
      };
  }
}

function activityTimestamp(job: Job): number {
  const iso = job.completedAt ?? job.startedAt ?? job.scheduledStart ?? null;
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

export default function AdminDashboardScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { profile } = useAuth();
  const { jobs, employees, loading } = useJobs();

  const now = useMemo(() => new Date(), []);

  const adminName = profile?.full_name?.trim() || "Admin";

  const dateLabel = useMemo(
    () =>
      now.toLocaleDateString("de-DE", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
      }),
    [now],
  );
  const timeLabel = useMemo(
    () =>
      now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }),
    [now],
  );

  // ── KPI-Werte (aus vorhandenen Jobs berechnet)
  const openCount = jobs.filter((j) => j.status === "open").length;
  const inProgressCount = jobs.filter((j) => j.status === "in_progress").length;
  const completedCount = jobs.filter((j) => j.status === "completed").length;
  // Heute fällig: single mit heutigem Datum + recurring mit heutigem Wochentag,
  // jeweils nur aktive — identische Logik wie in der Employee-Übersicht.
  const todayCount = jobs.filter((j) => isJobToday(j, now)).length;

  // ── Mitarbeiter-Aktivität: aktiver (in_progress) Job pro Mitarbeiter
  const employeeActivity = useMemo(
    () =>
      employees
        .filter((emp) => emp.isActive !== false)
        .map((emp) => {
          const activeJob = jobs.find(
            (j) => j.employeeId === emp.id && j.status === "in_progress",
          );
          return { id: emp.id, name: emp.fullName, activeJob };
        }),
    [employees, jobs],
  );

  // ── Letzte Aktivitäten: nach Zeitstempel absteigend, dann pro
  // Recurring-Parent nur den neuesten Eintrag (Dedup nach parentJobId ?? id),
  // damit materialisierte Daueraufträge denselben Kunden nicht mehrfach zeigen.
  // Danach max. 5 eindeutige Aktivitäten. Konkrete Jobs bleiben unverändert.
  const recentActivity = useMemo(() => {
    const sorted = [...jobs].sort(
      (a, b) => activityTimestamp(b) - activityTimestamp(a),
    );
    const seen = new Set<string>();
    const unique: Job[] = [];
    for (const job of sorted) {
      const key = job.parentJobId ?? job.id;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(job);
      if (unique.length >= 5) break;
    }
    return unique;
  }, [jobs]);

  if (loading) return <LoadingScreen />;

  return (
    <ScreenContainer>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <View style={styles.brandLeft}>
            <View style={styles.logoBadge}>
              <Ionicons
                name="business"
                size={18}
                color={theme.colors.onPrimaryContainer}
              />
            </View>
            <Text style={styles.companyName}>{COMPANY_NAME}</Text>
          </View>

          {/* Dezenter Online-Status oben rechts */}
          <SaveStatusBadge />
        </View>

        <Text style={styles.greeting}>
          {getGreeting(now)}, {adminName}
        </Text>
        <Text style={styles.dateText}>
          {dateLabel} · {timeLabel}
        </Text>
      </View>

      {/* ── Save-Status ── */}
      <OfflineBanner />

      {/* ── KPI-Karten (2×2) → tippen öffnet die Jobliste ── */}
      <View style={styles.kpiGrid}>
        <View style={styles.kpiItem}>
          <KPICard
            label="Offene Jobs"
            value={openCount}
            icon="folder-open-outline"
            accentColor={theme.colors.statusOpen}
            onPress={() => router.push("/(admin-tabs)/jobs")}
          />
        </View>
        <View style={styles.kpiItem}>
          <KPICard
            label="In Arbeit"
            value={inProgressCount}
            icon="time-outline"
            accentColor={theme.colors.statusInProgress}
            onPress={() => router.push("/(admin-tabs)/jobs")}
          />
        </View>
        <View style={styles.kpiItem}>
          <KPICard
            label="Erledigt"
            value={completedCount}
            icon="checkmark-done-outline"
            accentColor={theme.colors.statusCompleted}
            onPress={() => router.push("/(admin-tabs)/jobs")}
          />
        </View>
        <View style={styles.kpiItem}>
          <KPICard
            label="Heute fällig"
            value={todayCount}
            icon="calendar-outline"
            accentColor={theme.colors.primary}
            onPress={() => router.push("/(admin-tabs)/jobs")}
          />
        </View>
      </View>

      {/* ── Mitarbeiter-Aktivität ── */}
      <View style={styles.section}>
        <SectionHeader
          title="Mitarbeiter-Aktivität"
          subtitle="Wer arbeitet gerade an einem Job?"
        />
        {employeeActivity.length === 0 ? (
          <Card>
            <EmptyState
              title="Keine Mitarbeiter"
              message="Sobald du Mitarbeiter anlegst, erscheinen sie hier."
              icon="people-outline"
            />
          </Card>
        ) : (
          <Card padding={0}>
            {employeeActivity.map((emp, idx) => {
              const isActive = !!emp.activeJob;
              return (
                <TouchableOpacity
                  key={emp.id}
                  activeOpacity={0.7}
                  onPress={() => router.push(`/employees/${emp.id}`)}
                  style={[
                    styles.empRow,
                    idx > 0 && styles.rowDivider,
                  ]}
                >
                  <InitialsAvatar name={emp.name} size={40} />
                  <View style={styles.empInfo}>
                    <Text style={styles.empName} numberOfLines={1}>
                      {emp.name}
                    </Text>
                    <Text style={styles.empJob} numberOfLines={1}>
                      {isActive
                        ? emp.activeJob?.customerName ??
                          emp.activeJob?.service ??
                          "Aktiver Job"
                        : "Kein aktiver Job"}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusDot,
                      {
                        backgroundColor: isActive
                          ? theme.colors.statusInProgress
                          : theme.colors.outline,
                      },
                    ]}
                  />
                </TouchableOpacity>
              );
            })}
          </Card>
        )}
      </View>

      {/* ── Letzte Aktivitäten ── */}
      <View style={styles.section}>
        <SectionHeader
          title="Letzte Aktivitäten"
          subtitle="Aktuelle Job-Bewegungen"
        />
        {recentActivity.length === 0 ? (
          <Card>
            <EmptyState
              title="Noch keine Aktivitäten"
              message="Sobald Jobs erstellt oder bearbeitet werden, erscheinen sie hier."
              icon="pulse-outline"
            />
          </Card>
        ) : (
          <Card padding={0}>
            {recentActivity.map((job, idx) => {
              const cfg = activityConfig(theme, job.status);
              return (
                <TouchableOpacity
                  key={job.id}
                  activeOpacity={0.7}
                  onPress={() => router.push(`/jobs/${job.id}`)}
                  style={[
                    styles.activityRow,
                    idx > 0 && styles.rowDivider,
                  ]}
                >
                  <View
                    style={[
                      styles.activityIcon,
                      { backgroundColor: cfg.color + "22" },
                    ]}
                  >
                    <Ionicons name={cfg.icon} size={18} color={cfg.color} />
                  </View>
                  <View style={styles.activityInfo}>
                    <Text style={styles.activityLabel} numberOfLines={1}>
                      {cfg.label}
                    </Text>
                    <Text style={styles.activitySub} numberOfLines={1}>
                      {job.customerName}
                      {job.service ? ` · ${job.service}` : ""}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </Card>
        )}
      </View>

      <View style={{ height: theme.spacing.xxl }} />

      {/* ── Quick Action: Job erstellen ── */}
      <TouchableOpacity
        style={styles.fab}
        activeOpacity={0.85}
        onPress={() => router.push("/jobs/create")}
      >
        <Ionicons name="add" size={24} color={theme.colors.onPrimaryContainer} />
        <Text style={styles.fabText}>Job erstellen</Text>
      </TouchableOpacity>
    </ScreenContainer>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    // ── Header
    header: {
      paddingTop: theme.spacing.md,
      marginBottom: theme.spacing.xl,
      gap: 4,
    },
    brandRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: theme.spacing.md,
    },
    brandLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    logoBadge: {
      width: 34,
      height: 34,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
    },
    companyName: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    greeting: {
      marginTop: theme.spacing.sm,
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    dateText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // ── KPI Grid
    kpiGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.xl,
    },
    kpiItem: {
      width: "48.5%",
    },

    // ── Sections
    section: {
      marginBottom: theme.spacing.xl,
    },

    // ── Mitarbeiter-Zeile
    empRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      padding: theme.spacing.md,
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
    empJob: {
      marginTop: 2,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    statusDot: {
      width: 10,
      height: 10,
      borderRadius: theme.radius.full,
    },

    // ── Aktivitäts-Zeile
    activityRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      padding: theme.spacing.md,
    },
    activityIcon: {
      width: 36,
      height: 36,
      borderRadius: theme.radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    activityInfo: {
      flex: 1,
    },
    activityLabel: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    activitySub: {
      marginTop: 2,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // ── FAB / Quick Action
    fab: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      paddingVertical: 15,
      minHeight: theme.spacing.tapTarget,
      ...theme.shadows.md,
    },
    fabText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimaryContainer,
      letterSpacing: theme.typography.letterSpacing.wide,
    },
  });
}
