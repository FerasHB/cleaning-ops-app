// features/absences/admin/components/AdminAbsenceRow.tsx
// Eine Abwesenheits-Zeile in der Admin-Ansicht: Typ, Zeitraum, Status,
// Mitarbeitername (optional, z. B. in EmployeeDetail ausgeblendet), Notizen,
// und — nur bei status="requested" Urlaub — Genehmigen/Ablehnen.
//
// Geteilt zwischen AdminAbsencesScreen (Urlaubsanträge-Reiter, Krankmeldungen-
// Reiter) und EmployeeDetailScreen (pending Anträge dieses Mitarbeiters) —
// eine Komponente, ein Aktions-Vertrag, statt zwei Kopien mit demselben
// Genehmigen/Ablehnen-Verhalten.

import { Card } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { isVacationAccountingEnabled } from "@/services/vacation/vacationLedger.service";
import { VacationDeductionSheet } from "./VacationDeductionSheet";
import type { AppTheme } from "@/constants/theme";
import type { Absence } from "@/types/absence";
import { formatAbsenceDateRange } from "@/utils/absenceFormat";
import { confirmDialog } from "@/utils/dialogs";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { AbsenceStatusBadge } from "../../components/AbsenceStatusBadge";
import { RejectVacationSheet } from "./RejectVacationSheet";

type Props = {
  absence: Absence;
  busy: boolean;
  /** Standard true — EmployeeDetail blendet den Namen aus (steht bereits im Screen-Kontext). */
  showEmployeeName?: boolean;
  onApprove: (absenceId: string, deductions?: Record<string, number> | null) => void;
  onReject: (absenceId: string, adminNote: string) => void;
};

export function AdminAbsenceRow({
  absence,
  busy,
  showEmployeeName = true,
  onApprove,
  onReject,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [rejectSheetOpen, setRejectSheetOpen] = useState(false);
  const [deductionSheetOpen, setDeductionSheetOpen] = useState(false);

  const isVacation = absence.type === "vacation";
  const isPendingVacation = isVacation && absence.status === "requested";
  const reviewerNote =
    absence.status === "rejected" || absence.status === "approved"
      ? absence.adminNote
      : null;

  // Wird fuer diesen Mitarbeiter ein Urlaubskonto gefuehrt, muss der Admin
  // die Abzugsmenge bestaetigen (sie ist nicht berechenbar, siehe
  // VacationDeductionSheet). Ohne Urlaubskonto bleibt der bisherige,
  // einfache Bestaetigungsdialog.
  const handleApprove = async () => {
    if (!absence.employeeId) return;

    let accountingEnabled = false;
    try {
      accountingEnabled = await isVacationAccountingEnabled(absence.employeeId);
    } catch {
      // Konnte der Status nicht geladen werden, NICHT stillschweigend ohne
      // Abzug genehmigen — die RPC wuerde bei aktivem Konto ohnehin ablehnen.
      accountingEnabled = true;
    }

    if (accountingEnabled) {
      setDeductionSheetOpen(true);
      return;
    }

    const confirmed = await confirmDialog({
      title: "Urlaub genehmigen",
      message: `Urlaubsantrag von ${absence.employeeName} (${formatAbsenceDateRange(absence)}) genehmigen?`,
      confirmLabel: "Genehmigen",
    });
    if (confirmed) onApprove(absence.id);
  };

  const handleConfirmReject = (note: string) => {
    onReject(absence.id, note);
  };

  return (
    <Card style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.typeRow}>
          <View
            style={[
              styles.typeIcon,
              isVacation ? styles.typeIconVacation : styles.typeIconSickness,
            ]}
          >
            <Ionicons
              name={isVacation ? "sunny-outline" : "medkit-outline"}
              size={16}
              color={isVacation ? theme.colors.primary : theme.colors.statusOpen}
            />
          </View>
          <View style={styles.typeTextWrap}>
            {showEmployeeName ? (
              <Text style={styles.employeeName} numberOfLines={1}>
                {absence.employeeName}
              </Text>
            ) : (
              <Text style={styles.typeLabel}>
                {isVacation ? "Urlaub" : "Krankheit"}
              </Text>
            )}
            <Text style={styles.dateRange}>{formatAbsenceDateRange(absence)}</Text>
          </View>
        </View>
        <AbsenceStatusBadge status={absence.status} />
      </View>

      {absence.employeeNote ? (
        <Text style={styles.note} numberOfLines={4}>
          {absence.employeeNote}
        </Text>
      ) : null}

      {reviewerNote ? (
        <View style={styles.adminNoteWrap}>
          <Text style={styles.adminNoteLabel}>Deine Notiz</Text>
          <Text style={styles.note} numberOfLines={4}>
            {reviewerNote}
          </Text>
        </View>
      ) : null}

      {isPendingVacation ? (
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.approveBtn, busy && styles.actionBtnDisabled]}
            disabled={busy}
            activeOpacity={0.8}
            onPress={handleApprove}
          >
            <Ionicons name="checkmark" size={16} color={theme.colors.statusCompleted} />
            <Text style={styles.approveBtnText}>Genehmigen</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, styles.rejectBtn, busy && styles.actionBtnDisabled]}
            disabled={busy}
            activeOpacity={0.8}
            onPress={() => setRejectSheetOpen(true)}
          >
            <Ionicons name="close" size={16} color={theme.colors.error} />
            <Text style={styles.rejectBtnText}>Ablehnen</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <RejectVacationSheet
        visible={rejectSheetOpen}
        employeeName={absence.employeeName}
        busy={busy}
        onCancel={() => setRejectSheetOpen(false)}
        onConfirm={(note) => {
          setRejectSheetOpen(false);
          handleConfirmReject(note);
        }}
      />
          <VacationDeductionSheet
        visible={deductionSheetOpen}
        employeeName={absence.employeeName}
        rangeLabel={formatAbsenceDateRange(absence)}
        startDate={absence.startDate}
        endDate={absence.endDate ?? absence.startDate}
        onCancel={() => setDeductionSheetOpen(false)}
        onConfirm={(deductions) => {
          setDeductionSheetOpen(false);
          onApprove(absence.id, deductions);
        }}
      />
</Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.sm,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
    },
    typeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      flexShrink: 1,
    },
    typeIcon: {
      width: 32,
      height: 32,
      borderRadius: theme.radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    typeIconVacation: {
      backgroundColor: theme.colors.primaryContainer,
    },
    typeIconSickness: {
      backgroundColor: theme.colors.statusOpenBg,
    },
    typeTextWrap: {
      flexShrink: 1,
    },
    employeeName: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    typeLabel: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    dateRange: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      marginTop: 1,
    },
    note: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.sm,
    },
    adminNoteWrap: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderRadius: theme.radius.md,
      padding: theme.spacing.sm,
      gap: 2,
    },
    adminNoteLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      textTransform: "uppercase",
      letterSpacing: theme.typography.letterSpacing.wide,
    },
    actionsRow: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      marginTop: 2,
    },
    actionBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 10,
      borderRadius: theme.radius.md,
      borderWidth: 1,
    },
    actionBtnDisabled: {
      opacity: 0.5,
    },
    approveBtn: {
      backgroundColor: theme.colors.statusCompletedBg,
      borderColor: theme.colors.statusCompletedBorder,
    },
    approveBtnText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.statusCompleted,
    },
    rejectBtn: {
      backgroundColor: theme.colors.errorContainer,
      borderColor: theme.colors.error,
    },
    rejectBtnText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.error,
    },
  });
}
