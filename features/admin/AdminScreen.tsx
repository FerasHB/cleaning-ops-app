// screens/AdminScreen.tsx
import { Button, Card, Divider, Input, LoadingScreen } from "@/components/ui";
import { Colors, Radius, Spacing, Typography } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { router } from "expo-router";
import { useState } from "react";
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

export default function AdminScreen() {
  const { createJob, employees, loading } = useJobs();
  const { signOut, role, loading: authLoading } = useAuth();

  // Formular-State
  const [customerName, setCustomerName] = useState("");
  const [location, setLocation] = useState("");
  const [service, setService] = useState("");
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Inline-Fehler pro Feld
  const [errors, setErrors] = useState<Record<string, string>>({});

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

  // Formular validieren – inline Fehler setzen
  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!customerName.trim())
      newErrors.customerName = "Bitte Kundennamen eingeben.";
    if (!location.trim()) newErrors.location = "Bitte Ort eingeben.";
    if (!service.trim()) newErrors.service = "Bitte Service eingeben.";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleCreateJob = async () => {
    if (!validate()) return;

    try {
      setSubmitting(true);
      await createJob({
        customerName: customerName.trim(),
        location: location.trim(),
        service: service.trim(),
        employeeId,
        notes: notes.trim() || null,
      });

      // Formular zurücksetzen
      setCustomerName("");
      setLocation("");
      setService("");
      setEmployeeId(null);
      setNotes("");
      setErrors({});

      // Kurzes Erfolgsfeedback ohne blockierenden Alert
      Alert.alert("✓ Erfolgreich", "Job wurde erstellt.");
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
            style={styles.backButton}
            activeOpacity={0.7}
          >
            {/* Pfeil-Icon ohne externe Bibliothek */}
            <Text style={styles.backIcon}>‹</Text>
            <Text style={styles.backLabel}>Zurück</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Job erstellen</Text>
            {/* Zeigt zur Orientierung die aktuelle Rolle */}
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
          {/* ── Abschnitt: Job-Details ── */}
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Job-Details</Text>
            <Text style={styles.sectionSubtitle}>
              Pflichtfelder sind mit * markiert
            </Text>

            <Divider style={styles.sectionDivider} />

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
              label="Notizen"
              placeholder="Optional – interne Hinweise zum Job"
              value={notes}
              onChangeText={setNotes}
              multiline
              // Multiline-Inputs brauchen eine Mindesthöhe
              style={styles.notesInput}
            />
          </Card>

          {/* ── Abschnitt: Mitarbeiter zuweisen ── */}
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Mitarbeiter</Text>
            <Text style={styles.sectionSubtitle}>
              Optional – kann später geändert werden
            </Text>

            <Divider style={styles.sectionDivider} />

            {/* "Nicht zuweisen" als erste Option */}
            <EmployeeOption
              label="Nicht zuweisen"
              sublabel="Job bleibt offen"
              isSelected={employeeId === null}
              onPress={() => setEmployeeId(null)}
            />

            {employees.length === 0 ? (
              <Text style={styles.noEmployees}>
                Keine Mitarbeiter verfügbar.
              </Text>
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
          </Card>

          {/* ── Aktion ── */}
          <Button
            label="Job erstellen"
            loading={submitting}
            disabled={loading}
            onPress={handleCreateJob}
          />

          <View style={styles.bottomSpacer} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Lokale Komponente: Mitarbeiter-Auswahl-Zeile ──
interface EmployeeOptionProps {
  label: string;
  sublabel?: string;
  isSelected: boolean;
  onPress: () => void;
}

function EmployeeOption({
  label,
  sublabel,
  isSelected,
  onPress,
}: EmployeeOptionProps) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.employeeRow, isSelected && styles.employeeRowSelected]}
      activeOpacity={0.7}
    >
      {/* Auswahl-Indikator (Kreis wie ein Radio-Button) */}
      <View
        style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}
      >
        {isSelected && <View style={styles.radioInner} />}
      </View>

      <View style={styles.employeeInfo}>
        <Text
          style={[
            styles.employeeName,
            isSelected && styles.employeeNameSelected,
          ]}
        >
          {label}
        </Text>
        {sublabel && <Text style={styles.employeeSublabel}>{sublabel}</Text>}
      </View>
    </TouchableOpacity>
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

  // Scroll
  scroll: {
    padding: Spacing.lg,
    gap: Spacing.md,
    paddingBottom: 40,
  },

  // Sections
  section: {
    // Card bringt schon Padding und Background mit
  },
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

  notesInput: {
    minHeight: 90,
    textAlignVertical: "top",
    paddingTop: 14,
  },

  noEmployees: {
    fontSize: Typography.size.sm,
    color: Colors.text.muted,
    textAlign: "center",
    paddingVertical: Spacing.lg,
  },

  // Mitarbeiter-Zeile
  employeeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.sm,
    marginBottom: 2,
  },
  employeeRowSelected: {
    backgroundColor: Colors.accent.subtle,
  },

  // Radio-Button
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: Radius.full,
    borderWidth: 2,
    borderColor: Colors.border.default,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuterSelected: {
    borderColor: Colors.accent.default,
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent.default,
  },

  // Mitarbeiter-Info
  employeeInfo: { flex: 1, gap: 1 },
  employeeName: {
    fontSize: Typography.size.base,
    color: Colors.text.secondary,
    fontWeight: Typography.weight.medium,
  },
  employeeNameSelected: {
    color: Colors.accent.text,
  },
  employeeSublabel: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
  },

  bottomSpacer: { height: Spacing.xl },
});
