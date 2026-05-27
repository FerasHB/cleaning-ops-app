// app/profile.tsx
// Profil-Screen mit Avatar, Rolle und Logout.
// Vollständig auf useAppTheme() migriert — Light + Dark Mode.
// Business-Logik (signOut via AuthContext) unverändert.

import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo } from "react";
import {
  Alert,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";

export default function ProfileScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { user, role, signOut } = useAuth();

  const email = user?.email ?? "Keine E-Mail";

  // ── Logout (unveränderte Logik)
  const handleLogout = async () => {
    try {
      await signOut();
      router.replace("/");
    } catch {
      Alert.alert("Fehler", "Logout fehlgeschlagen.");
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      <View style={styles.content}>
        {/* ── Zurück-Button ── */}
        <TouchableOpacity
          style={styles.backButton}
          activeOpacity={0.8}
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
              return;
            }
            router.replace("/home");
          }}
        >
          <Ionicons
            name="chevron-back"
            size={18}
            color={theme.colors.onSurface}
          />
          <Text style={styles.backButtonText}>Zurück</Text>
        </TouchableOpacity>

        {/* ── Avatar ── */}
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {email.charAt(0).toUpperCase()}
          </Text>
        </View>

        {/* ── E-Mail ── */}
        <Text style={styles.name}>{email}</Text>

        {/* ── Role-Badge ── */}
        <View style={styles.roleBadge}>
          <View style={styles.roleDot} />
          <Text style={styles.roleText}>
            {role === "admin" ? "Admin" : "Mitarbeiter"}
          </Text>
        </View>

        {/* ── Logout-Button (destructive) ── */}
        <TouchableOpacity
          style={styles.logoutButton}
          activeOpacity={0.8}
          onPress={handleLogout}
        >
          <Ionicons
            name="log-out-outline"
            size={18}
            color={theme.colors.error}
            style={{ marginRight: 8 }}
          />
          <Text style={styles.logoutButtonText}>Abmelden</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      flex: 1,
      alignItems: "center",
      padding: theme.spacing.xl,
      paddingTop: theme.spacing.xxl,
    },

    // ── Zurück-Button (oben links)
    backButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      alignSelf: "flex-start",
      marginBottom: theme.spacing.xxl,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 8,
    },
    backButtonText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },

    // ── Avatar
    avatar: {
      width: 92,
      height: 92,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusInProgressBg,
      borderWidth: 1,
      borderColor: theme.colors.statusInProgressBorder,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: {
      fontSize: 34,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.statusInProgress,
    },

    // ── Name / E-Mail
    name: {
      marginTop: theme.spacing.lg,
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },

    // ── Rolle-Badge
    roleBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: theme.spacing.md,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 6,
    },
    roleDot: {
      width: 6,
      height: 6,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusCompleted,
    },
    roleText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },

    // ── Logout-Button (destructive)
    logoutButton: {
      flexDirection: "row",
      marginTop: theme.spacing.xxl,
      width: "100%",
      backgroundColor: theme.colors.errorContainer,
      borderWidth: 1,
      borderColor: theme.colors.error,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: "center",
      justifyContent: "center",
      minHeight: theme.spacing.tapTarget,
    },
    logoutButtonText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.error,
    },
  });
}
