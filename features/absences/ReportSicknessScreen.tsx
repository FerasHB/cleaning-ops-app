// features/absences/ReportSicknessScreen.tsx
// "Krank melden": Krank ab (Default heute) / Voraussichtlich bis (optional) /
// Notiz → report_own_sickness. Wird sofort aktiv (status=reported), keine
// Admin-Genehmigung nötig — kein Enddatum zu kennen ist der Normalfall, nicht
// die Ausnahme, deshalb ist "Bis" hier nie Pflicht.

import { AppHeader, ErrorBanner, Input } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { useAppTheme } from "@/hooks/useAppTheme";
import { reportOwnSickness } from "@/services/absences/absences.service";
import type { AppTheme } from "@/constants/theme";
import { formatDateISO } from "@/utils/date";
import { alertDialog } from "@/utils/dialogs";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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

export default function ReportSicknessScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  const [startDate, setStartDate] = useState<Date | null>(new Date());
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const validate = (): string | null => {
    if (!startDate) {
      return t("absences:errors.startDateRequired");
    }
    if (endDate && formatDateISO(endDate)! < formatDateISO(startDate)!) {
      return t("absences:errors.endBeforeStart");
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
      await reportOwnSickness({
        startDate: formatDateISO(startDate!)!,
        endDate: endDate ? formatDateISO(endDate) : null,
        note: note.trim() || undefined,
      });

      await alertDialog(
        t("absences:reportSickness.successTitle"),
        t("absences:reportSickness.successMessage"),
      );
      router.back();
    } catch (err) {
      // err.message ist bereits übersetzt — siehe RequestVacationScreen.
      setError(err instanceof Error ? err.message : t("absences:errors.reportFailed"));
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
        <AppHeader title={t("absences:reportSickness.title")} showBack />

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {error ? (
            <ErrorBanner message={error} onDismiss={() => setError("")} />
          ) : null}

          <View style={styles.form}>
            <DateTimeField
              label={t("absences:reportSickness.sinceLabel")}
              mode="date"
              value={startDate}
              onChange={setStartDate}
            />
            <DateTimeField
              label={t("absences:reportSickness.untilLabel")}
              mode="date"
              value={endDate}
              onChange={setEndDate}
              placeholder={t("absences:reportSickness.untilPlaceholder")}
            />
            <Input
              label={t("absences:reportSickness.noteLabel")}
              placeholder={t("absences:reportSickness.notePlaceholder")}
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
                {t("absences:reportSickness.submitButton")}
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
