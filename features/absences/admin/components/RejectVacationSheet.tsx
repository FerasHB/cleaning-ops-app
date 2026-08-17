// features/absences/admin/components/RejectVacationSheet.tsx
// Kleines Bottom-Sheet für "Ablehnen": optionale Notiz + Bestätigen/Abbrechen.
// admin_note_input ist auf der RPC optional (default null) — für die Beta
// bewusst kein Pflichtfeld, siehe Architektur-Audit Phase C Abschnitt 4.
// Eigenes Sheet statt Alert.alert, weil Alert keinen Freitext-Input kennt und
// auf Web ohnehin eine leere Attrappe ist (siehe utils/dialogs.ts).
//
// Tastatur-Handling: gleiche Bauform wie
// features/timesheets/components/TimeCorrectionSheet.tsx (das einzige andere
// Modal-Sheet mit Texteingabe in der App) — Modal > Overlay-View
// (justifyContent: flex-end) > KeyboardAvoidingView (behavior "padding" nur
// auf iOS) > Sheet-View. Ohne KeyboardAvoidingView schiebt sich das am
// unteren Rand angepinnte Sheet auf iOS NICHT über die Tastatur, die dann das
// Notizfeld verdeckt — Modals hängen an einem eigenen nativen Fenster und
// erben keinen KeyboardAvoidingView/SafeAreaView vom umgebenden Screen.
import { Button } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import React, { useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type Props = {
  visible: boolean;
  employeeName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
};

export function RejectVacationSheet({
  visible,
  employeeName,
  busy,
  onCancel,
  onConfirm,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [note, setNote] = useState("");

  const handleClose = () => {
    if (busy) return;
    setNote("");
    onCancel();
  };

  const handleConfirm = () => {
    onConfirm(note.trim());
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.kav}
        >
          <Pressable style={styles.sheet} onPress={() => {}}>
            <ScrollView
              contentContainerStyle={styles.scroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.grabber} />
              <Text style={styles.title}>Urlaub ablehnen</Text>
              <Text style={styles.subtitle}>
                Antrag von {employeeName} ablehnen. Eine Notiz ist optional.
              </Text>

              <TextInput
                style={styles.input}
                value={note}
                onChangeText={setNote}
                placeholder="Notiz für den Mitarbeiter (optional)"
                placeholderTextColor={theme.colors.outline}
                multiline
                editable={!busy}
              />

              <View style={styles.actions}>
                <Button
                  label="Abbrechen"
                  variant="secondary"
                  onPress={handleClose}
                  disabled={busy}
                  style={styles.actionBtn}
                />
                <Button
                  label="Ablehnen"
                  variant="danger"
                  onPress={handleConfirm}
                  loading={busy}
                  style={styles.actionBtn}
                />
              </View>
            </ScrollView>
          </Pressable>
        </KeyboardAvoidingView>
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
    kav: {
      width: "100%",
    },
    sheet: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: theme.radius.lg,
      borderTopRightRadius: theme.radius.lg,
      maxHeight: "92%",
    },
    scroll: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.xl,
      gap: theme.spacing.md,
    },
    grabber: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.colors.outlineVariant,
    },
    title: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },
    subtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    input: {
      backgroundColor: theme.colors.background,
      color: theme.colors.onSurface,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.regular,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 12,
      borderRadius: theme.radius.md,
      borderWidth: 1.5,
      borderColor: theme.colors.outlineVariant,
      minHeight: 88,
      textAlignVertical: "top",
    },
    actions: {
      flexDirection: "row",
      gap: theme.spacing.sm,
    },
    actionBtn: {
      flex: 1,
    },
  });
}
