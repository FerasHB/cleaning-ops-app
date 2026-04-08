import { useAuth } from "@/context/AuthContext";
import HomeScreen from "@/features/home/HomeScreen";
import { ActivityIndicator, View } from "react-native";

// Das ist der Start-Screen der App ("/")
// Hier wird entschieden, was der User als erstes sieht
export default function IndexScreen() {
  // Auth-Daten holen
  const { loading, session, profile } = useAuth();

  // Während geladen wird → Spinner anzeigen
  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center", // vertikal zentrieren
          alignItems: "center", // horizontal zentrieren
          backgroundColor: "#121212",
        }}
      >
        <ActivityIndicator size="large" color="#2563EB" />
      </View>
    );
  }

  // Wenn kein User oder kein Profil vorhanden → nichts anzeigen
  // (Login wird an anderer Stelle gehandelt)
  if (!session || !profile) {
    return null;
  }

  // 👉 Alle User landen hier im HomeScreen (egal ob Admin oder Employee)
  return <HomeScreen />;
}
