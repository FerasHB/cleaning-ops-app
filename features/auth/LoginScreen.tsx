// features/auth/LoginScreen.tsx
// Login-Formular (E-Mail/Passwort) via supabase.auth.signInWithPassword.

import { ErrorBanner, PasswordInput, Input } from "@/components/ui";
import { AuthBrand } from "@/features/auth/components/AuthBrand";
import { useAppTheme } from "@/hooks/useAppTheme";
import { supabase } from "@/lib/supabase";
import { toFriendlyAuthErrorMessage } from "@/utils/authErrorMessages";
import { isValidEmail, normalizeEmail } from "@/utils/email";
import { router } from "expo-router";
import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Animated,
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

export default function LoginScreen() {
  const theme  = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  const [email,     setEmail]     = useState("");
  const [password,  setPassword]  = useState("");
  const [loading,   setLoading]   = useState(false);
  const [formError, setFormError] = useState("");

  // Einzel-Feld-Fehler
  const [emailError,    setEmailError]    = useState("");
  const [passwordError, setPasswordError] = useState("");

  // Einmal-Animation
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;
  React.useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim,  { toValue: 1, duration: 450, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 380, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  // ── Validierung
  function validate(): boolean {
    let valid = true;
    setEmailError("");
    setPasswordError("");
    setFormError("");

    if (!email.trim()) {
      setEmailError(t("auth:login.validation.emailRequired"));
      valid = false;
    } else if (!isValidEmail(email)) {
      setEmailError(t("auth:login.validation.emailInvalid"));
      valid = false;
    }
    if (!password) {
      setPasswordError(t("auth:login.validation.passwordRequired"));
      valid = false;
    }
    return valid;
  }

  // ── Login
  async function handleLogin() {
    if (!validate()) return;
    try {
      setLoading(true);
      const { error } = await supabase.auth.signInWithPassword({
        email:    normalizeEmail(email),
        password,
      });
      if (error) {
        setFormError(toFriendlyAuthErrorMessage(error, t("auth:login.errors.loginFailed")));
        return;
      }
      // Erfolgreich → index.tsx übernimmt die Weiterleitung
      router.replace("/");
    } catch (err) {
      setFormError(toFriendlyAuthErrorMessage(err, t("auth:login.errors.unexpectedFailed")));
    } finally {
      setLoading(false);
    }
  }

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
          {/* ── Branding ── */}
          <Animated.View style={{ opacity: fadeAnim }}>
            <AuthBrand tagline={t("auth:login.tagline")} />
          </Animated.View>

          {/* ── Formular-Karte ── */}
          <Animated.View
            style={[
              styles.card,
              { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
            ]}
          >
            {/* Karten-Header */}
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{t("auth:login.cardTitle")}</Text>
              <Text style={styles.cardSubtitle}>{t("auth:login.cardSubtitle")}</Text>
            </View>

            {/* Fehler-Banner */}
            {formError ? (
              <ErrorBanner
                message={formError}
                onDismiss={() => setFormError("")}
              />
            ) : null}

            {/* Felder */}
            <View style={styles.fields}>
              <Input
                label={t("auth:login.emailLabel")}
                placeholder={t("auth:login.emailPlaceholder")}
                value={email}
                onChangeText={(v) => { setEmail(v); setEmailError(""); setFormError(""); }}
                error={emailError}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                returnKeyType="next"
                editable={!loading}
              />

              {/* Passwort + "Vergessen?"-Link */}
              <View style={styles.passwordBlock}>
                <PasswordInput
                  label={t("auth:login.passwordLabel")}
                  placeholder="••••••••"
                  value={password}
                  onChangeText={(v) => { setPassword(v); setPasswordError(""); setFormError(""); }}
                  error={passwordError}
                  autoComplete="password"
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                  editable={!loading}
                />
                <TouchableOpacity
                  onPress={() => router.push("/forgot-password")}
                  activeOpacity={0.7}
                  style={styles.forgotLink}
                >
                  <Text style={styles.forgotLinkText}>{t("auth:login.forgotLink")}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Login Button */}
            <TouchableOpacity
              style={[styles.loginBtn, loading && styles.loginBtnDisabled]}
              onPress={handleLogin}
              disabled={loading}
              activeOpacity={0.82}
              accessibilityRole="button"
              accessibilityLabel={t("auth:login.loginButtonA11y")}
              accessibilityState={{ disabled: loading, busy: loading }}
            >
              <Text style={styles.loginBtnText}>
                {loading ? t("auth:login.loginButtonLoading") : t("auth:login.loginButton")}
              </Text>
            </TouchableOpacity>

            {/* Divider */}
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>{t("auth:login.divider")}</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Register Link */}
            <TouchableOpacity
              onPress={() => router.replace("/register")}
              activeOpacity={0.75}
              style={styles.registerRow}
              disabled={loading}
            >
              <Text style={styles.registerText}>{t("auth:login.noAccountText")}{" "}</Text>
              <Text style={styles.registerLink}>{t("auth:login.registerLink")}</Text>
            </TouchableOpacity>
          </Animated.View>

          {/* ── Footer ── */}
          <Animated.View style={{ opacity: fadeAnim }}>
            <Text style={styles.footer}>{t("auth:login.footer")}</Text>
          </Animated.View>
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
      justifyContent: "center",
      paddingHorizontal: theme.spacing.gutter,
      paddingVertical: theme.spacing.xl,
      gap: theme.spacing.xl,
    },

    // Karte
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.xl,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.xl,
      gap: theme.spacing.lg,
      ...theme.shadows.md,
    },
    cardHeader: { gap: 4 },
    cardTitle: {
      fontSize: theme.typography.size.xl,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    cardSubtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // Felder
    fields: { gap: theme.spacing.md },

    // Passwort + Vergessen-Link
    passwordBlock: { gap: 6 },
    forgotLink: { alignSelf: "flex-end" },
    forgotLinkText: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.primary,
    },

    // Login-Button
    loginBtn: {
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 14,
    },
    loginBtnDisabled: { opacity: 0.5 },
    loginBtnText: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onPrimaryContainer,
    },

    // Divider
    dividerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    dividerLine: {
      flex: 1,
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
    },
    dividerText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
    },

    // Register-Link
    registerRow: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
    },
    registerText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    registerLink: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.primary,
    },

    // Footer
    footer: {
      textAlign: "center",
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
    },
  });
}
