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
  SectionHeader,
} from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { router } from "expo-router";
import React, { useCallback, useMemo, useRef } from "react";
import {
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AbsenceCard } from "./components/AbsenceCard";
import { VacationBalanceCard } from "./components/VacationBalanceCard";
import { useOwnVacationBalance } from "./hooks/useOwnVacationBalance";
import { useAbsences } from "./hooks/useAbsences";
import { groupAbsences } from "@/utils/absenceGrouping";

export default function AbsencesScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const {
    absences,
    loading,
    loadError,
    load,
    refreshing,
    refresh,
    actionBusyId,
    actionError,
    clearActionError,
    cancelVacation,
    cancelSickness,
    updateSicknessEnd,
  } = useAbsences();

  // Lädt bei JEDEM Fokussieren neu, nicht nur beim Mounten — Urlaub
  // beantragen/Krank melden sind eigene Root-Stack-Screens (app/absences/
  // request-vacation, report-sickness), die diesen Screen beim
  // Zurücknavigieren NICHT neu mounten. Gleiches Muster wie
  // AdminRecurringRulesScreen/JobDetailScreen: erstes Fokussieren lädt mit
  // vollem Spinner, jedes weitere still im Hintergrund (RefreshControl bleibt
  // unberührt, kein zusätzlicher Request beim allerersten Mount).
  const hasLoadedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      load({ silent: hasLoadedOnceRef.current });
      hasLoadedOnceRef.current = true;
    }, [load]),
  );

  const { current, upcoming, past } = useMemo(
    () => groupAbsences(absences),
    [absences],
  );

  // Urlaubskonto: liefert null, solange es nicht aktiv UND initialisiert ist —
  // die Karte rendert dann bewusst gar nichts (kein erfundenes "0 Tage").
  const vacationBalance = useOwnVacationBalance();
  const pendingVacations = useMemo(
    () => absences.filter((a) => a.type === "vacation" && a.status === "requested"),
    [absences],
  );

  if (loading) return <LoadingScreen />;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <AppHeader title="Abwesenheiten" showBack />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void refresh();
            }}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
          />
        }
      >
        <VacationBalanceCard balance={vacationBalance} pending={pendingVacations} />

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
      </ScrollView>
    </SafeAreaView>
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
  onUpdateSicknessEnd: (id: string, newEndDate: string | null) => Promise<unknown>;
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
    scrollContent: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.gutter,
      paddingTop: theme.spacing.lg,
      paddingBottom: 32,
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
