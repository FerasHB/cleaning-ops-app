// features/home/HomeScreen.tsx
// Dashboard / Übersicht — wird sowohl von Employee Home als auch vom Admin-Tab "Übersicht" verwendet.
// Vollständig theme-aware (Light + Dark Mode).
// Business-Logik (JobContext, AuthContext, useTranslation) unverändert.

import { EmptyState, LoadingScreen } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import HomeHeader from "@/features/home/components/HomeHeader";
import HomeStats from "@/features/home/components/HomeStats";
import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";
import JobCard from "../../components/JobCard";
import { useJobs } from "../../context/JobContext";
import { useTranslation } from "../../i18n/useTranslation";

// ── Fade-in Hook ──
function useFadeIn(delay = 0) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 420,
        delay,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 360,
        delay,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return { opacity, transform: [{ translateY }] };
}

export default function HomeScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { role, user } = useAuth();
  const { jobs, startJob, completeJob, loading } = useJobs();
  const { t } = useTranslation();

  const [selectedFilter, setSelectedFilter] = useState<
    "all" | "open" | "in_progress" | "completed"
  >("all");

  const headerAnim = useFadeIn(0);
  const statsAnim = useFadeIn(80);
  const listAnim = useFadeIn(160);

  const handleOpenProfile = () => {
    router.push("/profile");
  };

  if (loading) return <LoadingScreen />;

  const displayName = user?.email?.split("@")[0] ?? "Hey";
  const firstName = displayName.charAt(0).toUpperCase() + displayName.slice(1);

  const openJobs = jobs.filter((j) => j.status === "open");
  const inProgressJobs = jobs.filter((j) => j.status === "in_progress");
  const doneJobs = jobs.filter((j) => j.status === "completed");

  const filteredJobs = useMemo(() => {
    switch (selectedFilter) {
      case "open":
        return openJobs;
      case "in_progress":
        return inProgressJobs;
      case "completed":
        return doneJobs;
      default:
        return jobs;
    }
  }, [selectedFilter, jobs, openJobs, inProgressJobs, doneJobs]);

  const sectionLabel = {
    all: "Alle Jobs",
    open: "Offene Jobs",
    in_progress: "Jobs in Arbeit",
    completed: "Erledigte Jobs",
  }[selectedFilter];

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
        ListEmptyComponent={
          <EmptyState
            title={
              selectedFilter === "all"
                ? "Keine Jobs vorhanden"
                : "Keine Jobs in diesem Filter"
            }
            message={
              selectedFilter === "all"
                ? "Sobald ein Admin einen Job erstellt, erscheint er hier."
                : "Wähle einen anderen Filter oder erstelle neue Jobs."
            }
            icon="briefcase-outline"
          />
        }
        ListHeaderComponent={
          <>
            {/* ── Header ── */}
            <HomeHeader
              firstName={firstName}
              role={role}
              onLogout={handleOpenProfile}
              headerAnim={headerAnim}
            />

            {/* ── Stats Grid ── */}
            <HomeStats
              jobs={jobs}
              selectedFilter={selectedFilter}
              setSelectedFilter={setSelectedFilter}
              statsAnim={statsAnim}
            />

            {/* ── Abschnitts-Label ── */}
            <Animated.View style={[styles.sectionRow, listAnim]}>
              <Text style={styles.sectionTitle}>{sectionLabel}</Text>
              <View style={styles.countBadge}>
                <Text style={styles.countText}>{filteredJobs.length}</Text>
              </View>
            </Animated.View>
          </>
        }
        renderItem={({ item, index }) => (
          <AnimatedJobCard
            item={item}
            index={index}
            onPress={() => router.push(`/jobs/${item.id}`)}
            onStart={() => startJob(item.id)}
            onComplete={() => completeJob(item.id)}
            onEdit={
              role === "admin"
                ? () => router.push(`/jobs/${item.id}/edit`)
                : undefined
            }
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </SafeAreaView>
  );
}

// ── Staggered Job Card ──
function AnimatedJobCard({
  item,
  index,
  onStart,
  onComplete,
  onEdit,
  onPress,
}: {
  item: any;
  index: number;
  onStart: () => void;
  onComplete: () => void;
  onEdit?: () => void;
  onPress?: () => void;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(16)).current;

  useEffect(() => {
    const delay = 200 + index * 60;
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 380,
        delay,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 320,
        delay,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      <JobCard
        job={item}
        onStart={onStart}
        onComplete={onComplete}
        onEdit={onEdit}
        onPress={onPress}
      />
    </Animated.View>
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
      paddingBottom: 48,
      flexGrow: 1,
    },

    // Sektion-Label-Zeile
    sectionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.md,
    },
    sectionTitle: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wider,
      textTransform: "uppercase",
    },
    countBadge: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
    },
    countText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onSurfaceVariant,
      fontWeight: theme.typography.weight.semibold,
    },

    separator: {
      height: theme.spacing.sm,
    },
  });
}
