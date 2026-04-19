// features/home/components/HomeStats.tsx
import {
  Colors,
  Radius,
  Shadows,
  Spacing,
  Typography,
} from "@/constants/theme";
import React, { useRef } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type FilterType = "all" | "open" | "in_progress" | "completed";

type JobItem = {
  id: string;
  status: FilterType extends infer T ? T : never;
};

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

export default function HomeStats({
  jobs,
  selectedFilter,
  setSelectedFilter,
  statsAnim,
}: HomeStatsProps) {
  const openJobs = jobs.filter((job) => job.status === "open");
  const inProgressJobs = jobs.filter((job) => job.status === "in_progress");
  const completedJobs = jobs.filter((job) => job.status === "completed");

  return (
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
        count={completedJobs.length}
        active={selectedFilter === "completed"}
        color={Colors.status.success}
        activeBg={Colors.status.successBg}
        onPress={() => setSelectedFilter("completed")}
      />
    </Animated.View>
  );
}

type StatCardProps = {
  label: string;
  count: number;
  color: string;
  activeBg: string;
  active: boolean;
  onPress: () => void;
};

function StatCard({
  label,
  count,
  color,
  activeBg,
  active,
  onPress,
}: StatCardProps) {
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
            backgroundColor: activeBg,
            borderColor: `${color}40`,
          },
        ]}
      >
        <Text style={[styles.statCount, { color }]}>{count}</Text>
        <Text style={styles.statLabel}>{label}</Text>

        {active ? (
          <View style={[styles.statActiveDot, { backgroundColor: color }]} />
        ) : null}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
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
});
