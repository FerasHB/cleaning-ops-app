import { AuthProvider } from "@/context/AuthContext";
import { JobProvider } from "@/context/JobContext";
import { setupNotifications } from "@/services/notificationService";
import { Stack } from "expo-router";
import { useEffect, useRef } from "react";

function RootNavigator() {
  return (
    <JobProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="register" />
        <Stack.Screen name="setup-company" />
        <Stack.Screen name="home" />
        <Stack.Screen name="admin" />
      </Stack>
    </JobProvider>
  );
}

export default function RootLayout() {
  const didSetupNotificationsRef = useRef(false);

  useEffect(() => {
    if (didSetupNotificationsRef.current) return;

    didSetupNotificationsRef.current = true;
    setupNotifications();
  }, []);

  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}