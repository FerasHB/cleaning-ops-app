// features/admin/AdminScreen.tsx
// Job-Erstellen-Screen für Admins.
// Vollständig auf useAppTheme() migriert — Light + Dark Mode.
// Business-Logik (createJob, useJobForm, AuthContext, JobContext) unverändert.

import { AppHeader, Button, LoadingScreen } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { JobFormFields } from "@/features/jobs/components/JobFormFields";
import { useJobForm } from "@/features/jobs/hooks/useJobForm";
import { formatDateISO, formatTimeHHmm, formatToISO } from "@/utils/date";
import type { CreateJobInput } from "@/types/job";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";
import { toUserMessage } from "@/utils/userMessages";
import { alertDialog } from "@/utils/dialogs";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";

// ─────────────────────────────────────────────
// Section-Block (theme-aware Karte mit Header)
// ─────────────────────────────────────────────
function SectionBlock({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createSectionStyles(theme), [theme]);

  return (
    <View style={styles.block}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

function createSectionStyles(theme: AppTheme) {
  return StyleSheet.create({
    block: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      overflow: "hidden",
      ...theme.shadows.sm,
    },
    header: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
      gap: 3,
    },
    title: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    subtitle: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    body: {
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
  });
}

// ─────────────────────────────────────────────
// AdminScreen
// ─────────────────────────────────────────────
export default function AdminScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { createJob, employees, loading } = useJobs();
  const { loading: authLoading } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  // Synchrone Re-Entrancy-Sperre gegen Doppel-Absendung. setSubmitting(true)
  // wirkt erst beim nächsten Render — zwei sehr schnelle Taps könnten daher
  // beide den submitting-Check passieren, bevor der State aktualisiert ist.
  // Der Ref flippt synchron und schließt dieses Zeitfenster sofort.
  const submittingRef = useRef(false);

  // Beim Job-Erstellen nur aktive Mitarbeiter zur Auswahl anbieten.
  const activeEmployees = useMemo(
    () => employees.filter((e) => e.isActive !== false),
    [employees],
  );

  const { values, errors, isDirty, setField, validate, reset } = useJobForm();

  // Warnung vor dem Verlassen mit ungespeicherten Eingaben. Deckt eigenen
  // Zurück-Button, Android-Hardware-Zurück und iOS-Swipe ab (siehe Hook).
  // Während des Absendens bewusst aus: der Erfolgs-Pfad navigiert selbst.
  const { leaveWithoutWarning } = useUnsavedChangesGuard(isDirty && !submitting);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 350,
        useNativeDriver: true,
      }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  // ── Job erstellen
  const handleCreateJob = async () => {
    // Doppel-Absendung verhindern: synchroner Ref-Lock (sofort wirksam) UND
    // der submitting-State (steuert disabled-Button / Beschriftung). Der Ref
    // fängt sehr schnelle Doppel-Taps ab, bevor der State greift.
    if (submittingRef.current || submitting) return;
    if (!validate()) return;

    submittingRef.current = true;
    try {
      setSubmitting(true);

      // Rohtext -> positive Ganzzahl oder null (leer/ungültig = keine Dauer
      // geplant). JobFormFields lässt ohnehin nur Ziffern zu.
      const parsedDuration = parseInt(values.durationMinutes, 10);
      const plannedDurationMinutes =
        Number.isFinite(parsedDuration) && parsedDuration > 0
          ? parsedDuration
          : null;

      // Gemeinsame Basis
      const base = {
        customerName: values.customerName.trim(),
        location: values.location.trim(),
        service: values.service.trim(),
        employeeIds: values.employeeIds,
        notes: values.notes.trim() || null,
        plannedDurationMinutes,
      };

      // Terminierung je nach Auftragstyp aufbauen
      const input: CreateJobInput =
        values.jobType === "single"
          ? {
              ...base,
              jobType: "single",
              date: formatDateISO(values.singleDateTime),
              startTime: formatTimeHHmm(values.singleDateTime),
              // scheduled_start für Detail-/Monats-Anzeigen zusätzlich befüllen
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
              // recurring hat keinen einzelnen Termin
              scheduledStart: null,
            };

      const { recurringOccurrencesFailed } = await createJob(input);

      // Formular vor dem Erfolgshinweis zurücksetzen (setzt auch isDirty zurück).
      reset();

      // Erst den Hinweis abwarten, DANN navigieren — über alertDialog, weil
      // Alert.alert im Web nichts anzeigt und der onPress-Callback dort nie
      // liefe (die Navigation wäre unerreichbar). Der Job ist bereits angelegt,
      // deshalb navigieren wir auch bei fehlgeschlagener Occurrence-Generierung
      // — dann aber mit Teil-Erfolg-Hinweis statt vollem Erfolg.
      if (recurringOccurrencesFailed) {
        await alertDialog(
          "Job angelegt",
          "Der Job wurde angelegt, aber die Termine konnten nicht vollständig erzeugt werden. Bitte prüfe die Terminierung.",
        );
      } else {
        await alertDialog("Erstellt", "Der Job wurde erfolgreich angelegt.");
      }

      leaveWithoutWarning(() => router.replace("/(admin-tabs)/jobs"));
    } catch (err: unknown) {
      // Bei einem Fehler wird NICHT navigiert — der Admin bleibt im Formular.
      const msg = toUserMessage(err, "Job konnte nicht erstellt werden.");
      await alertDialog("Fehler", msg);
    } finally {
      // Sperre in beiden Fällen wieder freigeben (Erfolg wie Fehler).
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return <LoadingScreen />;
  }

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
        <AppHeader
          title="Neuer Job"
          showBack
          onBack={() => {
            if (router.canGoBack()) {
              router.back();
            } else {
              router.replace("/(admin-tabs)/jobs");
            }
          }}
        />

        {/* ── Scroll-Inhalt ── */}
        <Animated.ScrollView
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <SectionBlock
            title="Job-Details"
            subtitle="Mit * markierte Felder sind Pflicht"
          >
            <JobFormFields
              values={values}
              errors={errors}
              onChangeField={setField}
              employees={activeEmployees}
            />
          </SectionBlock>

          {/* Gemeinsamer Button statt eigener TouchableOpacity-Nachbau —
              gleiche Optik, gleicher Lade-Spinner und gleiche Tap-Fläche wie
              im Bearbeiten-Screen. */}
          <Button
            label="Job erstellen"
            onPress={handleCreateJob}
            loading={submitting}
            disabled={loading || submitting}
          />

          <View style={{ height: 40 }} />
        </Animated.ScrollView>
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

    // Scroll-Container
    scroll: {
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
    },
  });
}
