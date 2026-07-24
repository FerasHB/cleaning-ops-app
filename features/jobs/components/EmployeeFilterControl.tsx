// features/jobs/components/EmployeeFilterControl.tsx
// Kompakter Mitarbeiter-Filter für den Zeitplan: ein Icon-Button (Personen-
// Symbol + Aktiv-Punkt) öffnet ein Bottom-Sheet mit der Auswahl.
//
// Ersetzt die frühere horizontale Chip-Reihe, die bei vielen Mitarbeitern die
// gesamte Bildschirmbreite gefüllt hat. Die Liste im Sheet ist scrollbar und
// bekommt ab einer gewissen Größe ein eigenes Suchfeld.
//
// Die Auswahl selbst (welcher Mitarbeiter) lebt beim Aufrufer — diese
// Komponente rendert nur Button + Sheet und meldet die Auswahl zurück.

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

// Auswahl: alle, unzugewiesen oder eine konkrete Mitarbeiter-ID.
export type EmployeeSelection = "all" | "unassigned" | string;

// Ab dieser Anzahl bekommt das Sheet ein eigenes Suchfeld.
const SEARCH_THRESHOLD = 8;

export const ALL_LABEL = "Alle Mitarbeiter";
export const UNASSIGNED_LABEL = "Nicht zugewiesen";

/** Lesbares Label der aktuellen Auswahl (für Chip/Accessibility). */
export function employeeSelectionLabel(
  selection: EmployeeSelection,
  employees: EmployeeOption[],
): string {
  if (selection === "all") return ALL_LABEL;
  if (selection === "unassigned") return UNASSIGNED_LABEL;
  return employees.find((e) => e.id === selection)?.fullName ?? "Mitarbeiter";
}

type Props = {
  value: EmployeeSelection;
  onChange: (next: EmployeeSelection) => void;
  employees: EmployeeOption[];
};

export function EmployeeFilterControl({ value, onChange, employees }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const isFiltered = value !== "all";
  const currentLabel = employeeSelectionLabel(value, employees);

  const showSearch = employees.length >= SEARCH_THRESHOLD;

  const filteredEmployees = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => e.fullName.toLowerCase().includes(q));
  }, [employees, query]);

  const select = (next: EmployeeSelection) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  return (
    <>
      <TouchableOpacity
        style={[styles.button, isFiltered && styles.buttonActive]}
        onPress={() => setOpen(true)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Mitarbeiter filtern"
        accessibilityValue={{ text: currentLabel }}
        accessibilityHint="Öffnet die Mitarbeiter-Auswahl für den Zeitplan"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons
          name="people-outline"
          size={18}
          color={
            isFiltered
              ? theme.colors.onPrimaryContainer
              : theme.colors.onSurfaceVariant
          }
        />
        {/* Aktiv-Punkt: signalisiert einen gesetzten Filter auf einen Blick */}
        {isFiltered ? <View style={styles.activeDot} /> : null}
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {/* Inneres Pressable fängt Taps, damit das Sheet nicht schließt */}
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
                {query.length > 0 ? (
                  <TouchableOpacity
                    onPress={() => setQuery("")}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityLabel="Mitarbeiter-Suche löschen"
                  >
                    <Ionicons
                      name="close-circle"
                      size={16}
                      color={theme.colors.outline}
                    />
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

            <ScrollView
              style={styles.optionScroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Option
                label={ALL_LABEL}
                selected={value === "all"}
                onPress={() => select("all")}
                styles={styles}
                theme={theme}
              />
              <Option
                label={UNASSIGNED_LABEL}
                selected={value === "unassigned"}
                onPress={() => select("unassigned")}
                styles={styles}
                theme={theme}
              />

              {filteredEmployees.length > 0 ? (
                <View style={styles.divider} />
              ) : null}

              {filteredEmployees.map((emp) => (
                <Option
                  key={emp.id}
                  label={emp.fullName}
                  selected={value === emp.id}
                  onPress={() => select(emp.id)}
                  styles={styles}
                  theme={theme}
                />
              ))}

              {showSearch && filteredEmployees.length === 0 ? (
                <Text style={styles.noMatch}>Keine Treffer.</Text>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function Option({
  label,
  selected,
  onPress,
  styles,
  theme,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  return (
    <TouchableOpacity
      style={[styles.option, selected && styles.optionSelected]}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
    >
      <Text
        style={[styles.optionLabel, selected && styles.optionLabelSelected]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {selected ? (
        <Ionicons
          name="checkmark"
          size={18}
          color={theme.colors.onPrimaryContainer}
        />
      ) : null}
    </TouchableOpacity>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    // ── Icon-Button im Header
    button: {
      width: theme.spacing.tapTarget,
      height: theme.spacing.tapTarget,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonActive: {
      backgroundColor: theme.colors.primaryContainer,
      borderColor: theme.colors.primaryContainer,
    },
    activeDot: {
      position: "absolute",
      top: 6,
      right: 6,
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.colors.primary,
      borderWidth: 1,
      borderColor: theme.colors.surface,
    },

    // ── Bottom-Sheet
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
      justifyContent: "space-between",
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
    divider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
      marginVertical: theme.spacing.xs,
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
