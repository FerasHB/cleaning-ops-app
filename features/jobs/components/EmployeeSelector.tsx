import { Colors, Radius, Spacing, Typography } from "@/constants/theme";
import { EmployeeOption } from "@/types/job";
import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

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
        employees.map((emp) => (
          <EmployeeOptionRow
            key={emp.id}
            label={emp.fullName}
            sublabel="Mitarbeiter"
            isSelected={selectedEmployeeId === emp.id}
            onPress={() => onSelect(emp.id)}
          />
        ))
      )}
    </View>
  );
}

type EmployeeOptionRowProps = {
  label: string;
  sublabel?: string;
  isSelected: boolean;
  onPress: () => void;
};

function EmployeeOptionRow({
  label,
  sublabel,
  isSelected,
  onPress,
}: EmployeeOptionRowProps) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.row, isSelected && styles.rowSelected]}
      activeOpacity={0.7}
    >
      <View
        style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}
      >
        {isSelected && <View style={styles.radioInner} />}
      </View>

      <View style={styles.info}>
        <Text style={[styles.name, isSelected && styles.nameSelected]}>
          {label}
        </Text>
        {sublabel ? <Text style={styles.sublabel}>{sublabel}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 6,
  },
  emptyText: {
    textAlign: "center",
    color: Colors.text.muted,
    fontSize: Typography.size.sm,
    paddingVertical: Spacing.lg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.sm,
  },
  rowSelected: {
    backgroundColor: Colors.accent.subtle,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: Radius.full,
    borderWidth: 2,
    borderColor: Colors.border.default,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuterSelected: {
    borderColor: Colors.accent.default,
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent.default,
  },
  info: {
    flex: 1,
    gap: 1,
  },
  name: {
    fontSize: Typography.size.base,
    color: Colors.text.secondary,
    fontWeight: Typography.weight.medium,
  },
  nameSelected: {
    color: Colors.accent.text,
  },
  sublabel: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
  },
});
