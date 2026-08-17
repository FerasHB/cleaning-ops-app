// features/absences/admin/EmployeeAbsenceHistoryScreen.tsx
// "Alle anzeigen" aus dem Abwesenheiten-Abschnitt in EmployeeDetailScreen —
// volle Abwesenheitshistorie eines Mitarbeiters, gruppiert wie
// features/absences/AbsencesScreen.tsx (Aktuell/Bevorstehend/Vergangen, via
// utils/absenceGrouping.ts — keine zweite Gruppierungslogik). Pending
// Urlaubsanträge bleiben genehmig-/ablehnbar, egal in welcher Gruppe sie
// landen (AdminAbsenceRow zeigt Aktionen nur bei status=requested Urlaub).

import {
  AppHeader,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingScreen,
  SectionHeader,
} from "@/components/ui";
import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { groupAbsences } from "@/utils/absenceGrouping";
import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useMemo, useRef } from "react";
import { RefreshControl, ScrollView, StatusBar, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AdminAbsenceRow } from "./components/AdminAbsenceRow";
import { useEmployeeAbsences } from "./hooks/useEmployeeAbsences";

const HISTORY_LIMIT = 100;

export default function EmployeeAbsenceHistoryScreen({
  employeeId,
}: {
  employeeId: string;
}) {
  const theme = useAppTheme();
  const { employees } = useJobs();
  const employee = employees.find((e) => e.id === employeeId);

  const {
    absences,
    loading,
    loadError,
    load,
    refreshing,
    refresh,
    busyId,
    error: actionError,
    clearError,
    approve,
    reject,
  } = useEmployeeAbsences(employeeId, HISTORY_LIMIT);

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

  if (loading) return <LoadingScreen />;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      edges={["top"]}
    >
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <AppHeader
        title={employee ? `Abwesenheiten — ${employee.fullName}` : "Abwesenheiten"}
        showBack
      />

      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: theme.spacing.gutter,
          paddingTop: theme.spacing.lg,
          paddingBottom: 32,
        }}
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
        {loadError ? (
          <View style={{ marginBottom: theme.spacing.md }}>
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
          <View style={{ marginBottom: theme.spacing.md }}>
            <ErrorBanner message={actionError} onDismiss={clearError} />
          </View>
        ) : null}

        {absences.length === 0 ? (
          <Card>
            <EmptyState
              title="Keine Abwesenheiten erfasst."
              icon="calendar-outline"
            />
          </Card>
        ) : (
          <>
            <HistoryGroup
              title="Aktuell"
              absences={current}
              busyId={busyId}
              onApprove={approve}
              onReject={reject}
            />
            <HistoryGroup
              title="Bevorstehend"
              absences={upcoming}
              busyId={busyId}
              onApprove={approve}
              onReject={reject}
            />
            <HistoryGroup
              title="Vergangen"
              absences={past}
              busyId={busyId}
              onApprove={approve}
              onReject={reject}
            />
          </>
        )}

        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function HistoryGroup({
  title,
  absences,
  busyId,
  onApprove,
  onReject,
}: {
  title: string;
  absences: ReturnType<typeof groupAbsences>["current"];
  busyId: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string, note: string) => void;
}) {
  const theme = useAppTheme();
  if (absences.length === 0) return null;

  return (
    <View style={{ marginBottom: theme.spacing.xl, gap: theme.spacing.sm }}>
      <SectionHeader title={title} />
      <View style={{ gap: theme.spacing.sm }}>
        {absences.map((absence) => (
          <AdminAbsenceRow
            key={absence.id}
            absence={absence}
            busy={busyId === absence.id}
            showEmployeeName={false}
            onApprove={onApprove}
            onReject={onReject}
          />
        ))}
      </View>
    </View>
  );
}
