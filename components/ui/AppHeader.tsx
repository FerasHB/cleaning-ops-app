// components/ui/AppHeader.tsx
// ─────────────────────────────────────────────────────────────────
// Konsistenter App-Header für alle Screens.
// Fixiert am oberen Bildschirmrand mit Border-Bottom.
// Unterstützt optionalen Zurück-Button und rechte Aktionen.
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
} from "react-native";

interface AppHeaderProps {
  /** Titel in der Mitte des Headers */
  title?: string;
  /** Zurück-Button links anzeigen */
  showBack?: boolean;
  /** Custom Callback für Zurück — Standard: router.back() */
  onBack?: () => void;
  /** Optionale Elemente rechts (z.B. Icon-Buttons) */
  right?: React.ReactNode;
  /** Zusätzlicher Container-Style */
  style?: ViewStyle;
}

export function AppHeader({
  title,
  showBack = false,
  onBack,
  right,
  style,
}: AppHeaderProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const handleBack = onBack ?? (() => router.back());

  return (
    <View style={[styles.header, style]}>
      {/* Linke Seite */}
      <View style={styles.side}>
        {showBack && (
          <TouchableOpacity
            onPress={handleBack}
            style={styles.iconBtn}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name="arrow-back"
              size={22}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
        )}
      </View>

      {/* Titel (zentriert) */}
      {title ? (
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      ) : (
        <View />
      )}

      {/* Rechte Seite */}
      <View style={[styles.side, styles.sideRight]}>
        {right ?? <View style={styles.iconBtn} />}
      </View>
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useAppTheme>) {
  return StyleSheet.create({
    header: {
      height: theme.spacing.tapTarget,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.gutter,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
    },
    side: {
      width: 44,
      alignItems: "flex-start",
      justifyContent: "center",
    },
    sideRight: {
      alignItems: "flex-end",
    },
    iconBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
    },
    title: {
      flex: 1,
      textAlign: "center",
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.normal,
    },
  });
}
