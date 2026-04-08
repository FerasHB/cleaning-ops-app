import { useAuth } from "@/context/AuthContext";
import AdminScreen from "@/features/admin/AdminScreen";
import HomeScreen from "@/features/home/HomeScreen";
import { ActivityIndicator, View } from "react-native";

export default function AdminRoute() {
  const { loading, role, session, profile } = useAuth();

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "#121212",
        }}
      >
        <ActivityIndicator size="large" color="#2563EB" />
      </View>
    );
  }

  if (!session || !profile) {
    return null;
  }

  if (role !== "admin") {
    return <HomeScreen />;
  }

  return <AdminScreen />;
}
