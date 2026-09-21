// features/jobs/components/JobScheduleCard.tsx
// Terminierungs-Details eines AUSFÜHRBAREN Termins: geplanter Start und —
// falls eine Dauer geplant ist — geplante Dauer + daraus abgeleitetes Ende.
//
// Parent-Regeln laufen seit der eigenen Regel-Ansicht
// (RecurringRuleDetailScreen → RuleScheduleSummary) nicht mehr durch diese
// Karte; der frühere Wochentage/Uhrzeit/Gültigkeits-Zweig ist deshalb
// entfallen. Ebenso der Hinweis „Generierter Termin eines Dauerauftrags." —
// die Herkunft steht jetzt EINMAL und antippbar im Screen
// (OccurrenceOriginLink) statt zweimal als toter Text.
//
// Das geplante Ende kommt seit Phase 3 (Planned Duration Foundation) aus
// startTime + plannedDurationMinutes (getPlannedEndTime) — NICHT aus
// scheduledEnd, das von keinem Schreibpfad befüllt wird (siehe CLAUDE.md).
//
// Reine Anzeige, keine geänderte Terminierungs-Logik, keine neue Abfrage.

import { Card, InfoRow } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { formatDurationLong } from "@/utils/date";
import { formatJobScheduleLocalized, getPlannedEndTime } from "@/utils/jobSchedule";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";

type Props = {
  job: Pick<Job, "date" | "scheduledStart" | "startTime" | "plannedDurationMinutes">;
};

export function JobScheduleCard({ job }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  const plannedEnd = getPlannedEndTime(job);

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <InfoRow
        label={t("jobs:detail.jobTypeLabel")}
        value={t("jobs:detail.jobTypeSingle")}
        icon="calendar-outline"
      />
      <View style={styles.rowDivider} />
      <InfoRow
        label={t("jobs:detail.plannedStart")}
        value={formatJobScheduleLocalized(job) ?? t("jobs:detail.noScheduledDate")}
        icon="calendar-outline"
      />
      {job.plannedDurationMinutes ? (
        <>
          <View style={styles.rowDivider} />
          <InfoRow
            label={t("jobs:detail.plannedDuration")}
            value={formatDurationLong(job.plannedDurationMinutes)}
            icon="time-outline"
          />
        </>
      ) : null}
      {plannedEnd ? (
        <>
          <View style={styles.rowDivider} />
          <InfoRow
            label={t("jobs:detail.plannedEnd")}
            value={plannedEnd}
            icon="calendar-outline"
          />
        </>
      ) : null}
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.md,
    },
    rowDivider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
    },
  });
}
