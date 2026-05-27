// features/auth/SetupCompanyScreen.tsx
// Redesign: useAppTheme(), Inter-Font, Onboarding-Gefühl.
// setupCompanyForAdmin()-Logik bleibt vollständig unverändert.

import { ErrorBanner, Input } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { setupCompanyForAdmin } from "@/services/company/setupCompanyForAdmin";
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

export function SetupCompanyScreen() {
  const theme  = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { refreshProfile } = useAuth();

  const [companyName, setCompanyName] = useState("");
  const [nameError,   setNameError]   = useState("");
  const [formError,   setFormError]   = useState("");
  const [loading,     setLoading]     = useState(false);

  // ── Abschicken (unveränderte Logik)
  async function handleSubmit() {
    setNameError("");
    setFormError("");

    if (!companyName.trim()) {
      setNameError("Bitte gib einen Firmennamen ein.");
      return;
    }

    try {
      setLoading(true);
      await setupCompanyForAdmin(companyName);
      await refreshProfile();
      // Erfolgreich → index.tsx übernimmt Weiterleitung
      router.replace("/");
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : "Firma konnte nicht erstellt werden."
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
          {/* ── Schritt-Indikator ── */}
          <View style={styles.stepRow}>
            <View style={[styles.step, styles.stepDone]}>
              <Ionicons name="checkmark" size={12} color={theme.colors.onPrimaryContainer} />
            </View>
            <View style={styles.stepLine} />
            <View style={[styles.step, styles.stepActive]}>
              <Text style={styles.stepActiveText}>2</Text>
            </View>
          </View>
          <Text style={styles.stepHint}>Schritt 2 von 2 — Firma einrichten</Text>

          {/* ── Icon + Texte ── */}
          <View style={styles.heroArea}>
            <View style={styles.iconWrap}>
              <Ionicons name="business-outline" size={30} color={theme.colors.onPrimaryContainer} />
            </View>
            <Text style={styles.title}>Firma einrichten</Text>
            <Text style={styles.subtitle}>
              Gib den Namen deiner Reinigungsfirma ein. Dein Account wird danach als Admin eingerichtet.
            </Text>
          </View>

          {/* ── Formular ── */}
          <View style={styles.card}>
            {formError ? (
              <ErrorBanner message={formError} onDismiss={() => setFormError("")} />
            ) : null}

            <Input
              label="Firmenname"
              placeholder="z.B. Mustermann Reinigung GmbH"
              value={companyName}
              onChangeText={(t) => {
                setCompanyName(t);
                setNameError("");
                setFormError("");
              }}
              error={nameError}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
              editable={!loading}
              autoFocus
            />

            {/* Info-Zeile */}
            <View style={styles.infoRow}>
              <Ionicons name="information-circle-outline" size={14} color={theme.colors.outline} />
              <Text style={styles.infoText}>
                Der Firmenname kann später in den Einstellungen geändert werden.
              </Text>
            </View>

            {/* Weiter-Button */}
            <TouchableOpacity
              style={[styles.continueBtn, loading && styles.continueBtnDisabled]}
              onPress={handleSubmit}
              disabled={loading}
              activeOpacity={0.82}
            >
              <Text style={styles.continueBtnText}>
                {loading ? "Wird eingerichtet..." : "Firma erstellen & weiter"}
              </Text>
              {!loading && (
                <Ionicons
                  name="arrow-forward"
                  size={18}
                  color={theme.colors.onPrimaryContainer}
                />
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
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    flex: { flex: 1 },
    scroll: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.gutter,
      paddingVertical: theme.spacing.xl,
      gap: theme.spacing.lg,
    },

    // Schritt-Indikator
    stepRow: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "center",
      gap: 0,
    },
    step: {
      width: 28,
      height: 28,
      borderRadius: theme.radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    stepDone: {
      backgroundColor: theme.colors.statusCompleted,
    },
    stepActive: {
      backgroundColor: theme.colors.primaryContainer,
    },
    stepActiveText: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onPrimaryContainer,
    },
    stepLine: {
      width: 40,
      height: 2,
      backgroundColor: theme.colors.outlineVariant,
    },
    stepHint: {
      textAlign: "center",
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
      marginTop: 6,
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

    // Info-Zeile
    infoRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
    },
    infoText: {
      flex: 1,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
      lineHeight: theme.typography.lineHeight.xs,
    },

    // Weiter-Button
    continueBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
      paddingVertical: 14,
    },
    continueBtnDisabled: { opacity: 0.5 },
    continueBtnText: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onPrimaryContainer,
    },
  });
}
