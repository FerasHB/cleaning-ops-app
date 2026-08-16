// features/absences/components/AbsenceCard.tsx
// Eine Karte in "Meine Abwesenheiten": Typ, Zeitraum, Status, Notizen,
// kontextabhängige Aktionen. "Ende aktualisieren" klappt INLINE auf (kein
// eigenes Modal — siehe CLAUDE.md-Vorgabe "keine verschachtelte
// Modal-Komplexität").

import { Button, Card } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import type { Absence } from "@/types/absence";
import { formatDateISO } from "@/utils/date";
import { confirmDialog } from "@/utils/dialogs";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { AbsenceStatusBadge } from "./AbsenceStatusBadge";

/** "YYYY-MM-DD" → "DD.MM." (ohne Jahr, wie in den Kartenbeispielen). */
function formatDayMonth(dateIso: string): string {
  const [, m, d] = dateIso.split("-");
  return `${d}.${m}.`;
}

function formatDateRangeLabel(absence: Absence): string {
  if (absence.type === "vacation") {
    return `${formatDayMonth(absence.startDate)}–${formatDayMonth(absence.endDate!)}`;
  }
  // Krankheit: mit Ende ein Bereich, ohne Ende "Seit ...".
  if (absence.endDate) {
    return `${formatDayMonth(absence.startDate)}–${formatDayMonth(absence.endDate)}`;
  }
  return `Seit ${formatDayMonth(absence.startDate)}`;
}

const today = () => formatDateISO(new Date())!;

interface AbsenceCardProps {
  absence: Absence;
  busy: boolean;
  onCancelVacation: () => void;
  onCancelSickness: () => void;
  /** Resolves to the updated absence on success, or null on failure. */
  onUpdateSicknessEnd: (newEndDate: string | null) => Promise<unknown>;
}

export function AbsenceCard({
  absence,
  busy,
  onCancelVacation,
  onCancelSickness,
  onUpdateSicknessEnd,
}: AbsenceCardProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [editingEnd, setEditingEnd] = useState(false);
  const [draftEndDate, setDraftEndDate] = useState<Date | null>(
    absence.endDate ? new Date(absence.endDate) : null,
  );

  const isVacation = absence.type === "vacation";

  // Server-Prädikate gespiegelt (cancel_own_vacation/-sickness) — nur die
  // Sichtbarkeit von Aktionen, keine eigene Berechtigungslogik.
  const canCancelVacation =
    isVacation &&
    (absence.status === "requested" || absence.status === "approved") &&
    absence.startDate > today();
  const canManageSickness = !isVacation && absence.status === "reported";

  const handleCancelVacation = async () => {
    const confirmed = await confirmDialog({
      title: "Anfrage stornieren",
      message: "Möchtest du diesen Urlaubsantrag wirklich stornieren?",
      confirmLabel: "Stornieren",
      destructive: true,
    });
    if (confirmed) onCancelVacation();
  };

  const handleCancelSickness = async () => {
    const confirmed = await confirmDialog({
      title: "Krankmeldung stornieren",
      message: "Möchtest du diese Krankmeldung wirklich stornieren?",
      confirmLabel: "Stornieren",
      destructive: true,
    });
    if (confirmed) onCancelSickness();
  };

  // Erst NACH erfolgreichem Update einklappen — schlägt die RPC fehl (z. B.
  // Enddatum vor Beginn), bleibt der Editor offen und der Fehler erscheint im
  // ErrorBanner des Screens, statt den Eingabeversuch kommentarlos zu
  // verwerfen.
  const handleSaveEnd = async () => {
    const result = await onUpdateSicknessEnd(
      draftEndDate ? formatDateISO(draftEndDate) : null,
    );
    if (result) {
      setEditingEnd(false);
    }
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
              color={
                isVacation ? theme.colors.primary : theme.colors.statusOpen
              }
            />
          </View>
          <View>
            <Text style={styles.typeLabel}>
              {isVacation ? "Urlaub" : "Krankheit"}
            </Text>
            <Text style={styles.dateRange}>{formatDateRangeLabel(absence)}</Text>
          </View>
        </View>
        <AbsenceStatusBadge status={absence.status} />
      </View>

      {absence.employeeNote ? (
        <Text style={styles.note} numberOfLines={3}>
          {absence.employeeNote}
        </Text>
      ) : null}

      {absence.adminNote ? (
        <View style={styles.adminNoteWrap}>
          <Text style={styles.adminNoteLabel}>Notiz vom Admin</Text>
          <Text style={styles.note} numberOfLines={3}>
            {absence.adminNote}
          </Text>
        </View>
      ) : null}

      {(canCancelVacation || canManageSickness) && (
        <View style={styles.actionsRow}>
          {canCancelVacation && (
            <TouchableOpacity
              style={[styles.actionBtn, busy && styles.actionBtnDisabled]}
              disabled={busy}
              activeOpacity={0.8}
              onPress={handleCancelVacation}
            >
              <Text style={styles.actionBtnDangerText}>Anfrage stornieren</Text>
            </TouchableOpacity>
          )}

          {canManageSickness && (
            <>
              <TouchableOpacity
                style={[styles.actionBtn, busy && styles.actionBtnDisabled]}
                disabled={busy}
                activeOpacity={0.8}
                onPress={() => setEditingEnd((v) => !v)}
              >
                <Text style={styles.actionBtnText}>
                  {editingEnd ? "Abbrechen" : "Ende aktualisieren"}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionBtn, busy && styles.actionBtnDisabled]}
                disabled={busy}
                activeOpacity={0.8}
                onPress={handleCancelSickness}
              >
                <Text style={styles.actionBtnDangerText}>
                  Krankmeldung stornieren
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {editingEnd && (
        <View style={styles.editEndWrap}>
          <DateTimeField
            label="Voraussichtlich bis"
            mode="date"
            value={draftEndDate}
            onChange={setDraftEndDate}
            placeholder="Kein Enddatum bekannt"
          />
          <View style={styles.editEndActions}>
            {draftEndDate && (
              <TouchableOpacity
                style={styles.clearEndBtn}
                onPress={() => setDraftEndDate(null)}
              >
                <Text style={styles.clearEndText}>Enddatum entfernen</Text>
              </TouchableOpacity>
            )}
            <Button
              label="Speichern"
              onPress={handleSaveEnd}
              loading={busy}
              fullWidth={false}
              style={styles.saveEndBtn}
            />
          </View>
        </View>
      )}
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
      flexWrap: "wrap",
      gap: theme.spacing.sm,
      marginTop: 2,
    },
    actionBtn: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 9,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surfaceContainerHigh,
    },
    actionBtnDisabled: {
      opacity: 0.5,
    },
    actionBtnText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    actionBtnDangerText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.error,
    },
    editEndWrap: {
      marginTop: theme.spacing.xs,
      gap: theme.spacing.sm,
      paddingTop: theme.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.outlineVariant,
    },
    editEndActions: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
    },
    clearEndBtn: {
      paddingVertical: 8,
    },
    clearEndText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
      textDecorationLine: "underline",
    },
    saveEndBtn: {
      paddingHorizontal: theme.spacing.xl,
    },
  });
}
