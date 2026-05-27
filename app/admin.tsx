// app/admin.tsx
// Rolle-Gate: zeigt AdminScreen nur für Admin-User, sonst HomeScreen.

import { useAuth } from "@/context/AuthContext";
import AdminScreen from "@/features/admin/AdminScreen";
import HomeScreen from "@/features/home/HomeScreen";
import { useAppTheme } from "@/hooks/useAppTheme";
import { ActivityIndicator, StyleSheet, View } from "react-native";

export default function AdminRoute() {
  const { loading, role, session, profile } = useAuth();
  const theme = useAppTheme();

  // Während Auth lädt → theme-aware Spinner
  if (loading) {
    return (
      <View
        style={[styles.center, { backgroundColor: theme.colors.background }]}
      >
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  // Sollte nicht passieren (Routing-Gate schützt schon), aber safety net
  if (!session || !profile) {
    return null;
  }

  // Nicht-Admin → zurück zur normalen Home-Seite
  if (role !== "admin") {
    return <HomeScreen />;
  }

  // Admin → eigentlicher Screen
  return <AdminScreen />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
});
