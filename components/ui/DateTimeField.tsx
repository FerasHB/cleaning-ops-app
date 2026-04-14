import { Input } from "@/components/ui/index";
import {
  Colors,
  Radius,
  Shadows,
  Spacing,
  Typography,
} from "@/constants/theme";
import { formatForDisplay } from "@/utils/date";
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import React, { useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";

export interface DateTimeFieldProps {
  label: string;
  placeholder?: string;
  value: Date | null;
  onChange: (date: Date | null) => void;
}

export function DateTimeField({
  label,
  placeholder = "Datum auswählen...",
  value,
  onChange,
}: DateTimeFieldProps) {
  const [showPickerModal, setShowPickerModal] = useState(false);
  const [pickerStep, setPickerStep] = useState<"date" | "time">("date");
  const [tempDate, setTempDate] = useState<Date>(new Date());

  const openPicker = () => {
    setTempDate(value ?? new Date());
    setPickerStep("date");
    setShowPickerModal(true);
  };

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
                value={value ? formatForDisplay(value) : ""}
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
            <Text style={styles.clearBtnText}>✕</Text>
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
                themeVariant="light"
                textColor={Colors.text.primary}
                locale="de-DE"
                style={modalStyles.picker}
              />
            </View>

            <View style={modalStyles.footer}>
              {pickerStep === "date" ? (
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

const styles = StyleSheet.create({
  wrapper: {
    position: "relative",
    justifyContent: "center",
  },
  fieldArea: {
    width: "100%",
  },
  clearBtn: {
    position: "absolute",
    right: Spacing.sm,
    bottom: Spacing.sm + 4,
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.full,
  },
  clearBtnText: {
    fontSize: Typography.size.sm,
    color: Colors.text.muted,
  },
});

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: Spacing.lg,
  },
  container: {
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    width: "100%",
    maxWidth: 360,
    ...Shadows.md,
  },
  title: {
    fontSize: Typography.size.lg,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    marginBottom: Spacing.md,
    textAlign: "center",
  },
  pickerWrapper: {
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 220,
    marginVertical: Spacing.md,
    overflow: "hidden",
  },
  picker: {
    width: "100%",
    height: 220,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  btnCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: Radius.md,
    backgroundColor: Colors.bg.elevated,
    borderWidth: 1,
    borderColor: Colors.border.default,
    alignItems: "center",
  },
  btnCancelText: {
    fontSize: Typography.size.md,
    color: Colors.text.primary,
    fontWeight: Typography.weight.medium,
  },
  btnPrimary: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: Radius.md,
    backgroundColor: Colors.accent.default,
    alignItems: "center",
  },
  btnPrimaryText: {
    fontSize: Typography.size.md,
    color: Colors.white,
    fontWeight: Typography.weight.semibold,
  },
});
