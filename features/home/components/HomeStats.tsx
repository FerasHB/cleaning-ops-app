// features/home/components/HomeStats.tsx
// 4 Statistik-Kacheln (Gesamt / Offen / In Arbeit / Erledigt) als Filter-Toggles.
// Vollständig theme-aware (Light + Dark Mode).

import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useMemo, useRef } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { AppTheme } from "@/constants/theme";

type FilterType = "all" | "open" | "in_progress" | "completed";

type HomeStatsProps = {
  jobs: {
    id: string;
    status: "open" | "in_progress" | "completed";
  }[];
  selectedFilter: FilterType;
  setSelectedFilter: React.Dispatch<React.SetStateAction<FilterType>>;
  statsAnim: {
    opacity: Animated.Value;
    transform: { translateY: Animated.Value }[];
  };
};

// ── Theme-spezifische Farbpaare pro Filter
function getStatColors(theme: AppTheme, kind: FilterType) {
  switch (kind) {
    case "all":
      return {
        color:       theme.colors.onSurface,
        activeBg:    theme.colors.surfaceContainerHigh,
        activeBorder: theme.colors.outline,
      };
    case "open":
      return {
        color:        theme.colors.statusOpen,
        activeBg:     theme.colors.statusOpenBg,
        activeBorder: theme.colors.statusOpenBorder,
      };
    case "in_progress":
      return {
        color:        theme.colors.statusInProgress,
        activeBg:     theme.colors.statusInProgressBg,
        activeBorder: theme.colors.statusInProgressBorder,
      };
    case "completed":
      return {
        color:        theme.colors.statusCompleted,
        activeBg:     theme.colors.statusCompletedBg,
        activeBorder: theme.colors.statusCompletedBorder,
      };
  }
}

export default function HomeStats({
  jobs,
  selectedFilter,
  setSelectedFilter,
  statsAnim,
}: HomeStatsProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const openJobs = jobs.filter((job) => job.status === "open");
  const inProgressJobs = jobs.filter((job) => job.status === "in_progress");
  const completedJobs = jobs.filter((job) => job.status === "completed");

  return (
    <Animated.View style={[styles.statsGrid, statsAnim]}>
      <StatCard
        label="Gesamt"
        count={jobs.length}
        active={selectedFilter === "all"}
        kind="all"
        onPress={() => setSelectedFilter("all")}
      />

      <StatCard
        label="Offen"
        count={openJobs.length}
        active={selectedFilter === "open"}
        kind="open"
        onPress={() => setSelectedFilter("open")}
      />

      <StatCard
        label="In Arbeit"
        count={inProgressJobs.length}
        active={selectedFilter === "in_progress"}
        kind="in_progress"
        onPress={() => setSelectedFilter("in_progress")}
      />

      <StatCard
        label="Erledigt"
        count={completedJobs.length}
        active={selectedFilter === "completed"}
        kind="completed"
        onPress={() => setSelectedFilter("completed")}
      />
    </Animated.View>
  );
}

type StatCardProps = {
  label: string;
  count: number;
  kind: FilterType;
  active: boolean;
  onPress: () => void;
};

function StatCard({ label, count, kind, active, onPress }: StatCardProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const colors = getStatColors(theme, kind);

  const scale = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scale, {
      toValue: 0.96,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 30,
      bounciness: 6,
    }).start();
  };

  return (
    <Animated.View style={[styles.statCardWrap, { transform: [{ scale }] }]}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
        style={[
          styles.statCard,
          active && {
            backgroundColor: colors.activeBg,
            borderColor: colors.activeBorder,
          },
        ]}
      >
        <Text style={[styles.statCount, { color: colors.color }]}>{count}</Text>
        <Text style={styles.statLabel}>{label}</Text>

        {active ? (
          <View
            style={[styles.statActiveDot, { backgroundColor: colors.color }]}
          />
        ) : null}
      </TouchableOpacity>
    </Animated.View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    statsGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.xxl,
    },
    statCardWrap: {
      width: "48.5%",
    },
    statCard: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      paddingVertical: theme.spacing.lg,
      paddingHorizontal: theme.spacing.md,
      gap: 4,
      position: "relative",
      overflow: "hidden",
      ...theme.shadows.sm,
    },
    statCount: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.extrabold,
      letterSpacing: theme.typography.letterSpacing.tight,
      lineHeight: theme.typography.lineHeight.xxl,
    },
    statLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wide,
      textTransform: "uppercase",
    },
    statActiveDot: {
      position: "absolute",
      top: theme.spacing.md,
      right: theme.spacing.md,
      width: 6,
      height: 6,
      borderRadius: theme.radius.full,
    },
  });
}
