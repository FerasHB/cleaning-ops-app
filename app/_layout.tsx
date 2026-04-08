import { AuthProvider, useAuth } from "@/context/AuthContext";
import { JobProvider } from "@/context/JobContext";
import LoginScreen from "@/features/auth/LoginScreen";
import { Stack } from "expo-router";
import { ActivityIndicator, View } from "react-native";

function RootNavigator() {
  const { session, loading, profile } = useAuth();

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

  if (!profile) {
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

  return (
    <JobProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </JobProvider>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
