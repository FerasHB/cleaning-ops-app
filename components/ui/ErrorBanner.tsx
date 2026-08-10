// components/ui/ErrorBanner.tsx
// ─────────────────────────────────────────────────────────────────
// Dismissbares Fehler-Banner für Formular- und API-Fehler.
// Ersetzt das System-Alert für nicht-kritische Fehlermeldungen.
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

interface ErrorBannerProps {
  message: string;
  /** Callback zum Schließen — wenn nicht gesetzt, kein X-Button */
  onDismiss?: () => void;
  /** Banner-Typ: error (rot) oder warning (orange) */
  type?: "error" | "warning";
  /**
   * Optionale Wiederholen-Aktion. Nur zusammen mit `actionLabel` sichtbar.
   * Gedacht für Teil-Fehler, bei denen der Rest des Screens nutzbar bleibt
   * (z. B. fehlgeschlagene KPI-Abfrage im Admin-Dashboard) — dort wäre ein
   * Vollbild-Fehlerscreen falsch, aber ohne Retry säße der Nutzer fest.
   */
  onAction?: () => void;
  /** Beschriftung der Aktion, z. B. "Erneut versuchen". */
  actionLabel?: string;
}

export function ErrorBanner({
  message,
  onDismiss,
  type = "error",
  onAction,
  actionLabel,
}: ErrorBannerProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme, type), [theme, type]);

  const iconName =
    type === "warning" ? "warning-outline" : "alert-circle-outline";
  const iconColor =
    type === "warning" ? theme.colors.statusOpen : theme.colors.error;

  return (
    <View style={styles.banner}>
      <Ionicons name={iconName} size={16} color={iconColor} style={styles.icon} />
      <View style={styles.body}>
        <Text style={styles.message} numberOfLines={3}>
          {message}
        </Text>
        {onAction && actionLabel ? (
          <TouchableOpacity
            onPress={onAction}
            activeOpacity={0.7}
            style={styles.action}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="refresh" size={14} color={iconColor} />
            <Text style={styles.actionText}>{actionLabel}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {onDismiss && (
        <TouchableOpacity
          onPress={onDismiss}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="close" size={16} color={iconColor} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function createStyles(
  theme: ReturnType<typeof useAppTheme>,
  type: "error" | "warning"
) {
  const isError = type === "error";
  const bgColor = isError ? theme.colors.errorContainer : theme.colors.statusOpenBg;
  const borderColor = isError ? theme.colors.error : theme.colors.statusOpenBorder;
  const textColor = isError ? theme.colors.error : theme.colors.statusOpen;

  return StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.sm,
      backgroundColor: bgColor,
      borderWidth: 1,
      borderColor: borderColor,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 10,
    },
    icon: {
      marginTop: 1,
    },
    body: {
      flex: 1,
      gap: 6,
    },
    action: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      alignSelf: "flex-start",
    },
    actionText: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: textColor,
      textDecorationLine: "underline",
    },
    message: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.medium,
      fontFamily: theme.typography.family.medium,
      color: textColor,
      lineHeight: theme.typography.lineHeight.sm,
    },
  });
}
