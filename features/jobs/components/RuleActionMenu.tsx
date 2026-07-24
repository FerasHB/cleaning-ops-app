// features/jobs/components/RuleActionMenu.tsx
// Kompaktes Aktions-Menü (Drei-Punkte-Menü) für eine Dauerauftrags-Regel.
//
// Ersetzt die frühere permanente Aktionsleiste in der Regel-Karte
// (Bearbeiten / Deaktivieren / Löschen als drei nebeneinanderliegende
// Buttons). Die Karte selbst ist dadurch deutlich flacher und die ganze
// Karte bleibt für die Detail-Navigation antippbar.
//
// Optik/Verhalten wie RuleFilterSheet: Bottom-Sheet im Modal, Tippen auf den
// Hintergrund schließt. „Löschen" ist visuell destruktiv (Fehlerfarbe) und
// vom Rest durch eine Trennlinie abgesetzt.
//
// Bewusst KEINE Logik: die Komponente meldet nur die gewählte Aktion nach
// oben — Bestätigungsdialog, Historie-Schutz und Laden bleiben im Screen.

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

export type RuleAction = "edit" | "toggleActive" | "delete";

type Props = {
  visible: boolean;
  /** Titelzeile des Sheets (Objekt/Kunde der Regel). */
  title: string;
  /** Aktueller Aktiv-Zustand — bestimmt „Deaktivieren" vs. „Aktivieren". */
  active: boolean;
  onClose: () => void;
  onSelect: (action: RuleAction) => void;
};

export function RuleActionMenu({
  visible,
  title,
  active,
  onClose,
  onSelect,
}: Props) {
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
          <Text style={styles.sheetTitle} numberOfLines={1}>
            {title}
          </Text>

          <MenuItem
            icon="create-outline"
            label="Bearbeiten"
            onPress={() => onSelect("edit")}
            styles={styles}
            theme={theme}
          />
          <MenuItem
            icon={active ? "pause-outline" : "play-outline"}
            label={active ? "Deaktivieren" : "Aktivieren"}
            onPress={() => onSelect("toggleActive")}
            styles={styles}
            theme={theme}
          />
          <MenuItem
            icon="trash-outline"
            label="Löschen"
            onPress={() => onSelect("delete")}
            styles={styles}
            theme={theme}
            destructive
          />

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

function MenuItem({
  icon,
  label,
  onPress,
  styles,
  theme,
  destructive = false,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
  destructive?: boolean;
}) {
  const color = destructive ? theme.colors.error : theme.colors.onSurface;
  return (
    <TouchableOpacity
      style={[styles.item, destructive && styles.itemDestructive]}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[styles.itemLabel, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
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
    sheetTitle: {
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
    // „Löschen" optisch abgesetzt — destruktive Aktion nicht versehentlich treffen.
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
