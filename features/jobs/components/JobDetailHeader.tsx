// features/jobs/components/JobDetailHeader.tsx
// Sticky Top-Header des Job-Detail-Screens. Reines Präsentations-Element:
// zeigt den Zurück-Button und (nur Admin + Parent-Regel) den runden
// "…"-Button, der das Regel-Aktionsmenü öffnet. Keine eigene Logik — der
// Screen entscheidet, ob der Menü-Button sichtbar ist und was er tut.

import { AppHeader } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { ActivityIndicator, StyleSheet, TouchableOpacity } from "react-native";
import type { AppTheme } from "@/constants/theme";

type Props = {
  /** Zeigt den runden Menü-Button rechts (nur Admin, nur bei Parent-Regel). */
  showMenu: boolean;
  menuBusy: boolean;
  onMenuPress: () => void;
};

export function JobDetailHeader({ showMenu, menuBusy, onMenuPress }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <AppHeader
      title="Job-Details"
      showBack
      right={
        showMenu ? (
          <TouchableOpacity
            style={styles.menuBtn}
            onPress={onMenuPress}
            disabled={menuBusy}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Aktionen für diesen Dauerauftrag"
            accessibilityHint="Öffnet Bearbeiten, Aktivieren/Deaktivieren und Löschen"
          >
            {menuBusy ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : (
              <Ionicons
                name="ellipsis-horizontal"
                size={20}
                color={theme.colors.onSurface}
              />
            )}
          </TouchableOpacity>
        ) : undefined
      }
    />
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    menuBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
    },
  });
}
