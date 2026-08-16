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
  ScreenContainer,
} from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import { router, useFocusEffect } from "expo-router";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { AdminAbsenceRow } from "./components/AdminAbsenceRow";
import { useAdminAbsences } from "./hooks/useAdminAbsences";

type Segment = "vacation" | "sickness";

const SEGMENTS: { key: Segment; label: string }[] = [
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

  const list = segment === "vacation" ? pendingVacations : sicknessReports;

  return (
    <View style={styles.container}>
      <AppHeader title="Abwesenheiten verwalten" showBack />

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
            <ErrorBanner message={actionError} onDismiss={clearError} />
          </View>
        ) : null}

        {/* ── Segmented Control (gleiche Bauform wie JobFormFields' Auftragstyp) ── */}
        <View style={styles.segment}>
          {SEGMENTS.map((opt) => {
            const active = segment === opt.key;
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
                  : "Keine Krankmeldungen."
              }
              icon={segment === "vacation" ? "sunny-outline" : "medkit-outline"}
            />
          </Card>
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
      </ScreenContainer>
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
