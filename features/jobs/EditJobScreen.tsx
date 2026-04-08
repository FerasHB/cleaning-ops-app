import { Button, Card, Divider, Input, LoadingScreen } from "@/components/ui";
import { Colors, Radius, Spacing, Typography } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
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

function normalizeScheduledStart(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(" ", "T");
  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function formatForInput(value?: string | null): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export default function EditJobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { jobs, employees, loading, refreshJobs, refreshEmployees, updateJob } =
    useJobs();
  const { signOut, role, loading: authLoading } = useAuth();

  const job = useMemo(() => jobs.find((item) => item.id === id), [jobs, id]);

  const [customerName, setCustomerName] = useState("");
  const [location, setLocation] = useState("");
  const [service, setService] = useState("");
  const [scheduledStart, setScheduledStart] = useState("");
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

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
    if (!job) {
      return;
    }

    setCustomerName(job.customerName);
    setLocation(job.location);
    setService(job.service);
    setScheduledStart(formatForInput(job.scheduledStart));
    setEmployeeId(job.employeeId ?? null);
    setNotes(job.notes ?? "");
  }, [job]);

  const hasChanges = useMemo(() => {
    if (!job) {
      return false;
    }

    return (
      customerName !== job.customerName ||
      location !== job.location ||
      service !== job.service ||
      scheduledStart !== formatForInput(job.scheduledStart) ||
      employeeId !== (job.employeeId ?? null) ||
      notes !== (job.notes ?? "")
    );
  }, [customerName, employeeId, job, location, notes, scheduledStart, service]);

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

    if (!customerName.trim()) {
      newErrors.customerName = "Bitte Kundennamen eingeben.";
    }

    if (!location.trim()) {
      newErrors.location = "Bitte Ort eingeben.";
    }

    if (!service.trim()) {
      newErrors.service = "Bitte Service eingeben.";
    }

    if (scheduledStart.trim() && !normalizeScheduledStart(scheduledStart)) {
      newErrors.scheduledStart =
        "Bitte Datum und Uhrzeit korrekt eingeben, z.B. 2026-04-10 07:30.";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!job) {
      Alert.alert("Fehler", "Job wurde nicht gefunden.");
      return;
    }

    if (!validate()) {
      return;
    }

    const normalizedScheduledStart = normalizeScheduledStart(scheduledStart);

    try {
      setSubmitting(true);

      await updateJob({
        jobId: job.id,
        customerName: customerName.trim(),
        location: location.trim(),
        service: service.trim(),
        scheduledStart: normalizedScheduledStart,
        employeeId,
        notes: notes.trim() || null,
      });

      Alert.alert("Erfolgreich", "Job wurde aktualisiert.");
      router.back();
    } catch (err: any) {
      Alert.alert(
        "Fehler",
        err?.message ?? "Job konnte nicht gespeichert werden.",
      );
    } finally {
      setSubmitting(false);
    }
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

            <Input
              label="Kunde *"
              placeholder="z.B. Müller GmbH"
              value={customerName}
              onChangeText={(t) => {
                setCustomerName(t);
                if (errors.customerName) {
                  setErrors((e) => ({ ...e, customerName: "" }));
                }
              }}
              error={errors.customerName}
            />

            <Input
              label="Ort *"
              placeholder="z.B. Dortmund"
              value={location}
              onChangeText={(t) => {
                setLocation(t);
                if (errors.location) {
                  setErrors((e) => ({ ...e, location: "" }));
                }
              }}
              error={errors.location}
            />

            <Input
              label="Service *"
              placeholder="z.B. Wartung, Installation"
              value={service}
              onChangeText={(t) => {
                setService(t);
                if (errors.service) {
                  setErrors((e) => ({ ...e, service: "" }));
                }
              }}
              error={errors.service}
            />

            <Input
              label="Geplanter Start"
              placeholder="z.B. 2026-04-10 07:30"
              value={scheduledStart}
              onChangeText={(t) => {
                setScheduledStart(t);
                if (errors.scheduledStart) {
                  setErrors((e) => ({ ...e, scheduledStart: "" }));
                }
              }}
              error={errors.scheduledStart}
            />

            <Input
              label="Notizen"
              placeholder="Optional – interne Hinweise zum Job"
              value={notes}
              onChangeText={setNotes}
              multiline
              style={styles.notesInput}
            />
          </Card>

          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Mitarbeiter</Text>
            <Text style={styles.sectionSubtitle}>
              Zuweisung kann jederzeit geändert werden
            </Text>

            <Divider style={styles.sectionDivider} />

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

          <Button
            label={hasChanges ? "Änderungen speichern" : "Keine Änderungen"}
            loading={submitting}
            disabled={loading || !hasChanges}
            onPress={handleSave}
          />

          <View style={styles.bottomSpacer} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

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
