// app/_layout.tsx
// Root Layout — lädt Inter-Font und stellt Auth + Job Context bereit.
// Der Splash Screen bleibt sichtbar, bis die Fonts geladen sind.

import { AuthProvider } from "@/context/AuthContext";
import { JobProvider } from "@/context/JobContext";
import { setupNotifications } from "@/services/notificationService";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef } from "react";

// Splash Screen bleibt sichtbar, bis Fonts fertig geladen sind
SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  return (
    <JobProvider>
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="welcome" />
        <Stack.Screen name="login" />
        <Stack.Screen name="register" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="setup-company" />
        <Stack.Screen
          name="(employee-tabs)"
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="(admin-tabs)"
          options={{ headerShown: false }}
        />
      </Stack>
    </JobProvider>
  );
}

export default function RootLayout() {
  const didSetupNotificationsRef = useRef(false);

  // Lädt Inter in 4 Gewichten (Regular, Medium, SemiBold, Bold)
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Splash Screen ausblenden sobald Fonts geladen (oder fehlgeschlagen)
  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Push Notifications einmalig einrichten
  useEffect(() => {
    if (didSetupNotificationsRef.current) return;
    didSetupNotificationsRef.current = true;
    setupNotifications();
  }, []);

  // Nichts rendern solange Fonts noch laden
  // (fontError: Inter-Fallback auf System-Font — App bleibt funktionsfähig)
  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
