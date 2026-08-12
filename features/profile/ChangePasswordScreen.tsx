import { AppHeader, ErrorBanner, PasswordInput } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { useAppTheme } from "@/hooks/useAppTheme";
import { toFriendlyAuthErrorMessage } from "@/utils/authErrorMessages";
import type { AppTheme } from "@/constants/theme";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function ChangePasswordScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const validate = (): string | null => {
    if (!newPassword.trim()) return "Bitte ein neues Passwort eingeben.";
    if (newPassword.length < 6) return "Das Passwort muss mindestens 6 Zeichen lang sein.";
    if (newPassword !== confirmPassword) return "Die Passwörter stimmen nicht überein.";
    return null;
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        setError(
          toFriendlyAuthErrorMessage(updateError, "Passwort konnte nicht geändert werden."),
        );
        return;
      }

      Alert.alert("Gespeichert", "Dein Passwort wurde erfolgreich geändert.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (err) {
      setError(toFriendlyAuthErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <AppHeader title="Passwort ändern" showBack />

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {error && (
            <ErrorBanner
              message={error}
              onDismiss={() => setError(null)}
              type="error"
            />
          )}

          <View style={styles.form}>
            <PasswordInput
              label="Neues Passwort"
              placeholder="Mindestens 6 Zeichen"
              value={newPassword}
              onChangeText={(text) => {
                setNewPassword(text);
                if (error) setError(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              editable={!loading}
            />

            <PasswordInput
              label="Passwort bestätigen"
              placeholder="Passwort wiederholen"
              value={confirmPassword}
              onChangeText={(text) => {
                setConfirmPassword(text);
                if (error) setError(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSave}
              editable={!loading}
            />
          </View>

          <TouchableOpacity
            style={[styles.saveButton, loading && styles.saveButtonDisabled]}
            activeOpacity={0.8}
            onPress={handleSave}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
            ) : (
              <Text style={styles.saveButtonText}>Passwort speichern</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    flex: {
      flex: 1,
    },
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },

    // ── Content
    content: {
      padding: theme.spacing.lg,
      gap: theme.spacing.lg,
    },
    form: {
      gap: theme.spacing.md,
    },

    // ── Speichern-Button
    saveButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: "center",
      justifyContent: "center",
      minHeight: theme.spacing.tapTarget,
    },
    saveButtonDisabled: {
      opacity: 0.6,
    },
    saveButtonText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimary,
    },
  });
}
