// features/jobs/components/AssignedEmployeesCard.tsx
// Zuweisungsmenge eines Auftrags als lesbare Zeilen (Avatar + Name).
// Nutzt ausschließlich die bestehenden Zuweisungs-Helfer (utils/jobAssignees)
// und Job.assignees — keine eigene Zuweisungslogik, kein Kürzen von Namen.
//
// PHASE B1 — ADMIN-SICHT: zusätzlich der Status der INDIVIDUELLEN Arbeitszeit
// je Person plus Einstieg in die Zeitkorrektur. Das ist der sekundäre
// Einstiegspunkt („mir fällt beim Auftrag auf, dass Ahmad keine Zeit hat");
// der primäre liegt im Stundenzettel, wo die Lücke beim Abrechnen auffällt.
//
// MITARBEITER-SICHT BLEIBT UNVERÄNDERT: nur Avatar + Name. Die individuellen
// Zeiten der KollegInnen sind Personaldaten und gehen Mitarbeitende nichts an —
// auch wenn RLS das Lesen der Zuweisungszeilen technisch erlaubt.

import { Card, InitialsAvatar } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job, JobAssignee } from "@/types/job";
import { formatTimeHHmm } from "@/utils/date";
import {
  DELETED_SUFFIX,
  UNASSIGNED_LABEL,
  getAssignees,
  isCorrectableAssignment,
} from "@/utils/jobAssignees";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Props = {
  job: Pick<Job, "assignees">;
  /**
   * Admin-Sicht: Zeitstatus + Korrektur-Aktion einblenden. Default false,
   * damit jede bestehende Aufrufstelle unverändert weiterläuft.
   */
  isAdmin?: boolean;
  /** Wird mit der gewählten Zuweisung gerufen (öffnet das Korrektur-Sheet). */
  onCorrectTime?: (assignee: JobAssignee) => void;
};

// "08:00 – 12:00" / "ab 08:00" / "bis 12:00" / null, wenn nichts erfasst ist.
function ownTimeLabel(assignee: JobAssignee): string | null {
  const start = assignee.employeeStartedAt
    ? formatTimeHHmm(new Date(assignee.employeeStartedAt))
    : null;
  const end = assignee.employeeCompletedAt
    ? formatTimeHHmm(new Date(assignee.employeeCompletedAt))
    : null;

  if (start && end) return `${start} – ${end}`;
  if (start) return `ab ${start}`;
  if (end) return `bis ${end}`;
  return null;
}

export function AssignedEmployeesCard({
  job,
  isAdmin = false,
  onCorrectTime,
}: Props) {
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

            const timeLabel = ownTimeLabel(assignee);
            const isComplete =
              !!assignee.employeeStartedAt && !!assignee.employeeCompletedAt;
            // Korrigierbar heißt hier nur: die Zeile taugt als RPC-Eingabe.
            // Ob der AUFTRAG korrigierbar ist (single, abgeschlossen, nach
            // Cutoff), entscheidet die RPC — ein Fehlversuch endet mit einer
            // verständlichen Meldung statt mit einer stillen Nulloperation.
            const showAction =
              isAdmin && !!onCorrectTime && isCorrectableAssignment(assignee);

            return (
              <View
                key={assignee.assignmentId}
                style={styles.row}
                accessible
                accessibilityLabel={displayName}
              >
                <InitialsAvatar name={assignee.fullName} size={36} />

                <View style={styles.nameWrap}>
                  <Text style={styles.name}>{displayName}</Text>

                  {/* Zeitstatus nur für Admins (siehe Kopf-Kommentar). */}
                  {isAdmin ? (
                    isComplete ? (
                      <Text style={styles.timeOk}>{timeLabel}</Text>
                    ) : (
                      <Text style={styles.timeMissing}>
                        {timeLabel
                          ? `${timeLabel} · unvollständig`
                          : "Keine eigene Zeit erfasst"}
                      </Text>
                    )
                  ) : null}
                </View>

                {showAction ? (
                  <TouchableOpacity
                    onPress={() => onCorrectTime?.(assignee)}
                    style={styles.actionBtn}
                    activeOpacity={0.75}
                    accessibilityLabel={`Zeit korrigieren für ${assignee.fullName}`}
                  >
                    <Ionicons
                      name="create-outline"
                      size={16}
                      color={theme.colors.onPrimaryContainer}
                    />
                  </TouchableOpacity>
                ) : null}
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
    nameWrap: {
      flex: 1,
      gap: 2,
    },
    name: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
      flexWrap: "wrap",
    },
    timeOk: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    timeMissing: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.error,
    },
    actionBtn: {
      width: 36,
      height: 36,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}
