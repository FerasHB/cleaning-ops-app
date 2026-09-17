// features/jobs/components/JobServiceDetailsCard.tsx
// "Was ist zu tun?" — der Leistungs-/Service-Text des Auftrags, getrennt von
// der Terminierung (JobScheduleCard). Reine Anzeige, keine neue Logik.

import { Card, InfoRow } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";

type Props = {
  service: string;
};

export function JobServiceDetailsCard({ service }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <InfoRow label={t("jobs:detail.serviceLabel")} value={service} icon="construct-outline" />
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.md,
    },
  });
}
