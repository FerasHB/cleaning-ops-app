// screens/LoginScreen.tsx
import { Button, Input } from "@/components/ui";
import { Colors, Radius, Spacing, Typography } from "@/constants/theme";
import { supabase } from "@/lib/supabase";
import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // Inline-Fehlermeldungen statt Alert → bessere UX
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [formError, setFormError] = useState("");

  // Validierung vor dem Login
  const validate = () => {
    let valid = true;
    setEmailError("");
    setPasswordError("");
    setFormError("");

    if (!email.trim()) {
      setEmailError("E-Mail ist erforderlich.");
      valid = false;
    }
    if (!password) {
      setPasswordError("Passwort ist erforderlich.");
      valid = false;
    }
    return valid;
  };

  const handleLogin = async () => {
    if (!validate()) return;

    try {
      setLoading(true);
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        // Supabase gibt englische Fehler zurück – wir zeigen eine deutsche Meldung
        setFormError("E-Mail oder Passwort ist falsch.");
      }
    } catch {
      setFormError(
        "Login konnte nicht durchgeführt werden. Bitte versuche es erneut.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar barStyle="light-content" />

      {/*
        KeyboardAvoidingView: verhindert, dass die Tastatur
        die Eingabefelder verdeckt
      */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Logo / App-Branding-Bereich */}
          <View style={styles.brandArea}>
            <View style={styles.logoMark}>
              {/* Buchstaben-Logo – einfach austauschbar gegen ein echtes Icon */}
              <Text style={styles.logoText}>J</Text>
            </View>
            <Text style={styles.brandName}>JobManager</Text>
            <Text style={styles.brandTagline}>Anmelden um fortzufahren</Text>
          </View>

          {/* Formular-Bereich */}
          <View style={styles.form}>
            {/* Allgemeiner Fehler (z.B. falsche Credentials) */}
            {formError ? (
              <View style={styles.formErrorBox}>
                <Text style={styles.formErrorText}>{formError}</Text>
              </View>
            ) : null}

            <Input
              label="E-Mail"
              placeholder="name@firma.de"
              value={email}
              onChangeText={(t: string) => {
                setEmail(t);
                setEmailError(""); // Fehler beim Tippen zurücksetzen
                setFormError("");
              }}
              error={emailError}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              returnKeyType="next"
            />

            <Input
              label="Passwort"
              placeholder="••••••••"
              value={password}
              onChangeText={(t: string) => {
                setPassword(t);
                setPasswordError(""); // Fehler beim Tippen zurücksetzen
                setFormError("");
              }}
              error={passwordError}
              secureTextEntry
              autoComplete="password"
              returnKeyType="done"
              onSubmitEditing={handleLogin}
            />

            <Button
              label="Einloggen"
              loading={loading}
              onPress={handleLogin}
              style={styles.submitButton}
            />
          </View>

          {/* Footer-Hinweis */}
          <Text style={styles.footer}>Nur für autorisierte Mitarbeiter</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg.base,
  },
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: Spacing.xxl,
    paddingVertical: Spacing.xxxl,
  },

  // Branding
  brandArea: {
    alignItems: "center",
    marginBottom: 48,
    gap: Spacing.sm,
  },
  logoMark: {
    width: 64,
    height: 64,
    borderRadius: Radius.lg,
    backgroundColor: Colors.accent.default,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.sm,
  },
  logoText: {
    fontSize: 28,
    fontWeight: Typography.weight.bold,
    color: Colors.white,
    letterSpacing: -0.5,
  },
  brandName: {
    fontSize: Typography.size.xl,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    letterSpacing: -0.3,
  },
  brandTagline: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
  },

  // Formular
  form: {
    gap: 4, // Inputs haben intern marginBottom, daher kleiner gap
    marginBottom: Spacing.xl,
  },
  formErrorBox: {
    backgroundColor: Colors.status.dangerBg,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    marginBottom: Spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.status.danger,
  },
  formErrorText: {
    fontSize: Typography.size.sm,
    color: Colors.status.danger,
    fontWeight: Typography.weight.medium,
  },
  submitButton: {
    marginTop: Spacing.sm,
  },

  // Footer
  footer: {
    textAlign: "center",
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
  },
});
