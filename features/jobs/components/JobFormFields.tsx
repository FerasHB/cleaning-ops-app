// features/jobs/components/JobFormFields.tsx
// Form-Felder für Job-Erstellung/-Bearbeitung.
// Vollständig theme-aware (Light + Dark Mode).
//
// Terminierung:
// - Einmaliger Auftrag (single):     Datum + Uhrzeit
// - Wiederkehrender Auftrag (recurring): Wochentage + Uhrzeit + aktiv/inaktiv

import { Input } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { useAppTheme } from "@/hooks/useAppTheme";
import { EmployeeSelector } from "@/features/jobs/components/EmployeeSelector";
import { JobFormValues } from "@/features/jobs/hooks/useJobForm";
import { EmployeeOption, JobType } from "@/types/job";
import { WEEKDAYS, type WeekdayKey } from "@/utils/recurrence";
import React, { useMemo } from "react";
import { StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
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

const JOB_TYPE_OPTIONS: { key: JobType; label: string }[] = [
  { key: "single", label: "Einmalig" },
  { key: "recurring", label: "Wiederkehrend" },
];

export function JobFormFields({
  values,
  errors,
  onChangeField,
  employees = [],
}: JobFormFieldsProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const toggleWeekday = (key: WeekdayKey) => {
    const selected = values.recurringDays.includes(key);
    const next = selected
      ? values.recurringDays.filter((d) => d !== key)
      : [...values.recurringDays, key];
    onChangeField("recurringDays", next);
  };

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

      {/* ── Auftragstyp (Segmented Control) ── */}
      <Text style={styles.sectionLabel}>Auftragstyp *</Text>
      <View style={styles.segment}>
        {JOB_TYPE_OPTIONS.map((opt) => {
          const active = values.jobType === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[styles.segmentItem, active && styles.segmentItemActive]}
              onPress={() => onChangeField("jobType", opt.key)}
              activeOpacity={0.8}
            >
              <Text
                style={[
                  styles.segmentText,
                  active && styles.segmentTextActive,
                ]}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Einmalig: Datum + Uhrzeit ── */}
      {values.jobType === "single" ? (
        <View>
          <DateTimeField
            label="Datum & Uhrzeit *"
            placeholder="Datum und Uhrzeit auswählen..."
            value={values.singleDateTime}
            onChange={(val) => onChangeField("singleDateTime", val)}
          />
          {errors.singleDateTime ? (
            <Text style={styles.errorText}>{errors.singleDateTime}</Text>
          ) : null}
        </View>
      ) : (
        /* ── Wiederkehrend: Wochentage + Uhrzeit + aktiv ── */
        <View style={styles.recurringBlock}>
          <Text style={styles.sectionLabel}>Wochentage *</Text>
          <View style={styles.weekdayRow}>
            {WEEKDAYS.map((w) => {
              const active = values.recurringDays.includes(w.key);
              return (
                <TouchableOpacity
                  key={w.key}
                  style={[styles.weekdayChip, active && styles.weekdayChipActive]}
                  onPress={() => toggleWeekday(w.key)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[
                      styles.weekdayText,
                      active && styles.weekdayTextActive,
                    ]}
                  >
                    {w.short}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {errors.recurringDays ? (
            <Text style={styles.errorText}>{errors.recurringDays}</Text>
          ) : null}

          <DateTimeField
            label="Uhrzeit *"
            placeholder="Uhrzeit auswählen..."
            mode="time"
            value={values.startTime}
            onChange={(val) => onChangeField("startTime", val)}
          />
          {errors.startTime ? (
            <Text style={styles.errorText}>{errors.startTime}</Text>
          ) : null}

          <View style={styles.activeRow}>
            <View style={styles.activeTextWrap}>
              <Text style={styles.activeLabel}>Aktiv</Text>
              <Text style={styles.activeHint}>
                Inaktive Aufträge werden Mitarbeitern nicht angezeigt.
              </Text>
            </View>
            <Switch
              value={values.isActive}
              onValueChange={(val) => onChangeField("isActive", val)}
              trackColor={{
                false: theme.colors.outlineVariant,
                true: theme.colors.primary,
              }}
            />
          </View>
        </View>
      )}

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
    errorText: {
      marginTop: 4,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.error,
    },

    // ── Segmented Control (Auftragstyp)
    segment: {
      flexDirection: "row",
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: 3,
      gap: 3,
    },
    segmentItem: {
      flex: 1,
      paddingVertical: 9,
      borderRadius: theme.radius.sm,
      alignItems: "center",
    },
    segmentItemActive: {
      backgroundColor: theme.colors.primaryContainer,
    },
    segmentText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    segmentTextActive: {
      color: theme.colors.onPrimaryContainer,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },

    // ── Wiederkehrend
    recurringBlock: {
      gap: theme.spacing.sm,
    },
    weekdayRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
    },
    weekdayChip: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 8,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
      minWidth: 46,
      alignItems: "center",
    },
    weekdayChipActive: {
      backgroundColor: theme.colors.primaryContainer,
      borderColor: theme.colors.primaryContainer,
    },
    weekdayText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    weekdayTextActive: {
      color: theme.colors.onPrimaryContainer,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },

    // ── Aktiv-Schalter
    activeRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
      marginTop: theme.spacing.xs,
    },
    activeTextWrap: {
      flex: 1,
      gap: 2,
    },
    activeLabel: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    activeHint: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
