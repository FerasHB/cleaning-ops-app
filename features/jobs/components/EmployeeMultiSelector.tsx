// features/jobs/components/EmployeeMultiSelector.tsx
// Mehrfachauswahl (Checkboxen) für Mitarbeiterzuweisung.
// Vollständig theme-aware (Light + Dark Mode).
//
// Gegenstück zu EmployeeSelector (Radio, Einzelauswahl) für den
// Phase-6-Schreibpfad: ein Job kann 0, 1 oder mehrere Mitarbeiter tragen.
//
// Inaktive Zeilen (emp.isActive === false) sind AUSGEWÄHLT+GESPERRT
// darstellbar, aber nie neu antippbar — exakt wie zuvor beim
// Einzelauswahl-EmployeeSelector. Grund: die serverseitige RPC
// set_job_assignments validiert JEDE übergebene Mitarbeiter-ID auf
// active=true, unabhängig davon, ob sich an dieser Zuweisung überhaupt
// etwas ändert. Eine inaktive, aber weiterhin zugewiesene Person würde
// sonst — sobald sie erneut mitgeschickt wird — JEDE Speicherung dieses
// Jobs serverseitig ablehnen, auch bei völlig unabhängigen Feldänderungen.
// Aufrufer (EditJobScreen) filtert solche IDs deshalb vor dem Absenden
// zusätzlich heraus; siehe dortigen Kommentar bei handleSave.
//
// Absichtlich NICHT versucht: eine Zeile als "bereits gestartet/
// abgeschlossen und deshalb nicht entfernbar" zu kennzeichnen. Der Client
// kennt den Anwesenheits-/Review-Zustand einer Zuweisung nicht — JobAssignee
// (types/job.ts) trägt bewusst keine attendance-Felder. Eine solche
// Kennzeichnung wäre geraten, nicht belegt.

import { useAppTheme } from "@/hooks/useAppTheme";
import { EmployeeOption } from "@/types/job";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

type Props = {
  employees: EmployeeOption[];
  selectedEmployeeIds: string[];
  onChange: (next: string[]) => void;
  emptyLabel?: string;
};

// Dedupliziert nach id — defensiv, auch wenn der Aufrufer (EditJobScreen
// unioniert aktive + zugewiesene Mitarbeiter) bereits dedupliziert übergibt.
function dedupeById(employees: EmployeeOption[]): EmployeeOption[] {
  const seen = new Set<string>();
  const result: EmployeeOption[] = [];
  for (const emp of employees) {
    if (seen.has(emp.id)) continue;
    seen.add(emp.id);
    result.push(emp);
  }
  return result;
}

export function EmployeeMultiSelector({
  employees,
  selectedEmployeeIds,
  onChange,
  emptyLabel = "Keine Mitarbeiter verfügbar.",
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const uniqueEmployees = useMemo(() => dedupeById(employees), [employees]);
  const selectedSet = useMemo(
    () => new Set(selectedEmployeeIds),
    [selectedEmployeeIds],
  );

  const toggle = (employeeId: string, isInactive: boolean) => {
    if (isInactive) return;

    const next = selectedSet.has(employeeId)
      ? selectedEmployeeIds.filter((id) => id !== employeeId)
      : [...selectedEmployeeIds, employeeId];
    onChange(next);
  };

  if (uniqueEmployees.length === 0) {
    return (
      <View style={styles.wrapper}>
        <Text style={styles.emptyText}>{emptyLabel}</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      {uniqueEmployees.map((emp) => {
        const isInactive = emp.isActive === false;
        return (
          <EmployeeCheckboxRow
            key={emp.id}
            label={emp.fullName}
            sublabel={
              isInactive
                ? "Inaktiv – Auswahl kann hier nicht geändert werden"
                : "Mitarbeiter"
            }
            isSelected={selectedSet.has(emp.id)}
            disabled={isInactive}
            onPress={() => toggle(emp.id, isInactive)}
          />
        );
      })}

      {selectedEmployeeIds.length === 0 ? (
        <Text style={styles.unassignedHint}>
          Niemand zugewiesen – Job bleibt offen.
        </Text>
      ) : null}
    </View>
  );
}

type RowProps = {
  label: string;
  sublabel?: string;
  isSelected: boolean;
  disabled?: boolean;
  onPress: () => void;
};

function EmployeeCheckboxRow({
  label,
  sublabel,
  isSelected,
  disabled = false,
  onPress,
}: RowProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.row,
        isSelected && styles.rowSelected,
        disabled && styles.rowDisabled,
      ]}
      activeOpacity={disabled ? 1 : 0.7}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: isSelected, disabled }}
    >
      <View
        style={[
          styles.checkboxOuter,
          isSelected && styles.checkboxOuterSelected,
          disabled && styles.checkboxOuterDisabled,
        ]}
      >
        {isSelected ? (
          <Ionicons
            name="checkmark"
            size={14}
            color={
              disabled ? theme.colors.onSurfaceVariant : theme.colors.onPrimary
            }
          />
        ) : null}
      </View>

      <View style={styles.info}>
        <Text
          style={[
            styles.name,
            isSelected && styles.nameSelected,
            disabled && styles.nameDisabled,
          ]}
        >
          {label}
        </Text>
        {sublabel ? <Text style={styles.sublabel}>{sublabel}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    wrapper: {
      gap: 6,
    },
    emptyText: {
      textAlign: "center",
      color: theme.colors.onSurfaceVariant,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      paddingVertical: theme.spacing.lg,
    },
    unassignedHint: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      paddingTop: 4,
      paddingHorizontal: theme.spacing.sm,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.radius.sm,
      borderWidth: 1,
      borderColor: theme.colors.transparent,
    },
    rowSelected: {
      backgroundColor: theme.colors.statusInProgressBg,
      borderColor: theme.colors.statusInProgressBorder,
    },
    rowDisabled: {
      opacity: 0.5,
    },
    checkboxOuter: {
      width: 20,
      height: 20,
      borderRadius: 4,
      borderWidth: 2,
      borderColor: theme.colors.outline,
      alignItems: "center",
      justifyContent: "center",
    },
    checkboxOuterSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.primary,
    },
    checkboxOuterDisabled: {
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surfaceContainerHigh,
    },
    info: {
      flex: 1,
      gap: 1,
    },
    name: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    nameDisabled: {
      color: theme.colors.onSurfaceVariant,
    },
    nameSelected: {
      color: theme.colors.primary,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    sublabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
