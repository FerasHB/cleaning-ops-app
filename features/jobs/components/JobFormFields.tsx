import { Input } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { Colors, Spacing, Typography } from "@/constants/theme";
import { EmployeeSelector } from "@/features/jobs/components/EmployeeSelector";
import { JobFormValues } from "@/features/jobs/hooks/useJobForm";
import { EmployeeOption } from "@/types/job";
import React from "react";
import { StyleSheet, Text } from "react-native";

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

const styles = StyleSheet.create({
  sectionLabel: {
    marginTop: Spacing.xs,
    marginBottom: Spacing.xs,
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
  },
});
