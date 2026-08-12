// features/jobs/EditJobScreen.tsx
// Job-Bearbeiten-Screen für Admins.
// Vollständig auf useAppTheme() migriert — Light + Dark Mode.
// Business-Logik (updateJob, deleteJob, useJobForm, AuthContext, JobContext) unverändert.

import { AppHeader, Button, Card, Divider, ErrorBanner, LoadingScreen } from "@/components/ui";
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
import { getJobById, PartialUpdateError } from "@/services/jobs/jobs.service";
import type { Job } from "@/types/job";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
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
import { toUserMessage } from "@/utils/userMessages";
import { alertDialog, confirmDialog } from "@/utils/dialogs";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";

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
  const { role, loading: authLoading } = useAuth();

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

  // BLOCKIERT das Speichern vollständig, solange der Auftrag mindestens
  // einem INAKTIVEN Mitarbeiter zugewiesen ist.
  //
  // Grund (verifiziert direkt im deployten SQL-Quelltext, nicht angenommen):
  // supabase/migrations/20260728000000_occurrence_assignment_inheritance.sql,
  // Funktion set_job_assignments (Zeilen 543–687, die aktuell gültige
  // CREATE OR REPLACE-Fassung — keine spätere Migration definiert die
  // Funktion erneut). Die Validierung (Zeilen 597–614) prüft JEDE ID in der
  // übergebenen Menge p_employee_ids gegen profiles.is_active = true — ohne
  // jede Ausnahme für IDs, die dem Auftrag bereits zugewiesen sind (es gibt
  // in der gesamten Funktion keine Abfrage, die "schon zugewiesen" gegen
  // job_assignments prüft, bevor validiert wird). Eine inaktive, bereits
  // zugewiesene Person MUSS deshalb entweder mitgeschickt werden (→ die
  // GESAMTE Speicherung schlägt mit "Assignment rejected" fehl, Zeilen
  // 609–614) oder weggelassen werden — und genau das entfernt eine
  // spurenfreie Zuweisung endgültig (DELETE, Zeilen 616–623: entfernt jede
  // Zeile, deren employee_id NICHT in der übergebenen Menge steht UND die
  // weder Anwesenheit noch Review noch Zeitstempel trägt).
  //
  // Es gibt also KEINEN sicheren Weg, eine inaktive Zuweisung über diese RPC
  // zu erhalten: weder "mitschicken" (harter Fehler) noch "weglassen"
  // (stille Löschung, falls spurenfrei). Bis eine künftige SQL-Migration
  // set_job_assignments eine Ausnahme für bereits zugewiesene inaktive
  // Personen hinzufügt, wird das Bearbeiten eines solchen Auftrags hier
  // vollständig gesperrt, statt eine der beiden unsicheren Optionen zu
  // wählen.
  const inactiveAssignedEmployees = useMemo(
    () => pickerEmployees.filter((e) => e.isActive === false),
    [pickerEmployees],
  );
  const hasInactiveAssignedEmployees = inactiveAssignedEmployees.length > 0;

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

  // Warnung vor dem Verlassen mit ungespeicherten Änderungen. Nutzt dieselbe
  // hasChanges-Berechnung wie der Speichern-Button — es warnt also exakt dann,
  // wenn auch wirklich etwas zu speichern wäre. Während des Absendens aus.
  const { leaveWithoutWarning } = useUnsavedChangesGuard(
    hasChanges && !submitting,
  );

  // ── Speichern (Business-Logik unverändert)
  const handleSave = async () => {
    if (!job) {
      await alertDialog("Fehler", "Job wurde nicht gefunden.");
      return;
    }

    if (!validate()) {
      return;
    }

    // HARTE SPERRE (zusätzlich zum deaktivierten Save-Button unten): dieser
    // Auftrag hat mindestens eine inaktive Zuweisung, die set_job_assignments
    // nicht sicher abbilden kann (siehe ausführliche Begründung bei
    // hasInactiveAssignedEmployees weiter oben). Kein Schreibvorgang darf in
    // diesem Zustand stattfinden — auch nicht, falls der Button je über
    // einen anderen Pfad als disabled=false erreichbar wäre.
    if (hasInactiveAssignedEmployees) {
      await alertDialog(
        "Bearbeiten nicht möglich",
        "Dieser Auftrag ist mindestens einem inaktiven Mitarbeiter zugewiesen " +
          `(${inactiveAssignedEmployees.map((e) => e.fullName).join(", ")}). ` +
          "Aus Datensicherheitsgründen kann der Auftrag aktuell nicht " +
          "bearbeitet werden, da jedes Speichern diese Zuweisung " +
          "unbeabsichtigt entfernen könnte.",
      );
      return;
    }

    try {
      setSubmitting(true);

      // Zusätzliche Absicherung (defense-in-depth): inaktive Mitarbeiter
      // dürfen NIE an set_job_assignments gesendet werden (siehe Sperre
      // oben). Da das Speichern bereits vollständig blockiert ist, solange
      // hasInactiveAssignedEmployees zutrifft, sollte values.employeeIds an
      // dieser Stelle nie mehr eine inaktive ID enthalten — dieser Filter
      // fängt trotzdem den Fall ab, dass sich der Aktiv-Status eines
      // Mitarbeiters zwischen Prüfung und Absenden ändert (z. B. durch
      // gleichzeitige Deaktivierung in einer anderen Sitzung).
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

      // Erst den Hinweis abwarten, DANN zurück. Vorher lief Alert.alert
      // fire-and-forget und router.back() feuerte sofort — der Hinweis stand
      // dann über dem VORHERIGEN Screen bzw. verschwand mit dem Wechsel. Im
      // Web zeigte Alert.alert ohnehin nichts an.
      await alertDialog("Gespeichert", "Der Job wurde aktualisiert.");
      leaveWithoutWarning(() => router.back());
    } catch (err: unknown) {
      const msg = toUserMessage(err, "Job konnte nicht gespeichert werden.");

      // Teilerfolg: die Mitarbeiterzuweisung wurde bereits gespeichert, auch
      // wenn der Rest fehlgeschlagen ist (siehe PartialUpdateError in
      // jobs.service.ts). JobContext hat den frisch nachgelesenen Job dafür
      // bereits in den State übernommen — hier NICHT als vollständigen
      // Fehlschlag/Rollback darstellen, im Formular bleiben (kein
      // router.back()) und NICHT automatisch erneut speichern.
      if (err instanceof PartialUpdateError) {
        await alertDialog("Teilweise gespeichert", msg);
      } else {
        await alertDialog("Fehler", msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ── Löschen (Business-Logik unverändert)
  // Dialoge laufen jetzt über confirmDialog/alertDialog statt Alert.alert:
  // dieselbe Erfolgs-Reihenfolge wie beim Speichern (Hinweis abwarten, dann
  // navigieren) und im Web überhaupt sichtbar.
  const handleDelete = async () => {
    if (!job) {
      await alertDialog("Fehler", "Job wurde nicht gefunden.");
      return;
    }

    const confirmed = await confirmDialog({
      title: "Job löschen",
      message: "Möchtest du diesen Job wirklich löschen?",
      confirmLabel: "Löschen",
      destructive: true,
    });

    if (!confirmed) return;

    try {
      setSubmitting(true);
      await deleteJob(job.id);
      await alertDialog("Gelöscht", "Der Job wurde gelöscht.");
      leaveWithoutWarning(() => router.back());
    } catch (err: unknown) {
      const msg = toUserMessage(err, "Job konnte nicht gelöscht werden.");
      await alertDialog("Fehler", msg);
    } finally {
      setSubmitting(false);
    }
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
        <AppHeader title="Job bearbeiten" showBack />

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

            {/* Mitarbeiter-Auswahl bewusst NICHT hier: dieser Screen zeigt sie
                unten in einem eigenen Abschnitt — mit der Warnung zu inaktiven
                Zuweisungen und der erweiterten Liste (aktive + bereits
                zugewiesene). Ohne dieses Prop stand die Auswahl zweimal auf dem
                Bildschirm, oben dauerhaft leer. */}
            <JobFormFields
              values={values}
              errors={errors}
              onChangeField={setField}
              showEmployeePicker={false}
            />
          </Card>

          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Mitarbeiter</Text>
            <Text style={styles.sectionSubtitle}>
              Zuweisung kann jederzeit geändert werden
            </Text>

            <Divider style={styles.sectionDivider} />

            {hasInactiveAssignedEmployees ? (
              <View style={{ marginBottom: theme.spacing.sm }}>
                <ErrorBanner
                  type="warning"
                  message={
                    "Dieser Auftrag ist mindestens einem inaktiven Mitarbeiter " +
                    `zugewiesen (${inactiveAssignedEmployees
                      .map((e) => e.fullName)
                      .join(", ")}). Der Auftrag kann aktuell nicht bearbeitet ` +
                    "werden, da jedes Speichern diese Zuweisung unbeabsichtigt " +
                    "entfernen könnte. Diese Einschränkung entfällt mit einer " +
                    "künftigen Backend-Anpassung."
                  }
                />
              </View>
            ) : null}

            <EmployeeMultiSelector
              employees={pickerEmployees}
              selectedEmployeeIds={values.employeeIds}
              onChange={(ids) => setField("employeeIds", ids)}
              emptyLabel="Keine Mitarbeiter verfügbar."
            />
          </Card>

          <Button
            label={
              hasInactiveAssignedEmployees
                ? "Bearbeiten derzeit nicht möglich"
                : hasChanges
                  ? "Änderungen speichern"
                  : "Keine Änderungen"
            }
            loading={submitting}
            disabled={
              loading || submitting || !hasChanges || hasInactiveAssignedEmployees
            }
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
