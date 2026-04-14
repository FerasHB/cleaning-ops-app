// screens/HomeScreen.tsx
import { useAuth } from "@/context/AuthContext";

import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { EmptyState, LoadingScreen } from "@/components/ui";
import {
  Colors,
  Radius,
  Shadows,
  Spacing,
  Typography,
} from "@/constants/theme";
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
  const { jobs, startJob, completeJob, loading } = useJobs();
  const { signOut, role, user } = useAuth();
  const { t } = useTranslation();

  const [selectedFilter, setSelectedFilter] = useState<
    "all" | "open" | "in_progress" | "completed"
  >("all");

  const headerAnim = useFadeIn(0);
  const statsAnim = useFadeIn(80);
  const listAnim = useFadeIn(160);

  const handleLogout = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error("Logout failed:", error);
    }
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
      <StatusBar barStyle="light-content" />

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
          />
        }
        ListHeaderComponent={
          <>
            {/* ── Header ── */}
            <Animated.View style={[styles.header, headerAnim]}>
              <View style={styles.headerLeft}>
                <View style={styles.greetingRow}>
                  <View style={styles.onlineDot} />
                  <Text style={styles.greetingHint}>Willkommen zurück</Text>
                </View>
                <Text style={styles.greeting}>{firstName} 👋</Text>
                <Text style={styles.subtitle}>{t("subtitle")}</Text>
              </View>

              <View style={styles.headerActions}>
                {role === "admin" && (
                  <TouchableOpacity
                    onPress={() => router.push("/admin")}
                    style={styles.adminBtn}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.adminBtnText}>Admin</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={handleLogout}
                  style={styles.avatar}
                  activeOpacity={0.75}
                >
                  <Text style={styles.avatarText}>
                    {firstName.charAt(0).toUpperCase()}
                  </Text>
                </TouchableOpacity>
              </View>
            </Animated.View>

            {/* ── Stats Grid ── */}
            <Animated.View style={[styles.statsGrid, statsAnim]}>
              <StatCard
                label="Gesamt"
                count={jobs.length}
                active={selectedFilter === "all"}
                color={Colors.text.secondary}
                activeBg={Colors.bg.elevated}
                onPress={() => setSelectedFilter("all")}
              />
              <StatCard
                label="Offen"
                count={openJobs.length}
                active={selectedFilter === "open"}
                color={Colors.status.warning}
                activeBg={Colors.status.warningBg}
                onPress={() => setSelectedFilter("open")}
              />
              <StatCard
                label="In Arbeit"
                count={inProgressJobs.length}
                active={selectedFilter === "in_progress"}
                color={Colors.accent.text}
                activeBg={Colors.accent.subtle}
                onPress={() => setSelectedFilter("in_progress")}
              />
              <StatCard
                label="Erledigt"
                count={doneJobs.length}
                active={selectedFilter === "completed"}
                color={Colors.status.success}
                activeBg={Colors.status.successBg}
                onPress={() => setSelectedFilter("completed")}
              />
            </Animated.View>

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
}: {
  item: any;
  index: number;
  onStart: () => void;
  onComplete: () => void;
  onEdit?: () => void;
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
      />
    </Animated.View>
  );
}

// ── Stat Card ──
function StatCard({
  label,
  count,
  color,
  activeBg,
  active,
  onPress,
}: {
  label: string;
  count: number;
  color: string;
  activeBg: string;
  active: boolean;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = () =>
    Animated.spring(scale, {
      toValue: 0.96,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  const onPressOut = () =>
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 30,
      bounciness: 6,
    }).start();

  return (
    <Animated.View style={[styles.statCardWrap, { transform: [{ scale }] }]}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={1}
        style={[
          styles.statCard,
          active && { backgroundColor: activeBg, borderColor: color + "40" },
        ]}
      >
        <Text style={[styles.statCount, { color }]}>{count}</Text>
        <Text style={styles.statLabel}>{label}</Text>
        {active && (
          <View style={[styles.statActiveDot, { backgroundColor: color }]} />
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg.base,
  },
  listContent: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: 48,
  },

  // Header
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingTop: Spacing.xl,
    marginBottom: Spacing.xxl,
  },
  headerLeft: {
    flex: 1,
    gap: 4,
  },
  greetingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 2,
  },
  onlineDot: {
    width: 6,
    height: 6,
    borderRadius: Radius.full,
    backgroundColor: Colors.status.success,
  },
  greetingHint: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
    fontWeight: Typography.weight.medium,
    letterSpacing: Typography.tracking.wide,
  },
  greeting: {
    fontSize: Typography.size.xxl,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    letterSpacing: Typography.tracking.tight,
    lineHeight: Typography.size.xxl * Typography.leading.tight,
  },
  subtitle: {
    fontSize: Typography.size.sm,
    color: Colors.text.muted,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginTop: 4,
  },

  // Admin Button
  adminBtn: {
    backgroundColor: Colors.accent.muted,
    borderWidth: 1,
    borderColor: Colors.accent.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: 7,
    borderRadius: Radius.full,
  },
  adminBtnText: {
    fontSize: Typography.size.xs,
    fontWeight: Typography.weight.semibold,
    color: Colors.accent.text,
    letterSpacing: Typography.tracking.wide,
  },

  // Avatar
  avatar: {
    width: 38,
    height: 38,
    borderRadius: Radius.full,
    backgroundColor: Colors.bg.elevated,
    borderWidth: 1,
    borderColor: Colors.border.strong,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: Typography.size.base,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
  },

  // Stats Grid – 2x2
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
    marginBottom: Spacing.xxl,
  },
  statCardWrap: {
    width: "48.5%",
  },
  statCard: {
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border.default,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.md,
    gap: 4,
    position: "relative",
    overflow: "hidden",
    ...Shadows.sm,
  },
  statCount: {
    fontSize: Typography.size.xxl,
    fontWeight: Typography.weight.extrabold,
    letterSpacing: Typography.tracking.tight,
    lineHeight: Typography.size.xxl * Typography.leading.tight,
  },
  statLabel: {
    fontSize: Typography.size.xs,
    color: Colors.text.muted,
    fontWeight: Typography.weight.medium,
    letterSpacing: Typography.tracking.wide,
    textTransform: "uppercase",
  },
  statActiveDot: {
    position: "absolute",
    top: Spacing.md,
    right: Spacing.md,
    width: 6,
    height: 6,
    borderRadius: Radius.full,
  },

  // Sektion
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  sectionTitle: {
    fontSize: Typography.size.xs,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.muted,
    letterSpacing: Typography.tracking.wider,
    textTransform: "uppercase",
  },
  countBadge: {
    backgroundColor: Colors.bg.elevated,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border.default,
  },
  countText: {
    fontSize: Typography.size.xs,
    color: Colors.text.secondary,
    fontWeight: Typography.weight.semibold,
  },

  separator: {
    height: Spacing.sm,
  },
});
