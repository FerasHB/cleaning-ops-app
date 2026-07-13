// features/jobs/components/EmployeeSelector.tsx
// Auswahl-Liste (Radio) für Mitarbeiterzuweisung.
// Vollständig theme-aware (Light + Dark Mode).

import { useAppTheme } from "@/hooks/useAppTheme";
import { EmployeeOption } from "@/types/job";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { AppTheme } from "@/constants/theme";

type Props = {
  employees: EmployeeOption[];
  selectedEmployeeId: string | null;
  onSelect: (employeeId: string | null) => void;
  emptyLabel?: string;
};

export function EmployeeSelector({
  employees,
  selectedEmployeeId,
  onSelect,
  emptyLabel = "Keine Mitarbeiter verfügbar.",
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.wrapper}>
      <EmployeeOptionRow
        label="Nicht zuweisen"
        sublabel="Job bleibt offen"
        isSelected={selectedEmployeeId === null}
        onPress={() => onSelect(null)}
      />

      {employees.length === 0 ? (
        <Text style={styles.emptyText}>{emptyLabel}</Text>
      ) : (
        employees.map((emp) => {
          const isInactive = emp.isActive === false;
          return (
            <EmployeeOptionRow
              key={emp.id}
              label={emp.fullName}
              sublabel={
                isInactive ? "Inaktiv – kann nicht zugewiesen werden" : "Mitarbeiter"
              }
              isSelected={selectedEmployeeId === emp.id}
              disabled={isInactive}
              onPress={() => {
                if (isInactive) return;
                onSelect(emp.id);
              }}
            />
          );
        })
      )}
    </View>
  );
}

type EmployeeOptionRowProps = {
  label: string;
  sublabel?: string;
  isSelected: boolean;
  disabled?: boolean;
  onPress: () => void;
};

function EmployeeOptionRow({
  label,
  sublabel,
  isSelected,
  disabled = false,
  onPress,
}: EmployeeOptionRowProps) {
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
    >
      <View
        style={[
          styles.radioOuter,
          isSelected && styles.radioOuterSelected,
          disabled && styles.radioOuterDisabled,
        ]}
      >
        {isSelected && <View style={styles.radioInner} />}
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
    radioOuter: {
      width: 20,
      height: 20,
      borderRadius: theme.radius.full,
      borderWidth: 2,
      borderColor: theme.colors.outline,
      alignItems: "center",
      justifyContent: "center",
    },
    radioOuterSelected: {
      borderColor: theme.colors.primary,
    },
    radioOuterDisabled: {
      borderColor: theme.colors.outlineVariant,
    },
    radioInner: {
      width: 10,
      height: 10,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primary,
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
