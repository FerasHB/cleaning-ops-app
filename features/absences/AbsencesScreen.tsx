// features/absences/AbsencesScreen.tsx
// "Meine Abwesenheiten" — Übersicht über eigene Urlaubs-/Krankheitseinträge,
// gruppiert Aktuell/Bevorstehend/Vergangen (siehe utils/absenceGrouping.ts).
// Erreichbar über Profil → Meine Arbeit → Abwesenheiten.

import {
  AppHeader,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingScreen,
  ScreenContainer,
  SectionHeader,
} from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { AbsenceCard } from "./components/AbsenceCard";
import { useAbsences } from "./hooks/useAbsences";
import { groupAbsences } from "@/utils/absenceGrouping";

export default function AbsencesScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const {
    absences,
    loading,
    loadError,
    refreshing,
    refresh,
    actionBusyId,
    actionError,
    clearActionError,
    cancelVacation,
    cancelSickness,
    updateSicknessEnd,
  } = useAbsences();

  const { current, upcoming, past } = useMemo(
    () => groupAbsences(absences),
    [absences],
  );

  if (loading) return <LoadingScreen />;

  return (
    <View style={styles.container}>
      <AppHeader title="Abwesenheiten" showBack />

      <ScreenContainer
        refreshing={refreshing}
        onRefresh={() => {
          void refresh();
        }}
      >
        {loadError ? (
          <View style={styles.bannerWrap}>
            <ErrorBanner
              message={loadError}
              actionLabel="Erneut versuchen"
              onAction={() => {
                void refresh();
              }}
            />
          </View>
        ) : null}

        {actionError ? (
          <View style={styles.bannerWrap}>
            <ErrorBanner message={actionError} onDismiss={clearActionError} />
          </View>
        ) : null}

        {/* ── Aktionen ── */}
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.actionCard}
            activeOpacity={0.85}
            onPress={() => router.push("/absences/request-vacation")}
          >
            <Ionicons name="sunny-outline" size={20} color={theme.colors.primary} />
            <Text style={styles.actionCardText}>Urlaub beantragen</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionCard}
            activeOpacity={0.85}
            onPress={() => router.push("/absences/report-sickness")}
          >
            <Ionicons
              name="medkit-outline"
              size={20}
              color={theme.colors.statusOpen}
            />
            <Text style={styles.actionCardText}>Krank melden</Text>
          </TouchableOpacity>
        </View>

        {absences.length === 0 ? (
          <Card>
            <EmptyState
              title="Noch keine Abwesenheiten erfasst."
              icon="calendar-outline"
            />
          </Card>
        ) : (
          <>
            <AbsenceGroupSection
              title="Aktuell"
              absences={current}
              actionBusyId={actionBusyId}
              onCancelVacation={cancelVacation}
              onCancelSickness={cancelSickness}
              onUpdateSicknessEnd={updateSicknessEnd}
            />
            <AbsenceGroupSection
              title="Bevorstehend"
              absences={upcoming}
              actionBusyId={actionBusyId}
              onCancelVacation={cancelVacation}
              onCancelSickness={cancelSickness}
              onUpdateSicknessEnd={updateSicknessEnd}
            />
            <AbsenceGroupSection
              title="Vergangen"
              absences={past}
              actionBusyId={actionBusyId}
              onCancelVacation={cancelVacation}
              onCancelSickness={cancelSickness}
              onUpdateSicknessEnd={updateSicknessEnd}
            />
          </>
        )}

        <View style={{ height: theme.spacing.xl }} />
      </ScreenContainer>
    </View>
  );
}

function AbsenceGroupSection({
  title,
  absences,
  actionBusyId,
  onCancelVacation,
  onCancelSickness,
  onUpdateSicknessEnd,
}: {
  title: string;
  absences: ReturnType<typeof groupAbsences>["current"];
  actionBusyId: string | null;
  onCancelVacation: (id: string) => void;
  onCancelSickness: (id: string) => void;
  onUpdateSicknessEnd: (id: string, newEndDate: string | null) => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (absences.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionHeader title={title} />
      <View style={styles.cardList}>
        {absences.map((absence) => (
          <AbsenceCard
            key={absence.id}
            absence={absence}
            busy={actionBusyId === absence.id}
            onCancelVacation={() => onCancelVacation(absence.id)}
            onCancelSickness={() => onCancelSickness(absence.id)}
            onUpdateSicknessEnd={(newEndDate) =>
              onUpdateSicknessEnd(absence.id, newEndDate)
            }
          />
        ))}
      </View>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    bannerWrap: {
      marginBottom: theme.spacing.md,
    },
    actionRow: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.xl,
    },
    actionCard: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    actionCardText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    section: {
      marginBottom: theme.spacing.xl,
    },
    cardList: {
      gap: theme.spacing.sm,
    },
  });
}
