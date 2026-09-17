// features/jobs/components/StatusFilterRow.tsx
// ─────────────────────────────────────────────────────────────────
// Kompakter Status-Filter für den Admin-Kalender: „Alle" + ein Chip je
// kanonischem Status (Offen / In Arbeit / Erledigt).
//
// Reine Präsentation — die Filterung selbst passiert im aufrufenden Screen,
// rein clientseitig auf den bereits geladenen Monatsdaten. Ein Umschalten
// hier löst NIE einen Netzwerk-Request aus.
//
// Farben kommen aus utils/jobStatus.ts (JOB_STATUS_ORDER/getJobStatusMeta),
// Beschriftungen aus hooks/useJobStatusLabels.ts (i18n) — keine zweite
// Status-Tabelle, dieselbe Quelle wie Kalender-Punkte und Job-Karten.
//
// Horizontal scrollbar statt umbrechend: bei vier Chips + Mitarbeiter-Icon-
// Button in einer Zeile bleibt die Zeile so auf jeder Gerätebreite eine Zeile
// hoch, statt bei schmalen Displays ins Raster hineinzuwachsen.
// ─────────────────────────────────────────────────────────────────

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useJobStatusLabels } from "@/hooks/useJobStatusLabels";
import type { JobStatus } from "@/types/job";
import { JOB_STATUS_ORDER, getJobStatusMeta } from "@/utils/jobStatus";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";

export type StatusSelection = "all" | JobStatus;

/** Lesbares Label der aktuellen Auswahl (für Chip/Accessibility). */
export function useStatusSelectionLabel(selection: StatusSelection): string {
  const { t } = useTranslation();
  const labels = useJobStatusLabels();
  return selection === "all" ? t("common:filters.all") : labels[selection];
}

type Props = {
  value: StatusSelection;
  onChange: (next: StatusSelection) => void;
};

export function StatusFilterRow({ value, onChange }: Props) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const labels = useJobStatusLabels();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      <Chip
        label={t("common:filters.all")}
        active={value === "all"}
        onPress={() => onChange("all")}
        activeBg={theme.colors.primaryContainer}
        activeBorder={theme.colors.primaryContainer}
        activeText={theme.colors.onPrimaryContainer}
        styles={styles}
      />
      {JOB_STATUS_ORDER.map((status) => {
        const meta = getJobStatusMeta(status, theme.colors, labels[status]);
        return (
          <Chip
            key={status}
            label={meta.label}
            active={value === status}
            onPress={() => onChange(status)}
            activeBg={meta.bg}
            activeBorder={meta.border}
            activeText={meta.text}
            styles={styles}
          />
        );
      })}
    </ScrollView>
  );
}

function Chip({
  label,
  active,
  onPress,
  activeBg,
  activeBorder,
  activeText,
  styles,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  activeBg: string;
  activeBorder: string;
  activeText: string;
  styles: ReturnType<typeof createStyles>;
}) {
  const { t } = useTranslation();
  return (
    <TouchableOpacity
      style={[
        styles.chip,
        active && { backgroundColor: activeBg, borderColor: activeBorder },
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={t("common:a11y.statusFilter", { label })}
    >
      <Text
        style={[
          styles.chipText,
          active && styles.chipTextActive,
          active && { color: activeText },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    chip: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
    },
    chipText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    chipTextActive: {
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
  });
}
