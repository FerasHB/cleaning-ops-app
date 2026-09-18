// features/timesheets/components/TimeCorrectionSheet.tsx
// Wiederverwendbares Korrektur-Formular für die Arbeitszeit EINER Zuweisung
// (Phase B1). Wird sowohl vom Stundenzettel als auch von der Auftrags-Detail-
// Seite genutzt — deshalb bewusst ohne eigene Datenbeschaffung: alles, was
// angezeigt wird, kommt über Props.
//
// ZWEI SCHRITTE, BEWUSST:
//   1. Formular  — Beginn, Ende, Grund
//   2. Bestätigen — Alt → Neu im Klartext, erst dann wird gespeichert
// Eine Abrechnungskorrektur soll nie ein einzelner Tap sein.
//
// GETEILTE AUFTRAGSZEIT IST NUR EIN VORSCHLAG: sie wird ausdrücklich als
// „Vorgeschlagene Zeit aus Auftragszeit" beschriftet und nie als Arbeitszeit
// des Mitarbeiters dargestellt. Übernehmen muss der Admin aktiv.

import { Button, Card, ErrorBanner, Input } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import {
  correctAssignmentTime,
  validateCorrection,
} from "@/services/timesheets/timeCorrection.service";
import { formatDateTimeLocalized } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";

export type TimeCorrectionTarget = {
  assignmentId: string;
  employeeName: string;
  customerName: string;
  /** Zusatzinfo (Service · Ort), optional. */
  remark?: string;
  /** Aktuell erfasste Eigenzeit (ISO) — jeweils null, wenn nicht erfasst. */
  employeeStartedAt: string | null;
  employeeCompletedAt: string | null;
  /** Geteilte Auftragszeit (ISO) als Vorschlag — optional. */
  sharedStartedAt?: string | null;
  sharedCompletedAt?: string | null;
};

type Props = {
  visible: boolean;
  target: TimeCorrectionTarget | null;
  onClose: () => void;
  /** Wird nach erfolgreicher Korrektur gerufen (z. B. zum Neuladen). */
  onCorrected: () => void;
};

function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function timeLabel(iso: string | null | undefined): string {
  return formatDateTimeLocalized(iso) ?? "—";
}

export function TimeCorrectionSheet({
  visible,
  target,
  onClose,
  onCorrected,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  const [start, setStart] = useState<Date | null>(null);
  const [end, setEnd] = useState<Date | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Beim Öffnen mit der bereits erfassten Eigenzeit vorbelegen. Die geteilte
  // Auftragszeit wird NICHT automatisch übernommen — dafür gibt es den
  // ausdrücklichen Vorschlag-Button unten.
  useEffect(() => {
    if (!visible || !target) return;
    setStart(parseIso(target.employeeStartedAt));
    setEnd(parseIso(target.employeeCompletedAt));
    setReason("");
    setConfirming(false);
    setSubmitting(false);
    setError(null);
  }, [visible, target]);

  if (!target) return null;

  const validationError = validateCorrection({
    newStartedAt: start,
    newCompletedAt: end,
    reason,
  });
  const canSubmit = validationError === null && !submitting;

  const hasSuggestion =
    !!target.sharedStartedAt && !!target.sharedCompletedAt;

  const applySuggestion = () => {
    setStart(parseIso(target.sharedStartedAt));
    setEnd(parseIso(target.sharedCompletedAt));
    setError(null);
  };

  const handleSave = async () => {
    if (!start || !end) return;
    setSubmitting(true);
    setError(null);
    try {
      await correctAssignmentTime({
        assignmentId: target.assignmentId,
        newStartedAt: start.toISOString(),
        newCompletedAt: end.toISOString(),
        reason,
      });
      onCorrected();
      onClose();
    } catch (err) {
      // correctAssignmentTime wirft ausschließlich bereits übersetzte,
      // nutzersichere Meldungen (siehe translateRpcError) — kein zweiter
      // toUserMessage()-Durchlauf, der würde die übersetzte RPC-Meldung in
      // jeder Nicht-Deutsch-Sprache wieder durch den generischen Fallback
      // ersetzen (toUserMessage lässt Fremdsprachen-Text nicht durch).
      setError(
        err instanceof Error
          ? err.message
          : t("admin:timesheet.correction.saveFailedFallback"),
      );
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.kav}
        >
          <View style={styles.sheet}>
            {/* ── Kopf ── */}
            <View style={styles.header}>
              <Text style={styles.title}>{t("admin:timesheet.correction.title")}</Text>
              <TouchableOpacity
                onPress={onClose}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityLabel={t("admin:timesheet.correction.closeA11y")}
              >
                <Ionicons
                  name="close"
                  size={22}
                  color={theme.colors.onSurfaceVariant}
                />
              </TouchableOpacity>
            </View>

            <ScrollView
              contentContainerStyle={styles.scroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* ── Kontext ── */}
              <Card padding={theme.spacing.md} style={styles.contextCard}>
                <Text style={styles.contextLabel}>
                  {t("admin:timesheet.correction.employeeLabel")}
                </Text>
                <Text style={styles.contextValue}>{target.employeeName}</Text>
                <View style={styles.contextDivider} />
                <Text style={styles.contextLabel}>
                  {t("admin:timesheet.correction.jobLabel")}
                </Text>
                <Text style={styles.contextValue}>{target.customerName}</Text>
                {target.remark ? (
                  <Text style={styles.contextMeta}>{target.remark}</Text>
                ) : null}
                <View style={styles.contextDivider} />
                <Text style={styles.contextLabel}>
                  {t("admin:timesheet.correction.currentlyRecordedLabel")}
                </Text>
                <Text style={styles.contextValue}>
                  {target.employeeStartedAt || target.employeeCompletedAt
                    ? `${timeLabel(target.employeeStartedAt)} → ${timeLabel(target.employeeCompletedAt)}`
                    : t("admin:timesheet.correction.noOwnTime")}
                </Text>
              </Card>

              {confirming ? (
                /* ── Schritt 2: Bestätigen ── */
                <View style={styles.confirmBlock}>
                  <Text style={styles.confirmIntro}>
                    {t("admin:timesheet.correction.confirmIntro")}
                  </Text>

                  <Card padding={theme.spacing.md} style={styles.diffCard}>
                    <Text style={styles.diffLabel}>
                      {t("admin:timesheet.correction.oldLabel")}
                    </Text>
                    <Text style={styles.diffOld}>
                      {target.employeeStartedAt || target.employeeCompletedAt
                        ? `${timeLabel(target.employeeStartedAt)} → ${timeLabel(target.employeeCompletedAt)}`
                        : t("admin:timesheet.correction.noOwnTime")}
                    </Text>

                    <View style={styles.contextDivider} />

                    <Text style={styles.diffLabel}>
                      {t("admin:timesheet.correction.newLabel")}
                    </Text>
                    <Text style={styles.diffNew}>
                      {formatDateTimeLocalized(start?.toISOString())} →{" "}
                      {formatDateTimeLocalized(end?.toISOString())}
                    </Text>

                    <View style={styles.contextDivider} />

                    <Text style={styles.diffLabel}>
                      {t("admin:timesheet.correction.reasonLabel")}
                    </Text>
                    <Text style={styles.diffReason}>{reason.trim()}</Text>
                  </Card>

                  {error ? <ErrorBanner message={error} /> : null}

                  <Button
                    label={t("admin:timesheet.correction.saveButton")}
                    onPress={handleSave}
                    loading={submitting}
                    disabled={submitting}
                  />
                  <TouchableOpacity
                    style={styles.secondaryBtn}
                    onPress={() => setConfirming(false)}
                    disabled={submitting}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.secondaryBtnText}>
                      {t("admin:timesheet.correction.backButton")}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : (
                /* ── Schritt 1: Formular ── */
                <View style={styles.formBlock}>
                  {hasSuggestion ? (
                    <TouchableOpacity
                      style={styles.suggestion}
                      onPress={applySuggestion}
                      activeOpacity={0.75}
                    >
                      <Ionicons
                        name="bulb-outline"
                        size={16}
                        color={theme.colors.primary}
                      />
                      <View style={styles.suggestionTextWrap}>
                        <Text style={styles.suggestionTitle}>
                          {t("admin:timesheet.correction.suggestionTitle")}
                        </Text>
                        <Text style={styles.suggestionValue}>
                          {timeLabel(target.sharedStartedAt)} →{" "}
                          {timeLabel(target.sharedCompletedAt)}
                        </Text>
                        <Text style={styles.suggestionHint}>
                          {t("admin:timesheet.correction.suggestionHint")}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ) : null}

                  <DateTimeField
                    label={t("admin:timesheet.correction.startLabel")}
                    placeholder={t("admin:timesheet.correction.dateTimePlaceholder")}
                    value={start}
                    onChange={setStart}
                  />

                  <DateTimeField
                    label={t("admin:timesheet.correction.endLabel")}
                    placeholder={t("admin:timesheet.correction.dateTimePlaceholder")}
                    value={end}
                    onChange={setEnd}
                  />

                  <Input
                    label={t("admin:timesheet.correction.reasonFieldLabel")}
                    placeholder={t("admin:timesheet.correction.reasonPlaceholder")}
                    value={reason}
                    onChangeText={setReason}
                    multiline
                    numberOfLines={3}
                  />

                  {error ? <ErrorBanner message={error} /> : null}

                  {/* Hinweis zeigt genau den Grund, warum Weiter gesperrt ist. */}
                  {validationError ? (
                    <Text style={styles.validationHint}>{validationError}</Text>
                  ) : null}

                  <Button
                    label={t("admin:timesheet.correction.continueButton")}
                    onPress={() => setConfirming(true)}
                    disabled={!canSubmit}
                  />
                </View>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "flex-end",
    },
    kav: {
      width: "100%",
    },
    sheet: {
      backgroundColor: theme.colors.background,
      borderTopLeftRadius: theme.radius.lg,
      borderTopRightRadius: theme.radius.lg,
      maxHeight: "92%",
      paddingBottom: theme.spacing.lg,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
    },
    title: {
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },
    scroll: {
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
    },

    // ── Kontext
    contextCard: {
      gap: 2,
    },
    contextLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    contextValue: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    contextMeta: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    contextDivider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
      marginVertical: theme.spacing.sm,
    },

    // ── Formular
    formBlock: {
      gap: theme.spacing.md,
    },
    suggestion: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      alignItems: "flex-start",
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
    },
    suggestionTextWrap: {
      flex: 1,
      gap: 2,
    },
    suggestionTitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimaryContainer,
    },
    suggestionValue: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onPrimaryContainer,
    },
    suggestionHint: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onPrimaryContainer,
    },
    validationHint: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // ── Bestätigen
    confirmBlock: {
      gap: theme.spacing.md,
    },
    confirmIntro: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    diffCard: {
      gap: 2,
    },
    diffLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    diffOld: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textDecorationLine: "line-through",
    },
    diffNew: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },
    diffReason: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
    },
    secondaryBtn: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    secondaryBtnText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
