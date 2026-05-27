// features/auth/WelcomeScreen.tsx
// Erster Screen, den neue Nutzer sehen. Führt zu Login oder Registrierung.

import { AuthBrand } from "@/features/auth/components/AuthBrand";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";

// Feature-Punkte die auf dem Welcome Screen angezeigt werden
const FEATURES = [
  { icon: "briefcase-outline" as const,  text: "Jobs erstellen & zuweisen" },
  { icon: "phone-portrait-outline" as const, text: "Echtzeit-Updates für Mitarbeiter" },
  { icon: "cloud-outline" as const,      text: "Offline-fähig für den Außendienst" },
];

export default function WelcomeScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  // Einmal-Fade-in Animation
  const opacity    = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity,    { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 420, useNativeDriver: true }),
    ]).start();
  }, [opacity, translateY]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      <Animated.View style={[styles.content, { opacity, transform: [{ translateY }] }]}>
        {/* ── Oberer Bereich: Branding ── */}
        <View style={styles.top}>
          <AuthBrand tagline="Field Service, simplified." iconSize={32} />

          {/* Feature-Liste */}
          <View style={styles.featureList}>
            {FEATURES.map((f) => (
              <View key={f.text} style={styles.featureRow}>
                <View style={styles.featureIconWrap}>
                  <Ionicons name={f.icon} size={16} color={theme.colors.primary} />
                </View>
                <Text style={styles.featureText}>{f.text}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* ── Unterer Bereich: Aktionen ── */}
        <View style={styles.actions}>
          {/* Primär: Firma registrieren */}
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.push("/register")}
            activeOpacity={0.82}
          >
            <Text style={styles.primaryBtnText}>Firma registrieren</Text>
            <Ionicons
              name="arrow-forward"
              size={18}
              color={theme.colors.onPrimaryContainer}
            />
          </TouchableOpacity>

          {/* Sekundär: Bereits angemeldet */}
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => router.push("/login")}
            activeOpacity={0.75}
          >
            <Text style={styles.secondaryBtnText}>Ich habe bereits ein Konto</Text>
          </TouchableOpacity>

          {/* Hinweis-Text */}
          <Text style={styles.hint}>
            Nur für Unternehmer und autorisierte Firmeninhaber
          </Text>
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      flex: 1,
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.gutter,
      paddingTop: theme.spacing.xxl,
      paddingBottom: theme.spacing.lg,
    },

    // ── Oberer Bereich
    top: {
      gap: theme.spacing.xl,
      alignItems: "center",
    },

    // Feature-Liste
    featureList: {
      width: "100%",
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      gap: 2,
    },
    featureRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      paddingVertical: 10,
    },
    featureIconWrap: {
      width: 32,
      height: 32,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.surfaceContainerHigh,
      alignItems: "center",
      justifyContent: "center",
    },
    featureText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
      flex: 1,
    },

    // ── Unterer Bereich: Buttons
    actions: {
      gap: theme.spacing.sm,
    },
    primaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
      paddingVertical: 14,
      paddingHorizontal: theme.spacing.xl,
    },
    primaryBtnText: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onPrimaryContainer,
    },

    secondaryBtn: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: theme.spacing.tapTarget,
      borderRadius: theme.radius.md,
      borderWidth: 1.5,
      borderColor: theme.colors.outlineVariant,
      paddingVertical: 13,
    },
    secondaryBtnText: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurfaceVariant,
    },

    hint: {
      textAlign: "center",
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
      marginTop: theme.spacing.xs,
    },
  });
}
