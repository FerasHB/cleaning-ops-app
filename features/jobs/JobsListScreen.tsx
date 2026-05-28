// features/jobs/JobsListScreen.tsx
// Gemeinsamer Jobs-Tab für Employee und Admin.
// Employee: sieht eigene Jobs (JobContext liefert sie rollenabhängig).
// Admin: sieht alle Jobs + Plus-Button zum Erstellen + Mitarbeiter-Name auf der Card.
// Business-Logik (JobContext) unverändert.

import { EmptyState, LoadingScreen } from "@/components/ui";
import JobCard from "@/components/JobCard";
import { useJobs } from "@/context/JobContext";
import { useAuth } from "@/context/AuthContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";

type Filter = "all" | "open" | "in_progress" | "completed";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "open", label: "Offen" },
  { key: "in_progress", label: "In Arbeit" },
  { key: "completed", label: "Erledigt" },
];

export default function JobsListScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { role } = useAuth();
  const { jobs, startJob, completeJob, loading } = useJobs();
  const [filter, setFilter] = useState<Filter>("all");

  const isAdmin = role === "admin";

  const filteredJobs = useMemo(() => {
    if (filter === "all") return jobs;
    return jobs.filter((j) => j.status === filter);
  }, [filter, jobs]);

  if (loading) return <LoadingScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      <FlatList
        data={filteredJobs}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>Jobs</Text>

            <View style={styles.filterRow}>
              {FILTERS.map((f) => {
                const active = filter === f.key;
                return (
                  <TouchableOpacity
                    key={f.key}
                    onPress={() => setFilter(f.key)}
                    activeOpacity={0.8}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        active && styles.chipTextActive,
                      ]}
                    >
                      {f.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title={
              filter === "all"
                ? "Keine Jobs vorhanden"
                : "Keine Jobs in diesem Filter"
            }
            message={
              filter === "all"
                ? "Sobald ein Job erstellt wird, erscheint er hier."
                : "Wähle einen anderen Filter."
            }
            icon="briefcase-outline"
          />
        }
        renderItem={({ item }) => (
          <JobCard
            job={item}
            onStart={() => startJob(item.id)}
            onComplete={() => completeJob(item.id)}
            onPress={() => router.push(`/jobs/${item.id}`)}
            showEmployeeName={isAdmin}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />

      {/* ── Plus-Button (nur Admin) ── */}
      {isAdmin && (
        <TouchableOpacity
          style={styles.fab}
          activeOpacity={0.85}
          onPress={() => router.push("/jobs/create")}
        >
          <Ionicons
            name="add"
            size={28}
            color={theme.colors.onPrimaryContainer}
          />
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    listContent: {
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: 96,
      flexGrow: 1,
    },
    header: {
      paddingTop: theme.spacing.xl,
      marginBottom: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    title: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    filterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
    },
    chip: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
    },
    chipActive: {
      backgroundColor: theme.colors.primaryContainer,
      borderColor: theme.colors.primaryContainer,
    },
    chipText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
    chipTextActive: {
      color: theme.colors.onPrimaryContainer,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
    },
    separator: {
      height: theme.spacing.sm,
    },
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
