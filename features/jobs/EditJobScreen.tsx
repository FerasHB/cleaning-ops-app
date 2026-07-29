// features/jobs/EditJobScreen.tsx
// Job-Bearbeiten-Screen für Admins.
// Vollständig auf useAppTheme() migriert — Light + Dark Mode.
// Business-Logik (updateJob, deleteJob, useJobForm, AuthContext, JobContext) unverändert.

import { Button, Card, Divider, LoadingScreen } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { EmployeeMultiSelector } from "@/features/jobs/components/EmployeeMultiSelector";
import { JobFormFields } from "@/features/jobs/components/JobFormFields";
import { useJobForm } from "@/features/jobs/hooks/useJobForm";
import {
  formatDateISO,
  formatTimeHHmm,
  formatToISO,
  timeStringToDate,
} from "@/utils/date";
import type { WeekdayKey } from "@/utils/recurrence";
import { getAssignees } from "@/utils/jobAssignees";
import { getJobById } from "@/services/jobs/jobs.service";
import type { Job } from "@/types/job";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";

// Vergleicht zwei Mitarbeiter-ID-Mengen ordnungsunabhängig (normalisiert:
// dedupliziert + sortiert). Reine Umsortierung darf hasChanges NICHT
// auslösen — nur eine tatsächliche Änderung der Menge.
function sameIdSet(a: string[], b: string[]): boolean {
  const normalize = (ids: string[]) => Array.from(new Set(ids)).sort();
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length !== nb.length) return false;
  return na.every((id, i) => id === nb[i]);
}

export default function EditJobScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    jobs,
    employees,
    loading,
    refreshEmployees,
    updateJob,
    deleteJob,
  } = useJobs();
  const { signOut, role, loading: authLoading } = useAuth();

  // Cache-first mit Direktabruf-Fallback: Regeln/Jobs außerhalb des (für Admins
  // begrenzten) Ladefensters müssen dennoch bearbeitbar sein. RLS begrenzt die
  // Sichtbarkeit serverseitig.
  const cachedJob = useMemo(
    () => jobs.find((item) => item.id === id),
    [jobs, id],
  );
  const [fetchedJob, setFetchedJob] = useState<Job | null>(null);
  const [fetchAttempted, setFetchAttempted] = useState(false);
  const job = cachedJob ?? fetchedJob ?? undefined;
  const [submitting, setSubmitting] = useState(false);

  // Aktuell zugewiesene Mitarbeiter-IDs (live Profile). Zeilen mit
  // employeeId === null (gelöschte Konten) fallen hier bewusst heraus — sie
  // stehen nicht mehr in `employees` und können ohnehin nicht als Checkbox
  // dargestellt oder erneut ausgewählt werden.
  const assignedEmployeeIds = useMemo(
    () =>
      getAssignees(job ?? { assignees: [] })
        .map((a) => a.employeeId)
        .filter((id): id is string => !!id),
    [job],
  );

  // Picker beim Bearbeiten: aktive Mitarbeiter + ALLE aktuell zugewiesenen
  // (auch wenn inzwischen inaktiv), damit bestehende Zuweisungen im
  // Formular sichtbar bleiben und nicht still verschwinden.
  // EmployeeMultiSelector zeigt inaktive Zeilen als ausgewählt+gesperrt an
  // (dedupliziert zusätzlich selbst nach id).
  const pickerEmployees = useMemo(() => {
    const active = employees.filter((e) => e.isActive !== false);
    const activeIds = new Set(active.map((e) => e.id));
    const assignedButInactive = employees.filter(
      (e) => assignedEmployeeIds.includes(e.id) && !activeIds.has(e.id),
    );
    return [...active, ...assignedButInactive];
  }, [employees, assignedEmployeeIds]);

  const { values, errors, setField, validate, setValues, setErrors } =
    useJobForm();

  const isAdmin = role === "admin";

  useEffect(() => {
    if (!employees.length) {
      refreshEmployees();
    }
  }, [employees.length, refreshEmployees]);

  // Direktabruf per ID, falls der Job nicht im (begrenzten) Context-Fenster liegt.
  useEffect(() => {
    if (!id || cachedJob || fetchAttempted) return;
    let cancelled = false;
    getJobById(id)
      .then((j) => {
        if (!cancelled) setFetchedJob(j);
      })
      .catch(() => {
        if (!cancelled) setFetchedJob(null);
      })
      .finally(() => {
        if (!cancelled) setFetchAttempted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, cachedJob, fetchAttempted]);

  useEffect(() => {
    if (!job) return;

    const parsedStart = job.scheduledStart ? new Date(job.scheduledStart) : null;
    const singleDateTime =
      parsedStart && !isNaN(parsedStart.getTime()) ? parsedStart : null;

    setValues({
      customerName: job.customerName,
      location: job.location,
      service: job.service,
      // Seed aus der Zuweisungsmenge (assignees), NICHT aus dem deprecated
      // Legacy-Zeiger job.employeeId — sonst gingen sekundär Zugewiesene
      // beim Öffnen des Formulars sofort verloren.
      employeeIds: assignedEmployeeIds,
      notes: job.notes ?? "",
      jobType: job.jobType ?? "single",
      singleDateTime,
      startTime: timeStringToDate(job.startTime),
      recurringDays: (job.recurringDays ?? []) as WeekdayKey[],
      isActive: job.isActive ?? true,
      recurrenceStartDate: job.recurrenceStartDate
        ? new Date(job.recurrenceStartDate)
        : null,
      recurrenceEndDate: job.recurrenceEndDate
        ? new Date(job.recurrenceEndDate)
        : null,
    });

    setErrors({});
  }, [job, assignedEmployeeIds, setValues, setErrors]);

  const hasChanges = useMemo(() => {
    if (!job) return false;

    // Basisfelder
    const basicsChanged =
      values.customerName !== job.customerName ||
      values.location !== job.location ||
      values.service !== job.service ||
      !sameIdSet(values.employeeIds, assignedEmployeeIds) ||
      values.notes !== (job.notes ?? "") ||
      values.jobType !== (job.jobType ?? "single");

    if (basicsChanged) return true;

    // Terminierung je nach Typ
    if (values.jobType === "single") {
      const originalStartMs = job.scheduledStart
        ? new Date(job.scheduledStart).getTime()
        : null;
      const currentStartMs = values.singleDateTime
        ? values.singleDateTime.getTime()
        : null;
      return currentStartMs !== originalStartMs;
    }

    // recurring
    const sameDays =
      values.recurringDays.length === (job.recurringDays?.length ?? 0) &&
      values.recurringDays.every((d) => job.recurringDays?.includes(d));

    const sameStartDate =
      formatDateISO(values.recurrenceStartDate) ===
      (job.recurrenceStartDate ?? null);
    const sameEndDate =
      formatDateISO(values.recurrenceEndDate) ===
      (job.recurrenceEndDate ?? null);

    return (
      !sameDays ||
      formatTimeHHmm(values.startTime) !== (job.startTime ?? null) ||
      values.isActive !== (job.isActive ?? true) ||
      !sameStartDate ||
      !sameEndDate
    );
  }, [job, values, assignedEmployeeIds]);

  // ── Logout (unveränderte Logik)
  const handleLogout = async () => {
    Alert.alert("Abmelden", "Möchtest du dich wirklich abmelden?", [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Abmelden",
        style: "destructive",
        onPress: async () => {
          try {
            await signOut();
          } catch (err: unknown) {
            const msg =
              err instanceof Error ? err.message : "Abmeldung fehlgeschlagen.";
            Alert.alert("Fehler", msg);
          }
        },
      },
    ]);
  };

  // ── Speichern (unveränderte Logik)
  const handleSave = async () => {
    if (!job) {
      Alert.alert("Fehler", "Job wurde nicht gefunden.");
      return;
    }

    if (!validate()) {
      return;
    }

    try {
      setSubmitting(true);

      // Inaktive Mitarbeiter dürfen NICHT an set_job_assignments gesendet
      // werden: die RPC validiert JEDE übergebene ID (auch bereits
      // zugewiesene) auf active=true — unabhängig davon, ob sich an dieser
      // Zuweisung überhaupt etwas ändert. Eine im Formular als
      // ausgewählt+gesperrt angezeigte inaktive Person (siehe
      // EmployeeMultiSelector/pickerEmployees) bliebe sonst zwar sichtbar,
      // würde aber bei JEDEM Speichern — auch bei völlig unabhängigen
      // Feldänderungen — die gesamte Speicherung mit einem Serverfehler
      // blockieren. Deshalb hier vor dem Absenden herausfiltern.
      const activeEmployeeIds = new Set(
        employees.filter((e) => e.isActive !== false).map((e) => e.id),
      );
      const submittableEmployeeIds = values.employeeIds.filter((id) =>
        activeEmployeeIds.has(id),
      );

      const base = {
        jobId: job.id,
        customerName: values.customerName.trim(),
        location: values.location.trim(),
        service: values.service.trim(),
        employeeIds: submittableEmployeeIds,
        notes: values.notes.trim() || null,
      };

      await updateJob(
        values.jobType === "single"
          ? {
              ...base,
              jobType: "single",
              date: formatDateISO(values.singleDateTime),
              startTime: formatTimeHHmm(values.singleDateTime),
              scheduledStart: formatToISO(values.singleDateTime),
            }
          : {
              ...base,
              jobType: "recurring",
              startTime: formatTimeHHmm(values.startTime),
              recurringDays: values.recurringDays,
              isActive: values.isActive,
              recurrenceStartDate: formatDateISO(values.recurrenceStartDate),
              recurrenceEndDate: formatDateISO(values.recurrenceEndDate),
              scheduledStart: null,
            },
      );

      Alert.alert("Erfolgreich", "Job wurde aktualisiert.");
      router.back();
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Job konnte nicht gespeichert werden.";
      Alert.alert("Fehler", msg);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Löschen (unveränderte Logik)
  const handleDelete = async () => {
    if (!job) {
      Alert.alert("Fehler", "Job wurde nicht gefunden.");
      return;
    }

    Alert.alert("Job löschen", "Möchtest du diesen Job wirklich löschen?", [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Löschen",
        style: "destructive",
        onPress: async () => {
          try {
            setSubmitting(true);
            await deleteJob(job.id);
            Alert.alert("Erfolgreich", "Job wurde gelöscht.");
            router.back();
          } catch (err: unknown) {
            const msg =
              err instanceof Error
                ? err.message
                : "Job konnte nicht gelöscht werden.";
            Alert.alert("Fehler", msg);
          } finally {
            setSubmitting(false);
          }
        },
      },
    ]);
  };

  if (authLoading || loading) {
    return <LoadingScreen />;
  }

  // ── Kein-Zugriff-Ansicht
  if (!isAdmin) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <StatusBar
          barStyle={theme.isDark ? "light-content" : "dark-content"}
          backgroundColor={theme.colors.background}
        />
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>Kein Zugriff</Text>
          <Text style={styles.emptyText}>
            Nur Admins dürfen Jobs bearbeiten.
          </Text>
          <Button label="Zurück" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  // ── Job-nicht-gefunden-Ansicht
  if (!job) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <StatusBar
          barStyle={theme.isDark ? "light-content" : "dark-content"}
          backgroundColor={theme.colors.background}
        />
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>Job nicht gefunden</Text>
          <Text style={styles.emptyText}>
            Der gewünschte Job konnte nicht geladen werden.
          </Text>
          <Button label="Zurück" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  // ── Haupt-Ansicht
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
            activeOpacity={0.7}
          >
            <Ionicons
              name="chevron-back"
              size={22}
              color={theme.colors.primary}
            />
            <Text style={styles.backLabel}>Zurück</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Job bearbeiten</Text>
            {role && (
              <View style={styles.roleBadge}>
                <Text style={styles.roleBadgeText}>{role}</Text>
              </View>
            )}
          </View>

          <TouchableOpacity
            onPress={handleLogout}
            style={styles.logoutButton}
            activeOpacity={0.7}
          >
            <Text style={styles.logoutText}>Abmelden</Text>
          </TouchableOpacity>
        </View>

        {/* ── Scroll-Inhalt ── */}
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Job-Details bearbeiten</Text>
            <Text style={styles.sectionSubtitle}>
              Pflichtfelder sind mit * markiert
            </Text>

            <Divider style={styles.sectionDivider} />

            <JobFormFields
              values={values}
              errors={errors}
              onChangeField={setField}
            />
          </Card>

          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Mitarbeiter</Text>
            <Text style={styles.sectionSubtitle}>
              Zuweisung kann jederzeit geändert werden
            </Text>

            <Divider style={styles.sectionDivider} />

            <EmployeeMultiSelector
              employees={pickerEmployees}
              selectedEmployeeIds={values.employeeIds}
              onChange={(ids) => setField("employeeIds", ids)}
              emptyLabel="Keine Mitarbeiter verfügbar."
            />
          </Card>

          <Button
            label={hasChanges ? "Änderungen speichern" : "Keine Änderungen"}
            loading={submitting}
            disabled={loading || submitting || !hasChanges}
            onPress={handleSave}
          />

          <TouchableOpacity
            style={[
              styles.deleteButton,
              submitting && styles.deleteButtonDisabled,
            ]}
            onPress={handleDelete}
            activeOpacity={0.7}
            disabled={submitting}
          >
            <Ionicons
              name="trash-outline"
              size={16}
              color={theme.colors.error}
              style={{ marginRight: 6 }}
            />
            <Text style={styles.deleteButtonText}>Job löschen</Text>
          </TouchableOpacity>

          <View style={styles.bottomSpacer} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    flex: {
      flex: 1,
    },

    // ── Empty/Kein-Zugriff-Ansicht
    emptyWrap: {
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    emptyTitle: {
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },
    emptyText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
    },

    // ── Header
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.background,
    },
    backButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      paddingVertical: theme.spacing.xs,
      minWidth: 70,
    },
    backLabel: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.primary,
    },
    headerCenter: {
      flex: 1,
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "center",
      gap: theme.spacing.sm,
    },
    headerTitle: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    roleBadge: {
      backgroundColor: theme.colors.statusInProgressBg,
      borderWidth: 1,
      borderColor: theme.colors.statusInProgressBorder,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: theme.radius.full,
    },
    roleBadgeText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.statusInProgress,
    },
    logoutButton: {
      paddingVertical: theme.spacing.xs,
      minWidth: 70,
      alignItems: "flex-end",
    },
    logoutText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.error,
    },

    // ── Scroll-Container
    scroll: {
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
      paddingBottom: 40,
    },

    // ── Karten-Sektionen (Card-Komponente bringt eigenes Padding mit)
    section: {},
    sectionTitle: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    sectionSubtitle: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      marginTop: 2,
    },
    sectionDivider: {
      marginVertical: theme.spacing.md,
    },

    // ── Löschen-Button (destructive)
    deleteButton: {
      flexDirection: "row",
      marginTop: theme.spacing.sm,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: theme.spacing.md,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.error,
      backgroundColor: theme.colors.errorContainer,
      minHeight: theme.spacing.tapTarget,
    },
    deleteButtonDisabled: {
      opacity: 0.5,
    },
    deleteButtonText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.error,
    },

    bottomSpacer: {
      height: theme.spacing.xl,
    },
  });
}
