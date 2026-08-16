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

  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const validate = (): string | null => {
    if (!startDate || !endDate) {
      return "Bitte Von- und Bis-Datum angeben.";
    }
    if (formatDateISO(endDate)! < formatDateISO(startDate)!) {
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
      await requestOwnVacation({
        startDate: formatDateISO(startDate!)!,
        endDate: formatDateISO(endDate!)!,
        note: note.trim() || undefined,
      });

      await alertDialog(
        "Urlaub beantragt",
        "Dein Urlaubsantrag wurde eingereicht und wartet auf Prüfung.",
      );
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Der Urlaubsantrag konnte nicht gestellt werden.");
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
        <AppHeader title="Urlaub beantragen" showBack />

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
              label="Von"
              mode="date"
              value={startDate}
              onChange={setStartDate}
            />
            <DateTimeField
              label="Bis"
              mode="date"
              value={endDate}
              onChange={setEndDate}
            />
            <Input
              label="Notiz (optional)"
              placeholder="z. B. Grund oder Hinweis für den Admin"
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
              <Text style={styles.submitButtonText}>Urlaub beantragen</Text>
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
