// features/auth/ForgotPasswordScreen.tsx
// Passwort-Reset-Link anfordern via Supabase.
// Zwei Zustände: Formular → Erfolg.

import { ErrorBanner, Input } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { supabase } from "@/lib/supabase";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import {
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
import type { AppTheme } from "@/constants/theme";

export default function ForgotPasswordScreen() {
  const theme  = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [email,     setEmail]     = useState("");
  const [emailError, setEmailError] = useState("");
  const [formError, setFormError] = useState("");
  const [loading,   setLoading]   = useState(false);
  const [success,   setSuccess]   = useState(false);

  // ── Reset-Link anfordern
  async function handleReset() {
    setEmailError("");
    setFormError("");

    if (!email.trim()) {
      setEmailError("E-Mail ist erforderlich.");
      return;
    }

    try {
      setLoading(true);
      const { error } = await supabase.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        // redirectTo kann gesetzt werden, wenn eine Deep-Link-URL konfiguriert ist
        // { redirectTo: 'cleanops://reset-password' }
      );

      if (error) {
        setFormError(error.message || "Reset fehlgeschlagen. Bitte versuche es erneut.");
        return;
      }

      setSuccess(true);
    } catch {
      setFormError("Ein unbekannter Fehler ist aufgetreten.");
    } finally {
      setLoading(false);
    }
  }

  // ── Erfolgs-Ansicht
  if (success) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <StatusBar
          barStyle={theme.isDark ? "light-content" : "dark-content"}
          backgroundColor={theme.colors.background}
        />
        <View style={styles.successContainer}>
          <View style={styles.successIconWrap}>
            <Ionicons name="checkmark-circle" size={48} color={theme.colors.statusCompleted} />
          </View>
          <Text style={styles.successTitle}>E-Mail wurde gesendet</Text>
          <Text style={styles.successText}>
            Falls ein Konto mit{" "}
            <Text style={styles.successEmail}>{email.trim()}</Text>
            {" "}existiert, erhältst du in Kürze einen Link zum Zurücksetzen deines Passworts.
          </Text>
          <Text style={styles.successHint}>
            Bitte auch den Spam-Ordner prüfen.
          </Text>

          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => router.replace("/login")}
            activeOpacity={0.82}
          >
            <Text style={styles.backBtnText}>Zurück zum Login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Formular-Ansicht
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
          {/* ── Zurück-Button ── */}
          <TouchableOpacity
            style={styles.navBack}
            onPress={() => router.back()}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={20} color={theme.colors.primary} />
            <Text style={styles.navBackText}>Login</Text>
          </TouchableOpacity>

          {/* ── Icon + Texte ── */}
          <View style={styles.heroArea}>
            <View style={styles.iconWrap}>
              <Ionicons name="lock-open-outline" size={30} color={theme.colors.onPrimaryContainer} />
            </View>
            <Text style={styles.title}>Passwort zurücksetzen</Text>
            <Text style={styles.subtitle}>
              Gib deine E-Mail-Adresse ein. Wir senden dir einen Link zum Zurücksetzen deines Passworts.
            </Text>
          </View>

          {/* ── Formular ── */}
          <View style={styles.card}>
            {formError ? (
              <ErrorBanner message={formError} onDismiss={() => setFormError("")} />
            ) : null}

            <Input
              label="E-Mail-Adresse"
              placeholder="name@firma.de"
              value={email}
              onChangeText={(t) => { setEmail(t); setEmailError(""); setFormError(""); }}
              error={emailError}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              returnKeyType="send"
              onSubmitEditing={handleReset}
              editable={!loading}
            />

            <TouchableOpacity
              style={[styles.resetBtn, loading && styles.resetBtnDisabled]}
              onPress={handleReset}
              disabled={loading}
              activeOpacity={0.82}
            >
              <Ionicons
                name="send-outline"
                size={16}
                color={theme.colors.onPrimaryContainer}
                style={{ marginRight: 8 }}
              />
              <Text style={styles.resetBtnText}>
                {loading ? "Senden..." : "Reset-Link senden"}
              </Text>
            </TouchableOpacity>

            {/* Zurück-Link */}
            <TouchableOpacity
              onPress={() => router.replace("/login")}
              activeOpacity={0.75}
              style={styles.loginLinkRow}
            >
              <Text style={styles.loginLinkText}>Zurück zum Login</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    flex: { flex: 1 },
    scroll: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.gutter,
      paddingVertical: theme.spacing.xl,
      gap: theme.spacing.xl,
    },

    // Zurück-Button oben
    navBack: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
    },
    navBackText: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.primary,
    },

    // Hero-Bereich
    heroArea: {
      alignItems: "center",
      gap: theme.spacing.md,
    },
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
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    subtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
      lineHeight: theme.typography.lineHeight.sm,
      maxWidth: 300,
    },

    // Formular-Karte
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.xl,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.xl,
      gap: theme.spacing.lg,
      ...theme.shadows.md,
    },

    // Reset-Button
    resetBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
      paddingVertical: 14,
    },
    resetBtnDisabled: { opacity: 0.5 },
    resetBtnText: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onPrimaryContainer,
    },

    // Login-Link
    loginLinkRow: { alignItems: "center" },
    loginLinkText: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.primary,
    },

    // ── Erfolgs-Ansicht
    successContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing.xl,
      gap: theme.spacing.md,
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
    successTitle: {
      fontSize: theme.typography.size.xl,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },
    successText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
      lineHeight: theme.typography.lineHeight.sm,
    },
    successEmail: {
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurface,
    },
    successHint: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
      textAlign: "center",
    },
    backBtn: {
      marginTop: theme.spacing.md,
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
      paddingHorizontal: theme.spacing.xl,
      paddingVertical: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    backBtnText: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onPrimaryContainer,
    },
  });
}
