// components/ui/OfflineBanner.tsx
// ─────────────────────────────────────────────────────────────────
// Prominenter Offline-Hinweis für Außendienst-Mitarbeiter.
// Wird oben im Screen angezeigt, wenn keine Verbindung besteht.
// Props-basiert (UI-only) — Logik kommt vom aufrufenden Screen.
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

interface OfflineBannerProps {
  /** Banner anzeigen (false = versteckt) */
  visible: boolean;
  /** Anzahl ausstehender Aktionen in der Sync-Queue */
  pendingCount?: number;
  /** Callback für "Jetzt synchronisieren" */
  onSync?: () => void;
  /** Sync läuft gerade */
  syncing?: boolean;
}

export function OfflineBanner({
  visible,
  pendingCount = 0,
  onSync,
  syncing = false,
}: OfflineBannerProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (!visible) return null;

  const pendingText =
    pendingCount > 0
      ? `${pendingCount} ${pendingCount === 1 ? "Aktion" : "Aktionen"} ausstehend`
      : "Änderungen werden gespeichert";

  return (
    <View style={styles.banner}>
      <View style={styles.left}>
        <Ionicons
          name="cloud-offline-outline"
          size={18}
          color={theme.colors.statusOpen}
        />
        <View style={styles.textBlock}>
          <Text style={styles.title}>Offline</Text>
          <Text style={styles.subtitle}>{pendingText}</Text>
        </View>
      </View>

      {onSync && (
        <TouchableOpacity
          onPress={onSync}
          disabled={syncing}
          style={styles.syncBtn}
          activeOpacity={0.75}
        >
          <Ionicons
            name={syncing ? "sync" : "refresh-outline"}
            size={14}
            color={theme.colors.onSurface}
          />
          <Text style={styles.syncLabel}>
            {syncing ? "Sync..." : "Sync"}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useAppTheme>) {
  return StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: theme.colors.surfaceContainer,
      borderWidth: 1,
      borderColor: theme.colors.statusOpenBorder,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 10,
      marginHorizontal: theme.spacing.gutter,
      marginBottom: theme.spacing.sm,
    },
    left: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      flex: 1,
    },
    textBlock: {
      gap: 2,
    },
    title: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.statusOpen,
    },
    subtitle: {
      fontSize: theme.typography.size.xs,
      color: theme.colors.onSurfaceVariant,
      fontFamily: theme.typography.family.regular,
    },
    syncBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.sm,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    syncLabel: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurface,
    },
  });
}
