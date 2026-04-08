import { useAuth } from "@/context/AuthContext";
import HomeScreen from "@/features/home/HomeScreen";
import { ActivityIndicator, View } from "react-native";

export default function IndexScreen() {
  const { loading, session, profile } = useAuth();

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

  // 👉 ALLE User landen zuerst im HomeScreen
  return <HomeScreen />;
}
