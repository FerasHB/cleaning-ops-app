// components/ui/index.tsx
// Wiederverwendbare Basis-Komponenten für die gesamte App
// Importiere immer von hier – nicht direkt aus RN

import { Colors, Radius, Spacing, Typography } from "@/constants/theme";
import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  TouchableOpacityProps,
  View,
  ViewStyle,
} from "react-native";

// ─────────────────────────────────────────────
// PrimaryButton
// ─────────────────────────────────────────────
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends TouchableOpacityProps {
  label: string;
  loading?: boolean;
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

export function Button({
  label,
  loading = false,
  variant = "primary",
  fullWidth = true,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <TouchableOpacity
      style={[
        styles.btn,
        styles[`btn_${variant}`],
        fullWidth && styles.btnFull,
        isDisabled && styles.btnDisabled,
        style as ViewStyle,
      ]}
      disabled={isDisabled}
      activeOpacity={0.75}
      {...props}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === "primary" ? Colors.white : Colors.accent.default}
        />
      ) : (
        <Text style={[styles.btnText, styles[`btnText_${variant}`]]}>
          {label}
        </Text>
      )}
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────
interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
}

export function Input({ label, error, style, ...props }: InputProps) {
  return (
    <View style={styles.inputWrapper}>
      {label && <Text style={styles.inputLabel}>{label}</Text>}
      <TextInput
        style={[styles.input, error && styles.inputError, style as any]}
        placeholderTextColor={Colors.text.muted}
        {...props}
      />
      {error && <Text style={styles.errorText}>{error}</Text>}
    </View>
  );
}

// ─────────────────────────────────────────────
// Badge – Status-Anzeige (z.B. "Offen", "In Arbeit")
// ─────────────────────────────────────────────
type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";

interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
}

export function Badge({ label, variant = "default" }: BadgeProps) {
  return (
    <View style={[styles.badge, styles[`badge_${variant}`]]}>
      <Text style={[styles.badgeText, styles[`badgeText_${variant}`]]}>
        {label}
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────
// Card – Container für Inhalts-Abschnitte
// ─────────────────────────────────────────────
interface CardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  padding?: number;
}

export function Card({ children, style, padding = Spacing.lg }: CardProps) {
  return <View style={[styles.card, { padding }, style]}>{children}</View>;
}

// ─────────────────────────────────────────────
// SectionHeader – Abschnitts-Titel
// ─────────────────────────────────────────────
interface SectionHeaderProps {
  title: string;
  subtitle?: string;
}

export function SectionHeader({ title, subtitle }: SectionHeaderProps) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
    </View>
  );
}

// ─────────────────────────────────────────────
// Divider
// ─────────────────────────────────────────────
export function Divider({ style }: { style?: ViewStyle }) {
  return <View style={[styles.divider, style]} />;
}

// ─────────────────────────────────────────────
// EmptyState – wenn eine Liste leer ist
// ─────────────────────────────────────────────
interface EmptyStateProps {
  title: string;
  message?: string;
}

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <Text style={styles.emptyIconText}>📋</Text>
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {message && <Text style={styles.emptyMessage}>{message}</Text>}
    </View>
  );
}

// ─────────────────────────────────────────────
// LoadingScreen – Vollbild-Ladescreen
// ─────────────────────────────────────────────
export function LoadingScreen() {
  return (
    <View style={styles.loadingScreen}>
      <ActivityIndicator size="large" color={Colors.accent.default} />
    </View>
  );
}

// ─────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────
const styles = StyleSheet.create({
  // Button
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: Spacing.xl,
    borderRadius: Radius.md,
    minHeight: 50,
    gap: 8,
  },
  btnFull: { width: "100%" },
  btn_primary: { backgroundColor: Colors.accent.default },
  btn_secondary: {
    backgroundColor: Colors.bg.elevated,
    borderWidth: 1,
    borderColor: Colors.border.default,
  },
  btn_ghost: { backgroundColor: Colors.transparent },
  btn_danger: { backgroundColor: Colors.status.dangerBg },
  btnDisabled: { opacity: 0.5 },

  btnText: {
    fontSize: Typography.size.base,
    fontWeight: Typography.weight.semibold,
    letterSpacing: 0.2,
  },
  btnText_primary: { color: Colors.white },
  btnText_secondary: { color: Colors.text.primary },
  btnText_ghost: { color: Colors.accent.default },
  btnText_danger: { color: Colors.status.danger },

  // Input
  inputWrapper: { gap: 6, marginBottom: Spacing.md },
  inputLabel: {
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.medium,
    color: Colors.text.secondary,
    letterSpacing: 0.3,
  },
  input: {
    backgroundColor: Colors.bg.surface,
    color: Colors.text.primary,
    fontSize: Typography.size.base,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border.subtle,
    minHeight: 50,
  },
  inputError: { borderColor: Colors.status.danger },
  errorText: {
    fontSize: Typography.size.xs,
    color: Colors.status.danger,
    marginTop: 2,
  },

  // Badge
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
    alignSelf: "flex-start",
  },
  badge_default: { backgroundColor: Colors.bg.elevated },
  badge_success: { backgroundColor: Colors.status.successBg },
  badge_warning: { backgroundColor: Colors.status.warningBg },
  badge_danger: { backgroundColor: Colors.status.dangerBg },
  badge_info: { backgroundColor: Colors.accent.subtle },

  badgeText: {
    fontSize: Typography.size.xs,
    fontWeight: Typography.weight.semibold,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  badgeText_default: { color: Colors.text.secondary },
  badgeText_success: { color: Colors.status.success },
  badgeText_warning: { color: Colors.status.warning },
  badgeText_danger: { color: Colors.status.danger },
  badgeText_info: { color: Colors.accent.text },

  // Card
  card: {
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border.default,
  },

  // SectionHeader
  sectionHeader: { marginBottom: Spacing.lg, gap: 4 },
  sectionTitle: {
    fontSize: Typography.size.xl,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    letterSpacing: -0.3,
  },
  sectionSubtitle: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
  },

  // Divider
  divider: {
    height: 1,
    backgroundColor: Colors.border.subtle,
    marginVertical: Spacing.lg,
  },

  // EmptyState
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: Spacing.xxxl * 2,
    gap: Spacing.sm,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: Radius.lg,
    backgroundColor: Colors.bg.elevated,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.sm,
  },
  emptyIconText: { fontSize: 24 },
  emptyTitle: {
    fontSize: Typography.size.md,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
  },
  emptyMessage: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
    textAlign: "center",
    maxWidth: 240,
  },

  // LoadingScreen
  loadingScreen: {
    flex: 1,
    backgroundColor: Colors.bg.base,
    alignItems: "center",
    justifyContent: "center",
  },
});
