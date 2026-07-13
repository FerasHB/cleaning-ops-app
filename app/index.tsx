// app/index.tsx
// Routing-Gate: liest Auth-Zustand und leitet weiter.
// Rendert selbst keinen Auth-Screen – das übernehmen die dedizierten Routen.
// Ausnahme: ein echter Profil-Ladefehler (nicht "offline") wird hier direkt
// mit Retry-/Logout-Optionen angezeigt, damit die App nie endlos lädt.

import { useAuth } from "@/context/AuthContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export default function IndexScreen() {
  const { loading, session, profile, role, profileError, refreshProfile, signOut } =
    useAuth();
  const theme = useAppTheme();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    // Solange geladen wird → keine Entscheidung treffen
    if (loading) return;

    // Nicht eingeloggt → Welcome Screen
    if (!session) {
      router.replace("/welcome");
      return;
    }

    // Profil noch nicht da → warten (Spinner oder Fehlerzustand, siehe unten)
    if (!profile) return;

    // Eingeloggt, aber kein Unternehmen → Setup starten
    if (!profile.company_id) {
      router.replace("/setup-company");
      return;
    }

    // Alles passt → rollenabhängig in die jeweiligen Bottom-Tabs
    if (role === "admin") {
      router.replace("/(admin-tabs)/dashboard");
    } else {
      router.replace("/(employee-tabs)/overview");
    }
  }, [loading, session, profile, role]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await refreshProfile();
    } finally {
      setRetrying(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
    } catch {
      router.replace("/welcome");
    }
  };

  // ── Echter Server-/RLS-Fehler beim Profil-Laden (nicht offline) ──
  // Kein endloser Spinner: klarer Fehlerzustand mit Retry und Logout.
  if (!loading && session && !profile && profileError === "server") {
    return (
      <View
        style={[styles.center, { backgroundColor: theme.colors.background }]}
      >
        <View style={styles.errorBox}>
          <Text style={[styles.errorTitle, { color: theme.colors.onSurface }]}>
            Profil konnte nicht geladen werden
          </Text>
          <Text
            style={[styles.errorMessage, { color: theme.colors.onSurfaceVariant }]}
          >
            Es gab ein Problem beim Laden deines Kontos. Bitte versuche es
            erneut oder melde dich ab und wieder an.
          </Text>

          <TouchableOpacity
            style={[styles.retryBtn, { backgroundColor: theme.colors.primary }]}
            onPress={handleRetry}
            disabled={retrying}
            activeOpacity={0.8}
          >
            {retrying ? (
              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
            ) : (
              <Text style={[styles.retryBtnText, { color: theme.colors.onPrimary }]}>
                Erneut versuchen
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.logoutBtn}
            onPress={handleLogout}
            activeOpacity={0.7}
          >
            <Text style={[styles.logoutBtnText, { color: theme.colors.error }]}>
              Abmelden
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Offline: kein Fehler, sondern erwartbarer Zustand ──
  // Automatischer Retry läuft im AuthContext bei Reconnect (begrenzt).
  if (!loading && session && !profile && profileError === "network") {
    return (
      <View
        style={[styles.center, { backgroundColor: theme.colors.background }]}
      >
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text
          style={[
            styles.offlineHint,
            { color: theme.colors.onSurfaceVariant },
          ]}
        >
          Warte auf Internetverbindung …
        </Text>
      </View>
    );
  }

  // Spinner – sichtbar solange Auth-Zustand ermittelt wird
  return (
    <View
      style={[styles.center, { backgroundColor: theme.colors.background }]}
    >
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  errorBox: {
    paddingHorizontal: 32,
    alignItems: "center",
    gap: 12,
    maxWidth: 360,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
  },
  errorMessage: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  retryBtn: {
    marginTop: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    minWidth: 180,
    alignItems: "center",
  },
  retryBtnText: {
    fontSize: 15,
    fontWeight: "600",
  },
  logoutBtn: {
    marginTop: 4,
    paddingVertical: 8,
  },
  logoutBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },
  offlineHint: {
    marginTop: 12,
    fontSize: 14,
    textAlign: "center",
  },
});
