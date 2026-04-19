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

  const logoAnim = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.95)).current;
  const formAnim = useRef(new Animated.Value(0)).current;
  const formSlide = useRef(new Animated.Value(20)).current;

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
        bounciness: 6,
      }),
    ]).start();

    Animated.parallel([
      Animated.timing(formAnim, {
        toValue: 1,
        duration: 400,
        delay: 120,
        useNativeDriver: true,
      }),
      Animated.timing(formSlide, {
        toValue: 0,
        duration: 350,
        delay: 120,
        useNativeDriver: true,
      }),
    ]).start();
  }, [formAnim, formSlide, logoAnim, logoScale]);

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
        setFormError("E-Mail oder Passwort ist falsch.");
      }
    } catch {
      setFormError("Login fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar barStyle="dark-content" />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View
            style={[
              styles.brandArea,
              { opacity: logoAnim, transform: [{ scale: logoScale }] },
            ]}
          >
            <View style={styles.logoMark}>
              <Text style={styles.logoLetter}>J</Text>
            </View>

            <View style={styles.brandText}>
              <Text style={styles.brandName}>JobManager</Text>
              <Text style={styles.brandTagline}>
                Professionelles Job-Management
              </Text>
            </View>
          </Animated.View>

          <Animated.View
            style={[
              styles.card,
              { opacity: formAnim, transform: [{ translateY: formSlide }] },
            ]}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Anmelden</Text>
              <Text style={styles.cardSubtitle}>
                Für autorisierte Mitarbeiter
              </Text>
            </View>

            {formError ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorBannerText}>{formError}</Text>
              </View>
            ) : null}

            <View style={styles.fields}>
              <Input
                label="E-Mail"
                placeholder="name@firma.de"
                value={email}
                onChangeText={(text: string) => {
                  setEmail(text);
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
                onChangeText={(text: string) => {
                  setPassword(text);
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

            <TouchableOpacity
              onPress={handleLogin}
              disabled={loading}
              activeOpacity={0.85}
              style={[styles.loginBtn, loading && styles.loginBtnDisabled]}
            >
              <Text style={styles.loginBtnText}>
                {loading ? "Anmelden..." : "Anmelden"}
              </Text>
            </TouchableOpacity>
          </Animated.View>

          <Animated.View style={[styles.footer, { opacity: formAnim }]}>
            <Text style={styles.footerText}>
              Nur für autorisierte Mitarbeiter
            </Text>
          </Animated.View>
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
  flex: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xxl,
    gap: Spacing.xl,
  },

  brandArea: {
    alignItems: "center",
    gap: Spacing.md,
  },
  logoMark: {
    width: 72,
    height: 72,
    borderRadius: Radius.lg,
    backgroundColor: Colors.accent.default,
    alignItems: "center",
    justifyContent: "center",
    ...Shadows.md,
  },
  logoLetter: {
    fontSize: Typography.size.xxl,
    fontWeight: Typography.weight.extrabold,
    color: Colors.white,
  },
  brandText: {
    alignItems: "center",
    gap: Spacing.xs,
  },
  brandName: {
    fontSize: Typography.size.xl,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
  },
  brandTagline: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
  },

  card: {
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border.default,
    padding: Spacing.xl,
    gap: Spacing.lg,
    ...Shadows.lg,
  },
  cardHeader: {
    gap: Spacing.xs,
  },
  cardTitle: {
    fontSize: Typography.size.lg,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
  },
  cardSubtitle: {
    fontSize: Typography.size.sm,
    color: Colors.text.muted,
  },

  errorBanner: {
    backgroundColor: Colors.status.dangerBg,
    borderWidth: 1,
    borderColor: Colors.status.danger,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  errorBannerText: {
    fontSize: Typography.size.sm,
    color: Colors.status.danger,
    fontWeight: Typography.weight.medium,
  },

  fields: {
    gap: Spacing.md,
  },

  loginBtn: {
    backgroundColor: Colors.accent.default,
    paddingVertical: 14,
    borderRadius: Radius.md,
    alignItems: "center",
    ...Shadows.md,
  },
  loginBtnDisabled: {
    opacity: 0.6,
  },
  loginBtnText: {
    fontSize: Typography.size.base,
    fontWeight: Typography.weight.semibold,
    color: Colors.white,
  },

  footer: {
    alignItems: "center",
  },
  footerText: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
    textAlign: "center",
  },
});
