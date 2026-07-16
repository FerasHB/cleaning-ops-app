// app/index.tsx
// Routing-Gate: liest Auth-Zustand und leitet weiter.
// Rendert selbst keinen Auth-Screen – das übernehmen die dedizierten Routen.
// Ausnahme: ein echter Profil-Ladefehler (nicht "offline") wird hier direkt
// mit Retry-/Logout-Optionen angezeigt, damit die App nie endlos lädt.

import { LoadingScreen } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Redirect, router } from "expo-router";
import { useState } from "react";
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

  // ── Ziel der Weiterleitung EINMAL bestimmen (rein aus dem Auth-Zustand) ──
  let redirectTo: string | null = null;
  if (!loading) {
    if (!session) {
      redirectTo = "/welcome";
    } else if (profile) {
      if (!profile.company_id) redirectTo = "/setup-company";
      else if (role === "admin") redirectTo = "/(admin-tabs)/dashboard";
      else if (role === "employee") redirectTo = "/(employee-tabs)/overview";
    }
  }

  // ── Deklarative Weiterleitung statt router.replace() im useEffect ──
  // Ursache des Offline-Kaltstart-Spinners: ein imperatives router.replace() in
  // einem useEffect konnte beim Cold-Start verworfen werden (Navigator/Guard
  // noch nicht bereit) — die App blieb dann auf app/index hängen, obwohl
  // loading=false und das Profil vorhanden war. <Redirect> wird bei JEDEM Render
  // neu bewertet und ist damit race-frei.
  if (redirectTo) {
    return <Redirect href={redirectTo as never} />;
  }

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

  // ── Offline UND kein lokaler Cache → expliziter Fehlerzustand ──
  // Gibt es ein gecachtes Profil, wird es im AuthContext gesetzt und wir landen
  // gar nicht hier — die App startet dann direkt (mit Offline-Banner). Nur wenn
  // weder Verbindung NOCH lokale Daten vorhanden sind, zeigen wir diesen
  // Bildschirm (kein endloser Spinner). Retry lädt neu, sobald wieder online.
  if (!loading && session && !profile && profileError === "network") {
    return (
      <View
        style={[styles.center, { backgroundColor: theme.colors.background }]}
      >
        <View style={styles.errorBox}>
          <Text style={[styles.errorTitle, { color: theme.colors.onSurface }]}>
            Keine Verbindung
          </Text>
          <Text
            style={[styles.errorMessage, { color: theme.colors.onSurfaceVariant }]}
          >
            Keine Verbindung und keine lokalen Daten verfügbar. Sobald du wieder
            online bist, kannst du es erneut versuchen.
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

  // Spinner – sichtbar solange der Auth-Bootstrap läuft. jobsLoading blockiert
  // den Root NICHT (die Tab-Screens rendern gecachte Jobs, siehe
  // JobContext.loadAll).
  return <LoadingScreen />;
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
});
