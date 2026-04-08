import { useAuth } from "@/context/AuthContext";
import AdminScreen from "@/features/admin/AdminScreen";
import HomeScreen from "@/features/home/HomeScreen";
import { ActivityIndicator, View } from "react-native";

// Diese Route entscheidet: darf der User Admin sehen oder nicht?
export default function AdminRoute() {
  // Daten aus dem AuthContext holen
  const { loading, role, session, profile } = useAuth();

  // Wenn noch geladen wird → Spinner anzeigen
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

  // Wenn kein Login oder kein Profil → nichts anzeigen (sollte eigentlich nicht passieren)
  if (!session || !profile) {
    return null;
  }

  // Wenn der User kein Admin ist → zurück zur normalen Home Seite
  if (role !== "admin") {
    return <HomeScreen />;
  }

  // Wenn alles passt → Admin Screen anzeigen
  return <AdminScreen />;
}
