import { router } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "@/context/AuthContext";
import LoginScreen from "@/features/auth/LoginScreen";

export default function IndexScreen() {
  // Zustand aus AuthContext:
  // loading → noch am Laden
  // session → eingeloggt oder nicht
  // profile → User-Daten aus DB
  const { loading, session, profile } = useAuth();

  useEffect(() => {
    // Solange geladen wird → keine Entscheidung treffen
    if (loading) return;

    // Nicht eingeloggt → UI kümmert sich (LoginScreen)
    if (!session) return;

    // Profil noch nicht da → warten
    if (!profile) return;

    // Eingeloggt, aber kein Unternehmen → Setup starten
    if (!profile.company_id) {
      router.replace("/setup-company");
      return; // wichtig: verhindert weiteres Routing
    }

    // Alles passt → zur Hauptseite
    router.replace("/home");
  }, [loading, session, profile]);

  // Während loading → Spinner anzeigen
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

  // Nicht eingeloggt → Login anzeigen
  if (!session) {
    return <LoginScreen />;
  }

  // Übergangszustand (kurz sichtbar bis Redirect passiert)
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
