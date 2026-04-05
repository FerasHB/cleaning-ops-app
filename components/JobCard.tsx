import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "../i18n/useTranslation";
import { Job } from "../types/job";

type Props = {
  job: Job;
  onStart: () => void;
  onComplete: () => void;
};

export default function JobCard({ job, onStart, onComplete }: Props) {
  const { t } = useTranslation();
  const badgeStyle =
    job.status === "open"
      ? styles.badgeOpen
      : job.status === "in_progress"
        ? styles.badgeProgress
        : styles.badgeCompleted;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.customer}>{job.customer}</Text>
        <View style={[styles.badge, badgeStyle]}>
          <Text style={styles.badgeText}>{job.status}</Text>
        </View>
      </View>

      <Text style={styles.detail}>📍 {job.location}</Text>
      <Text style={styles.detail}>🕒 {job.time}</Text>
      <Text style={styles.detail}>🧽 {job.service}</Text>
      <Text style={styles.detail}>👤 {job.employee}</Text>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.startButton]}
          onPress={onStart}
          disabled={job.status !== "open"}
        >
          <Text style={styles.buttonText}>{t("startJob")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.completeButton]}
          onPress={onComplete}
          disabled={job.status !== "in_progress"}
        >
          <Text style={styles.buttonText}>{t("complete")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#1E1E1E",
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#2A2A2A",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  customer: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700",
    flex: 1,
    marginRight: 10,
  },
  detail: {
    color: "#CFCFCF",
    fontSize: 14,
    marginBottom: 6,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  badgeOpen: {
    backgroundColor: "#3A3A3A",
  },
  badgeProgress: {
    backgroundColor: "#8A5A00",
  },
  badgeCompleted: {
    backgroundColor: "#1F6F43",
  },
  badgeText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
  buttonRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  startButton: {
    backgroundColor: "#2563EB",
  },
  completeButton: {
    backgroundColor: "#16A34A",
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
});
