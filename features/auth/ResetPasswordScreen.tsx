// features/auth/ResetPasswordScreen.tsx
// Ziel des Passwort-Reset-Deep-Links (taskopsmanager://reset-password).
// Die eigentliche Link-Einlösung (PKCE/Implicit, Mehrfachquellen, Watchdog)
// steckt in useAuthLinkSession — dieser Screen kümmert sich nur noch um das
// "neues Passwort setzen"-Formular und die reset-spezifische Copy/CTA.

import { ErrorBanner, PasswordInput } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAuthLinkSession } from "@/features/auth/useAuthLinkSession";
import { useAppTheme } from "@/hooks/useAppTheme";
import { supabase } from "@/lib/supabase";
import { toFriendlyAuthErrorMessage } from "@/utils/authErrorMessages";
import { validateNewPassword } from "@/utils/passwordValidation";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
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

const DEFAULT_INVALID_MESSAGE =
  "Der Link ist ungültig. Bitte fordere einen neuen Link an.";
const EXPIRED_RESET_MESSAGE =
  "Der Link zum Zurücksetzen des Passworts ist abgelaufen. Bitte fordere einen neuen Link an.";

export default function ResetPasswordScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { status, invalidMessage, recheck } = useAuthLinkSession(
    DEFAULT_INVALID_MESSAGE,
    EXPIRED_RESET_MESSAGE,
  );

  const [formSuccess, setFormSuccess] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const validationError = validateNewPassword(newPassword, confirmPassword);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setFormError("");
    setSubmitting(true);

    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) {
        setFormError(
          toFriendlyAuthErrorMessage(error, "Passwort konnte nicht gesetzt werden."),
        );
        return;
      }

      // Recovery-Session beenden — der Nutzer soll sich bewusst mit dem
      // neuen Passwort neu anmelden, keine automatische App-Sitzung aus
      // dem Reset-Link heraus.
      await supabase.auth.signOut().catch(() => {});

      setFormSuccess(true);
    } catch (err) {
      setFormError(toFriendlyAuthErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Wird geprüft ──
  if (status === "checking") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.centerHint}>Link wird geprüft …</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Ungültiger/abgelaufener Link ──
  if (status === "invalid") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <StatusBar
          barStyle={theme.isDark ? "light-content" : "dark-content"}
          backgroundColor={theme.colors.background}
        />
        <View style={styles.centerState}>
          <View style={styles.errorIconWrap}>
            <Ionicons name="alert-circle" size={44} color={theme.colors.error} />
          </View>
          <Text style={styles.centerTitle}>Link ungültig</Text>
          <Text style={styles.centerText}>{invalidMessage}</Text>

          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.replace("/forgot-password")}
            activeOpacity={0.82}
          >
            <Text style={styles.primaryBtnText}>Neuen Link anfordern</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={recheck}
            activeOpacity={0.75}
          >
            <Text style={styles.linkBtnText}>Link erneut prüfen</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => router.replace("/login")}
            activeOpacity={0.75}
          >
            <Text style={styles.linkBtnText}>Zurück zum Login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Erfolgreich gesetzt ──
  if (formSuccess) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.centerState}>
          <View style={styles.successIconWrap}>
            <Ionicons
              name="checkmark-circle"
              size={48}
              color={theme.colors.statusCompleted}
            />
          </View>
          <Text style={styles.centerTitle}>Passwort gesetzt</Text>
          <Text style={styles.centerText}>
            Dein neues Passwort wurde gespeichert. Bitte melde dich damit an.
          </Text>

          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.replace("/login")}
            activeOpacity={0.82}
          >
            <Text style={styles.primaryBtnText}>Zum Login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Neues Passwort setzen ──
  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.heroArea}>
            <View style={styles.iconWrap}>
              <Ionicons
                name="key-outline"
                size={30}
                color={theme.colors.onPrimaryContainer}
              />
            </View>
            <Text style={styles.title}>Neues Passwort festlegen</Text>
            <Text style={styles.subtitle}>
              Vergib ein neues Passwort für dein Konto.
            </Text>
          </View>

          <View style={styles.card}>
            {formError ? (
              <ErrorBanner message={formError} onDismiss={() => setFormError("")} />
            ) : null}

            <PasswordInput
              label="Neues Passwort"
              placeholder="Mindestens 6 Zeichen"
              value={newPassword}
              onChangeText={(text) => {
                setNewPassword(text);
                if (formError) setFormError("");
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              editable={!submitting}
            />

            <PasswordInput
              label="Passwort bestätigen"
              placeholder="Passwort wiederholen"
              value={confirmPassword}
              onChangeText={(text) => {
                setConfirmPassword(text);
                if (formError) setFormError("");
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
              editable={!submitting}
            />

            <TouchableOpacity
              style={[styles.primaryBtn, submitting && styles.primaryBtnDisabled]}
              onPress={handleSubmit}
              disabled={submitting}
              activeOpacity={0.82}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={theme.colors.onPrimary} />
              ) : (
                <Text style={styles.primaryBtnText}>Passwort speichern</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.colors.background },
    flex: { flex: 1 },
    scroll: {
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: theme.spacing.gutter,
      paddingVertical: theme.spacing.xl,
      gap: theme.spacing.xl,
    },

    heroArea: { alignItems: "center", gap: theme.spacing.md },
    iconWrap: {
      width: 68,
      height: 68,
      borderRadius: theme.radius.xl,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
    },
    title: {
      fontSize: theme.typography.size.xl,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },
    subtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
      lineHeight: theme.typography.lineHeight.sm,
      maxWidth: 300,
    },

    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.xl,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.xl,
      gap: theme.spacing.lg,
      ...theme.shadows.md,
    },

    primaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
      paddingVertical: 14,
      marginTop: theme.spacing.sm,
    },
    primaryBtnDisabled: { opacity: 0.6 },
    primaryBtnText: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onPrimaryContainer,
    },

    linkBtn: { marginTop: theme.spacing.sm, alignItems: "center" },
    linkBtnText: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.primary,
    },

    centerState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing.xl,
      gap: theme.spacing.sm,
    },
    centerHint: {
      marginTop: theme.spacing.md,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    centerTitle: {
      fontSize: theme.typography.size.xl,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },
    centerText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
      lineHeight: theme.typography.lineHeight.sm,
      maxWidth: 320,
    },
    errorIconWrap: {
      width: 80,
      height: 80,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.errorContainer,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.sm,
    },
    successIconWrap: {
      width: 80,
      height: 80,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusCompletedBg,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.sm,
    },
  });
}
