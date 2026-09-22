// features/timesheets/hooks/useRecoveryQueue.ts
// Datenbeschaffung der firmenweiten Admin-Prüfliste. Bewusst NICHT an Monat
// oder Mitarbeiter gebunden — die monatsbezogene needsAttention-Liste des
// Stundenzettels bleibt davon unberührt und behält ihre eigene Aufgabe.

import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getReviewSessions,
  getSessionCorrectionAudit,
  getWorkRecoveryQueue,
  reviewSessionAssignment,
  type RecoveryQueueItem,
  type SessionCorrectionAudit,
} from "@/services/timesheets/sessionRecovery.service";
import type { ReviewSession } from "@/features/timesheets/components/SessionReviewSheet";
import { fetchAssignmentWorkSummary } from "@/services/jobs/workSessions.service";
import type { RecoveryOperation } from "@/utils/sessionRecoveryUi";
import { toUserMessage } from "@/utils/userMessages";

export function useRecoveryQueue() {
  const { t } = useTranslation();
  const [items, setItems] = useState<RecoveryQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecoveryQueueItem | null>(null);
  const [sessions, setSessions] = useState<ReviewSession[]>([]);
  const [audit, setAudit] = useState<SessionCorrectionAudit[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await getWorkRecoveryQueue());
    } catch (err) {
      setError(toUserMessage(err, t("timesheets:recovery.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void reload(); }, [reload]);

  const open = useCallback(async (item: RecoveryQueueItem) => {
    setSelected(item);
    setSubmitError(null);
    setSessions([]);
    setAudit([]);
    try {
      const [sessionRows, chain] = await Promise.all([
        getReviewSessions(item.assignmentId),
        getSessionCorrectionAudit([item.assignmentId]),
      ]);
      setSessions(sessionRows);
      setAudit(chain);
    } catch (err) {
      setSubmitError(toUserMessage(err, t("timesheets:recovery.loadFailed")));
    }
  }, [t]);

  const submit = useCallback(async (input: {
    operation: RecoveryOperation; sessionId: string;
    effectiveEndedAt: string; reason: string;
  }) => {
    if (!selected) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Die erwartete Revision wird unmittelbar vor dem Schreiben frisch
      // gelesen. Weicht sie ab, lehnt der Server mit "Stale work revision" ab —
      // genau das soll passieren, wenn inzwischen jemand anders gehandelt hat.
      const summary = await fetchAssignmentWorkSummary(selected.assignmentId);
      await reviewSessionAssignment({
        recoveryId: Crypto.randomUUID(),
        assignmentId: selected.assignmentId,
        expectedRevision: summary.workRevision,
        reason: input.reason,
        corrections: [{
          sessionId: input.sessionId,
          // Die Aktionsart kommt aus der Oberfläche und wird nie aus den
          // Zeitstempeln erraten.
          operation: input.operation,
          effectiveEndedAt: input.effectiveEndedAt,
        }],
      });
      setSelected(null);
      await reload();
    } catch (err) {
      setSubmitError(toUserMessage(err, t("timesheets:recovery.submitFailed")));
    } finally {
      setSubmitting(false);
    }
  }, [selected, reload, t]);

  return { items, loading, error, reload, selected, sessions, audit,
    submitting, submitError, open, close: () => setSelected(null), submit };
}
