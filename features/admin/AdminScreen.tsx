


import { LoadingScreen } from "@/components/ui";
import { Colors, Radius, Shadows, Spacing, Typography } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { JobFormFields } from "@/features/jobs/components/JobFormFields";
import { useJobForm } from "@/features/jobs/hooks/useJobForm";
import { formatToISO } from "@/utils/date";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
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
console.log("useJobForm check:", useJobForm);
console.log("JobFormFields check:", JobFormFields);
function SectionBlock({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={sectionStyles.block}>
      <View style={sectionStyles.header}>
        <Text style={sectionStyles.title}>{title}</Text>
        {subtitle ? <Text style={sectionStyles.subtitle}>{subtitle}</Text> : null}
      </View>
      <View style={sectionStyles.body}>{children}</View>
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  block: {
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border.default,
    overflow: "hidden",
    ...Shadows.sm,
  },
  header: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border.subtle,
    gap: 3,
  },
  title: {
    fontSize: Typography.size.base,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
    letterSpacing: Typography.tracking.tight,
  },
  subtitle: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
  },
  body: {
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
});

export default function AdminScreen() {
  const { createJob, employees, loading } = useJobs();
  const { signOut, role, loading: authLoading } = useAuth();
  const [submitting, setSubmitting] = useState(false);

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

  const handleCreateJob = async () => {
    if (!validate()) return;

    try {
      setSubmitting(true);

      await createJob({
        customerName: values.customerName.trim(),
        location: values.location.trim(),
        service: values.service.trim(),
        scheduledStart: formatToISO(values.scheduledStart),
        employeeId: values.employeeId,
        notes: values.notes.trim() || null,
      });

      reset();
      Alert.alert("✓ Erstellt", "Der Job wurde erfolgreich angelegt.");
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Job konnte nicht erstellt werden.";
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
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backBtn}
            activeOpacity={0.7}
          >
            <Text style={styles.backIcon}>‹</Text>
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

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg.base,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border.subtle,
    backgroundColor: Colors.bg.base,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minWidth: 72,
  },
  backIcon: {
    fontSize: 24,
    color: Colors.accent.default,
    lineHeight: 28,
    fontWeight: "300",
  },
  backLabel: {
    fontSize: Typography.size.base,
    color: Colors.accent.default,
    fontWeight: Typography.weight.medium,
  },
  headerCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
  },
  headerTitle: {
    fontSize: Typography.size.base,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
  },
  rolePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.accent.muted,
    borderWidth: 1,
    borderColor: Colors.accent.border,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  roleDot: {
    width: 5,
    height: 5,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent.default,
  },
  rolePillText: {
    fontSize: Typography.size.xs,
    color: Colors.accent.text,
    fontWeight: Typography.weight.medium,
  },
  logoutBtn: {
    minWidth: 72,
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
  },
  createBtn: {
    backgroundColor: Colors.accent.default,
    paddingVertical: 15,
    borderRadius: Radius.md,
    alignItems: "center",
    ...Shadows.accent,
  },
  createBtnDisabled: {
    opacity: 0.5,
  },
  createBtnText: {
    fontSize: Typography.size.base,
    fontWeight: Typography.weight.semibold,
    color: Colors.white,
    letterSpacing: Typography.tracking.wide,
  },
});