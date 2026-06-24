// features/admin/AdminScreen.tsx
// Job-Erstellen-Screen für Admins.
// Vollständig auf useAppTheme() migriert — Light + Dark Mode.
// Business-Logik (createJob, useJobForm, AuthContext, JobContext) unverändert.

import { LoadingScreen } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { JobFormFields } from "@/features/jobs/components/JobFormFields";
import { useJobForm } from "@/features/jobs/hooks/useJobForm";
import { formatDateISO, formatTimeHHmm, formatToISO } from "@/utils/date";
import type { CreateJobInput } from "@/types/job";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";

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
  const { signOut, role, loading: authLoading } = useAuth();
  const [submitting, setSubmitting] = useState(false);

  // Beim Job-Erstellen nur aktive Mitarbeiter zur Auswahl anbieten.
  const activeEmployees = useMemo(
    () => employees.filter((e) => e.isActive !== false),
    [employees],
  );

  const { values, errors, setField, validate, reset } = useJobForm();

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

  // ── Job erstellen (unveränderte Logik)
  const handleCreateJob = async () => {
    if (!validate()) return;

    try {
      setSubmitting(true);

      // Gemeinsame Basis
      const base = {
        customerName: values.customerName.trim(),
        location: values.location.trim(),
        service: values.service.trim(),
        employeeId: values.employeeId,
        notes: values.notes.trim() || null,
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

      await createJob(input);

      reset();
      Alert.alert("✓ Erstellt", "Der Job wurde erfolgreich angelegt.");
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Job konnte nicht erstellt werden.";
      Alert.alert("Fehler", msg);
    } finally {
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
        {/* ── Header ── */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => {
              if (router.canGoBack()) {
                router.back();
              } else {
                router.replace("/(admin-tabs)/jobs");
              }
            }}
            style={styles.backBtn}
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
            <Text style={styles.headerTitle}>Neuer Job</Text>
            {role ? (
              <View style={styles.rolePill}>
                <View style={styles.roleDot} />
                <Text style={styles.rolePillText}>{role}</Text>
              </View>
            ) : null}
          </View>

          <TouchableOpacity
            onPress={handleLogout}
            style={styles.logoutBtn}
            activeOpacity={0.7}
          >
            <Text style={styles.logoutText}>Abmelden</Text>
          </TouchableOpacity>
        </View>

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

          <TouchableOpacity
            onPress={handleCreateJob}
            disabled={loading || submitting}
            activeOpacity={0.85}
            style={[
              styles.createBtn,
              (loading || submitting) && styles.createBtnDisabled,
            ]}
          >
            <Text style={styles.createBtnText}>
              {submitting ? "Wird erstellt…" : "Job erstellen"}
            </Text>
          </TouchableOpacity>

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

    // Header
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
    backBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      minWidth: 72,
    },
    backLabel: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.primary,
    },
    headerCenter: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
    },
    headerTitle: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },

    // Rolle-Pill (z.B. "admin")
    rolePill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: theme.colors.statusInProgressBg,
      borderWidth: 1,
      borderColor: theme.colors.statusInProgressBorder,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: theme.radius.full,
    },
    roleDot: {
      width: 5,
      height: 5,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusInProgress,
    },
    rolePillText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.statusInProgress,
    },

    // Logout-Button
    logoutBtn: {
      minWidth: 72,
      alignItems: "flex-end",
    },
    logoutText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.error,
    },

    // Scroll-Container
    scroll: {
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
    },

    // "Job erstellen"-Button
    createBtn: {
      backgroundColor: theme.colors.primaryContainer,
      paddingVertical: 15,
      borderRadius: theme.radius.md,
      alignItems: "center",
      minHeight: theme.spacing.tapTarget,
      justifyContent: "center",
      ...theme.shadows.md,
    },
    createBtnDisabled: {
      opacity: 0.5,
    },
    createBtnText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimaryContainer,
      letterSpacing: theme.typography.letterSpacing.wide,
    },
  });
}
