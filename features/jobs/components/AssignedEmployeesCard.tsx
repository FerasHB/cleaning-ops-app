// features/jobs/components/AssignedEmployeesCard.tsx
// Zuweisungsmenge eines Auftrags als lesbare Zeilen (Avatar + Name).
// Nutzt ausschließlich die bestehenden Zuweisungs-Helfer (utils/jobAssignees)
// und Job.assignees — keine eigene Zuweisungslogik, kein Kürzen von Namen.

import { Card, InitialsAvatar } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import {
  DELETED_SUFFIX,
  UNASSIGNED_LABEL,
  getAssignees,
} from "@/utils/jobAssignees";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  job: Pick<Job, "assignees">;
};

export function AssignedEmployeesCard({ job }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const assignees = getAssignees(job);
  const label = assignees.length > 1 ? "Mitarbeitende" : "Mitarbeiter";

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <View style={styles.labelRow}>
        <Ionicons
          name={assignees.length > 1 ? "people-outline" : "person-outline"}
          size={12}
          color={theme.colors.primary}
        />
        <Text style={styles.label}>{label.toUpperCase()}</Text>
      </View>

      {assignees.length === 0 ? (
        <Text style={styles.emptyText}>{UNASSIGNED_LABEL}</Text>
      ) : (
        <View style={styles.list}>
          {assignees.map((assignee) => {
            const displayName = assignee.isDeleted
              ? `${assignee.fullName}${DELETED_SUFFIX}`
              : assignee.fullName;
            return (
              <View
                key={assignee.assignmentId}
                style={styles.row}
                accessible
                accessibilityLabel={displayName}
              >
                <InitialsAvatar name={assignee.fullName} size={36} />
                <Text style={styles.name}>{displayName}</Text>
              </View>
            );
          })}
        </View>
      )}
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.md,
    },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    label: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    emptyText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    list: {
      gap: theme.spacing.sm,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    name: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
      flexWrap: "wrap",
    },
  });
}
