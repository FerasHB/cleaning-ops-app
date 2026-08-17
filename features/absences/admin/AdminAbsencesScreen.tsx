// features/absences/admin/AdminAbsencesScreen.tsx
// "Abwesenheiten verwalten" — die eine Admin-Workflow-Fläche für Phase C:
// zwei Reiter, Urlaubsanträge (Genehmigen/Ablehnen) und Krankmeldungen
// (read-only, siehe Architektur-Audit Phase C Abschnitt 9 — Krankheit ist ein
// Report, kein Genehmigungs-Workflow). Erreichbar über Dashboard-Chip,
// Profil → Administration, und den "Alle anzeigen"-Link in EmployeeDetail.
//
// Kein neuer Realtime-Kanal — useFocusEffect lädt bei jedem Refokussieren
// still neu (gleiches Muster wie AbsencesScreen), Aktionen aktualisieren die
// Liste optimistisch (siehe useAdminAbsences).

import {
  AppHeader,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingScreen,
} from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import { router, useFocusEffect } from "expo-router";
import React, { useCallback, useMemo, useRef, useState } from "react";
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
import { AbsentTodayRow } from "./components/AbsentTodayRow";
import { AdminAbsenceRow } from "./components/AdminAbsenceRow";
import { useAdminAbsences } from "./hooks/useAdminAbsences";

type Segment = "absent" | "vacation" | "sickness";

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "absent", label: "Abwesend" },
  { key: "vacation", label: "Urlaubsanträge" },
  { key: "sickness", label: "Krankmeldungen" },
];

export default function AdminAbsencesScreen({
  initialSegment = "vacation",
}: {
  initialSegment?: Segment;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [segment, setSegment] = useState<Segment>(initialSegment);

  const {
    pendingVacations,
    sicknessReports,
    activeToday,
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
  } = useAdminAbsences();

  const hasLoadedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      load({ silent: hasLoadedOnceRef.current });
      hasLoadedOnceRef.current = true;
    }, [load]),
  );

  if (loading) return <LoadingScreen />;

  const list =
    segment === "vacation"
      ? pendingVacations
      : segment === "sickness"
        ? sicknessReports
        : activeToday;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <AppHeader title="Abwesenheiten verwalten" showBack />

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
            <ErrorBanner message={actionError} onDismiss={clearError} />
          </View>
        ) : null}

        {/* ── Segmented Control (gleiche Bauform wie JobFormFields' Auftragstyp) ── */}
        <View style={styles.segment}>
          {SEGMENTS.map((opt) => {
            const active = segment === opt.key;
            // Nur der Urlaubsanträge-Reiter trägt eine Zähl-Badge (Warte-
            // schlange, die abgearbeitet werden muss) — "Abwesend" ist eine
            // Momentaufnahme, keine Warteschlange, daher bewusst ohne Zahl im
            // Segment (die Dashboard-Karte trägt die Zahl bereits).
            const count = opt.key === "vacation" ? pendingVacations.length : null;
            return (
              <TouchableOpacity
                key={opt.key}
                style={[styles.segmentItem, active && styles.segmentItemActive]}
                onPress={() => setSegment(opt.key)}
                activeOpacity={0.8}
              >
                <Text
                  style={[styles.segmentText, active && styles.segmentTextActive]}
                  numberOfLines={1}
                >
                  {opt.label}
                  {count ? ` (${count})` : ""}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity
          style={styles.createBtn}
          activeOpacity={0.85}
          onPress={() => router.push("/admin/absences/create")}
        >
          <Text style={styles.createBtnText}>Abwesenheit erfassen</Text>
        </TouchableOpacity>

        {list.length === 0 ? (
          <Card>
            <EmptyState
              title={
                segment === "vacation"
                  ? "Keine offenen Urlaubsanträge."
                  : segment === "sickness"
                    ? "Keine Krankmeldungen."
                    : "Heute sind keine Mitarbeiter abwesend."
              }
              icon={
                segment === "vacation"
                  ? "sunny-outline"
                  : segment === "sickness"
                    ? "medkit-outline"
                    : "walk-outline"
              }
            />
          </Card>
        ) : segment === "absent" ? (
          <View style={styles.cardList}>
            {activeToday.map((absence) => (
              <AbsentTodayRow
                key={absence.id}
                absence={absence}
                // Gelöschtes Konto (employeeId null) → nicht antippbar, bleibt
                // aber lesbar über employee_name_snapshot (siehe mapAbsence).
                onPress={
                  absence.employeeId
                    ? () => router.push(`/employees/${absence.employeeId}`)
                    : undefined
                }
              />
            ))}
          </View>
        ) : (
          <View style={styles.cardList}>
            {list.map((absence) => (
              <AdminAbsenceRow
                key={absence.id}
                absence={absence}
                busy={busyId === absence.id}
                onApprove={approve}
                onReject={reject}
              />
            ))}
          </View>
        )}

        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
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
    segment: {
      flexDirection: "row",
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: 3,
      gap: 3,
      marginBottom: theme.spacing.md,
    },
    segmentItem: {
      flex: 1,
      paddingVertical: 9,
      borderRadius: theme.radius.sm,
      alignItems: "center",
    },
    segmentItemActive: {
      backgroundColor: theme.colors.primaryContainer,
    },
    segmentText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    segmentTextActive: {
      color: theme.colors.onPrimaryContainer,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    createBtn: {
      alignSelf: "flex-start",
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 9,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
      marginBottom: theme.spacing.lg,
    },
    createBtnText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
    },
    cardList: {
      gap: theme.spacing.sm,
    },
  });
}
