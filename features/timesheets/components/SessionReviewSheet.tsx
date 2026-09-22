// features/timesheets/components/SessionReviewSheet.tsx
// Admin-Prüfung EINER session-basierten Zuweisung (Migration 20260922000000).
//
// ZWEI SCHRITTE, BEWUSST — wie bei TimeCorrectionSheet:
//   1. Formular    — Abschnitte, tatsächliches Arbeitsende, Grund
//   2. Bestätigen  — die Abrechnungsfolge in Zahlen, erst dann wird gespeichert
// Eine Abrechnungsentscheidung darf nie ein einzelner Tap sein.
//
// DAS ENDE-FELD STARTET LEER. Kein now(), keine 12-Stunden-Grenze, kein
// geplantes Auftragsende: ein vorbelegtes Feld, das der Admin durchtippt, ist
// keine Prüfung. Der Wert muss vom Administrator kommen.
//
// reduce ist die Standardaktion. raise ist getrennt, ausdrücklich beschriftet
// und verlangt einen längeren Grund — die Oberfläche wandelt eine versehentliche
// Erhöhung NIE selbst in ein raise um; sie zeigt die Server-Ablehnung.

import { Button, Card, ErrorBanner, Input } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useIsRTL } from "@/hooks/useIsRTL";
import type {
  RecoveryQueueItem,
  SessionCorrectionAudit,
} from "@/services/timesheets/sessionRecovery.service";
import {
  buildRecoveryPreview,
  formatSeconds,
  formatSignedSeconds,
  reasonCodeKey,
  type RecoveryOperation,
} from "@/utils/sessionRecoveryUi";
import { formatDateTimeLocalized } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export type ReviewSession = {
  id: string;
  startedAt: string;
  /** null = der Mitarbeiter hat nie ein Arbeitsende erfasst. */
  rawEndedAt: string | null;
  effectiveEndedAt: string | null;
};

export function SessionReviewSheet({
  item, sessions, audit, submitting, error, onCancel, onSubmit,
}: {
  item: RecoveryQueueItem;
  sessions: ReviewSession[];
  audit: SessionCorrectionAudit[];
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: { operation: RecoveryOperation; sessionId: string;
    effectiveEndedAt: string; reason: string }) => void;
}) {
  const theme = useAppTheme();
  const isRTL = useIsRTL();
  const styles = useMemo(() => createStyles(theme, isRTL), [theme, isRTL]);
  const { t } = useTranslation();

  // Die Prüfung korrigiert den LETZTEN Abschnitt: eine vergessene Pause oder
  // ein vergessener Abschluss blähen immer das jüngste Intervall auf.
  const target = sessions.at(-1) ?? null;
  const [operation, setOperation] = useState<RecoveryOperation>("reduce");
  const [end, setEnd] = useState<Date | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);

  const preview = useMemo(() => buildRecoveryPreview({
    operation,
    sessionStartedAt: target?.startedAt ?? new Date(0).toISOString(),
    recordedEndedAt: target?.rawEndedAt ?? null,
    currentEffectiveEndedAt: target?.effectiveEndedAt ?? null,
    reviewedEndedAt: end ? end.toISOString() : null,
    reason,
  }), [operation, target, end, reason]);

  const hasRecordedEnd = target?.rawEndedAt !== null && target?.rawEndedAt !== undefined;
  const employee = item.employeeName;

  const confirmationLines = (): string[] => {
    const effective = formatSeconds(preview.effectiveSeconds);
    if (operation === "raise") {
      return [
        t("timesheets:recovery.confirmRaise", {
          previous: formatSeconds(preview.previousEffectiveSeconds ?? 0),
          effective,
          increase: formatSeconds(
            preview.effectiveSeconds - (preview.previousEffectiveSeconds ?? 0)),
        }),
        t("timesheets:recovery.confirmLogged"),
      ];
    }
    if (!hasRecordedEnd) {
      return [
        t("timesheets:recovery.confirmClosed", { employee, effective,
          end: end ? formatDateTimeLocalized(end.toISOString()) : "" }),
        t("timesheets:recovery.confirmLogged"),
      ];
    }
    return [
      t("timesheets:recovery.confirmReduce", { employee, effective,
        recorded: formatSeconds(preview.recordedSeconds ?? 0) }),
      t("timesheets:recovery.confirmKeepRaw"),
      t("timesheets:recovery.confirmLogged"),
    ];
  };

  const submitLabel = operation === "raise" ? "submitRaise"
    : hasRecordedEnd ? "submitReduce" : "submitClose";

  return <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
    <KeyboardAvoidingView style={styles.backdrop}
      behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.sheet}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{t("timesheets:recovery.title")}</Text>
          <TouchableOpacity onPress={onCancel} accessibilityRole="button" hitSlop={10}>
            <Ionicons name="close" size={22} color={theme.colors.onSurfaceVariant} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
          {error ? <ErrorBanner message={error} /> : null}

          <Card>
            <Text style={styles.employee}>{employee}</Text>
            <Text style={styles.meta}>{item.customerName}
              {item.serviceName ? ` · ${item.serviceName}` : ""}</Text>
            <Text style={styles.meta}>{t("timesheets:recovery.started", {
              time: item.employeeStartedAt
                ? formatDateTimeLocalized(item.employeeStartedAt) : "—" })}</Text>
            <Text style={styles.reasonCode}>{t(reasonCodeKey(item.reasonCode))}</Text>
          </Card>

          <Card>
            <Text style={styles.sectionTitle}>{t("timesheets:recovery.sessions")}</Text>
            {sessions.map((session) => <Text key={session.id} style={styles.meta}>
              {session.rawEndedAt
                ? t("timesheets:recovery.sessionRow", {
                    begin: formatDateTimeLocalized(session.startedAt),
                    end: formatDateTimeLocalized(session.effectiveEndedAt ?? session.rawEndedAt) })
                : t("timesheets:recovery.sessionOpenRow", {
                    begin: formatDateTimeLocalized(session.startedAt) })}
            </Text>)}
            {/* "Aufgezeichnet: 0:00" waere irrefuehrend: der Mitarbeiter hat
                nicht null Stunden gearbeitet, er hat kein Ende erfasst. */}
            <Text style={styles.meta}>{hasRecordedEnd
              ? t("timesheets:recovery.recorded", {
                  time: formatSeconds(preview.recordedSeconds ?? 0) })
              : t("timesheets:recovery.recordedMissing")}</Text>
          </Card>

          {audit.length > 0 ? <Card>
            <Text style={styles.sectionTitle}>{t("timesheets:recovery.auditTitle")}</Text>
            {audit.map((entry) => <View key={entry.correctionId}>
              <Text style={styles.meta}>{t("timesheets:recovery.auditRow", {
                revision: entry.revisionNo,
                origin: t(`timesheets:recovery.origin.${entry.origin}`),
                time: formatSeconds(entry.effectiveDurationSeconds) })}</Text>
              <Text style={styles.auditReason}>{entry.reason}</Text>
            </View>)}
          </Card> : null}

          <Card>
            <DateTimeField
              label={t("timesheets:recovery.endLabel")}
              placeholder={t("timesheets:recovery.endPlaceholder")}
              value={end}
              onChange={setEnd}
              mode="datetime"
              error={end === null ? undefined : preview.endOk
                ? undefined : t("timesheets:recovery.endMissing")}
            />
            {/* Live-Vorschau: die Abrechnungsfolge steht VOR der Bestaetigung
                in Zahlen auf dem Schirm, nicht erst danach. */}
            <Text style={styles.preview}>{t("timesheets:recovery.effective", {
              time: formatSeconds(preview.effectiveSeconds) })}</Text>
            {preview.correctionSeconds !== null ? <Text style={styles.preview}>
              {t("timesheets:recovery.correction", {
                time: formatSignedSeconds(preview.correctionSeconds) })}
            </Text> : null}

            <Input
              label={t("timesheets:recovery.reasonLabel")}
              placeholder={t("timesheets:recovery.reasonPlaceholder")}
              value={reason}
              onChangeText={setReason}
              multiline
              error={reason.length > 0 && !preview.reasonOk
                ? t("timesheets:recovery.reasonTooShort", { count: preview.reasonMin })
                : undefined}
            />
          </Card>

          {/* raise ist NICHT die Standardaktion: eigener Abschnitt, eigene
              Beschriftung, laengerer Pflichtgrund. */}
          <Card>
            <Text style={styles.sectionTitle}>{t("timesheets:recovery.raiseSection")}</Text>
            <Text style={styles.meta}>{t("timesheets:recovery.raiseHint")}</Text>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>{t("timesheets:recovery.raiseToggle")}</Text>
              <Switch
                value={operation === "raise"}
                onValueChange={(next) => setOperation(next ? "raise" : "reduce")}
                accessibilityLabel={t("timesheets:recovery.raiseToggle")}
              />
            </View>
          </Card>
        </ScrollView>

        <View style={styles.footer}>
          <Button
            label={t(`timesheets:recovery.${submitLabel}`)}
            onPress={() => setConfirming(true)}
            disabled={!preview.canSubmit || submitting || !target}
            loading={submitting}
          />
        </View>
      </View>
    </KeyboardAvoidingView>

    {confirming && target && end ? <Modal visible transparent animationType="fade"
      onRequestClose={() => setConfirming(false)}>
      <View style={styles.backdrop}>
        <View style={styles.confirm}>
          <Text style={styles.title}>{t("timesheets:recovery.confirmTitle")}</Text>
          {confirmationLines().map((line) => <Text key={line} style={styles.confirmLine}>{line}</Text>)}
          <Button label={t("timesheets:recovery.confirmCta")} loading={submitting}
            onPress={() => {
              setConfirming(false);
              onSubmit({ operation, sessionId: target.id,
                effectiveEndedAt: end.toISOString(), reason: reason.trim() });
            }} />
          <Button label={t("common:actions.cancel")} variant="secondary"
            onPress={() => setConfirming(false)} />
        </View>
      </View>
    </Modal> : null}
  </Modal>;
}

function createStyles(theme: AppTheme, isRTL: boolean) {
  return StyleSheet.create({
    backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
    sheet: {
      backgroundColor: theme.colors.background, borderTopLeftRadius: theme.radius.lg,
      borderTopRightRadius: theme.radius.lg, maxHeight: "92%", paddingBottom: theme.spacing.lg,
    },
    headerRow: {
      flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center",
      justifyContent: "space-between", padding: theme.spacing.lg,
    },
    title: {
      fontFamily: theme.typography.family.bold, fontSize: theme.typography.size.lg,
      color: theme.colors.onSurface, textAlign: isRTL ? "right" : "left",
    },
    body: { paddingHorizontal: theme.spacing.lg },
    employee: {
      fontFamily: theme.typography.family.medium, fontSize: theme.typography.size.md,
      color: theme.colors.onSurface, textAlign: isRTL ? "right" : "left",
    },
    meta: {
      fontSize: theme.typography.size.sm, color: theme.colors.onSurfaceVariant,
      textAlign: isRTL ? "right" : "left",
    },
    reasonCode: {
      fontSize: theme.typography.size.sm, color: theme.colors.statusInProgress,
      textAlign: isRTL ? "right" : "left",
    },
    sectionTitle: {
      fontFamily: theme.typography.family.medium, color: theme.colors.onSurface,
      marginBottom: theme.spacing.xs, textAlign: isRTL ? "right" : "left",
    },
    auditReason: {
      fontSize: theme.typography.size.xs, color: theme.colors.onSurfaceVariant,
      marginBottom: theme.spacing.xs, textAlign: isRTL ? "right" : "left",
    },
    preview: {
      fontFamily: theme.typography.family.medium, color: theme.colors.onSurface,
      marginTop: theme.spacing.xs, textAlign: isRTL ? "right" : "left",
    },
    switchRow: {
      flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center",
      justifyContent: "space-between", marginTop: theme.spacing.sm,
    },
    switchLabel: { color: theme.colors.onSurface, flex: 1, textAlign: isRTL ? "right" : "left" },
    footer: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md },
    confirm: {
      margin: theme.spacing.lg, padding: theme.spacing.lg, borderRadius: theme.radius.lg,
      backgroundColor: theme.colors.surface, gap: theme.spacing.sm,
      alignSelf: "center", width: "90%",
    },
    confirmLine: {
      color: theme.colors.onSurface, fontSize: theme.typography.size.sm,
      textAlign: isRTL ? "right" : "left",
    },
  });
}
