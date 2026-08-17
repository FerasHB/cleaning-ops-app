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
  ErrorBanner,
  InitialsAvatar,
  KPICard,
  LoadingScreen,
  OfflineBanner,
  ScreenContainer,
  SectionHeader,
} from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import type { Job } from "@/types/job";
import type { Absence } from "@/types/absence";
import {
  getScheduleKpis,
  type ScheduleKpis,
} from "@/services/jobs/jobs.service";
import {
  getCurrentCompanyAbsences,
  getPendingVacationCount,
} from "@/services/absences/adminAbsences.service";
import { formatDateISO } from "@/utils/date";
import { isAssignedTo } from "@/utils/jobAssignees";
import { getJobStatusLabel } from "@/utils/jobStatus";
import { toUserMessage } from "@/utils/userMessages";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const {
    jobs,
    employees,
    loading,
    error: dataError,
    refreshJobs,
    refreshEmployees,
  } = useJobs();

  // Zeitpunkt beim Render. Header zeigt nur das Datum (keine Live-Uhrzeit).
  const now = new Date();

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

  // ── KPI-Werte: serverseitig, gebündelt und ohne Parent-Regeln.
  // Frühere Berechnung aus dem (unbeschränkten) jobs-Array zählte
  // Recurring-Parents doppelt und war nach oben unbegrenzt. Jetzt liefert
  // getScheduleKpis reine Zähler (count/head) über job_type='single'.
  const todayKey = useMemo(() => formatDateISO(now) ?? "", [now]);
  const [kpis, setKpis] = useState<ScheduleKpis | null>(null);
  // Schlägt die KPI-Abfrage fehl, blieben die vier Kacheln früher stumm auf
  // „—" stehen — für den Admin nicht von „es gibt heute nichts" zu
  // unterscheiden. Jetzt: sichtbares Banner + Retry, restliches Dashboard
  // bleibt nutzbar (ein fehlgeschlagener Zähler ist kein Screen-Fehler).
  const [kpiError, setKpiError] = useState("");
  const kpiLoadingRef = useRef(false);

  const loadKpis = useCallback(async () => {
    if (!todayKey || kpiLoadingRef.current) return;
    kpiLoadingRef.current = true;
    try {
      const fresh = await getScheduleKpis(todayKey);
      setKpis(fresh);
      setKpiError("");
    } catch (err: unknown) {
      // Zuvor geladene Werte NICHT verwerfen — veraltete Zahlen sind
      // brauchbarer als leere Kacheln, das Banner ordnet sie ein.
      setKpiError(
        toUserMessage(err, "Die Kennzahlen konnten nicht geladen werden."),
      );
    } finally {
      kpiLoadingRef.current = false;
    }
  }, [todayKey]);

  useEffect(() => {
    void loadKpis();
  }, [loadKpis]);

  // ── Abwesenheiten (Phase C — Admin Absence Workflow) ──────────────────────
  // Zwei leichte Signale, keine Zeilenlisten: die Anzahl offener Urlaubs-
  // anträge (Dashboard-Chip) und die firmenweit heute aktiven Abwesenheiten
  // (genehmigter Urlaub / gemeldete Krankheit — NICHT requested, siehe
  // getCurrentCompanyAbsences). Eine Abfrage für die ganze Firma, kein Loop
  // pro Mitarbeiter. useFocusEffect statt Mount-Effect: nach einem Review auf
  // AdminAbsencesScreen soll der Chip beim Zurücknavigieren sofort stimmen.
  const [pendingVacationCount, setPendingVacationCount] = useState<number | null>(null);
  const [currentAbsences, setCurrentAbsences] = useState<Absence[]>([]);
  const absenceLoadingRef = useRef(false);

  const loadAbsenceSignals = useCallback(async () => {
    if (!todayKey || absenceLoadingRef.current) return;
    absenceLoadingRef.current = true;
    try {
      const [count, active] = await Promise.all([
        getPendingVacationCount(),
        getCurrentCompanyAbsences(todayKey),
      ]);
      setPendingVacationCount(count);
      setCurrentAbsences(active);
    } catch {
      // Stiller Fehlschlag: Chip/Aktivitäts-Status bleiben einfach auf dem
      // vorherigen Stand stehen. Ein eigenes Banner für zwei Nebeninfos wäre
      // unverhältnismäßig — Dashboard-KPIs haben bereits eines für den
      // wichtigeren Fall.
    } finally {
      absenceLoadingRef.current = false;
    }
  }, [todayKey]);

  useFocusEffect(
    useCallback(() => {
      void loadAbsenceSignals();
    }, [loadAbsenceSignals]),
  );

  const absenceByEmployeeId = useMemo(() => {
    const map = new Map<string, Absence>();
    for (const absence of currentAbsences) {
      if (absence.employeeId) map.set(absence.employeeId, absence);
    }
    return map;
  }, [currentAbsences]);

  // ── Pull-to-Refresh ──────────────────────────────────────────────────────
  // Aktualisiert Jobs, Mitarbeiter und KPIs gemeinsam. Bewusst KEIN
  // loading-Gate: der LoadingScreen darf den Screen dabei nicht ersetzen,
  // sichtbare (auch veraltete) Inhalte bleiben stehen.
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  const handleRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await Promise.all([
        refreshJobs(),
        refreshEmployees(),
        loadKpis(),
        loadAbsenceSignals(),
      ]);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [refreshJobs, refreshEmployees, loadKpis, loadAbsenceSignals]);

  const openCount = kpis?.offen ?? null;
  const inProgressCount = kpis?.inArbeit ?? null;
  const completedCount = kpis?.erledigt ?? null;
  const todayCount = kpis?.heute ?? null;
  const overdueCount = kpis?.ueberfaellig ?? 0;

  // ── Mitarbeiter-Aktivität: aktiver (in_progress) Job ODER aktive
  // Abwesenheit pro Mitarbeiter, in dieser Priorität. Ein laufender Job zählt
  // immer als das dringlichere Signal — kommt in der Praxis kaum vor
  // (schlechte Datenlage, keine strukturelle Garantie), gewinnt aber bewusst
  // visuell, siehe Architektur-Audit Phase C Abschnitt 16 (Risiken).
  const employeeActivity = useMemo(
    () =>
      employees
        .filter((emp) => emp.isActive !== false)
        .map((emp) => {
          const activeJob = jobs.find(
            (j) => isAssignedTo(j, emp.id) && j.status === "in_progress",
          );
          const activeAbsence = absenceByEmployeeId.get(emp.id) ?? null;
          return { id: emp.id, name: emp.fullName, activeJob, activeAbsence };
        }),
    [employees, jobs, absenceByEmployeeId],
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
    <ScreenContainer
      refreshing={refreshing}
      onRefresh={() => {
        void handleRefresh();
      }}
    >
      {/* ── Header ── */}
      <View style={styles.header}>
        {/* Marken-Zeile. Rechts saß hier ein Save-Status-Badge, der nur im
            Normalfall gerendert wurde und bei jedem Speichern verschwand —
            aussagekräftige Zustände zeigt jetzt ausschließlich das Banner. */}
        <View style={styles.brandRow}>
          <View style={styles.logoBadge}>
            <Ionicons
              name="business"
              size={18}
              color={theme.colors.onPrimaryContainer}
            />
          </View>
          <Text style={styles.companyName}>{COMPANY_NAME}</Text>
        </View>

        <Text style={styles.greeting}>
          {getGreeting(now)}, {adminName}
        </Text>
        <Text style={styles.dateText}>{dateLabel}</Text>
      </View>

      {/* ── Save-Status ── */}
      <OfflineBanner />

      {/* ── Lade-/Aktualisierungsfehler der Job-/Mitarbeiterdaten ──
          Sichtbar, aber nicht destruktiv: die zuletzt geladenen (ggf.
          veralteten) Inhalte bleiben stehen. Offline setzt JobContext
          bewusst KEINEN Fehler — dafür ist das OfflineBanner zuständig. */}
      {dataError ? (
        <View style={styles.kpiErrorWrap}>
          <ErrorBanner
            message={dataError}
            actionLabel="Erneut versuchen"
            onAction={() => {
              void handleRefresh();
            }}
          />
        </View>
      ) : null}

      {/* ── KPI-Fehler: nur die Kacheln betroffen, Rest bleibt bedienbar ── */}
      {kpiError ? (
        <View style={styles.kpiErrorWrap}>
          <ErrorBanner
            message={kpiError}
            type="warning"
            actionLabel="Erneut versuchen"
            onAction={() => {
              void loadKpis();
            }}
            onDismiss={() => setKpiError("")}
          />
        </View>
      ) : null}

      {/* ── KPI-Karten (2×2) → tippen öffnet die Jobliste ── */}
      <View style={styles.kpiGrid}>
        <View style={styles.kpiItem}>
          <KPICard
            label="Heute fällig"
            value={todayCount ?? "—"}
            icon="calendar-outline"
            accentColor={theme.colors.primary}
            onPress={() => router.push("/(admin-tabs)/jobs")}
          />
        </View>
        <View style={styles.kpiItem}>
          <KPICard
            label={getJobStatusLabel("open")}
            value={openCount ?? "—"}
            icon="folder-open-outline"
            accentColor={theme.colors.statusOpen}
            onPress={() => router.push("/(admin-tabs)/jobs")}
          />
        </View>
        <View style={styles.kpiItem}>
          <KPICard
            label={getJobStatusLabel("in_progress")}
            value={inProgressCount ?? "—"}
            icon="time-outline"
            accentColor={theme.colors.statusInProgress}
            onPress={() => router.push("/(admin-tabs)/jobs")}
          />
        </View>
        <View style={styles.kpiItem}>
          <KPICard
            label={getJobStatusLabel("completed")}
            value={completedCount ?? "—"}
            icon="checkmark-done-outline"
            accentColor={theme.colors.statusCompleted}
            onPress={() => router.push("/(admin-tabs)/jobs")}
          />
        </View>
      </View>

      {/* ── Überfällig-Hinweis (nur wenn vorhanden) ── */}
      {overdueCount > 0 ? (
        <TouchableOpacity
          style={styles.overdueBanner}
          activeOpacity={0.8}
          onPress={() => router.push("/(admin-tabs)/jobs")}
        >
          <Ionicons
            name="alert-circle"
            size={18}
            color={theme.colors.statusOpen}
          />
          <Text style={styles.overdueText}>
            {overdueCount}{" "}
            {overdueCount === 1 ? "überfälliger Termin" : "überfällige Termine"}
          </Text>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={theme.colors.statusOpen}
            style={{ marginLeft: "auto" }}
          />
        </TouchableOpacity>
      ) : null}

      {/* ── Urlaubsanträge (nur wenn welche offen sind) ── */}
      {pendingVacationCount && pendingVacationCount > 0 ? (
        <TouchableOpacity
          style={styles.pendingVacationCard}
          activeOpacity={0.8}
          onPress={() => router.push("/admin/absences?tab=vacation")}
        >
          <View style={styles.pendingVacationIcon}>
            <Ionicons name="sunny-outline" size={20} color={theme.colors.primary} />
          </View>
          <View style={styles.timesheetInfo}>
            <Text style={styles.timesheetTitle}>Urlaubsanträge</Text>
            <Text style={styles.timesheetSub}>
              {pendingVacationCount} offen
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.colors.outline} />
        </TouchableOpacity>
      ) : null}

      {/* ── Heute abwesend (nur wenn welche aktiv sind) ──
          Wiederverwendet `currentAbsences` (bereits für Mitarbeiter-Aktivität
          geladen, siehe loadAbsenceSignals) — keine zweite/eigene Abfrage. */}
      {currentAbsences.length > 0 ? (
        <TouchableOpacity
          style={styles.absentTodayCard}
          activeOpacity={0.8}
          onPress={() => router.push("/admin/absences?tab=absent")}
        >
          <View style={styles.absentTodayIcon}>
            <Ionicons name="walk-outline" size={20} color={theme.colors.statusOpen} />
          </View>
          <View style={styles.timesheetInfo}>
            <Text style={styles.timesheetTitle}>Heute abwesend</Text>
            <Text style={styles.timesheetSub}>
              {currentAbsences.length} Mitarbeiter
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.colors.outline} />
        </TouchableOpacity>
      ) : null}

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
              // Priorität: laufender Job > aktive Abwesenheit > "Kein aktiver Job".
              // Nur genehmigter Urlaub/gemeldete Krankheit zählen als aktive
              // Abwesenheit (siehe getCurrentCompanyAbsences) — eine
              // angefragte Abwesenheit macht niemanden "abwesend".
              const isAbsent = !isActive && !!emp.activeAbsence;
              const activityLabel = isActive
                ? emp.activeJob?.customerName ?? emp.activeJob?.service ?? "Aktiver Job"
                : isAbsent
                  ? emp.activeAbsence!.type === "sickness"
                    ? "Krank gemeldet"
                    : "Im Urlaub"
                  : "Kein aktiver Job";
              const dotColor = isActive
                ? theme.colors.statusInProgress
                : isAbsent
                  ? theme.colors.statusOpen
                  : theme.colors.outline;
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
                      {activityLabel}
                    </Text>
                  </View>
                  <View
                    style={[styles.statusDot, { backgroundColor: dotColor }]}
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

      {/* ── Stundenzettel ── */}
      <TouchableOpacity
        style={styles.timesheetCard}
        activeOpacity={0.8}
        onPress={() => router.push("/timesheets")}
      >
        <View style={styles.timesheetIcon}>
          <Ionicons
            name="document-text-outline"
            size={20}
            color={theme.colors.primary}
          />
        </View>
        <View style={styles.timesheetInfo}>
          <Text style={styles.timesheetTitle}>Stundenzettel</Text>
          <Text style={styles.timesheetSub} numberOfLines={1}>
            Arbeitszeitnachweis als PDF erstellen
          </Text>
        </View>
        <Ionicons
          name="chevron-forward"
          size={18}
          color={theme.colors.outline}
        />
      </TouchableOpacity>

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
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.md,
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
    kpiErrorWrap: {
      marginBottom: theme.spacing.md,
    },
    kpiGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.xl,
    },
    kpiItem: {
      width: "48.5%",
    },

    // ── Überfällig-Banner
    overdueBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.statusOpenBg,
      borderWidth: 1,
      borderColor: theme.colors.statusOpenBorder,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      marginBottom: theme.spacing.xl,
    },
    overdueText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.statusOpen,
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

    // ── Stundenzettel-Karte
    timesheetCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.md,
      ...theme.shadows.sm,
    },
    timesheetIcon: {
      width: 40,
      height: 40,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surfaceContainerHigh,
      alignItems: "center",
      justifyContent: "center",
    },
    timesheetInfo: {
      flex: 1,
    },

    // ── Urlaubsanträge-Karte (gleiche Bauform wie Stundenzettel-Karte)
    pendingVacationCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.statusOpenBorder,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.xl,
      ...theme.shadows.sm,
    },
    pendingVacationIcon: {
      width: 40,
      height: 40,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
    },

    // ── Heute-abwesend-Karte (gleiche Bauform wie Urlaubsanträge-Karte)
    absentTodayCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.xl,
      ...theme.shadows.sm,
    },
    absentTodayIcon: {
      width: 40,
      height: 40,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.statusOpenBg,
      alignItems: "center",
      justifyContent: "center",
    },
    timesheetTitle: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    timesheetSub: {
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
