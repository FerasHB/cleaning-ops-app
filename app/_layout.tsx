// app/_layout.tsx
// Root Layout — lädt Inter-Font und stellt Auth + Job Context bereit.
// Der Splash Screen bleibt sichtbar, bis die Fonts geladen sind.

import { AuthProvider, useAuth } from "@/context/AuthContext";
import { JobProvider } from "@/context/JobContext";
import { setupNotifications } from "@/services/notificationService";
import { installNetworkErrorGuard } from "@/utils/networkError";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { Component, type ReactNode, useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

// Splash Screen bleibt sichtbar, bis Fonts fertig geladen sind
SplashScreen.preventAutoHideAsync();

// Globaler Guard: erwartete Netzwerkfehler (offline) erzeugen kein Dev-Redbox/
// -Toast. Nur Entwicklung, echte Fehler bleiben sichtbar. Modul-Scope, damit der
// Guard aktiv ist, bevor Provider-Effekte erste Requests starten.
installNetworkErrorGuard();

// Einfacher globaler Error-Boundary: fängt unerwartete Render-Fehler im
// gesamten App-Baum ab, damit die App nicht komplett weiß/rot einfriert.
// Bewusst minimal (kein Crash-Reporting, kein Theme) — nur ein deutscher
// Fallback mit "Erneut versuchen".
type AppErrorBoundaryState = { hasError: boolean };

class AppErrorBoundary extends Component<
  { children: ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    // Nur loggen (im Expo-Log sichtbar) — kein Crash-Reporting im MVP.
    console.error("Unerwarteter Render-Fehler:", error);
  }

  private handleReset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Etwas ist schiefgelaufen</Text>
          <Text style={styles.errorMessage}>
            Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es
            erneut.
          </Text>
          <Pressable style={styles.errorButton} onPress={this.handleReset}>
            <Text style={styles.errorButtonText}>Erneut versuchen</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#FFFFFF",
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 8,
    textAlign: "center",
  },
  errorMessage: {
    fontSize: 15,
    color: "#4B5563",
    textAlign: "center",
    marginBottom: 24,
  },
  errorButton: {
    backgroundColor: "#2563EB",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  errorButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
});

function RootNavigator() {
  const { session, profile } = useAuth();

  // ── Auth-Gates für den Back-Stack ──────────────────────────────────────
  // Entscheidet, welche Routen-Gruppen überhaupt im Navigations-State liegen.
  // Stack.Protected entfernt nicht-zugängliche Routen vollständig aus dem
  // Stack → eingeloggte User können nicht per Swipe/Back auf Welcome/Login
  // zurück, und Auth-Screens bleiben nicht hinter den Tabs liegen.
  const hasSession = !!session;
  const hasCompany = !!profile?.company_id;
  // Eingeloggt, Profil geladen, aber noch kein Unternehmen → Setup.
  const needsSetup = hasSession && !!profile && !hasCompany;
  // Voll eingeloggt (Session + Unternehmen) → App/Tabs.
  const isAuthed = hasSession && hasCompany;

  return (
    <JobProvider>
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      >
        {/* Routing-Gate: immer verfügbar, leitet je nach Auth-Zustand weiter. */}
        <Stack.Screen name="index" />

        {/* Auth-Screens: nur ohne Session erreichbar. */}
        <Stack.Protected guard={!hasSession}>
          <Stack.Screen name="welcome" />
          <Stack.Screen name="login" />
          <Stack.Screen name="register" />
          <Stack.Screen name="forgot-password" />
        </Stack.Protected>

        {/* Setup: eingeloggt, aber noch kein Unternehmen. */}
        <Stack.Protected guard={needsSetup}>
          <Stack.Screen name="setup-company" />
        </Stack.Protected>

        {/* App: eingeloggt mit Unternehmen → Tabs + Detail-/Form-Routen. */}
        <Stack.Protected guard={isAuthed}>
          <Stack.Screen name="(admin-tabs)" />
          <Stack.Screen name="(employee-tabs)" />
          <Stack.Screen name="jobs/create" />
          <Stack.Screen name="jobs/[id]/index" />
          <Stack.Screen name="jobs/[id]/edit" />
          <Stack.Screen name="employees/[id]/index" />
          <Stack.Screen name="timesheets/index" />
          <Stack.Screen name="change-password" />
        </Stack.Protected>
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
    <AppErrorBoundary>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </AppErrorBoundary>
  );
}
