import { router } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "@/context/AuthContext";
import LoginScreen from "@/features/auth/LoginScreen";

export default function IndexScreen() {
  const { loading, session, profile } = useAuth();

  useEffect(() => {
    if (loading) return;

    if (!session) return;

    if (!profile) return;

    if (!profile.company_id) {
      router.replace("/setup-company");
      return;
    }

    router.replace("/home");
  }, [loading, session, profile]);

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

  if (!session) {
    return <LoginScreen />;
  }

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
