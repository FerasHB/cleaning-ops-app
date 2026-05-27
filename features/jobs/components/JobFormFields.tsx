// features/jobs/components/JobFormFields.tsx
// Form-Felder für Job-Erstellung/-Bearbeitung.
// Vollständig theme-aware (Light + Dark Mode).

import { Input } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { useAppTheme } from "@/hooks/useAppTheme";
import { EmployeeSelector } from "@/features/jobs/components/EmployeeSelector";
import { JobFormValues } from "@/features/jobs/hooks/useJobForm";
import { EmployeeOption } from "@/types/job";
import React, { useMemo } from "react";
import { StyleSheet, Text } from "react-native";
import type { AppTheme } from "@/constants/theme";

type JobFormFieldsProps = {
  values: JobFormValues;
  errors: Partial<Record<keyof JobFormValues, string>>;
  onChangeField: <K extends keyof JobFormValues>(
    field: K,
    value: JobFormValues[K],
  ) => void;
  employees?: EmployeeOption[];
};

export function JobFormFields({
  values,
  errors,
  onChangeField,
  employees = [],
}: JobFormFieldsProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <>
      <Input
        label="Kunde *"
        placeholder="z.B. Müller GmbH"
        value={values.customerName}
        onChangeText={(val) => onChangeField("customerName", val)}
        error={errors.customerName}
      />

      <Input
        label="Ort *"
        placeholder="z.B. Dortmund"
        value={values.location}
        onChangeText={(val) => onChangeField("location", val)}
        error={errors.location}
      />

      <Input
        label="Service *"
        placeholder="z.B. Wartung, Installation"
        value={values.service}
        onChangeText={(val) => onChangeField("service", val)}
        error={errors.service}
      />

      <DateTimeField
        label="Geplanter Start"
        placeholder="Datum auswählen..."
        value={values.scheduledStart}
        onChange={(val) => onChangeField("scheduledStart", val)}
      />

      <Text style={styles.sectionLabel}>Mitarbeiter</Text>
      <EmployeeSelector
        employees={employees}
        selectedEmployeeId={values.employeeId}
        onSelect={(employeeId) => onChangeField("employeeId", employeeId)}
      />

      <Input
        label="Notizen"
        placeholder="Interne Hinweise (optional)"
        value={values.notes}
        onChangeText={(val) => onChangeField("notes", val)}
        multiline
      />
    </>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    sectionLabel: {
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.xs,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
  });
}
