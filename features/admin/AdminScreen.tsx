// screens/AdminScreen.tsx
import { Input, LoadingScreen } from "@/components/ui";
import {
  Colors,
  Radius,
  Shadows,
  Spacing,
  Typography,
} from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
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

function normalizeScheduledStart(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

// ── Abschnitts-Wrapper ──
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
        {subtitle && <Text style={sectionStyles.subtitle}>{subtitle}</Text>}
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

  const [customerName, setCustomerName] = useState("");
  const [location, setLocation] = useState("");
  const [service, setService] = useState("");
  const [scheduledStart, setScheduledStart] = useState("");
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

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
  }, []);

  const handleLogout = async () => {
    Alert.alert("Abmelden", "Möchtest du dich wirklich abmelden?", [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Abmelden",
        style: "destructive",
        onPress: async () => {
          try {
            await signOut();
          } catch (err: any) {
            Alert.alert("Fehler", err?.message ?? "Abmeldung fehlgeschlagen.");
          }
        },
      },
    ]);
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!customerName.trim())
      newErrors.customerName = "Bitte Kundennamen eingeben.";
    if (!location.trim()) newErrors.location = "Bitte Ort eingeben.";
    if (!service.trim()) newErrors.service = "Bitte Service eingeben.";
    if (scheduledStart.trim() && !normalizeScheduledStart(scheduledStart)) {
      newErrors.scheduledStart = "Format: 2026-04-10 07:30";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleCreateJob = async () => {
    if (!validate()) return;
    const normalizedScheduledStart = normalizeScheduledStart(scheduledStart);
    try {
      setSubmitting(true);
      await createJob({
        customerName: customerName.trim(),
        location: location.trim(),
        service: service.trim(),
        scheduledStart: normalizedScheduledStart,
        employeeId,
        notes: notes.trim() || null,
      });
      setCustomerName("");
      setLocation("");
      setService("");
      setScheduledStart("");
      setEmployeeId(null);
      setNotes("");
      setErrors({});
      Alert.alert("✓ Erstellt", "Der Job wurde erfolgreich angelegt.");
    } catch (err: any) {
      Alert.alert(
        "Fehler",
        err?.message ?? "Job konnte nicht erstellt werden.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading) return <LoadingScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {/* ── Sticky Header ── */}
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
            {role && (
              <View style={styles.rolePill}>
                <View style={styles.roleDot} />
                <Text style={styles.rolePillText}>{role}</Text>
              </View>
            )}
          </View>

          <TouchableOpacity
            onPress={handleLogout}
            style={styles.logoutBtn}
            activeOpacity={0.7}
          >
            <Text style={styles.logoutText}>Abmelden</Text>
          </TouchableOpacity>
        </View>

        {/* ── Scroll-Content ── */}
        <Animated.ScrollView
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Sektion: Job-Details */}
          <SectionBlock
            title="Job-Details"
            subtitle="Mit * markierte Felder sind Pflicht"
          >
            <Input
              label="Kunde *"
              placeholder="z.B. Müller GmbH"
              value={customerName}
              onChangeText={(t) => {
                setCustomerName(t);
                if (errors.customerName)
                  setErrors((e) => ({ ...e, customerName: "" }));
              }}
              error={errors.customerName}
            />
            <Input
              label="Ort *"
              placeholder="z.B. Dortmund"
              value={location}
              onChangeText={(t) => {
                setLocation(t);
                if (errors.location) setErrors((e) => ({ ...e, location: "" }));
              }}
              error={errors.location}
            />
            <Input
              label="Service *"
              placeholder="z.B. Wartung, Installation"
              value={service}
              onChangeText={(t) => {
                setService(t);
                if (errors.service) setErrors((e) => ({ ...e, service: "" }));
              }}
              error={errors.service}
            />
            <Input
              label="Geplanter Start"
              placeholder="2026-04-10 07:30"
              value={scheduledStart}
              onChangeText={(t) => {
                setScheduledStart(t);
                if (errors.scheduledStart)
                  setErrors((e) => ({ ...e, scheduledStart: "" }));
              }}
              error={errors.scheduledStart}
            />
            <Input
              label="Notizen"
              placeholder="Interne Hinweise (optional)"
              value={notes}
              onChangeText={setNotes}
              multiline
              style={styles.notesInput}
            />
          </SectionBlock>

          {/* Sektion: Mitarbeiter */}
          <SectionBlock
            title="Mitarbeiter zuweisen"
            subtitle="Optional – kann später geändert werden"
          >
            <EmployeeOption
              label="Nicht zuweisen"
              sublabel="Job bleibt allen sichtbar"
              isSelected={employeeId === null}
              onPress={() => setEmployeeId(null)}
            />

            {employees.length === 0 ? (
              <View style={styles.emptyEmployees}>
                <Text style={styles.emptyEmployeesText}>
                  Keine Mitarbeiter verfügbar.
                </Text>
              </View>
            ) : (
              employees.map((emp) => (
                <EmployeeOption
                  key={emp.id}
                  label={emp.fullName}
                  sublabel="Mitarbeiter"
                  isSelected={employeeId === emp.id}
                  onPress={() => setEmployeeId(emp.id)}
                />
              ))
            )}
          </SectionBlock>

          {/* CTA */}
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

// ── Mitarbeiter Option ──
function EmployeeOption({
  label,
  sublabel,
  isSelected,
  onPress,
}: {
  label: string;
  sublabel?: string;
  isSelected: boolean;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const onPressIn = () =>
    Animated.spring(scale, {
      toValue: 0.98,
      useNativeDriver: true,
      speed: 60,
      bounciness: 2,
    }).start();
  const onPressOut = () =>
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 40,
      bounciness: 4,
    }).start();

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={1}
        style={[styles.employeeRow, isSelected && styles.employeeRowSelected]}
      >
        <View style={[styles.radioOuter, isSelected && styles.radioSelected]}>
          {isSelected && <View style={styles.radioInner} />}
        </View>
        <View style={styles.employeeInfo}>
          <Text style={[styles.empName, isSelected && styles.empNameActive]}>
            {label}
          </Text>
          {sublabel && <Text style={styles.empSub}>{sublabel}</Text>}
        </View>
        {isSelected && (
          <View style={styles.selectedCheck}>
            <Text style={styles.selectedCheckText}>✓</Text>
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg.base,
  },
  flex: { flex: 1 },

  // Header
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

  // Scroll
  scroll: {
    padding: Spacing.lg,
    gap: Spacing.md,
  },

  notesInput: {
    minHeight: 90,
    textAlignVertical: "top",
    paddingTop: 12,
  },

  // Leere Mitarbeiterliste
  emptyEmployees: {
    paddingVertical: Spacing.lg,
    alignItems: "center",
  },
  emptyEmployeesText: {
    fontSize: Typography.size.sm,
    color: Colors.text.muted,
  },

  // Mitarbeiter-Zeile
  employeeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.transparent,
  },
  employeeRowSelected: {
    backgroundColor: Colors.accent.muted,
    borderColor: Colors.accent.border,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: Radius.full,
    borderWidth: 2,
    borderColor: Colors.border.strong,
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: {
    borderColor: Colors.accent.default,
  },
  radioInner: {
    width: 9,
    height: 9,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent.default,
  },
  employeeInfo: {
    flex: 1,
    gap: 2,
  },
  empName: {
    fontSize: Typography.size.base,
    color: Colors.text.secondary,
    fontWeight: Typography.weight.medium,
  },
  empNameActive: {
    color: Colors.accent.text,
  },
  empSub: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
  },
  selectedCheck: {
    width: 20,
    height: 20,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent.default,
    alignItems: "center",
    justifyContent: "center",
  },
  selectedCheckText: {
    fontSize: 11,
    color: Colors.white,
    fontWeight: Typography.weight.bold,
  },

  // Haupt-CTA
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
