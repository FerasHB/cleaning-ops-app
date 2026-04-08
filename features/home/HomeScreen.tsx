import { useAuth } from "@/context/AuthContext";
import { router } from "expo-router";
import React from "react";
import {
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import JobCard from "../../components/JobCard";
import { useJobs } from "../../context/JobContext";
import { useTranslation } from "../../i18n/useTranslation";

// HomeScreen ist die Hauptseite für alle User nach dem Login
export default function HomeScreen() {
  // Jobs und Aktionen aus dem JobContext holen
  const { jobs, startJob, completeJob } = useJobs();

  // Auth-Daten holen
  const { signOut, role } = useAuth();

  // Übersetzungsfunktion für Texte
  const { t } = useTranslation();

  // Logout-Funktion
  const handleLogout = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Helle StatusBar für dunklen Hintergrund */}
      <StatusBar barStyle="light-content" />

      <View style={styles.container}>
        {/* Kopfbereich mit Titel + Aktionen */}
        <View style={styles.headerRow}>
          <Text style={styles.title}>{t("title")}</Text>

          <View style={styles.headerActions}>
            {/* Admin-Button nur anzeigen, wenn der User Admin ist */}
            {role === "admin" && (
              <TouchableOpacity onPress={() => router.push("/admin")}>
                <Text style={styles.adminButton}>Admin</Text>
              </TouchableOpacity>
            )}

            {/* Logout-Button */}
            <TouchableOpacity onPress={handleLogout}>
              <Text style={styles.logoutButton}>Abmelden</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Untertitel / kleine Beschreibung */}
        <Text style={styles.subtitle}>{t("subtitle")}</Text>

        {/* Liste aller Jobs */}
        <FlatList
          data={jobs}
          keyExtractor={(item) => item.id} // jede Zeile bekommt eine stabile ID
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <JobCard
              job={item}
              onStart={() => startJob(item.id)} // Job starten
              onComplete={() => completeJob(item.id)} // Job abschließen
            />
          )}
        />
      </View>
    </SafeAreaView>
  );
}

// Styles für den HomeScreen
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#121212",
  },
  container: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 28,
    fontWeight: "800",
  },
  subtitle: {
    color: "#A1A1AA",
    fontSize: 14,
    marginBottom: 18,
    marginTop: 6,
  },
  adminButton: {
    color: "#2563EB",
    fontWeight: "700",
  },
  logoutButton: {
    color: "#F87171",
    fontWeight: "700",
  },
  listContent: {
    paddingBottom: 24,
  },
});
