// features/jobs/components/RuleFilterSheet.tsx
// Kompaktes Filter-Bottom-Sheet für Daueraufträge (Verwaltungsansicht).
//
// Enthält heute drei Abschnitte: Status (Radio), Mitarbeiter (Radio),
// Wochentage (Mehrfachauswahl). Arbeitet mit einem lokalen Entwurf (Draft):
// Änderungen wirken erst nach „Anwenden"; „Zurücksetzen" leert den Entwurf;
// Antippen des Hintergrunds verwirft ihn (wie bei den meisten Filter-Sheets).
// Suche bleibt davon unberührt — sie lebt außerhalb dieser Komponente.
//
// Erweiterbarkeit (siehe utils/recurringRuleFilter.ts): ein künftiger Filter
// (Service/Objekt/Kunde/Region/Tags) ist ein weiterer <FilterSection>-Block
// hier plus ein Feld in RuleFilters — die bestehenden Abschnitte bleiben
// unverändert.

import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import type { EmployeeOption } from "@/types/job";
import { WEEKDAYS, type WeekdayKey } from "@/utils/recurrence";
import {
  DEFAULT_RULE_FILTERS,
  type RuleFilters,
} from "@/utils/recurringRuleFilter";
import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type Props = {
  visible: boolean;
  onClose: () => void;
  filters: RuleFilters;
  onApply: (next: RuleFilters) => void;
  employees: EmployeeOption[];
};

export function RuleFilterSheet({
  visible,
  onClose,
  filters,
  onApply,
  employees,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [draft, setDraft] = useState<RuleFilters>(filters);

  // Entwurf beim Öffnen mit dem aktuell angewendeten Stand synchronisieren —
  // ein zuvor verworfener Entwurf darf beim nächsten Öffnen nicht wieder
  // auftauchen.
  useEffect(() => {
    if (visible) setDraft(filters);
  }, [visible, filters]);

  const toggleWeekday = (key: WeekdayKey) => {
    setDraft((prev) => ({
      ...prev,
      weekdays: prev.weekdays.includes(key)
        ? prev.weekdays.filter((d) => d !== key)
        : [...prev.weekdays, key],
    }));
  };

  const handleApply = () => {
    onApply(draft);
    onClose();
  };

  const handleReset = () => {
    setDraft(DEFAULT_RULE_FILTERS);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.grabber} />
          <Text style={styles.sheetTitle}>Filter</Text>

          <ScrollView
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <FilterSection title="Status" styles={styles}>
              <RadioOption
                label="Alle"
                selected={draft.status === "all"}
                onPress={() => setDraft((p) => ({ ...p, status: "all" }))}
                styles={styles}
                theme={theme}
              />
              <RadioOption
                label="Aktiv"
                selected={draft.status === "active"}
                onPress={() => setDraft((p) => ({ ...p, status: "active" }))}
                styles={styles}
                theme={theme}
              />
              <RadioOption
                label="Inaktiv"
                selected={draft.status === "inactive"}
                onPress={() => setDraft((p) => ({ ...p, status: "inactive" }))}
                styles={styles}
                theme={theme}
              />
            </FilterSection>

            <FilterSection title="Mitarbeiter" styles={styles}>
              <RadioOption
                label="Alle Mitarbeiter"
                selected={draft.employee === "all"}
                onPress={() => setDraft((p) => ({ ...p, employee: "all" }))}
                styles={styles}
                theme={theme}
              />
              <RadioOption
                label="Nicht zugewiesen"
                selected={draft.employee === "unassigned"}
                onPress={() =>
                  setDraft((p) => ({ ...p, employee: "unassigned" }))
                }
                styles={styles}
                theme={theme}
              />
              {employees.map((emp) => (
                <RadioOption
                  key={emp.id}
                  label={emp.fullName}
                  selected={draft.employee === emp.id}
                  onPress={() =>
                    setDraft((p) => ({ ...p, employee: emp.id }))
                  }
                  styles={styles}
                  theme={theme}
                />
              ))}
            </FilterSection>

            <FilterSection title="Wochentage" styles={styles} last>
              <View style={styles.weekdayRow}>
                {WEEKDAYS.map((w) => {
                  const active = draft.weekdays.includes(w.key);
                  return (
                    <TouchableOpacity
                      key={w.key}
                      style={[
                        styles.weekdayChip,
                        active && styles.weekdayChipActive,
                      ]}
                      onPress={() => toggleWeekday(w.key)}
                      activeOpacity={0.8}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: active }}
                      accessibilityLabel={w.label}
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
            </FilterSection>
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.footerBtnSecondary}
              onPress={handleReset}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Alle Filter zurücksetzen"
            >
              <Text style={styles.footerBtnSecondaryText}>Zurücksetzen</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.footerBtnPrimary}
              onPress={handleApply}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Filter anwenden"
            >
              <Text style={styles.footerBtnPrimaryText}>Anwenden</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Ein Abschnitt im Sheet (Titel + Inhalt). Neue Filterkategorien werden als
// weiterer <FilterSection> ergänzt, ohne bestehende anzufassen.
function FilterSection({
  title,
  children,
  styles,
  last = false,
}: {
  title: string;
  children: React.ReactNode;
  styles: ReturnType<typeof createStyles>;
  last?: boolean;
}) {
  return (
    <View style={[styles.section, last && styles.sectionLast]}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function RadioOption({
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
      accessibilityRole="radio"
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
      maxHeight: "80%",
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
      marginBottom: theme.spacing.xs,
    },
    scroll: { flexGrow: 0 },

    section: {
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
    },
    sectionLast: {
      borderBottomWidth: 0,
      paddingBottom: theme.spacing.sm,
    },
    sectionTitle: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wide,
      textTransform: "uppercase",
      marginBottom: 4,
    },

    option: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 10,
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

    // Wochentage: gleiche Chip-Optik wie im Job-Formular (JobFormFields).
    weekdayRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.sm,
      paddingTop: 4,
    },
    weekdayChip: {
      width: 40,
      height: 40,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
      alignItems: "center",
      justifyContent: "center",
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

    footer: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.md,
    },
    footerBtnSecondary: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 12,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
    },
    footerBtnSecondaryText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
    },
    footerBtnPrimary: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 12,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.primaryContainer,
    },
    footerBtnPrimaryText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimaryContainer,
    },
  });
}
