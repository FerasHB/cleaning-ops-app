// features/auth/RegisterScreen.tsx
// Admin-Registrierung: Konto + Firma in einem Formular
// (registerAdmin ruft im Anschluss setupCompanyForAdmin auf).

import { ErrorBanner, Input, PasswordInput } from "@/components/ui";
import { AuthBrand } from "@/features/auth/components/AuthBrand";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { registerAdmin } from "@/services/auth/registerAdmin";
import { Ionicons } from "@expo/vector-icons";
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
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";
import { toFriendlyAuthErrorMessage } from "@/utils/authErrorMessages";
import { isValidEmail } from "@/utils/email";
import { isValidPhone } from "@/utils/phone";
import {
  MIN_PASSWORD_LENGTH,
  validatePassword,
} from "@/utils/passwordValidation";

export default function RegisterScreen() {
  const theme      = useAppTheme();
  const styles     = useMemo(() => createStyles(theme), [theme]);
  const { refreshProfile } = useAuth();
  const { t } = useTranslation();

  // Felder
  const [fullName,     setFullName]     = useState("");
  const [adminPhone,   setAdminPhone]   = useState("");
  const [companyName,  setCompanyName]  = useState("");
  const [companyEmail, setCompanyEmail] = useState("");
  const [companyPhone, setCompanyPhone] = useState("");
  const [sameAsMyPhone, setSameAsMyPhone] = useState(false);
  const [email,        setEmail]        = useState("");
  const [password,     setPassword]     = useState("");
  const [passwordConf, setPasswordConf] = useState("");

  // Fehler pro Feld
  const [fullNameError,     setFullNameError]     = useState("");
  const [adminPhoneError,   setAdminPhoneError]   = useState("");
  const [companyNameError,  setCompanyNameError]  = useState("");
  const [companyEmailError, setCompanyEmailError] = useState("");
  const [companyPhoneError, setCompanyPhoneError] = useState("");
  const [emailError,        setEmailError]        = useState("");
  const [passwordError,     setPasswordError]     = useState("");
  const [passwordConfError, setPasswordConfError] = useState("");
  const [formError,         setFormError]         = useState("");

  const [loading, setLoading] = useState(false);

  const passwordMeetsLength = password.length >= MIN_PASSWORD_LENGTH;

  // Animation
  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;
  React.useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim,  { toValue: 1, duration: 450, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 380, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  function clearError() {
    setFormError("");
  }

  // Firmen-Telefon spiegelt die eigene Nummer, solange der Schalter an ist.
  const handleAdminPhoneChange = (t: string) => {
    setAdminPhone(t);
    setAdminPhoneError("");
    clearError();
    if (sameAsMyPhone) {
      setCompanyPhone(t);
      setCompanyPhoneError("");
    }
  };

  const handleSameAsMyPhoneToggle = (next: boolean) => {
    setSameAsMyPhone(next);
    if (next) {
      setCompanyPhone(adminPhone);
      setCompanyPhoneError("");
    }
  };

  // ── Validierung
  function validate(): boolean {
    let valid = true;
    setFullNameError(""); setAdminPhoneError("");
    setCompanyNameError(""); setCompanyEmailError(""); setCompanyPhoneError("");
    setEmailError("");
    setPasswordError(""); setPasswordConfError(""); setFormError("");

    if (!fullName.trim()) {
      setFullNameError(t("auth:register.validation.nameRequired"));
      valid = false;
    }
    if (adminPhone.trim() && !isValidPhone(adminPhone)) {
      setAdminPhoneError(t("auth:register.validation.phoneInvalid"));
      valid = false;
    }
    if (!companyName.trim()) {
      setCompanyNameError(t("auth:register.validation.companyNameRequired"));
      valid = false;
    }
    if (!companyEmail.trim()) {
      setCompanyEmailError(t("auth:register.validation.companyEmailRequired"));
      valid = false;
    } else if (!isValidEmail(companyEmail)) {
      setCompanyEmailError(t("auth:register.validation.emailInvalid"));
      valid = false;
    }
    if (!companyPhone.trim()) {
      setCompanyPhoneError(t("auth:register.validation.companyPhoneRequired"));
      valid = false;
    } else if (!isValidPhone(companyPhone)) {
      setCompanyPhoneError(t("auth:register.validation.phoneInvalid"));
      valid = false;
    }
    if (!email.trim()) {
      setEmailError(t("auth:register.validation.emailRequired"));
      valid = false;
    } else if (!isValidEmail(email)) {
      setEmailError(t("auth:register.validation.emailInvalid"));
      valid = false;
    }
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      setPasswordError(passwordCheck.errors[0]);
      valid = false;
    }
    if (password && passwordConf && password !== passwordConf) {
      setPasswordConfError(t("common:validation.passwordMismatch"));
      valid = false;
    }
    if (password && !passwordConf) {
      setPasswordConfError(t("auth:register.validation.passwordConfirmRequired"));
      valid = false;
    }
    return valid;
  }

  // ── Registrieren (unveränderte Logik)
  async function handleRegister() {
    if (!validate()) return;
    try {
      setLoading(true);
      await registerAdmin({
        fullName,
        email,
        password,
        companyName,
        companyEmail,
        companyPhone,
        adminPhone: adminPhone.trim() || undefined,
      });
      await refreshProfile();
      // Erfolgreich → index.tsx übernimmt Weiterleitung
      router.replace("/");
    } catch (err) {
      setFormError(
        toFriendlyAuthErrorMessage(err, t("auth:register.errors.registrationFailed"))
      );
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
            <AuthBrand tagline={t("auth:register.tagline")} />
          </Animated.View>

          {/* ── Formular-Karte ── */}
          <Animated.View
            style={[
              styles.card,
              { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
            ]}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{t("auth:register.cardTitle")}</Text>
              <Text style={styles.cardSubtitle}>
                {t("auth:register.cardSubtitle")}
              </Text>
            </View>

            {/* Fehler-Banner */}
            {formError ? (
              <ErrorBanner message={formError} onDismiss={() => setFormError("")} />
            ) : null}

            {/* ── Abschnitt: Persönliche Daten ── */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{t("auth:register.sectionPersonal")}</Text>
              <View style={styles.fields}>
                <Input
                  label={t("auth:register.fullNameLabel")}
                  placeholder={t("auth:register.fullNamePlaceholder")}
                  value={fullName}
                  onChangeText={(v) => { setFullName(v); setFullNameError(""); clearError(); }}
                  error={fullNameError}
                  autoCapitalize="words"
                  returnKeyType="next"
                  editable={!loading}
                />
                <Input
                  label={t("auth:register.emailLabel")}
                  placeholder={t("auth:register.emailPlaceholder")}
                  value={email}
                  onChangeText={(v) => { setEmail(v); setEmailError(""); clearError(); }}
                  error={emailError}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  returnKeyType="next"
                  editable={!loading}
                />
                <Input
                  label={t("auth:register.adminPhoneLabel")}
                  placeholder={t("auth:register.phonePlaceholder")}
                  value={adminPhone}
                  onChangeText={handleAdminPhoneChange}
                  error={adminPhoneError}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  returnKeyType="next"
                  editable={!loading}
                />
              </View>
            </View>

            {/* ── Abschnitt: Firma ── */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{t("auth:register.sectionCompany")}</Text>
              <View style={styles.fields}>
                <Input
                  label={t("auth:register.companyNameLabel")}
                  placeholder={t("auth:register.companyNamePlaceholder")}
                  value={companyName}
                  onChangeText={(v) => { setCompanyName(v); setCompanyNameError(""); clearError(); }}
                  error={companyNameError}
                  autoCapitalize="words"
                  returnKeyType="next"
                  editable={!loading}
                />
                <Input
                  label={t("auth:register.companyEmailLabel")}
                  placeholder={t("auth:register.companyEmailPlaceholder")}
                  value={companyEmail}
                  onChangeText={(v) => { setCompanyEmail(v); setCompanyEmailError(""); clearError(); }}
                  error={companyEmailError}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  returnKeyType="next"
                  editable={!loading}
                />
                <Input
                  label={t("auth:register.companyPhoneLabel")}
                  placeholder={t("auth:register.phonePlaceholder")}
                  value={companyPhone}
                  onChangeText={(v) => { setCompanyPhone(v); setCompanyPhoneError(""); clearError(); }}
                  error={companyPhoneError}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  returnKeyType="next"
                  editable={!loading && !sameAsMyPhone}
                />
                <View style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>{t("auth:register.samePhoneToggle")}</Text>
                  <Switch
                    value={sameAsMyPhone}
                    onValueChange={handleSameAsMyPhoneToggle}
                    disabled={loading || !adminPhone.trim()}
                    trackColor={{ false: theme.colors.outlineVariant, true: theme.colors.primary }}
                  />
                </View>
              </View>
            </View>

            {/* ── Abschnitt: Passwort ── */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{t("auth:register.sectionPassword")}</Text>
              <View style={styles.fields}>
                <View style={styles.passwordField}>
                  <PasswordInput
                    label={t("auth:register.passwordLabel")}
                    placeholder={t("auth:register.passwordPlaceholder", { min: MIN_PASSWORD_LENGTH })}
                    value={password}
                    onChangeText={(v) => { setPassword(v); setPasswordError(""); clearError(); }}
                    error={passwordError}
                    autoComplete="password-new"
                    returnKeyType="next"
                    editable={!loading}
                  />
                  <View style={styles.passwordHintRow}>
                    <Ionicons
                      name={passwordMeetsLength ? "checkmark-circle" : "ellipse-outline"}
                      size={14}
                      color={passwordMeetsLength ? theme.colors.statusCompleted : theme.colors.outline}
                    />
                    <Text
                      style={[
                        styles.passwordHintText,
                        passwordMeetsLength && styles.passwordHintTextMet,
                      ]}
                    >
                      {t("auth:register.passwordMinHint", { min: MIN_PASSWORD_LENGTH })}
                    </Text>
                  </View>
                </View>
                <PasswordInput
                  label={t("auth:register.passwordConfirmLabel")}
                  placeholder={t("auth:register.passwordConfirmPlaceholder")}
                  value={passwordConf}
                  onChangeText={(v) => { setPasswordConf(v); setPasswordConfError(""); clearError(); }}
                  error={passwordConfError}
                  autoComplete="password-new"
                  returnKeyType="done"
                  onSubmitEditing={handleRegister}
                  editable={!loading}
                />
              </View>
            </View>

            {/* ── Hinweis-Box ── */}
            <View style={styles.infoBox}>
              <Text style={styles.infoText}>
                {t("auth:register.infoBox")}
              </Text>
            </View>

            {/* ── Register-Button ── */}
            <TouchableOpacity
              style={[styles.registerBtn, loading && styles.registerBtnDisabled]}
              onPress={handleRegister}
              disabled={loading}
              activeOpacity={0.82}
              accessibilityRole="button"
              accessibilityLabel={t("auth:register.registerButtonA11y")}
              accessibilityState={{ disabled: loading, busy: loading }}
            >
              <Text style={styles.registerBtnText}>
                {loading ? t("auth:register.registerButtonLoading") : t("auth:register.registerButton")}
              </Text>
            </TouchableOpacity>

            {/* ── Login-Link ── */}
            <TouchableOpacity
              onPress={() => router.replace("/login")}
              activeOpacity={0.75}
              style={styles.loginRow}
              disabled={loading}
            >
              <Text style={styles.loginText}>{t("auth:register.haveAccountText")}{" "}</Text>
              <Text style={styles.loginLink}>{t("auth:register.loginLink")}</Text>
            </TouchableOpacity>
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
      lineHeight: theme.typography.lineHeight.sm,
    },

    // Abschnitte
    section: { gap: theme.spacing.sm },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: 2,
    },
    toggleLabel: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    sectionLabel: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.widest,
    },
    fields: { gap: theme.spacing.md },

    // Passwort-Feld + Live-Anforderungshinweis
    passwordField: { gap: 6 },
    passwordHintRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingStart: 2,
    },
    passwordHintText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
    },
    passwordHintTextMet: {
      color: theme.colors.statusCompleted,
      fontFamily: theme.typography.family.medium,
    },

    // Hinweis-Box
    infoBox: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
    },
    infoText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.sm,
    },

    // Register-Button
    registerBtn: {
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 14,
    },
    registerBtnDisabled: { opacity: 0.5 },
    registerBtnText: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onPrimaryContainer,
    },

    // Login-Link
    loginRow: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
    },
    loginText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    loginLink: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.primary,
    },
  });
}
