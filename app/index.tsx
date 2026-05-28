// app/index.tsx
// Routing-Gate: liest Auth-Zustand und leitet weiter.
// Rendert selbst keinen Auth-Screen – das übernehmen die dedizierten Routen.

import { useAuth } from "@/context/AuthContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { router } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

export default function IndexScreen() {
  const { loading, session, profile, role } = useAuth();
  const theme = useAppTheme();

  useEffect(() => {
    // Solange geladen wird → keine Entscheidung treffen
    if (loading) return;

    // Nicht eingeloggt → Welcome Screen
    if (!session) {
      router.replace("/welcome");
      return;
    }

    // Profil noch nicht da → warten
    if (!profile) return;

    // Eingeloggt, aber kein Unternehmen → Setup starten
    if (!profile.company_id) {
      router.replace("/setup-company");
      return;
    }

    // Alles passt → rollenabhängig in die jeweiligen Bottom-Tabs
    if (role === "admin") {
      router.replace("/(admin-tabs)/dashboard");
    } else {
      router.replace("/(employee-tabs)/overview");
    }
  }, [loading, session, profile, role]);

  // Spinner – sichtbar solange Auth-Zustand ermittelt wird
  return (
    <View
      style={[styles.center, { backgroundColor: theme.colors.background }]}
    >
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
});
