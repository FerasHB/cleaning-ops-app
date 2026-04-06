import { useAuth } from "@/context/AuthContext";
import LoginScreen from "@/features/auth/LoginScreen";
import HomeScreen from "@/features/home/HomeScreen";
import React from "react";
import { ActivityIndicator, View } from "react-native";

export default function Index() {
  const { session, loading } = useAuth();

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
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  return <HomeScreen />;
}
