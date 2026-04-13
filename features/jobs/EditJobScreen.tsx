import { Button, Card, Divider, LoadingScreen } from "@/components/ui";
import { Colors, Radius, Spacing, Typography } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { EmployeeSelector } from "@/features/jobs/components/EmployeeSelector";
import { JobFormFields } from "@/features/jobs/components/JobFormFields";
import { useJobForm } from "@/features/jobs/hooks/useJobForm";
import { formatToISO } from "@/utils/date";
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

export default function EditJobScreen() {
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

  const { values, errors, setField, validate, setValues, setErrors } = useJobForm();

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
        err instanceof Error ? err.message : "Job konnte nicht gespeichert werden.";
      Alert.alert("Fehler", msg);
    } finally {
      setSubmitting(false);
    }
  };

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
              err instanceof Error ? err.message : "Job konnte nicht gelöscht werden.";
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

  if (!isAdmin) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <StatusBar barStyle="light-content" />
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

  if (!job) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <StatusBar barStyle="light-content" />
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

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar barStyle="light-content" />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
            activeOpacity={0.7}
          >
            <Text style={styles.backIcon}>‹</Text>
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
            style={styles.deleteButton}
            onPress={handleDelete}
            activeOpacity={0.7}
            disabled={submitting}
          >
            <Text style={styles.deleteButtonText}>Job löschen</Text>
          </TouchableOpacity>

          <View style={styles.bottomSpacer} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg.base,
  },
  flex: {
    flex: 1,
  },
  emptyWrap: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: Spacing.lg,
    gap: Spacing.md,
  },
  emptyTitle: {
    fontSize: Typography.size.lg,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    textAlign: "center",
  },
  emptyText: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
    textAlign: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border.subtle,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingVertical: Spacing.xs,
    minWidth: 70,
  },
  backIcon: {
    fontSize: 22,
    color: Colors.accent.default,
    lineHeight: 26,
    fontWeight: "300",
  },
  backLabel: {
    fontSize: Typography.size.base,
    color: Colors.accent.default,
    fontWeight: Typography.weight.medium,
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: Spacing.sm,
  },
  headerTitle: {
    fontSize: Typography.size.base,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
  },
  roleBadge: {
    backgroundColor: Colors.accent.subtle,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.full,
  },
  roleBadgeText: {
    fontSize: Typography.size.xs,
    color: Colors.accent.text,
    fontWeight: Typography.weight.medium,
  },
  logoutButton: {
    paddingVertical: Spacing.xs,
    minWidth: 70,
    alignItems: "flex-end",
  },
  logoutText: {
    fontSize: Typography.size.sm,
    color: Colors.status.danger,
    fontWeight: Typography.weight.medium,
  },
  scroll: {
    padding: Spacing.lg,
    gap: Spacing.md,
    paddingBottom: 40,
  },
  section: {},
  sectionTitle: {
    fontSize: Typography.size.md,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
    letterSpacing: -0.2,
  },
  sectionSubtitle: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
    marginTop: 2,
  },
  sectionDivider: {
    marginVertical: Spacing.md,
  },
  deleteButton: {
    marginTop: Spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.status.danger,
    backgroundColor: Colors.status.dangerBg,
  },
  deleteButtonText: {
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.semibold,
    color: Colors.status.danger,
  },
  bottomSpacer: {
    height: Spacing.xl,
  },
});