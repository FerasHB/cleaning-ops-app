// features/timesheets/RecoveryQueueScreen.tsx
// Firmenweite Admin-Prüfliste für Arbeitszeit, die der Mitarbeiter selbst nicht
// mehr abschließen kann (Migration 20260922000000).
//
// ABGRENZUNG: das ist NICHT die needsAttention-Liste des Stundenzettels. Die
// ist an einen Mitarbeiter und einen Monat gebunden und damit als stehende
// Warteschlange ungeeignet — ein Admin müsste jeden Mitarbeiter in jedem Monat
// durchblättern, um hängende Arbeit zu finden. Quelle hier ist ausschließlich
// get_work_recovery_queue().

import { AppHeader, Card, EmptyState, ErrorBanner, SectionHeader } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { SessionReviewSheet } from "@/features/timesheets/components/SessionReviewSheet";
import { useRecoveryQueue } from "@/features/timesheets/hooks/useRecoveryQueue";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useIsRTL } from "@/hooks/useIsRTL";
import { formatDateTimeLocalized } from "@/utils/date";
import {
  formatSeconds,
  hasRecordedEnd,
  reasonCodeKey,
  stuckHours,
} from "@/utils/sessionRecoveryUi";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function RecoveryQueueScreen() {
  const theme = useAppTheme();
  const isRTL = useIsRTL();
  const styles = useMemo(() => createStyles(theme, isRTL), [theme, isRTL]);
  const { t } = useTranslation();
  const queue = useRecoveryQueue();
  const now = Date.now();

  return <SafeAreaView style={styles.safe} edges={["top"]}>
    <StatusBar barStyle={theme.isDark ? "light-content" : "dark-content"}
      backgroundColor={theme.colors.background} />
    <AppHeader title={t("timesheets:recovery.title")} showBack />

    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <SectionHeader title={t("timesheets:recovery.title")}
        subtitle={t("timesheets:recovery.subtitle")} />
      {queue.error ? <ErrorBanner message={queue.error} /> : null}

      {queue.loading ? <View style={styles.center}><ActivityIndicator /></View>
        : queue.items.length === 0 ? <Card>
            <EmptyState title={t("timesheets:recovery.emptyTitle")}
              message={t("timesheets:recovery.empty")} icon="checkmark-done-outline" compact />
          </Card>
        : queue.items.map((item) => {
            // Ein Einsatz ohne erfasstes Arbeitsende darf nicht als
            // "Aufgezeichnet: 0:00" erscheinen — der Mitarbeiter hat nicht null
            // Stunden gearbeitet, er hat nur nicht auf "Beenden" getippt.
            const recordedKnown = hasRecordedEnd(item);
            return <TouchableOpacity key={item.assignmentId} accessibilityRole="button"
              onPress={() => void queue.open(item)}>
              <Card>
                <View style={styles.row}>
                  <Text style={styles.employee}>{item.employeeName}</Text>
                  <Text style={styles.stuck}>{t("timesheets:recovery.stuckSince",
                    { hours: stuckHours(item.stuckSince, now) })}</Text>
                </View>
                <Text style={styles.meta}>{item.customerName}
                  {item.serviceName ? ` · ${item.serviceName}` : ""}</Text>
                <Text style={styles.meta}>{t("timesheets:recovery.started", {
                  time: item.employeeStartedAt
                    ? formatDateTimeLocalized(item.employeeStartedAt) : "—" })}</Text>
                <Text style={styles.meta}>{recordedKnown
                  ? t("timesheets:recovery.recorded",
                      { time: formatSeconds(item.recordedSeconds) })
                  : t("timesheets:recovery.recordedMissing")}</Text>
                <Text style={styles.meta}>{t("timesheets:recovery.effective",
                  { time: formatSeconds(item.effectiveSeconds) })}</Text>
                <View style={styles.row}>
                  <Ionicons name="alert-circle-outline" size={16}
                    color={theme.colors.statusInProgress} />
                  <Text style={styles.reason}>{t(reasonCodeKey(item.reasonCode))}</Text>
                </View>
                {item.openSessionId ? <Text style={styles.open}>
                  {t("timesheets:recovery.openSession")}</Text> : null}
              </Card>
            </TouchableOpacity>;
          })}
    </ScrollView>

    {queue.selected ? <SessionReviewSheet
      item={queue.selected}
      sessions={queue.sessions}
      audit={queue.audit}
      submitting={queue.submitting}
      error={queue.submitError}
      onCancel={queue.close}
      onSubmit={(input) => void queue.submit(input)}
    /> : null}
  </SafeAreaView>;
}

function createStyles(theme: AppTheme, isRTL: boolean) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.colors.background },
    scroll: { padding: theme.spacing.lg, gap: theme.spacing.md },
    center: { paddingVertical: theme.spacing.xl, alignItems: "center" },
    row: {
      flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center",
      justifyContent: "space-between", gap: theme.spacing.xs,
    },
    employee: {
      fontFamily: theme.typography.family.medium, fontSize: theme.typography.size.md,
      color: theme.colors.onSurface, flex: 1, textAlign: isRTL ? "right" : "left",
    },
    stuck: { fontSize: theme.typography.size.xs, color: theme.colors.onSurfaceVariant },
    meta: {
      fontSize: theme.typography.size.sm, color: theme.colors.onSurfaceVariant,
      textAlign: isRTL ? "right" : "left",
    },
    reason: {
      flex: 1, fontSize: theme.typography.size.sm, color: theme.colors.statusInProgress,
      textAlign: isRTL ? "right" : "left",
    },
    open: {
      fontSize: theme.typography.size.sm, color: theme.colors.error,
      textAlign: isRTL ? "right" : "left",
    },
  });
}
