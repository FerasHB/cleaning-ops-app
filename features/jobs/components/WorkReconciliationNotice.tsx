import { Button, Card } from "@/components/ui";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { confirmDialog } from "@/utils/dialogs";
import type { WorkOperation } from "@/services/offline/workJournal.core";
import { reconciliationOptions } from "@/utils/assignmentWorkUi";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

export function WorkReconciliationNotice({ jobId }: { jobId?: string }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { jobs, workOperations, online, retryWorkSync, refreshJobs, refreshWorkUi,
    discardWorkOperation } = useJobs();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unresolved = workOperations.filter((op) => (!jobId || op.jobId === jobId) &&
    (op.status === "blocked" || op.status === "rejected_permanent" ||
      op.status === "pending" && (op.failureKind === "transport" || op.failureKind === "auth_expired")));
  if (unresolved.length === 0) return null;

  const actionLabel = (op: WorkOperation) => op.action === "start" ? t("jobs:actions.start")
    : op.action === "complete" ? t("jobs:actions.complete") : t(`jobs:work.${op.action}`);
  const run = async (id: string, action: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(id); setError(null);
    try { await action(); }
    catch { setError(t("jobs:work.actionFailed")); }
    finally { setBusyId(null); }
  };
  return <Card>
    <Text style={{ color: theme.colors.onSurface, fontWeight: "700" }}>
      {t("jobs:work.reconciliationTitle")}
    </Text>
    {unresolved.map((op) => {
      const { hasDependents, canRetry, canDiscard } = reconciliationOptions(op, workOperations, online);
      const retryable = op.status === "pending";
      const jobName = jobs.find((job) => job.id === op.jobId)?.customerName ?? t("jobs:work.unknownJob");
      return <View key={op.operationId} style={{ paddingTop: 12, gap: 6 }}>
        <Text style={{ color: theme.colors.onSurface }}>
          {t(op.status === "blocked" ? "jobs:work.blockedWaiting" : "jobs:work.failedAction",
            { action: actionLabel(op), job: jobName })}
        </Text>
        <Text style={{ color: theme.colors.onSurfaceVariant }}>
          {t(`jobs:work.reason.${op.failureKind ?? "permanent_rejection"}`)}
        </Text>
        {hasDependents ? <Text style={{ color: theme.colors.onSurfaceVariant }}>
          {t("jobs:work.dependentWaiting")}
        </Text> : null}
        {op.failureKind !== "transport" && op.failureKind !== "auth_expired" ?
          <Text style={{ color: theme.colors.statusInProgress }}>{t("jobs:work.adminReview")}</Text> : null}
        {retryable ? <Button label={t("jobs:work.retry")} icon="refresh-outline"
          disabled={!canRetry || !!busyId} loading={busyId === op.operationId}
          onPress={() => void run(op.operationId, retryWorkSync)} /> :
          <Button label={t("jobs:work.refresh")} icon="refresh-outline" variant="secondary"
            disabled={!!busyId} onPress={() => void run(op.operationId, async () => {
              await refreshJobs(); await refreshWorkUi();
            })} />}
        {canDiscard ? <Button label={t("jobs:work.discard")}
          icon="trash-outline" variant="secondary" disabled={!!busyId}
          onPress={() => void run(op.operationId, async () => {
            const confirmed = await confirmDialog({ title: t("jobs:work.discardTitle"),
              message: t("jobs:work.discardMessage"), confirmLabel: t("jobs:work.discard"),
              cancelLabel: t("common:actions.cancel") });
            if (confirmed) await discardWorkOperation(op.operationId);
          })} /> : null}
        {!retryable && hasDependents ? <Text style={{ color: theme.colors.onSurfaceVariant }}>
          {t("jobs:work.cannotDiscardChain")}
        </Text> : null}
      </View>;
    })}
    {error ? <Text style={{ color: theme.colors.error }}>{error}</Text> : null}
  </Card>;
}
