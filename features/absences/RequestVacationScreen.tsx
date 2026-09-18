// features/absences/RequestVacationScreen.tsx
// "Urlaub beantragen": Von/Bis + optionale Notiz → request_own_vacation.
// Kein clientseitig erfundener Genehmigungsstatus — die Anfrage geht als
// status=requested raus, die RPC ist die einzige Instanz.

import { AppHeader, ErrorBanner, Input } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { useAppTheme } from "@/hooks/useAppTheme";
import { requestOwnVacation } from "@/services/absences/absences.service";
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

export default function RequestVacationScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const validate = (): string | null => {
    if (!startDate || !endDate) {
      return t("absences:errors.datesRequired");
    }
    if (formatDateISO(endDate)! < formatDateISO(startDate)!) {
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
      await requestOwnVacation({
        startDate: formatDateISO(startDate!)!,
        endDate: formatDateISO(endDate!)!,
        note: note.trim() || undefined,
      });

      await alertDialog(
        t("absences:requestVacation.successTitle"),
        t("absences:requestVacation.successMessage"),
      );
      router.back();
    } catch (err) {
      // err.message ist bereits übersetzt: requestOwnVacation() wirft über
      // translateRpcError()/toUserMessage() (siehe absences.service.ts), die
      // beide i18next.t() nutzen — kein roher Server-/RPC-Text kommt hier an.
      setError(err instanceof Error ? err.message : t("absences:errors.requestFailed"));
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
        <AppHeader title={t("absences:requestVacation.title")} showBack />

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
              label={t("absences:requestVacation.fromLabel")}
              mode="date"
              value={startDate}
              onChange={setStartDate}
            />
            <DateTimeField
              label={t("absences:requestVacation.toLabel")}
              mode="date"
              value={endDate}
              onChange={setEndDate}
            />
            <Input
              label={t("absences:requestVacation.noteLabel")}
              placeholder={t("absences:requestVacation.notePlaceholder")}
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
                {t("absences:requestVacation.submitButton")}
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
