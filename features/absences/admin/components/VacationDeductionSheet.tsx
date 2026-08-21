// features/absences/admin/components/VacationDeductionSheet.tsx
// Bestätigung der Abzugsmenge bei der Urlaubsgenehmigung.
//
// WARUM EINE EINGABE STATT EINER BERECHNUNG: aus den Referenz-Arbeitstagen
// pro Woche (eine ANZAHL, nicht konkrete Wochentage) lässt sich nicht
// ableiten, welche Tage eines Zeitraums Anspruch verbrauchen. Die
// Einsatzplanung taugt ebenfalls nicht als Quelle — sie ist nachträglich
// änderbar und nur ~3 Monate im Voraus materialisiert. Der Admin bestätigt
// deshalb bewusst; der bestätigte Wert wird unveränderlich festgeschrieben.
//
// Bei einem Urlaub über den Jahreswechsel gibt es je Kalenderjahr ein
// eigenes Feld — dadurch ist es unmöglich, versehentlich alle Tage ins
// Startjahr zu buchen.

import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import { yearsInRange } from "@/utils/vacationBalance";
import React, { useMemo, useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

type Props = {
  visible: boolean;
  employeeName: string;
  rangeLabel: string;
  startDate: string;
  endDate: string;
  onCancel: () => void;
  onConfirm: (deductions: Record<string, number>) => void;
};

export function VacationDeductionSheet({
  visible,
  employeeName,
  rangeLabel,
  startDate,
  endDate,
  onCancel,
  onConfirm,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const years = useMemo(() => yearsInRange(startDate, endDate), [startDate, endDate]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const handleConfirm = () => {
    const result: Record<string, number> = {};
    for (const year of years) {
      const raw = (values[String(year)] ?? "").trim().replace(",", ".");
      if (!raw) {
        setError(`Bitte die Tage für ${year} angeben (0 ist erlaubt).`);
        return;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError(`Ungültiger Wert für ${year}.`);
        return;
      }
      result[String(year)] = parsed;
    }
    setError("");
    setValues({});
    onConfirm(result);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Urlaub genehmigen</Text>
          <Text style={styles.subtitle}>
            {employeeName} · {rangeLabel}
          </Text>
          <Text style={styles.hint}>
            Bitte bestätige, wie viele Urlaubstage abgezogen werden. Der Wert
            wird dauerhaft festgeschrieben und später nicht neu berechnet.
          </Text>

          {years.map((year) => (
            <View key={year} style={styles.field}>
              <Text style={styles.label}>
                {years.length > 1 ? `Tage für ${year}` : "Urlaubstage"}
              </Text>
              <TextInput
                style={styles.input}
                keyboardType="decimal-pad"
                value={values[String(year)] ?? ""}
                onChangeText={(text) =>
                  setValues((prev) => ({ ...prev, [String(year)]: text }))
                }
                placeholder="z. B. 3"
                placeholderTextColor={theme.colors.onSurfaceVariant}
              />
            </View>
          ))}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelText}>Abbrechen</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.confirmBtn} onPress={handleConfirm}>
              <Text style={styles.confirmText}>Genehmigen</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "center",
      padding: theme.spacing.lg,
    },
    sheet: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    title: {
      fontSize: theme.typography.size.lg,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    subtitle: { fontSize: theme.typography.size.sm, color: theme.colors.onSurfaceVariant },
    hint: {
      fontSize: theme.typography.size.xs,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.xs,
      marginBottom: theme.spacing.xs,
    },
    field: { gap: theme.spacing.xs },
    label: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      color: theme.colors.onSurface,
      fontSize: theme.typography.size.md,
    },
    error: { fontSize: theme.typography.size.xs, color: theme.colors.error },
    actions: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      marginTop: theme.spacing.md,
    },
    cancelBtn: {
      flex: 1,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      alignItems: "center",
    },
    cancelText: { color: theme.colors.onSurface, fontSize: theme.typography.size.sm },
    confirmBtn: {
      flex: 1,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.primary,
      alignItems: "center",
    },
    confirmText: {
      color: theme.colors.onPrimary,
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
    },
  });
}
