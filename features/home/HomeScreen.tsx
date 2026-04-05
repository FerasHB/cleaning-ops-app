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

export default function HomeScreen() {
  const { jobs, startJob, completeJob } = useJobs();
  const { t } = useTranslation();

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />

      <View style={styles.container}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{t("title")}</Text>

          <TouchableOpacity onPress={() => router.push("/admin")}>
            <Text style={styles.adminButton}>Admin</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.subtitle}>{t("subtitle")}</Text>

        <FlatList
          data={jobs}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <JobCard
              job={item}
              onStart={() => startJob(item.id)}
              onComplete={() => completeJob(item.id)}
            />
          )}
        />
      </View>
    </SafeAreaView>
  );
}

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
  listContent: {
    paddingBottom: 24,
  },
});
