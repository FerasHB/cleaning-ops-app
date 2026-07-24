// components/ui/ActionMenuSheet.tsx
// ─────────────────────────────────────────────────────────────────
// Generisches Aktions-Menü als Bottom-Sheet — die Zielansicht für
// Drei-Punkte-Menüs (Header-Aktionen, Listenzeilen-Overflow).
//
// Bewusst ohne eigene Logik: die Komponente meldet nur den gewählten
// Eintrag nach oben. Bestätigungsdialoge, Ladezustände und Fehler
// bleiben beim aufrufenden Screen.
// ─────────────────────────────────────────────────────────────────

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export type ActionMenuItem = {
  /** Stabiler Schlüssel, wird an onSelect zurückgegeben. */
  key: string;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  /** Destruktiv (Löschen): Fehlerfarbe + optisch abgesetzt. */
  destructive?: boolean;
};

interface ActionMenuSheetProps {
  visible: boolean;
  /** Titelzeile über den Aktionen (z. B. Objekt-/Kundenname). */
  title?: string;
  items: ActionMenuItem[];
  onClose: () => void;
  onSelect: (key: string) => void;
}

export function ActionMenuSheet({
  visible,
  title,
  items,
  onClose,
  onSelect,
}: ActionMenuSheetProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.grabber} />
          {title ? (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          ) : null}

          {items.map((item) => {
            const color = item.destructive
              ? theme.colors.error
              : theme.colors.onSurface;
            return (
              <TouchableOpacity
                key={item.key}
                style={[styles.item, item.destructive && styles.itemDestructive]}
                onPress={() => onSelect(item.key)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={item.label}
              >
                <Ionicons name={item.icon} size={18} color={color} />
                <Text style={[styles.itemLabel, { color }]} numberOfLines={1}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}

          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={onClose}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Menü schließen"
          >
            <Text style={styles.cancelText}>Abbrechen</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: theme.radius.lg,
      borderTopRightRadius: theme.radius.lg,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.lg,
    },
    grabber: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.colors.outlineVariant,
      marginBottom: theme.spacing.sm,
    },
    title: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      marginBottom: theme.spacing.xs,
    },
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 12,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
    },
    // Destruktive Aktion abgesetzt, damit sie nicht versehentlich getroffen wird.
    itemDestructive: {
      marginTop: theme.spacing.xs,
      borderTopWidth: 1,
      borderTopColor: theme.colors.outlineVariant,
      borderRadius: 0,
    },
    itemLabel: {
      flex: 1,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
    },
    cancelBtn: {
      marginTop: theme.spacing.sm,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 12,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      minHeight: theme.spacing.tapTarget,
    },
    cancelText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
