// features/absences/admin/AdminCreateAbsenceScreen.tsx
// "Abwesenheit erfassen" — manuelle Admin-Erfassung über admin_create_absence.
// Urlaub landet serverseitig direkt bei status=approved, Krankheit bei
// status=reported (siehe Migration) — kein clientseitig erfundener Status.
//
// Gleiche Struktur wie features/absences/RequestVacationScreen.tsx /
// ReportSicknessScreen.tsx (Employee-Selbstbedienung), erweitert um die
// Mitarbeiter-Auswahl und den Urlaub/Krankheit-Umschalter.

import { AppHeader, ErrorBanner, Input } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { adminCreateAbsence } from "@/services/absences/adminAbsences.service";
import type { AppTheme } from "@/constants/theme";
import type { AbsenceType } from "@/types/absence";
import { formatDateISO } from "@/utils/date";
import { alertDialog } from "@/utils/dialogs";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { EmployeePickerField } from "./components/EmployeePickerField";

const TYPE_OPTIONS: { key: AbsenceType; label: string }[] = [
  { key: "vacation", label: "Urlaub" },
  { key: "sickness", label: "Krankheit" },
];

export default function AdminCreateAbsenceScreen({
  preselectedEmployeeId,
}: {
  preselectedEmployeeId?: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { employees } = useJobs();

  const [employeeId, setEmployeeId] = useState<string | null>(
    preselectedEmployeeId ?? null,
  );
  const [type, setType] = useState<AbsenceType>("vacation");
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const validate = (): string | null => {
    if (!employeeId) return "Bitte einen Mitarbeiter auswählen.";
    if (!startDate) return "Bitte ein Startdatum angeben.";
    if (type === "vacation" && !endDate) {
      return "Bitte ein Enddatum für den Urlaub angeben.";
    }
    if (endDate && formatDateISO(endDate)! < formatDateISO(startDate)!) {
      return "Das Enddatum darf nicht vor dem Startdatum liegen.";
    }
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");
    setSubmitting(true);
    try {
      await adminCreateAbsence({
        employeeId: employeeId!,
        type,
        startDate: formatDateISO(startDate!)!,
        endDate: endDate ? formatDateISO(endDate) : null,
        note: note.trim() || undefined,
      });

      await alertDialog(
        "Abwesenheit erfasst",
        type === "vacation"
          ? "Der Urlaub wurde als genehmigt erfasst."
          : "Die Krankmeldung wurde erfasst.",
      );
      router.back();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Die Abwesenheit konnte nicht erfasst werden.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <AppHeader title="Abwesenheit erfassen" showBack />

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {error ? (
            <ErrorBanner message={error} onDismiss={() => setError("")} />
          ) : null}

          <View style={styles.form}>
            <EmployeePickerField
              employees={employees}
              value={employeeId}
              onChange={setEmployeeId}
            />

            <View>
              <Text style={styles.sectionLabel}>Art *</Text>
              <View style={styles.segment}>
                {TYPE_OPTIONS.map((opt) => {
                  const active = type === opt.key;
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[styles.segmentItem, active && styles.segmentItemActive]}
                      onPress={() => setType(opt.key)}
                      activeOpacity={0.8}
                    >
                      <Text
                        style={[
                          styles.segmentText,
                          active && styles.segmentTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <DateTimeField
              label="Von *"
              mode="date"
              value={startDate}
              onChange={setStartDate}
            />
            <DateTimeField
              label={type === "vacation" ? "Bis *" : "Bis (optional)"}
              mode="date"
              value={endDate}
              onChange={setEndDate}
              placeholder={
                type === "sickness" ? "Kein Enddatum bekannt" : undefined
              }
            />

            <Input
              label="Notiz (optional)"
              placeholder="z. B. telefonisch gemeldet"
              value={note}
              onChangeText={setNote}
              multiline
              editable={!submitting}
            />
          </View>

          <TouchableOpacity
            style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
            activeOpacity={0.8}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
            ) : (
              <Text style={styles.submitButtonText}>Abwesenheit erfassen</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      padding: theme.spacing.lg,
      gap: theme.spacing.lg,
    },
    form: {
      gap: theme.spacing.md,
    },
    sectionLabel: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wide,
      marginBottom: 6,
    },
    segment: {
      flexDirection: "row",
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: 3,
      gap: 3,
    },
    segmentItem: {
      flex: 1,
      paddingVertical: 9,
      borderRadius: theme.radius.sm,
      alignItems: "center",
    },
    segmentItemActive: {
      backgroundColor: theme.colors.primaryContainer,
    },
    segmentText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    segmentTextActive: {
      color: theme.colors.onPrimaryContainer,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    submitButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: "center",
      justifyContent: "center",
      minHeight: theme.spacing.tapTarget,
    },
    submitButtonDisabled: {
      opacity: 0.6,
    },
    submitButtonText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimary,
    },
  });
}
