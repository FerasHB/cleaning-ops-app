// features/jobs/components/JobScheduleCard.tsx
// Terminierungs-Details eines AUSFÜHRBAREN Termins: geplanter Start und —
// falls gesetzt — das geplante Ende.
//
// Parent-Regeln laufen seit der eigenen Regel-Ansicht
// (RecurringRuleDetailScreen → RuleScheduleSummary) nicht mehr durch diese
// Karte; der frühere Wochentage/Uhrzeit/Gültigkeits-Zweig ist deshalb
// entfallen. Ebenso der Hinweis „Generierter Termin eines Dauerauftrags." —
// die Herkunft steht jetzt EINMAL und antippbar im Screen
// (OccurrenceOriginLink) statt zweimal als toter Text.
//
// Reine Anzeige, keine geänderte Terminierungs-Logik, keine neue Abfrage.

import { Card, InfoRow } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { formatDateTimeDE } from "@/utils/date";
import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

type Props = {
  job: Pick<Job, "scheduledStart" | "scheduledEnd">;
};

export function JobScheduleCard({ job }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <InfoRow label="Auftragstyp" value="Einmalig" icon="calendar-outline" />
      <View style={styles.rowDivider} />
      <InfoRow
        label="Geplanter Start"
        value={formatDateTimeDE(job.scheduledStart) ?? "Kein Termin geplant"}
        icon="calendar-outline"
      />
      {job.scheduledEnd ? (
        <>
          <View style={styles.rowDivider} />
          <InfoRow
            label="Geplantes Ende"
            value={formatDateTimeDE(job.scheduledEnd) ?? "—"}
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
