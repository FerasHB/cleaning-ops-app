// features/jobs/AdminJobsScreen.tsx
// Admin-Jobs-Bereich mit klarer Trennung über einen Segmented Control:
//   • Zeitplan      – ausführbare Termine (single + Occurrences), gebunden geladen
//   • Daueraufträge – nur Parent-Regeln (job_type='recurring', parent_job_id NULL)
//
// Bewusst EIN Screen mit zwei Sektionen (Segmented Control) statt zweier
// Bottom-Tabs: der Segmented Control ist gut erreichbar, jede Sektion lädt ihre
// eigenen gebundenen Daten, und die Struktur bildet die spätere Trennung
// (Zeitplan/Daueraufträge) direkt ab.

import AdminScheduleScreen from "@/features/jobs/AdminScheduleScreen";
import AdminRecurringRulesScreen from "@/features/jobs/AdminRecurringRulesScreen";
import { OfflineBanner } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import { StatusBar, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Segment = "zeitplan" | "daueraueftrage";

const SEGMENTS: { key: Segment; label: string; icon: any }[] = [
  { key: "zeitplan", label: "Zeitplan", icon: "calendar-outline" },
  { key: "daueraueftrage", label: "Daueraufträge", icon: "repeat-outline" },
];

export default function AdminJobsScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [segment, setSegment] = useState<Segment>("zeitplan");

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      <View style={styles.header}>
        <OfflineBanner />
        <Text style={styles.title}>Jobs</Text>

        {/* Segmented Control */}
        <View style={styles.segment}>
          {SEGMENTS.map((s) => {
            const active = segment === s.key;
            return (
              <TouchableOpacity
                key={s.key}
                style={[styles.segmentItem, active && styles.segmentItemActive]}
                onPress={() => setSegment(s.key)}
                activeOpacity={0.85}
              >
                <Ionicons
                  name={s.icon}
                  size={15}
                  color={
                    active
                      ? theme.colors.onPrimaryContainer
                      : theme.colors.onSurfaceVariant
                  }
                />
                <Text
                  style={[
                    styles.segmentText,
                    active && styles.segmentTextActive,
                  ]}
                >
                  {s.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={styles.body}>
        {segment === "zeitplan" ? (
          <AdminScheduleScreen />
        ) : (
          <AdminRecurringRulesScreen />
        )}
      </View>

      {/* Plus-Button: neuen Job/Dauerauftrag anlegen */}
      <TouchableOpacity
        style={styles.fab}
        activeOpacity={0.85}
        onPress={() => router.push("/jobs/create")}
      >
        <Ionicons name="add" size={28} color={theme.colors.onPrimaryContainer} />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.colors.background },
    header: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    title: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    segment: {
      flexDirection: "row",
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderRadius: theme.radius.md,
      padding: 3,
      gap: 3,
    },
    segmentItem: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 9,
      borderRadius: theme.radius.sm,
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
    body: { flex: 1, marginTop: theme.spacing.sm },
    fab: {
      position: "absolute",
      right: theme.spacing.lg,
      bottom: theme.spacing.xl,
      width: 56,
      height: 56,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
      ...theme.shadows.md,
    },
  });
}
