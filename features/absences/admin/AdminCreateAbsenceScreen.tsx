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
import { toUserMessage } from "@/utils/userMessages";
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
import { useTranslation } from "react-i18next";
import { EmployeePickerField } from "./components/EmployeePickerField";

export default function AdminCreateAbsenceScreen({
  preselectedEmployeeId,
}: {
  preselectedEmployeeId?: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();
  const { employees } = useJobs();

  const TYPE_OPTIONS: { key: AbsenceType; label: string }[] = [
    { key: "vacation", label: t("absences:types.vacation") },
    { key: "sickness", label: t("absences:types.sickness") },
  ];

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
    if (!employeeId) return t("admin:absenceAdmin.create.employeeRequiredError");
    if (!startDate) return t("admin:absenceAdmin.create.startDateRequiredError");
    if (type === "vacation" && !endDate) {
      return t("admin:absenceAdmin.create.endDateRequiredError");
    }
    if (endDate && formatDateISO(endDate)! < formatDateISO(startDate)!) {
      return t("admin:absenceAdmin.create.endBeforeStartError");
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
      const created = await adminCreateAbsence({
        employeeId: employeeId!,
        type,
        startDate: formatDateISO(startDate!)!,
        endDate: endDate ? formatDateISO(endDate) : null,
        note: note.trim() || undefined,
      });

      // Wortlaut richtet sich nach dem TATSÄCHLICH zurückgegebenen Status,
      // nicht nach einer hier erneut geprüften Konto-Annahme: für einen
      // Mitarbeiter mit geführtem Urlaubskonto liefert admin_create_absence
      // seit 20260826000002 status='requested' statt 'approved' — die
      // Genehmigung samt Abzugsbestätigung läuft dann über die bestehende
      // Urlaubsanträge-Ansicht (admin_review_vacation), nicht hier.
      await alertDialog(
        t("admin:absenceAdmin.create.createdDialogTitle"),
        type === "vacation"
          ? created.status === "approved"
            ? t("admin:absenceAdmin.create.createdVacationApproved")
            : t("admin:absenceAdmin.create.createdVacationPendingLedger")
          : t("admin:absenceAdmin.create.createdSickness"),
      );
      router.back();
    } catch (err) {
      setError(
        toUserMessage(err, t("admin:absenceAdmin.create.createFailedFallback")),
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
        <AppHeader title={t("admin:absenceAdmin.create.headerTitle")} showBack />

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
              <Text style={styles.sectionLabel}>
                {t("admin:absenceAdmin.create.typeSectionLabel")}
              </Text>
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
              label={t("admin:absenceAdmin.create.fromLabel")}
              mode="date"
              value={startDate}
              onChange={setStartDate}
            />
            <DateTimeField
              label={
                type === "vacation"
                  ? t("admin:absenceAdmin.create.toLabelVacation")
                  : t("admin:absenceAdmin.create.toLabelSickness")
              }
              mode="date"
              value={endDate}
              onChange={setEndDate}
              placeholder={
                type === "sickness"
                  ? t("admin:absenceAdmin.create.noEndDatePlaceholder")
                  : undefined
              }
            />

            <Input
              label={t("admin:absenceAdmin.create.noteLabel")}
              placeholder={t("admin:absenceAdmin.create.notePlaceholder")}
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
              <Text style={styles.submitButtonText}>
                {t("admin:absenceAdmin.create.submitButton")}
              </Text>
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
