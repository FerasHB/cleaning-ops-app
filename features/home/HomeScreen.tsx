// screens/HomeScreen.tsx
import { useAuth } from "@/context/AuthContext";
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

import { EmptyState, LoadingScreen } from "@/components/ui";
import { Colors, Radius, Spacing, Typography } from "@/constants/theme";
import JobCard from "../../components/JobCard";
import { useJobs } from "../../context/JobContext";
import { useTranslation } from "../../i18n/useTranslation";

export default function HomeScreen() {
  const { jobs, startJob, completeJob, loading } = useJobs();
  const { signOut, role, user } = useAuth();
  const { t } = useTranslation();

  const [selectedFilter, setSelectedFilter] = useState<
    "all" | "open" | "in_progress" | "completed"
  >("all");

  const handleLogout = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  // Ladescreen solange Jobs noch geladen werden
  if (loading) return <LoadingScreen />;

  // Kurzer Anzeigename aus der E-Mail extrahieren (z.B. "Max" aus "max@firma.de")
  const displayName = user?.email?.split("@")[0] ?? "Hey";
  // Ersten Buchstaben großschreiben
  const firstName = displayName.charAt(0).toUpperCase() + displayName.slice(1);

  // Jobs nach Status gruppieren – so sieht man schnell was offen ist
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

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar barStyle="light-content" />

      <FlatList
        data={filteredJobs}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        // Leerliste abfangen – nur wenn auch wirklich keine Jobs da sind
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
        // Header: Begrüßung + Stats + Admin-Button
        ListHeaderComponent={
          <>
            {/* ── Kopfzeile ── */}
            <View style={styles.header}>
              <View style={styles.headerLeft}>
                <Text style={styles.greeting}>Hallo, {firstName} 👋</Text>
                <Text style={styles.subtitle}>{t("subtitle")}</Text>
              </View>

              <View style={styles.headerRight}>
                {/* Admin-Panel Link – nur für Admins sichtbar */}
                {role === "admin" && (
                  <TouchableOpacity
                    onPress={() => router.push("/admin")}
                    style={styles.adminChip}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.adminChipText}>Admin</Text>
                  </TouchableOpacity>
                )}
                {/* Avatar-Button für Logout */}
                <TouchableOpacity
                  onPress={handleLogout}
                  style={styles.avatar}
                  activeOpacity={0.7}
                >
                  <Text style={styles.avatarText}>
                    {firstName.charAt(0).toUpperCase()}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* ── Stat-Chips: schneller Status-Überblick ── */}
            <View style={styles.statRow}>
              <StatChip
                label="Alle"
                count={jobs.length}
                variant="neutral"
                active={selectedFilter === "all"}
                onPress={() => setSelectedFilter("all")}
              />
              <StatChip
                label="Offen"
                count={openJobs.length}
                variant="warning"
                active={selectedFilter === "open"}
                onPress={() => setSelectedFilter("open")}
              />
              <StatChip
                label="In Arbeit"
                count={inProgressJobs.length}
                variant="info"
                active={selectedFilter === "in_progress"}
                onPress={() => setSelectedFilter("in_progress")}
              />
              <StatChip
                label="Erledigt"
                count={doneJobs.length}
                variant="success"
                active={selectedFilter === "completed"}
                onPress={() => setSelectedFilter("completed")}
              />
            </View>

            {/* ── Sektion-Titel ── */}
            <Text style={styles.sectionTitle}>
              {selectedFilter === "all"
                ? "Alle Jobs"
                : selectedFilter === "open"
                  ? "Offene Jobs"
                  : selectedFilter === "in_progress"
                    ? "Jobs in Arbeit"
                    : "Erledigte Jobs"}
            </Text>
          </>
        }
        renderItem={({ item }) => (
          <JobCard
            job={item}
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

// ── Kleine Stat-Kachel (Anzahl + Label) ──
// Ausgelagert als lokale Komponente – nur in diesem Screen gebraucht
interface StatChipProps {
  label: string;
  count: number;
  variant: "neutral" | "warning" | "info" | "success";
  active: boolean;
  onPress: () => void;
}

function StatChip({ label, count, variant, active, onPress }: StatChipProps) {
  const variantStyles = {
    neutral: { bg: Colors.bg.elevated, text: Colors.text.primary },
    warning: { bg: Colors.status.warningBg, text: Colors.status.warning },
    info: { bg: Colors.accent.subtle, text: Colors.accent.text },
    success: { bg: Colors.status.successBg, text: Colors.status.success },
  };

  const { bg, text } = variantStyles[variant];

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={[
        styles.statChip,
        { backgroundColor: bg },
        active && styles.statChipActive,
      ]}
    >
      <Text style={[styles.statCount, { color: text }]}>{count}</Text>
      <Text style={[styles.statLabel, { color: text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg.base,
  },
  listContent: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: 40,
  },

  // Header
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingTop: Spacing.xl,
    marginBottom: Spacing.xl,
  },
  headerLeft: { flex: 1, gap: 3 },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  greeting: {
    fontSize: Typography.size.xxl,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
  },

  // Admin-Chip
  adminChip: {
    backgroundColor: Colors.accent.subtle,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: Radius.full,
  },
  adminChipText: {
    fontSize: Typography.size.xs,
    fontWeight: Typography.weight.semibold,
    color: Colors.accent.text,
    letterSpacing: 0.3,
  },

  // Avatar (Logout)
  avatar: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.bg.elevated,
    borderWidth: 1,
    borderColor: Colors.border.default,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
  },

  // Stats
  statRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  statChip: {
    flex: 1,
    minWidth: "48%",
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    alignItems: "center",
    gap: 2,
  },
  statChipActive: {
    borderWidth: 1,
    borderColor: Colors.border.focus,
  },
  statCount: {
    fontSize: Typography.size.xl,
    fontWeight: Typography.weight.bold,
  },
  statLabel: {
    fontSize: Typography.size.xs,
    fontWeight: Typography.weight.medium,
    letterSpacing: 0.2,
  },

  // Sektion
  sectionTitle: {
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.secondary,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: Spacing.md,
  },

  separator: {
    height: Spacing.sm,
  },
});
