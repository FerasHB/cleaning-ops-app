// components/ui/index.tsx
// ─────────────────────────────────────────────────────────────────
// Zentraler Export-Punkt für alle UI-Komponenten.
// Importiere immer von hier: import { Button, Card, ... } from '@/components/ui'
//
// Bestehende Komponenten wurden auf useAppTheme() umgestellt →
// unterstützen automatisch Light- und Dark-Mode.
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  TouchableOpacityProps,
  View,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppTheme } from "@/constants/theme";
// TEMP Diagnose (offline-debug-3) — nach Verifikation entfernbar.
import NetInfo from "@react-native-community/netinfo";
import { BUILD_MARKER, useBootstrapDiag } from "@/utils/bootstrapDiag";

// ─────────────────────────────────────────────
// Re-Exports: Neue Komponenten aus eigenen Dateien
// ─────────────────────────────────────────────
export { ScreenContainer } from "./ScreenContainer";
export { AppHeader } from "./AppHeader";
export { StatusBadge } from "./StatusBadge";
export { SkeletonCard } from "./SkeletonCard";
export { OfflineBanner, SaveStatusBadge } from "./OfflineBanner";
export { ErrorBanner } from "./ErrorBanner";
export { InitialsAvatar } from "./InitialsAvatar";
export { InfoRow } from "./InfoRow";
export { KPICard } from "./KPICard";
export type { JobStatus } from "./StatusBadge";

// ─────────────────────────────────────────────
// Button
// ─────────────────────────────────────────────
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends TouchableOpacityProps {
  label: string;
  loading?: boolean;
  variant?: ButtonVariant;
  fullWidth?: boolean;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
}

export function Button({
  label,
  loading = false,
  variant = "primary",
  fullWidth = true,
  disabled,
  style,
  icon,
  ...props
}: ButtonProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createButtonStyles(theme), [theme]);
  const isDisabled = disabled || loading;

  const spinnerColor =
    variant === "primary" || variant === "danger"
      ? theme.colors.onPrimary
      : theme.colors.primary;

  // Container-Varianten-Styles explizit auswählen (TypeScript-sicher)
  const variantContainerStyle = {
    primary:   styles.btn_primary,
    secondary: styles.btn_secondary,
    ghost:     styles.btn_ghost,
    danger:    styles.btn_danger,
  }[variant];

  // Text-Varianten-Styles explizit auswählen
  const variantTextStyle = {
    primary:   styles.btnText_primary,
    secondary: styles.btnText_secondary,
    ghost:     styles.btnText_ghost,
    danger:    styles.btnText_danger,
  }[variant];

  return (
    <TouchableOpacity
      style={[
        styles.btn,
        variantContainerStyle,
        fullWidth && styles.btnFull,
        isDisabled && styles.btnDisabled,
        style as ViewStyle,
      ]}
      disabled={isDisabled}
      activeOpacity={0.78}
      {...props}
    >
      {loading ? (
        <ActivityIndicator size="small" color={spinnerColor} />
      ) : (
        <View style={styles.btnInner}>
          {icon && (
            <Ionicons
              name={icon}
              size={16}
              color={
                variant === "primary" || variant === "danger"
                  ? theme.colors.onPrimaryContainer
                  : theme.colors.primary
              }
            />
          )}
          <Text style={[styles.btnText, variantTextStyle]}>{label}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

function createButtonStyles(theme: AppTheme) {
  return StyleSheet.create({
    btn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 13,
      paddingHorizontal: theme.spacing.xl,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
    },
    btnFull: { width: "100%" },
    btnDisabled: { opacity: 0.45 },

    // Varianten
    btn_primary: {
      backgroundColor: theme.colors.primaryContainer,
    },
    btn_secondary: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
    },
    btn_ghost: {
      backgroundColor: theme.colors.transparent,
    },
    btn_danger: {
      backgroundColor: theme.colors.errorContainer,
      borderWidth: 1,
      borderColor: theme.colors.error,
    },

    btnInner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    btnText: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      letterSpacing: theme.typography.letterSpacing.wide,
    },
    btnText_primary: {
      color: theme.colors.onPrimaryContainer,
    },
    btnText_secondary: {
      color: theme.colors.onSurface,
    },
    btnText_ghost: {
      color: theme.colors.primary,
    },
    btnText_danger: {
      color: theme.colors.error,
    },
  });
}

// ─────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────
interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
}

export function Input({ label, error, style, onFocus, onBlur, ...props }: InputProps) {
  const theme = useAppTheme();
  const [focused, setFocused] = useState(false);
  const styles = useMemo(() => createInputStyles(theme), [theme]);

  return (
    <View style={styles.wrapper}>
      {label && <Text style={styles.label}>{label}</Text>}
      <TextInput
        style={[
          styles.input,
          focused && styles.inputFocused,
          error && styles.inputError,
          style as any,
        ]}
        placeholderTextColor={theme.colors.outline}
        // Internen Focus-State behalten UND ein durchgereichtes onFocus/onBlur
        // aufrufen (Spread darf den internen Handler nicht überschreiben).
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        {...props}
      />
      {error && <Text style={styles.errorText}>{error}</Text>}
    </View>
  );
}

// ─────────────────────────────────────────────
// PasswordInput (Input mit Toggle-Sichtbarkeit)
// ─────────────────────────────────────────────
interface PasswordInputProps extends Omit<InputProps, "secureTextEntry"> {
  label?: string;
  error?: string;
}

export function PasswordInput({ label, error, style, ...props }: PasswordInputProps) {
  const theme = useAppTheme();
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const styles = useMemo(() => createInputStyles(theme), [theme]);

  return (
    <View style={styles.wrapper}>
      {label && <Text style={styles.label}>{label}</Text>}
      <View style={styles.passwordRow}>
        <TextInput
          style={[
            styles.input,
            styles.passwordInput,
            focused && styles.inputFocused,
            error && styles.inputError,
            style as any,
          ]}
          placeholderTextColor={theme.colors.outline}
          secureTextEntry={!visible}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          {...props}
        />
        <TouchableOpacity
          onPress={() => setVisible((v) => !v)}
          style={styles.eyeBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons
            name={visible ? "eye-off-outline" : "eye-outline"}
            size={18}
            color={theme.colors.outline}
          />
        </TouchableOpacity>
      </View>
      {error && <Text style={styles.errorText}>{error}</Text>}
    </View>
  );
}

function createInputStyles(theme: AppTheme) {
  return StyleSheet.create({
    wrapper: {
      gap: 6,
    },
    label: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wide,
    },
    input: {
      backgroundColor: theme.colors.background,
      color: theme.colors.onSurface,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.regular,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 13,
      borderRadius: theme.radius.md,
      borderWidth: 1.5,
      borderColor: theme.colors.outlineVariant,
      minHeight: theme.spacing.tapTarget,
    },
    inputFocused: {
      borderColor: theme.colors.primary,
    },
    inputError: {
      borderColor: theme.colors.error,
    },
    errorText: {
      fontSize: theme.typography.size.xs,
      color: theme.colors.error,
      fontFamily: theme.typography.family.regular,
      marginTop: 2,
    },
    // Password spezifisch
    passwordRow: {
      position: "relative",
    },
    passwordInput: {
      paddingRight: 48,
    },
    eyeBtn: {
      position: "absolute",
      right: 14,
      top: 0,
      bottom: 0,
      justifyContent: "center",
    },
  });
}

// ─────────────────────────────────────────────
// Badge (generisch — für nicht-Job-Status Badges)
// Für Job-Status: StatusBadge verwenden
// ─────────────────────────────────────────────
type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";

interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
}

export function Badge({ label, variant = "default" }: BadgeProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBadgeStyles(theme), [theme]);

  const variantBadgeStyle = {
    default: styles.badge_default,
    success: styles.badge_success,
    warning: styles.badge_warning,
    danger:  styles.badge_danger,
    info:    styles.badge_info,
  }[variant];

  const variantTextStyle = {
    default: styles.text_default,
    success: styles.text_success,
    warning: styles.text_warning,
    danger:  styles.text_danger,
    info:    styles.text_info,
  }[variant];

  return (
    <View style={[styles.badge, variantBadgeStyle]}>
      <Text style={[styles.text, variantTextStyle]}>{label}</Text>
    </View>
  );
}

function createBadgeStyles(theme: AppTheme) {
  return StyleSheet.create({
    badge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: theme.radius.full,
      alignSelf: "flex-start",
      borderWidth: 1,
    },
    badge_default: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderColor: theme.colors.outlineVariant,
    },
    badge_success: {
      backgroundColor: theme.colors.statusCompletedBg,
      borderColor: theme.colors.statusCompletedBorder,
    },
    badge_warning: {
      backgroundColor: theme.colors.statusOpenBg,
      borderColor: theme.colors.statusOpenBorder,
    },
    badge_danger: {
      backgroundColor: theme.colors.errorContainer,
      borderColor: theme.colors.error,
    },
    badge_info: {
      backgroundColor: theme.colors.statusInProgressBg,
      borderColor: theme.colors.statusInProgressBorder,
    },
    text: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      letterSpacing: theme.typography.letterSpacing.wide,
      textTransform: "uppercase",
    },
    text_default: { color: theme.colors.onSurfaceVariant },
    text_success: { color: theme.colors.statusCompleted },
    text_warning: { color: theme.colors.statusOpen },
    text_danger:  { color: theme.colors.error },
    text_info:    { color: theme.colors.statusInProgress },
  });
}

// ─────────────────────────────────────────────
// Card
// ─────────────────────────────────────────────
interface CardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  padding?: number;
}

export function Card({ children, style, padding }: CardProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createCardStyles(theme), [theme]);
  const p = padding ?? theme.spacing.md;

  return (
    <View style={[styles.card, { padding: p }, style]}>
      {children}
    </View>
  );
}

function createCardStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      ...theme.shadows.sm,
    },
  });
}

// ─────────────────────────────────────────────
// SectionHeader
// ─────────────────────────────────────────────
interface SectionHeaderProps {
  title: string;
  subtitle?: string;
}

export function SectionHeader({ title, subtitle }: SectionHeaderProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createSectionHeaderStyles(theme), [theme]);

  return (
    <View style={styles.wrapper}>
      <Text style={styles.title}>{title}</Text>
      {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
}

function createSectionHeaderStyles(theme: AppTheme) {
  return StyleSheet.create({
    wrapper: {
      gap: 4,
      marginBottom: theme.spacing.md,
    },
    title: {
      fontSize: theme.typography.size.xl,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    subtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}

// ─────────────────────────────────────────────
// Divider
// ─────────────────────────────────────────────
export function Divider({ style }: { style?: ViewStyle }) {
  const theme = useAppTheme();
  return (
    <View
      style={[
        {
          height: 1,
          backgroundColor: theme.colors.outlineVariant,
          marginVertical: theme.spacing.md,
        },
        style,
      ]}
    />
  );
}

// ─────────────────────────────────────────────
// EmptyState
// ─────────────────────────────────────────────
interface EmptyStateProps {
  title: string;
  message?: string;
  /** Optionaler CTA-Button */
  ctaLabel?: string;
  onCta?: () => void;
  /** Emoji oder Ionicons-Name als Icon */
  icon?: React.ComponentProps<typeof Ionicons>["name"];
}

export function EmptyState({ title, message, ctaLabel, onCta, icon }: EmptyStateProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createEmptyStateStyles(theme), [theme]);

  return (
    <View style={styles.container}>
      <View style={styles.iconWrap}>
        {icon ? (
          <Ionicons name={icon} size={28} color={theme.colors.outline} />
        ) : (
          <Text style={styles.emoji}>📋</Text>
        )}
      </View>
      <Text style={styles.title}>{title}</Text>
      {message && <Text style={styles.message}>{message}</Text>}
      {ctaLabel && onCta && (
        <Button
          label={ctaLabel}
          onPress={onCta}
          fullWidth={false}
          style={{ marginTop: theme.spacing.sm, paddingHorizontal: theme.spacing.xl }}
        />
      )}
    </View>
  );
}

function createEmptyStateStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 64,
      paddingHorizontal: theme.spacing.xl,
      gap: theme.spacing.sm,
    },
    iconWrap: {
      width: 60,
      height: 60,
      borderRadius: theme.radius.lg,
      backgroundColor: theme.colors.surfaceContainerHigh,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.xs,
    },
    emoji: {
      fontSize: 26,
    },
    title: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },
    message: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
      maxWidth: 260,
      lineHeight: theme.typography.lineHeight.sm,
    },
  });
}

// ─────────────────────────────────────────────
// LoadingScreen (Vollbild-Spinner)
// TEMP Diagnose (offline-debug-3): rendert einen SICHTBAREN Debug-Block, damit
// wir auch im Preview-Build (ohne Metro/Console) sehen, welcher State den
// Spinner hält. Nach der Diagnose: `debugName`-Prop + Debug-Block + Store
// wieder entfernen, dann bleibt nur der Spinner.
// ─────────────────────────────────────────────
export function LoadingScreen({ debugName }: { debugName?: string }) {
  const theme = useAppTheme();
  const diag = useBootstrapDiag();

  const [netConnected, setNetConnected] = useState<boolean | null>(null);
  const [netReachable, setNetReachable] = useState<boolean | null>(null);

  useEffect(() => {
    // Live-NetInfo direkt im Spinner — zeigt den echten Zustand im Moment des Hängens.
    NetInfo.fetch().then((s) => {
      setNetConnected(s.isConnected);
      setNetReachable(s.isInternetReachable);
    });
    const unsub = NetInfo.addEventListener((s) => {
      setNetConnected(s.isConnected);
      setNetReachable(s.isInternetReachable);
    });
    return () => unsub();
  }, []);

  const rows: [string, string][] = [
    ["Screen", debugName ?? "(unbenannt)"],
    ["AuthContext.loading", String(diag.authLoading)],
    ["profile vorhanden", diag.hasProfile ? "ja" : "nein"],
    ["role", diag.role],
    ["hasCompany", String(diag.hasCompany)],
    ["index redirect target", diag.indexRedirectTarget],
    ["cache key", diag.cacheKey],
    ["cache version", diag.cacheVersion],
    ["cachedProfile.role", diag.cachedRole],
    ["cachedProfile.company_id", diag.cachedCompany],
    ["remoteProfile.role", diag.remoteRole],
    ["remoteProfile.company_id", diag.remoteCompany],
    ["setProfile #", String(diag.setProfileSequence)],
    ["lastSetProfile source", diag.lastSetProfileSource],
    ["lastSetProfile role", diag.lastSetProfileRole],
    ["lastSetProfile company_id", diag.lastSetProfileCompanyId],
    ["JobContext.loading", String(diag.jobsLoading)],
    ["lokaler loading-State", "kein eigener (== JobContext.loading)"],
    ["jobs.length", String(diag.jobsCount)],
    ["employees.length", String(diag.employeesCount)],
    ["online (JobContext)", String(diag.online)],
    ["NetInfo.isConnected", String(netConnected)],
    ["NetInfo.isInternetReachable", String(netReachable)],
    ["cacheLoadStarted", String(diag.cacheLoadStarted)],
    ["cacheLoadFinished", String(diag.cacheLoadFinished)],
    ["loadingFalseCalled", String(diag.loadingFalseCalled)],
    ["remoteRefreshStarted", String(diag.remoteRefreshStarted)],
    ["letzter Bootstrap-Schritt", diag.lastBootstrapStep],
    [
      "letzter Fehler",
      diag.lastErrorName
        ? `${diag.lastErrorName}: ${diag.lastErrorMessage}`
        : "(keiner)",
    ],
  ];

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.background,
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <ActivityIndicator size="large" color={theme.colors.primary} />

      {/* ── TEMP Debug-Block (offline-debug-3) ── */}
      <ScrollView
        style={{
          marginTop: 20,
          maxHeight: 360,
          alignSelf: "stretch",
          borderWidth: 2,
          borderColor: "#e11d48",
          borderRadius: 10,
          backgroundColor: "#111827",
        }}
        contentContainerStyle={{ padding: 12 }}
      >
        <Text
          style={{
            color: "#f43f5e",
            fontWeight: "700",
            fontSize: 14,
            marginBottom: 8,
          }}
        >
          BUILD_MARKER: {BUILD_MARKER}
        </Text>
        {rows.map(([label, value]) => (
          <View
            key={label}
            style={{ flexDirection: "row", marginBottom: 3, flexWrap: "wrap" }}
          >
            <Text style={{ color: "#93c5fd", fontSize: 12 }}>{label}: </Text>
            <Text
              style={{ color: "#f9fafb", fontSize: 12, fontWeight: "600", flexShrink: 1 }}
            >
              {value}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
