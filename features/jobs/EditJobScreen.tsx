// features/jobs/EditJobScreen.tsx
// Job-Bearbeiten-Screen für Admins.
// Vollständig auf useAppTheme() migriert — Light + Dark Mode.
// Business-Logik (updateJob, deleteJob, useJobForm, AuthContext, JobContext) unverändert.

import { Button, Card, Divider, LoadingScreen } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { EmployeeSelector } from "@/features/jobs/components/EmployeeSelector";
import { JobFormFields } from "@/features/jobs/components/JobFormFields";
import { useJobForm } from "@/features/jobs/hooks/useJobForm";
import { formatToISO } from "@/utils/date";
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

export default function EditJobScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    jobs,
    employees,
    loading,
    refreshJobs,
    refreshEmployees,
    updateJob,
    deleteJob,
  } = useJobs();
  const { signOut, role, loading: authLoading } = useAuth();

  const job = useMemo(() => jobs.find((item) => item.id === id), [jobs, id]);
  const [submitting, setSubmitting] = useState(false);

  const { values, errors, setField, validate, setValues, setErrors } =
    useJobForm();

  const isAdmin = role === "admin";

  useEffect(() => {
    if (!jobs.length) {
      refreshJobs();
    }

    if (!employees.length) {
      refreshEmployees();
    }
  }, [jobs.length, employees.length, refreshJobs, refreshEmployees]);

  useEffect(() => {
    if (!job) return;

    const parsedStart = job.scheduledStart ? new Date(job.scheduledStart) : null;

    setValues({
      customerName: job.customerName,
      location: job.location,
      service: job.service,
      scheduledStart:
        parsedStart && !isNaN(parsedStart.getTime()) ? parsedStart : null,
      employeeId: job.employeeId ?? null,
      notes: job.notes ?? "",
    });

    setErrors({});
  }, [job, setValues, setErrors]);

  const hasChanges = useMemo(() => {
    if (!job) return false;

    const originalStartMs = job.scheduledStart
      ? new Date(job.scheduledStart).getTime()
      : null;

    const currentStartMs = values.scheduledStart
      ? values.scheduledStart.getTime()
      : null;

    return (
      values.customerName !== job.customerName ||
      values.location !== job.location ||
      values.service !== job.service ||
      currentStartMs !== originalStartMs ||
      values.employeeId !== (job.employeeId ?? null) ||
      values.notes !== (job.notes ?? "")
    );
  }, [job, values]);

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

      await updateJob({
        jobId: job.id,
        customerName: values.customerName.trim(),
        location: values.location.trim(),
        service: values.service.trim(),
        scheduledStart: formatToISO(values.scheduledStart),
        employeeId: values.employeeId,
        notes: values.notes.trim() || null,
      });

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

            <EmployeeSelector
              employees={employees}
              selectedEmployeeId={values.employeeId}
              onSelect={(employeeId) => setField("employeeId", employeeId)}
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
