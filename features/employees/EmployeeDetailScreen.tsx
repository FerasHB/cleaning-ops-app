// features/employees/EmployeeDetailScreen.tsx
// Admin-Detailansicht eines Mitarbeiters.
// Reines Lesen aus dem JobContext (employees + jobs) — keine Business-Logik.
//
// Hinweis zu Datenquellen:
// - EmployeeOption liefert id, fullName, role, isActive, phone (aus profiles)
//   sowie email — profiles hat KEINE email-Spalte, die Adresse kommt separat
//   über die RPC get_company_employee_emails() (services/jobs/jobs.service.ts,
//   Migration 20260912000001) und wird dort per id gemerged.

import {
  AppHeader,
  Button,
  Card,
  EmailRow,
  EmptyState,
  ErrorBanner,
  InfoRow,
  InitialsAvatar,
  KPICard,
  LoadingScreen,
  PhoneRow,
} from "@/components/ui";
import JobCard from "@/components/JobCard";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { resendInvite } from "@/services/employees/resendInvite";
import type { AppTheme } from "@/constants/theme";
import type { Job, JobStatus } from "@/types/job";
import { formatDateTimeLocalized } from "@/utils/date";
import { getEmployeeStatus } from "@/utils/employeeStatus";
import { isAssignedTo } from "@/utils/jobAssignees";
import { useJobStatusLabels } from "@/hooks/useJobStatusLabels";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { toUserMessage } from "@/utils/userMessages";
import { AdminAbsenceRow } from "@/features/absences/admin/components/AdminAbsenceRow";
import { useEmployeeAbsences } from "@/features/absences/admin/hooks/useEmployeeAbsences";
import { groupAbsences } from "@/utils/absenceGrouping";
import { useTranslation } from "react-i18next";

// Abwesenheiten-Abschnitt: kompakter Ausschnitt hier, volle Historie unter
// "Alle anzeigen" (app/employees/[id]/absences.tsx). Aktuell wird immer
// gezeigt (kein Cap), Bevorstehend/Vergangen je bis zu 3 Zeilen — spiegelt
// EmployeeDetailScreen's bestehendes "Cap bei 5, Meta-Zähler"-Muster für
// Jobs, nur enger, da Abwesenheiten seltener sind als Jobs.
const ABSENCE_SECTION_LIMIT = 6;
const ABSENCE_ROWS_PER_GROUP = 3;

// Reihenfolge für die Job-Liste: laufend → offen → erledigt
const STATUS_ORDER: Record<JobStatus, number> = {
  in_progress: 0,
  open: 1,
  completed: 2,
};

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
  const jobStatusLabels = useJobStatusLabels();
  const { t } = useTranslation();

  const { id } = useLocalSearchParams<{ id: string }>();
  const { employees, jobs, loading, setEmployeeActive } = useJobs();

  // Loading-State für Deaktivieren/Reaktivieren.
  const [updatingActive, setUpdatingActive] = useState(false);
  // Loading-/Feedback-State für "Einladung erneut senden". Eigenes
  // Erfolgs-/Fehler-Feedback statt Alert.alert (auf Web ein No-Op) — analog
  // zum Muster in app/(admin-tabs)/employees.tsx.
  const [resendingInvite, setResendingInvite] = useState(false);
  const [resendError, setResendError] = useState("");
  const [resendSuccess, setResendSuccess] = useState("");
  const resendSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resendSuccessTimerRef.current) clearTimeout(resendSuccessTimerRef.current);
    };
  }, []);

  const employee = useMemo(
    () => employees.find((e) => e.id === id),
    [employees, id],
  );

  // ── Abwesenheiten (Phase C — Admin Absence Workflow) ──
  const {
    absences,
    loadError: absenceLoadError,
    load: loadAbsences,
    busyId: absenceBusyId,
    error: absenceActionError,
    clearError: clearAbsenceError,
    approve: approveVacation,
    reject: rejectVacation,
  } = useEmployeeAbsences(employee?.id, ABSENCE_SECTION_LIMIT);

  const hasLoadedAbsencesOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!employee?.id) return;
      loadAbsences({ silent: hasLoadedAbsencesOnceRef.current });
      hasLoadedAbsencesOnceRef.current = true;
    }, [employee?.id, loadAbsences]),
  );

  const { current: currentAbsences, upcoming: upcomingAbsences, past: pastAbsences } =
    useMemo(() => groupAbsences(absences), [absences]);

  // Alle Jobs dieses Mitarbeiters — über die Zuweisungsmenge, damit auch
  // Aufträge zählen, bei denen er nicht der Legacy-Primär ist.
  const assignedJobs = useMemo(
    () => jobs.filter((j) => isAssignedTo(j, id)),
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
        <AppHeader title={t("admin:employeeDetail.headerTitle")} showBack />
        <View style={styles.emptyWrap}>
          <EmptyState
            title={t("admin:employeeDetail.notFoundTitle")}
            message={t("admin:employeeDetail.notFoundMessage")}
            icon="person-outline"
            ctaLabel={t("common:actions.back")}
            onCta={() => router.back()}
          />
        </View>
      </SafeAreaView>
    );
  }

  // Konto-Status aus profiles.is_active (neutraler Fallback: nicht "inaktiv"
  // behaupten, wenn der Wert fehlt).
  const accountActive = employee.isActive !== false;

  // Einladungs-Status (Eingeladen/Aktiv/Inaktiv) — dieselbe Ableitung wie in
  // der Mitarbeiter-Liste, siehe utils/employeeStatus.ts.
  const status = getEmployeeStatus(employee);
  const invitePending = status.variant === "pending";
  const invitedAtText = formatDateTimeLocalized(employee.invitedAt);

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
    setResendError("");
    try {
      setResendingInvite(true);
      const mode = await resendInvite(employee.id);

      if (resendSuccessTimerRef.current) clearTimeout(resendSuccessTimerRef.current);
      // "recovery": das Konto war bereits bestätigt (abgelaufene
      // Einladungs-Sitzung) — es ging ein Passwort-Link raus, keine neue
      // Einladung (siehe resend-invite/index.ts).
      setResendSuccess(
        mode === "recovery"
          ? t("admin:employeeDetail.resendSuccessRecovery", { name: employee.fullName })
          : t("admin:employeeDetail.resendSuccessInvite", { name: employee.fullName }),
      );
      resendSuccessTimerRef.current = setTimeout(
        () => setResendSuccess(""),
        3000,
      );
    } catch (err) {
      const message = toUserMessage(
        err,
        t("admin:employeeDetail.resendFailedFallback"),
      );
      setResendError(message);
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
        t("admin:employeeDetail.successTitle"),
        nextActive
          ? t("admin:employeeDetail.reactivatedMessage")
          : t("admin:employeeDetail.deactivatedMessage"),
      );
    } catch (err) {
      const message = toUserMessage(
        err,
        t("admin:employeeDetail.toggleFailedFallback"),
      );
      Alert.alert(t("common:errors.title"), message);
    } finally {
      setUpdatingActive(false);
    }
  };

  const handleToggleActive = () => {
    if (!employee || updatingActive) return;

    if (accountActive) {
      Alert.alert(
        t("admin:employeeDetail.deactivateConfirmTitle"),
        t("admin:employeeDetail.deactivateConfirmMessage", {
          name: employee.fullName,
        }),
        [
          { text: t("common:actions.cancel"), style: "cancel" },
          {
            text: t("admin:employeeDetail.deactivateConfirmAction"),
            style: "destructive",
            onPress: () => applyActiveChange(false),
          },
        ],
      );
    } else {
      Alert.alert(
        t("admin:employeeDetail.reactivateConfirmTitle"),
        t("admin:employeeDetail.reactivateConfirmMessage", {
          name: employee.fullName,
        }),
        [
          { text: t("common:actions.cancel"), style: "cancel" },
          {
            text: t("admin:employeeDetail.reactivateConfirmAction"),
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
      <AppHeader title={t("admin:employeeDetail.headerTitle")} showBack />

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
            label={t("admin:employeeDetail.fieldRole")}
            value={t(
              employee.role === "admin" ? "profile:roles.admin" : "profile:roles.employee",
            )}
            icon="briefcase-outline"
          />
          <View style={styles.rowDivider} />
          <EmailRow email={employee.email} />
          <View style={styles.rowDivider} />
          <PhoneRow phone={employee.phone} contactName={employee.fullName} />
          <View style={styles.rowDivider} />
          <InfoRow
            label={t("admin:employeeDetail.fieldAccountStatus")}
            value={status.label}
            icon="pulse-outline"
          />
          {invitePending && invitedAtText ? (
            <>
              <View style={styles.rowDivider} />
              <InfoRow
                label={t("admin:employeeDetail.fieldInvitedAt")}
                value={invitedAtText}
                icon="mail-unread-outline"
              />
            </>
          ) : null}
          <View style={styles.rowDivider} />
          {/* Beschäftigung & Urlaub liegt auf einem eigenen Screen: die
              Stammdaten-Karte bleibt eine reine Übersicht, und die
              Konfiguration ist ein Admin-Formular mit eigener Validierung. */}
          <TouchableOpacity
            onPress={() => router.push(`/employees/${employee.id}/employment`)}
            accessibilityRole="button"
          >
            <InfoRow
              label={t("admin:employeeDetail.fieldEmployment")}
              value={t("admin:employeeDetail.fieldEmploymentValue")}
              icon="calendar-outline"
            />
          </TouchableOpacity>
          <View style={styles.rowDivider} />
          <TouchableOpacity
            onPress={() => router.push(`/employees/${employee.id}/vacation`)}
            accessibilityRole="button"
          >
            <InfoRow
              label={t("admin:employeeDetail.fieldVacationAccount")}
              value={t("admin:employeeDetail.fieldVacationAccountValue")}
              icon="sunny-outline"
            />
          </TouchableOpacity>
        </Card>

        {/* ── Aktueller Job ── */}
        {activeJob ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>
              {t("admin:employeeDetail.sectionCurrentJob")}
            </Text>
            <JobCard
              job={activeJob}
              onPress={() => router.push(`/jobs/${activeJob.id}`)}
            />
          </View>
        ) : null}

        {/* ── Statistiken ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            {t("admin:employeeDetail.sectionStats")}
          </Text>
          <View style={styles.kpiGrid}>
            <View style={styles.kpiItem}>
              <KPICard
                label={t("admin:employeeDetail.statToday")}
                value={todayCount}
                icon="today-outline"
                accentColor={theme.colors.primary}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label={jobStatusLabels.open}
                value={openCount}
                icon="folder-open-outline"
                accentColor={theme.colors.statusOpen}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label={jobStatusLabels.in_progress}
                value={inProgressCount}
                icon="time-outline"
                accentColor={theme.colors.statusInProgress}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label={jobStatusLabels.completed}
                value={completedCount}
                icon="checkmark-circle-outline"
                accentColor={theme.colors.statusCompleted}
              />
            </View>
            <View style={styles.kpiItem}>
              <KPICard
                label={t("admin:employeeDetail.statTotal")}
                value={totalCount}
                icon="layers-outline"
              />
            </View>
          </View>
        </View>

        {/* ── Zugewiesene Jobs ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionLabel}>
              {t("admin:employeeDetail.sectionAssignedJobs")}
            </Text>
            {totalCount > visibleJobs.length ? (
              <Text style={styles.sectionMeta}>
                {t("admin:employeeDetail.metaShownOfTotal", {
                  shown: visibleJobs.length,
                  total: totalCount,
                })}
              </Text>
            ) : null}
          </View>

          {visibleJobs.length === 0 ? (
            <Card padding={theme.spacing.lg}>
              <EmptyState
                title={t("admin:employeeDetail.emptyJobsTitle")}
                message={t("admin:employeeDetail.emptyJobsMessage")}
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

        {/* ── Abwesenheiten ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionLabel}>
              {t("admin:employeeDetail.sectionAbsences")}
            </Text>
            {absences.length >= ABSENCE_SECTION_LIMIT ? (
              <Text
                style={styles.sectionMeta}
                onPress={() => router.push(`/employees/${employee.id}/absences`)}
              >
                {t("admin:employeeDetail.viewAllAbsences")}
              </Text>
            ) : null}
          </View>

          {absenceLoadError ? (
            <ErrorBanner
              message={absenceLoadError}
              actionLabel={t("common:actions.retry")}
              onAction={() => loadAbsences()}
            />
          ) : null}

          {absenceActionError ? (
            <ErrorBanner message={absenceActionError} onDismiss={clearAbsenceError} />
          ) : null}

          {absences.length === 0 && !absenceLoadError ? (
            <Card padding={theme.spacing.lg}>
              <EmptyState
                title={t("admin:employeeDetail.emptyAbsencesTitle")}
                message={t("admin:employeeDetail.emptyAbsencesMessage")}
                icon="calendar-outline"
              />
            </Card>
          ) : (
            <View style={styles.jobList}>
              {currentAbsences.map((absence) => (
                <AdminAbsenceRow
                  key={absence.id}
                  absence={absence}
                  busy={absenceBusyId === absence.id}
                  showEmployeeName={false}
                  onApprove={approveVacation}
                  onReject={rejectVacation}
                />
              ))}
              {upcomingAbsences.slice(0, ABSENCE_ROWS_PER_GROUP).map((absence) => (
                <AdminAbsenceRow
                  key={absence.id}
                  absence={absence}
                  busy={absenceBusyId === absence.id}
                  showEmployeeName={false}
                  onApprove={approveVacation}
                  onReject={rejectVacation}
                />
              ))}
              {pastAbsences.slice(0, ABSENCE_ROWS_PER_GROUP).map((absence) => (
                <AdminAbsenceRow
                  key={absence.id}
                  absence={absence}
                  busy={absenceBusyId === absence.id}
                  showEmployeeName={false}
                  onApprove={approveVacation}
                  onReject={rejectVacation}
                />
              ))}
            </View>
          )}

          <Button
            label={t("admin:employeeDetail.recordAbsenceButton")}
            variant="secondary"
            icon="calendar-outline"
            onPress={() =>
              router.push(`/admin/absences/create?employeeId=${employee.id}`)
            }
            style={{ marginTop: theme.spacing.sm }}
          />
        </View>

        {/* ── Aktionen ── */}
        <View style={styles.actions}>
          {resendError ? (
            <ErrorBanner message={resendError} onDismiss={() => setResendError("")} />
          ) : null}
          {resendSuccess ? (
            <View style={styles.resendSuccessBanner}>
              <Ionicons
                name="checkmark-circle-outline"
                size={16}
                color={theme.colors.statusCompleted}
              />
              <Text style={styles.resendSuccessText}>{resendSuccess}</Text>
            </View>
          ) : null}
          <Button
            label={t("admin:employeeDetail.assignJobButton")}
            icon="add"
            onPress={handleAssignJob}
          />
          {invitePending ? (
            <Button
              label={t("admin:employeeDetail.resendInviteButton")}
              variant="secondary"
              icon="mail-outline"
              loading={resendingInvite}
              onPress={handleResendInvite}
            />
          ) : null}
          <Button
            label={
              accountActive
                ? t("admin:employeeDetail.deactivateButton")
                : t("admin:employeeDetail.reactivateButton")
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
    resendSuccessBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      backgroundColor: theme.colors.statusCompletedBg,
      borderWidth: 1,
      borderColor: theme.colors.statusCompletedBorder,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 8,
    },
    resendSuccessText: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.statusCompleted,
    },
  });
}
