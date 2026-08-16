// features/absences/admin/components/EmployeePickerField.tsx
// Mitarbeiter-Einzelauswahl für "Abwesenheit erfassen". Gleiches Sheet-Muster
// wie features/jobs/components/EmployeeFilterControl.tsx, aber als
// Formularfeld (Label + Wert statt Icon-Button) und OHNE "Alle"/"Nicht
// zugewiesen" — hier wird immer genau ein Mitarbeiter gebraucht.
//
// Inaktive Mitarbeiter werden NICHT ausgeblendet (admin_create_absence
// erlaubt sie explizit für historische Nacherfassung, siehe Migrations-
// Kommentar), aber mit einem "Inaktiv"-Tag markiert.

import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import type { EmployeeOption } from "@/types/job";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const SEARCH_THRESHOLD = 8;

type Props = {
  label?: string;
  employees: EmployeeOption[];
  value: string | null;
  onChange: (employeeId: string) => void;
  error?: string;
};

export function EmployeePickerField({
  label = "Mitarbeiter *",
  employees,
  value,
  onChange,
  error,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = employees.find((e) => e.id === value) ?? null;
  const showSearch = employees.length >= SEARCH_THRESHOLD;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => e.fullName.toLowerCase().includes(q));
  }, [employees, query]);

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <View style={styles.wrapper}>
      {label ? <Text style={styles.label}>{label}</Text> : null}

      <TouchableOpacity
        style={[styles.field, error && styles.fieldError]}
        onPress={() => setOpen(true)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Mitarbeiter auswählen"
      >
        <Text
          style={[styles.fieldText, !selected && styles.fieldPlaceholder]}
          numberOfLines={1}
        >
          {selected ? selected.fullName : "Mitarbeiter auswählen…"}
        </Text>
        {selected?.isActive === false ? (
          <View style={styles.inactiveTag}>
            <Text style={styles.inactiveTagText}>Inaktiv</Text>
          </View>
        ) : null}
        <Ionicons
          name="chevron-down"
          size={16}
          color={theme.colors.onSurfaceVariant}
        />
      </TouchableOpacity>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>Mitarbeiter</Text>

            {showSearch ? (
              <View style={styles.sheetSearch}>
                <Ionicons
                  name="search"
                  size={16}
                  color={theme.colors.onSurfaceVariant}
                />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Mitarbeiter suchen …"
                  placeholderTextColor={theme.colors.outline}
                  style={styles.sheetSearchInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            ) : null}

            <ScrollView
              style={styles.optionScroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {filtered.map((emp) => {
                const isSelected = value === emp.id;
                return (
                  <TouchableOpacity
                    key={emp.id}
                    style={[styles.option, isSelected && styles.optionSelected]}
                    onPress={() => select(emp.id)}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.optionLabel,
                        isSelected && styles.optionLabelSelected,
                      ]}
                      numberOfLines={1}
                    >
                      {emp.fullName}
                    </Text>
                    {emp.isActive === false ? (
                      <View style={styles.inactiveTag}>
                        <Text style={styles.inactiveTagText}>Inaktiv</Text>
                      </View>
                    ) : null}
                    {isSelected ? (
                      <Ionicons
                        name="checkmark"
                        size={18}
                        color={theme.colors.onPrimaryContainer}
                      />
                    ) : null}
                  </TouchableOpacity>
                );
              })}

              {filtered.length === 0 ? (
                <Text style={styles.noMatch}>Keine Treffer.</Text>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    wrapper: {
      gap: 6,
    },
    label: {
      fontSize: theme.typography.size.xs,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wide,
    },
    field: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.background,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 13,
      borderRadius: theme.radius.md,
      borderWidth: 1.5,
      borderColor: theme.colors.outlineVariant,
      minHeight: theme.spacing.tapTarget,
    },
    fieldError: {
      borderColor: theme.colors.error,
    },
    fieldText: {
      flex: 1,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },
    fieldPlaceholder: {
      color: theme.colors.outline,
    },
    errorText: {
      fontSize: theme.typography.size.xs,
      color: theme.colors.error,
      fontFamily: theme.typography.family.regular,
      marginTop: 2,
    },
    inactiveTag: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
    },
    inactiveTagText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },

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
      paddingBottom: theme.spacing.xl,
      maxHeight: "70%",
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
      marginBottom: theme.spacing.sm,
    },
    sheetSearch: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      marginBottom: theme.spacing.sm,
      minHeight: 40,
    },
    sheetSearchInput: {
      flex: 1,
      paddingVertical: 8,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },
    optionScroll: {
      flexGrow: 0,
    },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 12,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
    },
    optionSelected: {
      backgroundColor: theme.colors.primaryContainer,
    },
    optionLabel: {
      flex: 1,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    optionLabelSelected: {
      color: theme.colors.onPrimaryContainer,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    noMatch: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
