// screens/LoginScreen.tsx
import { Input } from "@/components/ui";
import {
  Colors,
  Radius,
  Shadows,
  Spacing,
  Typography,
} from "@/constants/theme";
import { supabase } from "@/lib/supabase";
import React, { useEffect, useRef, useState } from "react";
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

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [formError, setFormError] = useState("");

  // Eingangs-Animationen
  const logoAnim = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.85)).current;
  const formAnim = useRef(new Animated.Value(0)).current;
  const formSlide = useRef(new Animated.Value(24)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(logoAnim, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.spring(logoScale, {
        toValue: 1,
        useNativeDriver: true,
        speed: 12,
        bounciness: 8,
      }),
    ]).start();

    Animated.parallel([
      Animated.timing(formAnim, {
        toValue: 1,
        duration: 440,
        delay: 160,
        useNativeDriver: true,
      }),
      Animated.timing(formSlide, {
        toValue: 0,
        duration: 380,
        delay: 160,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

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
      if (error) setFormError("E-Mail oder Passwort ist falsch.");
    } catch {
      setFormError("Login fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar barStyle="light-content" />

      {/* Dekorative Hintergrund-Kreise */}
      <View style={styles.bgDecor1} />
      <View style={styles.bgDecor2} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ── Logo & Branding ── */}
          <Animated.View
            style={[
              styles.brandArea,
              { opacity: logoAnim, transform: [{ scale: logoScale }] },
            ]}
          >
            <View style={styles.logoContainer}>
              {/* Äußerer Glow-Ring */}
              <View style={styles.logoGlow} />
              <View style={styles.logoMark}>
                <Text style={styles.logoLetter}>J</Text>
              </View>
            </View>

            <View style={styles.brandText}>
              <Text style={styles.brandName}>JobManager</Text>
              <View style={styles.brandTagRow}>
                <View style={styles.brandTagDot} />
                <Text style={styles.brandTagline}>
                  Professionelles Job-Management
                </Text>
              </View>
            </View>
          </Animated.View>

          {/* ── Formular-Karte ── */}
          <Animated.View
            style={[
              styles.card,
              { opacity: formAnim, transform: [{ translateY: formSlide }] },
            ]}
          >
            {/* Karten-Header */}
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Anmelden</Text>
              <Text style={styles.cardSubtitle}>
                Für autorisierte Mitarbeiter
              </Text>
            </View>

            <View style={styles.cardDivider} />

            {/* Fehler-Banner */}
            {formError ? (
              <View style={styles.errorBanner}>
                <View style={styles.errorIcon}>
                  <Text style={styles.errorIconText}>!</Text>
                </View>
                <Text style={styles.errorBannerText}>{formError}</Text>
              </View>
            ) : null}

            {/* Eingabefelder */}
            <View style={styles.fields}>
              <Input
                label="E-Mail"
                placeholder="name@firma.de"
                value={email}
                onChangeText={(t: string) => {
                  setEmail(t);
                  setEmailError("");
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
                  setPasswordError("");
                  setFormError("");
                }}
                error={passwordError}
                secureTextEntry
                autoComplete="password"
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />
            </View>

            {/* Login Button */}
            <TouchableOpacity
              onPress={handleLogin}
              disabled={loading}
              activeOpacity={0.85}
              style={[styles.loginBtn, loading && styles.loginBtnLoading]}
            >
              <Text style={styles.loginBtnText}>
                {loading ? "Anmelden…" : "Anmelden"}
              </Text>
            </TouchableOpacity>
          </Animated.View>

          {/* ── Footer ── */}
          <Animated.View style={[styles.footer, { opacity: formAnim }]}>
            <View style={styles.footerDivider} />
            <Text style={styles.footerText}>
              Nur für autorisierte Mitarbeiter
            </Text>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const DECOR_SIZE = 320;

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg.base,
  },
  flex: { flex: 1 },

  // Dekorative Hintergrundkreise
  bgDecor1: {
    position: "absolute",
    top: -DECOR_SIZE / 2,
    right: -DECOR_SIZE / 3,
    width: DECOR_SIZE,
    height: DECOR_SIZE,
    borderRadius: DECOR_SIZE / 2,
    backgroundColor: Colors.accent.glow,
    // Kein shadow – bleibt flat, nur Farbe
  },
  bgDecor2: {
    position: "absolute",
    bottom: DECOR_SIZE / 4,
    left: -DECOR_SIZE / 2,
    width: DECOR_SIZE * 0.7,
    height: DECOR_SIZE * 0.7,
    borderRadius: DECOR_SIZE / 2,
    backgroundColor: "rgba(99,102,241,0.06)",
  },

  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xxxl,
    gap: Spacing.xxl,
  },

  // Branding
  brandArea: {
    alignItems: "center",
    gap: Spacing.lg,
  },
  logoContainer: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  logoGlow: {
    position: "absolute",
    width: 88,
    height: 88,
    borderRadius: Radius.xl,
    backgroundColor: Colors.accent.glow,
  },
  logoMark: {
    width: 68,
    height: 68,
    borderRadius: Radius.lg,
    backgroundColor: Colors.accent.default,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.accent.border,
    ...Shadows.accent,
  },
  logoLetter: {
    fontSize: 30,
    fontWeight: Typography.weight.extrabold,
    color: Colors.white,
    letterSpacing: -1,
  },
  brandText: {
    alignItems: "center",
    gap: 6,
  },
  brandName: {
    fontSize: Typography.size.xl,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    letterSpacing: Typography.tracking.tight,
  },
  brandTagRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  brandTagDot: {
    width: 5,
    height: 5,
    borderRadius: Radius.full,
    backgroundColor: Colors.status.success,
  },
  brandTagline: {
    fontSize: Typography.size.sm,
    color: Colors.text.muted,
  },

  // Karte
  card: {
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border.default,
    overflow: "hidden",
    ...Shadows.lg,
  },
  cardHeader: {
    paddingHorizontal: Spacing.xxl,
    paddingTop: Spacing.xxl,
    paddingBottom: Spacing.lg,
    gap: 4,
  },
  cardTitle: {
    fontSize: Typography.size.lg,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    letterSpacing: Typography.tracking.tight,
  },
  cardSubtitle: {
    fontSize: Typography.size.sm,
    color: Colors.text.muted,
  },
  cardDivider: {
    height: 1,
    backgroundColor: Colors.border.subtle,
    marginHorizontal: Spacing.xxl,
    marginBottom: Spacing.lg,
  },

  // Fehler
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    backgroundColor: Colors.status.dangerBg,
    borderWidth: 1,
    borderColor: Colors.status.dangerBorder,
    marginHorizontal: Spacing.xxl,
    marginBottom: Spacing.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm,
  },
  errorIcon: {
    width: 18,
    height: 18,
    borderRadius: Radius.full,
    backgroundColor: Colors.status.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  errorIconText: {
    fontSize: 11,
    fontWeight: Typography.weight.bold,
    color: Colors.white,
  },
  errorBannerText: {
    flex: 1,
    fontSize: Typography.size.sm,
    color: Colors.status.danger,
    fontWeight: Typography.weight.medium,
  },

  // Felder
  fields: {
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },

  // Login Button
  loginBtn: {
    marginHorizontal: Spacing.xxl,
    marginBottom: Spacing.xxl,
    backgroundColor: Colors.accent.default,
    paddingVertical: 15,
    borderRadius: Radius.md,
    alignItems: "center",
    ...Shadows.accent,
  },
  loginBtnLoading: {
    opacity: 0.65,
  },
  loginBtnText: {
    fontSize: Typography.size.base,
    fontWeight: Typography.weight.semibold,
    color: Colors.white,
    letterSpacing: Typography.tracking.wide,
  },

  // Footer
  footer: {
    alignItems: "center",
    gap: Spacing.md,
  },
  footerDivider: {
    width: 40,
    height: 1,
    backgroundColor: Colors.border.subtle,
  },
  footerText: {
    fontSize: Typography.size.xs,
    color: Colors.text.placeholder,
    textAlign: "center",
  },
});
