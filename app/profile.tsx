import { Colors, Radius, Spacing, Typography } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { router } from "expo-router";
import React from "react";
import {
  Alert,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export default function ProfileScreen() {
  const { user, role, signOut } = useAuth();

  const email = user?.email ?? "Keine E-Mail";

  const handleLogout = async () => {
    try {
      await signOut();
      router.replace("/");
    } catch (error) {
      Alert.alert("Fehler", "Logout fehlgeschlagen.");
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
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
          <Text style={styles.backButtonText}>← Zurück</Text>
        </TouchableOpacity>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{email.charAt(0).toUpperCase()}</Text>
        </View>

        <Text style={styles.name}>{email}</Text>

        <View style={styles.roleBadge}>
          <Text style={styles.roleText}>
            {role === "admin" ? "Admin" : "Mitarbeiter"}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.logoutButton}
          activeOpacity={0.8}
          onPress={handleLogout}
        >
          <Text style={styles.logoutButtonText}>Abmelden</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg.app,
  },
  content: {
    flex: 1,
    alignItems: "center",
    padding: Spacing.xl,
    paddingTop: 80,
  },
  avatar: {
    width: 92,
    height: 92,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent.subtle,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 34,
    fontWeight: Typography.weight.bold,
    color: Colors.accent.text,
  },
  name: {
    marginTop: Spacing.lg,
    fontSize: Typography.size.lg,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
  },
  roleBadge: {
    marginTop: Spacing.md,
    backgroundColor: Colors.bg.elevated,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
  },
  roleText: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
    fontWeight: Typography.weight.medium,
  },
  logoutButton: {
    marginTop: Spacing.xxl,
    width: "100%",
    backgroundColor: Colors.status.danger,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    alignItems: "center",
  },
  logoutButtonText: {
    fontSize: Typography.size.md,
    fontWeight: Typography.weight.semibold,
    color: Colors.white,
  },
  backButton: {
    alignSelf: "flex-start",
    marginBottom: Spacing.xxl,
    backgroundColor: Colors.bg.surface,
    borderWidth: 1,
    borderColor: Colors.border.default,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
  },
  backButtonText: {
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
  },
});
