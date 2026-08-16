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
import { isCorrectableJob } from "@/utils/jobCorrection";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Props = {
  // status/startedAt/completedAt sind für die Korrektur-Sichtbarkeit nötig
  // (siehe jobIsCorrectable unten) — NICHT für die Zuweisungsanzeige selbst.
  job: Pick<Job, "assignees" | "status" | "startedAt" | "completedAt">;
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

  // ENTSCHEIDET ÜBER DEN GESAMTEN ADMIN-ZUSATZ (Status-Zeile UND Aktion).
  //
  // Ohne diese Prüfung meldete die Karte an JEDEM offenen Auftrag rot „Keine
  // eigene Zeit erfasst" — was dort kein Mangel ist, sondern der Normalfall:
  // der Auftrag wurde schlicht noch nicht ausgeführt. In der Produktions-
  // datenbank betraf das ~93 % aller Zuweisungen; das rote Signal wäre damit
  // der Regelzustand gewesen und für die wenigen echten Lücken wertlos.
  // Ebenso bei laufenden Aufträgen (Beginn erfasst, Ende erwartungsgemäß
  // offen) und bei Alt-Aufträgen vor dem Phase-1-Grenzwert, für die der
  // Stundenzettel weiterhin über die geteilte Job-Uhr abrechnet — dort ist
  // eine fehlende Eigenzeit weder Mangel noch korrigierbar.
  //
  // Deckungsgleich mit admin_correct_assignment_time: was hier sichtbar ist,
  // kann die RPC auch tatsächlich annehmen.
  const jobIsCorrectable = isCorrectableJob(job);
  const showAdminTimeInfo = isAdmin && jobIsCorrectable;

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
            // Zwei Ebenen: der AUFTRAG muss korrigierbar sein
            // (showAdminTimeInfo, siehe oben) UND die ZEILE als RPC-Eingabe
            // taugen — Legacy-/anonymisierte Zeilen fallen hier heraus.
            const showAction =
              showAdminTimeInfo &&
              !!onCorrectTime &&
              isCorrectableAssignment(assignee);

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

                  {/* Zeitstatus nur für Admins UND nur an korrigierbaren
                      Aufträgen (siehe jobIsCorrectable oben). */}
                  {showAdminTimeInfo ? (
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
