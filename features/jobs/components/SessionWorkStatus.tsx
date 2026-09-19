import { Card } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { WorkAction, WorkAssignmentState } from "@/services/offline/workJournal.core";
import { formatTimeHHmm } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

export function SessionWorkStatus({ state, workedLabel, pendingAction, reviewRequired, latestSessionEnd }: {
  state: WorkAssignmentState | "loading"; workedLabel: string; pendingAction?: WorkAction;
  reviewRequired: boolean; latestSessionEnd?: string | null;
}) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const pausedAt = latestSessionEnd ? formatTimeHHmm(new Date(latestSessionEnd)) : null;
  return <Card>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Ionicons name={state === "active" ? "timer-outline" : "time-outline"} size={18}
        color={theme.colors.primary} />
      <Text style={{ color: theme.colors.onSurface, fontWeight: "600", flex: 1 }}>
        {t(`jobs:work.state.${state}`)} · {workedLabel} h
      </Text>
    </View>
    {state === "paused" && pausedAt ? <Text style={{ color: theme.colors.onSurfaceVariant }}>
      {t("jobs:work.pausedSince", { time: pausedAt })}
    </Text> : null}
    {pendingAction ? <Text style={{ color: theme.colors.onSurfaceVariant }}>
      {t(`jobs:work.pending.${pendingAction}`)} · {t("jobs:work.savedLocally")}
    </Text> : null}
    {reviewRequired ? <Text style={{ color: theme.colors.statusInProgress }}>
      {t("jobs:work.reviewRequired")}
    </Text> : null}
  </Card>;
}
