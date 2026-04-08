import { AuthProvider, useAuth } from "@/context/AuthContext";
import { JobProvider } from "@/context/JobContext";
import LoginScreen from "@/features/auth/LoginScreen";
import { Stack } from "expo-router";
import { ActivityIndicator, View } from "react-native";

// Diese Komponente entscheidet, was der User sieht (Login, Loading oder App)
function RootNavigator() {
  // Holen uns die wichtigsten Daten aus dem AuthContext
  const { session, loading, profile } = useAuth();

  // Während die Daten geladen werden → einfach Spinner anzeigen
  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center", // zentriert vertikal
          alignItems: "center", // zentriert horizontal
          backgroundColor: "#121212", // dunkler Hintergrund
        }}
      >
        {/* Lade-Spinner */}
        <ActivityIndicator size="large" color="#2563EB" />
      </View>
    );
  }

  // Wenn kein User eingeloggt ist → Login Screen anzeigen
  if (!session) {
    return <LoginScreen />;
  }

  // Falls Session da ist, aber Profil noch nicht geladen → wieder Loading anzeigen
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

  // Wenn alles da ist (User + Profil) → App starten
  return (
    <JobProvider>
      {/* Navigation Stack (alle Screens kommen hier rein) */}
      <Stack screenOptions={{ headerShown: false }} />
    </JobProvider>
  );
}

// Root Layout wird ganz oben gerendert (Entry Point der App)
export default function RootLayout() {
  return (
    // AuthProvider um die ganze App → damit überall Zugriff auf Auth-Daten
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
