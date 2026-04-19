import { AuthProvider, useAuth } from "@/context/AuthContext";
import { JobProvider } from "@/context/JobContext";
import LoginScreen from "@/features/auth/LoginScreen";
import { setupNotifications } from "@/services/notificationService";
import { Stack } from "expo-router";
import { useEffect, useRef } from "react";
import { ActivityIndicator, View } from "react-native";
console.log("JobProvider import:", JobProvider);
// Diese Komponente entscheidet, was der User sieht (Login, Loading oder App)
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

// Root Layout wird ganz oben gerendert (Entry Point der App)
export default function RootLayout() {
  const didSetupNotificationsRef = useRef(false);

  useEffect(() => {
    if (didSetupNotificationsRef.current) {
      return;
    }

    didSetupNotificationsRef.current = true;
    setupNotifications();
  }, []);

  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
