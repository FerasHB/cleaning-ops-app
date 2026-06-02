// components/ui/DateTimeField.tsx
// Datum-/Uhrzeit-Auswahl mit Modal-Picker.
// Vollständig theme-aware (Light + Dark Mode).
// Native Picker passt sich über themeVariant automatisch an.

import { Input } from "@/components/ui/index";
import { useAppTheme } from "@/hooks/useAppTheme";
import { formatForDisplay, formatTimeHHmm } from "@/utils/date";
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

export interface DateTimeFieldProps {
  label: string;
  placeholder?: string;
  value: Date | null;
  onChange: (date: Date | null) => void;
  /**
   * "datetime" (Default): Datum → Uhrzeit in zwei Schritten (einmalige Aufträge).
   * "time": nur Uhrzeit (wiederkehrende Aufträge — Wochentage kommen separat).
   */
  mode?: "datetime" | "time";
}

export function DateTimeField({
  label,
  placeholder = "Datum auswählen...",
  value,
  onChange,
  mode = "datetime",
}: DateTimeFieldProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const modalStyles = useMemo(() => createModalStyles(theme), [theme]);

  const isTimeOnly = mode === "time";

  const [showPickerModal, setShowPickerModal] = useState(false);
  const [pickerStep, setPickerStep] = useState<"date" | "time">("date");
  const [tempDate, setTempDate] = useState<Date>(new Date());

  const openPicker = () => {
    setTempDate(value ?? new Date());
    setPickerStep(isTimeOnly ? "time" : "date");
    setShowPickerModal(true);
  };

  const displayValue = value
    ? isTimeOnly
      ? formatTimeHHmm(value) ?? ""
      : formatForDisplay(value)
    : "";

  const handleTempDateChange = (
    _event: DateTimePickerEvent,
    selectedDate?: Date,
  ) => {
    if (selectedDate) {
      setTempDate(selectedDate);
    }
  };

  const handlePickerNext = () => setPickerStep("time");
  const handlePickerBack = () => setPickerStep("date");

  const handlePickerCancel = () => {
    setShowPickerModal(false);
  };

  const handlePickerConfirm = () => {
    onChange(tempDate);
    setShowPickerModal(false);
  };

  const handleClear = () => {
    onChange(null);
  };

  return (
    <>
      <View style={styles.wrapper}>
        <View style={styles.fieldArea}>
          <TouchableOpacity onPress={openPicker} activeOpacity={0.8}>
            <View pointerEvents="none">
              <Input
                label={label}
                placeholder={placeholder}
                value={displayValue}
                editable={false}
              />
            </View>
          </TouchableOpacity>
        </View>

        {value && (
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={handleClear}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            activeOpacity={0.6}
          >
            <Ionicons
              name="close"
              size={16}
              color={theme.colors.onSurfaceVariant}
            />
          </TouchableOpacity>
        )}
      </View>

      <Modal visible={showPickerModal} transparent animationType="fade">
        <View style={modalStyles.overlay}>
          <View style={modalStyles.container}>
            <Text style={modalStyles.title}>
              {pickerStep === "date" ? "Datum wählen" : "Uhrzeit wählen"}
            </Text>

            <View style={modalStyles.pickerWrapper}>
              <DateTimePicker
                value={tempDate}
                mode={pickerStep}
                display="spinner"
                onChange={handleTempDateChange}
                themeVariant={theme.isDark ? "dark" : "light"}
                textColor={theme.colors.onSurface}
                locale="de-DE"
                style={modalStyles.picker}
              />
            </View>

            <View style={modalStyles.footer}>
              {isTimeOnly ? (
                <>
                  <TouchableOpacity
                    onPress={handlePickerCancel}
                    style={modalStyles.btnCancel}
                  >
                    <Text style={modalStyles.btnCancelText}>Abbrechen</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handlePickerConfirm}
                    style={modalStyles.btnPrimary}
                  >
                    <Text style={modalStyles.btnPrimaryText}>Bestätigen</Text>
                  </TouchableOpacity>
                </>
              ) : pickerStep === "date" ? (
                <>
                  <TouchableOpacity
                    onPress={handlePickerCancel}
                    style={modalStyles.btnCancel}
                  >
                    <Text style={modalStyles.btnCancelText}>Abbrechen</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handlePickerNext}
                    style={modalStyles.btnPrimary}
                  >
                    <Text style={modalStyles.btnPrimaryText}>Weiter</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity
                    onPress={handlePickerBack}
                    style={modalStyles.btnCancel}
                  >
                    <Text style={modalStyles.btnCancelText}>Zurück</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handlePickerConfirm}
                    style={modalStyles.btnPrimary}
                  >
                    <Text style={modalStyles.btnPrimaryText}>Bestätigen</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    wrapper: {
      position: "relative",
      justifyContent: "center",
    },
    fieldArea: {
      width: "100%",
    },
    clearBtn: {
      position: "absolute",
      right: theme.spacing.sm,
      bottom: theme.spacing.sm + 4,
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.background,
      borderRadius: theme.radius.full,
    },
  });
}

function createModalStyles(theme: AppTheme) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "center",
      alignItems: "center",
      padding: theme.spacing.lg,
    },
    container: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      width: "100%",
      maxWidth: 360,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      ...theme.shadows.md,
    },
    title: {
      fontSize: theme.typography.size.lg,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onSurface,
      marginBottom: theme.spacing.md,
      textAlign: "center",
    },
    pickerWrapper: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.md,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 220,
      marginVertical: theme.spacing.md,
      overflow: "hidden",
    },
    picker: {
      width: "100%",
      height: 220,
    },
    footer: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      marginTop: theme.spacing.md,
    },
    btnCancel: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      alignItems: "center",
      minHeight: theme.spacing.tapTarget,
      justifyContent: "center",
    },
    btnCancelText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    btnPrimary: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      minHeight: theme.spacing.tapTarget,
      justifyContent: "center",
    },
    btnPrimaryText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimaryContainer,
    },
  });
}
