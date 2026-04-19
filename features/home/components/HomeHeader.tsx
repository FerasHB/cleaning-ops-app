// features/home/components/HomeHeader.tsx
import { Colors, Radius, Spacing, Typography } from "@/constants/theme";
import { router } from "expo-router";
import React from "react";
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type HomeHeaderProps = {
  firstName: string;
  role: "admin" | "employee" | null;
  onLogout: () => void;
  headerAnim: {
    opacity: Animated.Value;
    transform: { translateY: Animated.Value }[];
  };
};

export default function HomeHeader({
  firstName,
  role,
  onLogout,
  headerAnim,
}: HomeHeaderProps) {
  return (
    <Animated.View style={[styles.header, headerAnim]}>
      <View style={styles.headerLeft}>
        <View style={styles.greetingRow}>
          <View style={styles.onlineDot} />
          <Text style={styles.greetingHint}>Willkommen zurück</Text>
        </View>

        <Text style={styles.greeting}>{firstName} 👋</Text>
        <Text style={styles.subtitle}>Hier ist dein aktueller Überblick</Text>
      </View>

      <View style={styles.headerActions}>
        {role === "admin" && (
          <TouchableOpacity
            onPress={() => router.push("/admin")}
            style={styles.adminBtn}
            activeOpacity={0.75}
          >
            <Text style={styles.adminBtnText}>Admin</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          onPress={onLogout}
          style={styles.avatar}
          activeOpacity={0.75}
        >
          <Text style={styles.avatarText}>
            {firstName.charAt(0).toUpperCase()}
          </Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingTop: Spacing.xl,
    marginBottom: Spacing.xxl,
  },
  headerLeft: {
    flex: 1,
    gap: 4,
  },
  greetingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 2,
  },
  onlineDot: {
    width: 6,
    height: 6,
    borderRadius: Radius.full,
    backgroundColor: Colors.status.success,
  },
  greetingHint: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
    fontWeight: Typography.weight.medium,
    letterSpacing: Typography.tracking.wide,
  },
  greeting: {
    fontSize: Typography.size.xxl,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    letterSpacing: Typography.tracking.tight,
    lineHeight: Typography.size.xxl * Typography.leading.tight,
  },
  subtitle: {
    fontSize: Typography.size.sm,
    color: Colors.text.muted,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginTop: 4,
  },
  adminBtn: {
    backgroundColor: Colors.accent.muted,
    borderWidth: 1,
    borderColor: Colors.accent.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: 7,
    borderRadius: Radius.full,
  },
  adminBtnText: {
    fontSize: Typography.size.xs,
    fontWeight: Typography.weight.semibold,
    color: Colors.accent.text,
    letterSpacing: Typography.tracking.wide,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: Radius.full,
    backgroundColor: Colors.bg.elevated,
    borderWidth: 1,
    borderColor: Colors.border.strong,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: Typography.size.base,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
  },
});
