// features/auth/RegisterScreen.tsx
// Redesign: useAppTheme(), Inter-Font, PasswordInput, Passwort-Bestätigung.
// registerAdmin()-Logik bleibt vollständig unverändert.

import { ErrorBanner, Input, PasswordInput } from "@/components/ui";
import { AuthBrand } from "@/features/auth/components/AuthBrand";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { registerAdmin } from "@/services/auth/registerAdmin";
import { router } from "expo-router";
import React, { useMemo, useRef, useState } from "react";
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

export default function RegisterScreen() {
  const theme      = useAppTheme();
  const styles     = useMemo(() => createStyles(theme), [theme]);
  const { refreshProfile } = useAuth();

  // Felder
  const [fullName,     setFullName]     = useState("");
  const [companyName,  setCompanyName]  = useState("");
  const [email,        setEmail]        = useState("");
  const [password,     setPassword]     = useState("");
  const [passwordConf, setPasswordConf] = useState("");

  // Fehler pro Feld
  const [fullNameError,     setFullNameError]     = useState("");
  const [companyNameError,  setCompanyNameError]  = useState("");
  const [emailError,        setEmailError]        = useState("");
  const [passwordError,     setPasswordError]     = useState("");
  const [passwordConfError, setPasswordConfError] = useState("");
  const [formError,         setFormError]         = useState("");

  const [loading, setLoading] = useState(false);

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

  // ── Validierung
  function validate(): boolean {
    let valid = true;
    setFullNameError(""); setCompanyNameError(""); setEmailError("");
    setPasswordError(""); setPasswordConfError(""); setFormError("");

    if (!fullName.trim()) {
      setFullNameError("Name ist erforderlich.");
      valid = false;
    }
    if (!companyName.trim()) {
      setCompanyNameError("Firmenname ist erforderlich.");
      valid = false;
    }
    if (!email.trim()) {
      setEmailError("E-Mail ist erforderlich.");
      valid = false;
    }
    if (!password) {
      setPasswordError("Passwort ist erforderlich.");
      valid = false;
    } else if (password.length < 6) {
      setPasswordError("Mindestens 6 Zeichen.");
      valid = false;
    }
    if (password && passwordConf && password !== passwordConf) {
      setPasswordConfError("Passwörter stimmen nicht überein.");
      valid = false;
    }
    if (password && !passwordConf) {
      setPasswordConfError("Passwort bestätigen.");
      valid = false;
    }
    return valid;
  }

  // ── Registrieren (unveränderte Logik)
  async function handleRegister() {
    if (!validate()) return;
    try {
      setLoading(true);
      await registerAdmin({ fullName, email, password, companyName });
      await refreshProfile();
      // Erfolgreich → index.tsx übernimmt Weiterleitung
      router.replace("/");
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Registrierung fehlgeschlagen."
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
            <AuthBrand tagline="Firmenkonto erstellen" />
          </Animated.View>

          {/* ── Formular-Karte ── */}
          <Animated.View
            style={[
              styles.card,
              { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
            ]}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Firma registrieren</Text>
              <Text style={styles.cardSubtitle}>
                Erstelle dein Admin-Konto und richte deine Firma ein
              </Text>
            </View>

            {/* Fehler-Banner */}
            {formError ? (
              <ErrorBanner message={formError} onDismiss={() => setFormError("")} />
            ) : null}

            {/* ── Abschnitt: Persönliche Daten ── */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>PERSÖNLICHE DATEN</Text>
              <View style={styles.fields}>
                <Input
                  label="Vollständiger Name"
                  placeholder="Max Mustermann"
                  value={fullName}
                  onChangeText={(t) => { setFullName(t); setFullNameError(""); clearError(); }}
                  error={fullNameError}
                  autoCapitalize="words"
                  returnKeyType="next"
                  editable={!loading}
                />
                <Input
                  label="E-Mail-Adresse"
                  placeholder="name@firma.de"
                  value={email}
                  onChangeText={(t) => { setEmail(t); setEmailError(""); clearError(); }}
                  error={emailError}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  returnKeyType="next"
                  editable={!loading}
                />
              </View>
            </View>

            {/* ── Abschnitt: Firma ── */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>FIRMA</Text>
              <Input
                label="Firmenname"
                placeholder="Muster Reinigung GmbH"
                value={companyName}
                onChangeText={(t) => { setCompanyName(t); setCompanyNameError(""); clearError(); }}
                error={companyNameError}
                autoCapitalize="words"
                returnKeyType="next"
                editable={!loading}
              />
            </View>

            {/* ── Abschnitt: Passwort ── */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>PASSWORT</Text>
              <View style={styles.fields}>
                <PasswordInput
                  label="Passwort"
                  placeholder="Mindestens 6 Zeichen"
                  value={password}
                  onChangeText={(t) => { setPassword(t); setPasswordError(""); clearError(); }}
                  error={passwordError}
                  autoComplete="password-new"
                  returnKeyType="next"
                  editable={!loading}
                />
                <PasswordInput
                  label="Passwort bestätigen"
                  placeholder="Passwort wiederholen"
                  value={passwordConf}
                  onChangeText={(t) => { setPasswordConf(t); setPasswordConfError(""); clearError(); }}
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
                💡 Mitarbeiter werden später vom Admin per Einladung hinzugefügt.
              </Text>
            </View>

            {/* ── Register-Button ── */}
            <TouchableOpacity
              style={[styles.registerBtn, loading && styles.registerBtnDisabled]}
              onPress={handleRegister}
              disabled={loading}
              activeOpacity={0.82}
            >
              <Text style={styles.registerBtnText}>
                {loading ? "Konto wird erstellt..." : "Firma erstellen"}
              </Text>
            </TouchableOpacity>

            {/* ── Login-Link ── */}
            <TouchableOpacity
              onPress={() => router.replace("/login")}
              activeOpacity={0.75}
              style={styles.loginRow}
              disabled={loading}
            >
              <Text style={styles.loginText}>Bereits ein Konto?{" "}</Text>
              <Text style={styles.loginLink}>Anmelden</Text>
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
    sectionLabel: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.widest,
    },
    fields: { gap: theme.spacing.md },

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
