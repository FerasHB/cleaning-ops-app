// features/auth/UpdateRequiredScreen.tsx
// Client-Compatibility-Fundament (20260916120000). Reine UX für Nutzer, die
// bereits vor der eigentlichen Sicherheitsgrenze abgefangen werden — die
// serverseitige enforce_min_client_version()-Prüfung bleibt in jedem Fall
// die Autorität, unabhängig davon, ob dieser Screen je erreicht wird.
//
// Bewusst NICHT abweisbar: kein Zurück-Button, keine Tab-Leiste (liegt
// außerhalb von (admin-tabs)/(employee-tabs)), app/index.tsx leitet über
// isVersionBlocked ausschließlich hierher um, solange die Bedingung gilt.

import { useAuth } from "@/context/AuthContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Linking, StatusBar, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";

export default function UpdateRequiredScreen() {
  const theme = useAppTheme();
  const { updateUrl, signOut } = useAuth();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const handleUpdate = () => {
    if (!updateUrl) return;
    Linking.openURL(updateUrl).catch(() => {
      // Kein Redbox für einen kaputten/veralteten Link — der Nutzer sieht
      // ohnehin schon eine klare Anleitung im Fließtext.
    });
  };

  const handleLogout = () => {
    signOut().catch(() => {
      // Ohnehin nur eine Rückfalloption; ein Fehler hier ist nicht kritisch.
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      <View style={styles.content}>
        <View style={styles.iconWrap}>
          <Ionicons name="cloud-download-outline" size={40} color={theme.colors.primary} />
        </View>

        <Text style={styles.title}>App-Update erforderlich</Text>

        <Text style={styles.message}>
          Diese App-Version wird nicht mehr unterstützt. Bitte aktualisiere die
          App, um fortzufahren.
        </Text>

        {updateUrl ? (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={handleUpdate}
            activeOpacity={0.82}
          >
            <Text style={styles.primaryBtnText}>Jetzt aktualisieren</Text>
            <Ionicons name="open-outline" size={18} color={theme.colors.onPrimaryContainer} />
          </TouchableOpacity>
        ) : (
          <Text style={styles.hint}>
            Bitte suche „TaskOps Manager" im App Store bzw. bei Google Play und
            installiere das neueste Update.
          </Text>
        )}

        <TouchableOpacity style={styles.secondaryBtn} onPress={handleLogout} activeOpacity={0.75}>
          <Text style={styles.secondaryBtnText}>Abmelden</Text>
        </TouchableOpacity>
      </View>
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
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: theme.spacing.xl,
      gap: theme.spacing.md,
    },
    iconWrap: {
      width: 72,
      height: 72,
      borderRadius: theme.radius.lg,
      backgroundColor: theme.colors.surfaceContainerHigh,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.sm,
    },
    title: {
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },
    message: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
      lineHeight: 20,
      maxWidth: 320,
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
      marginTop: theme.spacing.sm,
    },
    primaryBtnText: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onPrimaryContainer,
    },
    hint: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
      textAlign: "center",
      maxWidth: 300,
      marginTop: theme.spacing.sm,
    },
    secondaryBtn: {
      marginTop: theme.spacing.lg,
      paddingVertical: 8,
      paddingHorizontal: theme.spacing.md,
    },
    secondaryBtnText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.outline,
    },
  });
}
