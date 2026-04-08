import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "../i18n/useTranslation";
import { Job } from "../types/job";

// Props für die Komponente:
// job → die Daten vom Auftrag
// onStart → Funktion wenn "Start" gedrückt wird
// onComplete → Funktion wenn "Complete" gedrückt wird
type Props = {
  job: Job;
  onStart: () => void;
  onComplete: () => void;
};

export default function JobCard({ job, onStart, onComplete }: Props) {
  // Übersetzungs-Funktion (z.B. für Buttons & Status)
  const { t } = useTranslation();

  // Badge Farbe je nach Status bestimmen
  const badgeStyle =
    job.status === "open"
      ? styles.badgeOpen // grau
      : job.status === "in_progress"
        ? styles.badgeProgress // orange
        : styles.badgeCompleted; // grün

  // Text für Status (übersetzt)
  const statusLabel =
    job.status === "open"
      ? t("open")
      : job.status === "in_progress"
        ? t("inProgress")
        : t("completed");

  return (
    <View style={styles.card}>
      {/* Kopfbereich: Kundenname + Status Badge */}
      <View style={styles.headerRow}>
        <Text style={styles.customer}>{job.customerName}</Text>

        {/* Status Badge */}
        <View style={[styles.badge, badgeStyle]}>
          <Text style={styles.badgeText}>{statusLabel}</Text>
        </View>
      </View>

      {/* Job Details */}
      <Text style={styles.detail}>📍 {job.location}</Text>
      <Text style={styles.detail}>🕒 {job.time}</Text>
      <Text style={styles.detail}>🧽 {job.service}</Text>

      {/* Wenn kein Mitarbeiter → "-" anzeigen */}
      <Text style={styles.detail}>👤 {job.employeeName ?? "-"}</Text>

      {/* Buttons für Aktionen */}
      <View style={styles.buttonRow}>
        {/* Start Button */}
        <TouchableOpacity
          style={[
            styles.button,
            styles.startButton,
            // Wenn Job nicht "open" ist → Button deaktiviert (halb transparent)
            job.status !== "open" && { opacity: 0.5 },
          ]}
          onPress={onStart}
          disabled={job.status !== "open"} // nur klickbar wenn Status "open"
        >
          <Text style={styles.buttonText}>{t("startJob")}</Text>
        </TouchableOpacity>

        {/* Complete Button */}
        <TouchableOpacity
          style={[
            styles.button,
            styles.completeButton,
            // Nur aktiv wenn Job läuft
            job.status !== "in_progress" && { opacity: 0.5 },
          ]}
          onPress={onComplete}
          disabled={job.status !== "in_progress"} // nur klickbar wenn Status "in_progress"
        >
          <Text style={styles.buttonText}>{t("complete")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Styles für die UI (Dark Theme)
const styles = StyleSheet.create({
  card: {
    backgroundColor: "#1E1E1E", // dunkle Karte
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#2A2A2A",
  },
  headerRow: {
    flexDirection: "row", // nebeneinander
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
    borderRadius: 999, // rund
  },
  badgeOpen: {
    backgroundColor: "#3A3A3A", // grau
  },
  badgeProgress: {
    backgroundColor: "#8A5A00", // orange
  },
  badgeCompleted: {
    backgroundColor: "#1F6F43", // grün
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
    backgroundColor: "#2563EB", // blau
  },
  completeButton: {
    backgroundColor: "#16A34A", // grün
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
});
