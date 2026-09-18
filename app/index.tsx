// app/index.tsx
// Routing-Gate: liest Auth-Zustand und leitet weiter.
// Rendert selbst keinen Auth-Screen – das übernehmen die dedizierten Routen.
// Ausnahme: ein echter Profil-Ladefehler (nicht "offline") wird hier direkt
// mit Retry-/Logout-Optionen angezeigt, damit die App nie endlos lädt.

import { useAuth } from "@/context/AuthContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Redirect, router } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export default function IndexScreen() {
  const {
    loading,
    session,
    profile,
    role,
    profileError,
    refreshProfile,
    signOut,
    isRecoverySession,
    endRecoverySession,
    isVersionBlocked,
  } = useAuth();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);

  // Selbstheilung: Marker ohne Session bedeutet, die Recovery-Sitzung ist weg
  // (abgelaufen/abgemeldet). Marker aufräumen, damit der nächste Start wieder
  // normal auf dem Login landet. MUSS vor jedem bedingten return stehen —
  // sonst wäre es ein konditionaler Hook-Aufruf.
  useEffect(() => {
    if (!loading && isRecoverySession && !session) {
      void endRecoverySession();
    }
  }, [loading, isRecoverySession, session, endRecoverySession]);

  // ── Ziel der Weiterleitung EINMAL bestimmen (rein aus dem Auth-Zustand) ──
  let redirectTo: string | null = null;
  if (!loading) {
    if (isRecoverySession) {
      // SICHERHEITSGRENZE: Eine reine Passwort-Reset-Sitzung führt IMMER zurück
      // in den Reset-Flow, nie in die App — auch nach Force-Close/Kaltstart.
      // Ist der Marker gesetzt, die Session aber weg (abgelaufen/abgemeldet),
      // wäre der Nutzer sonst dauerhaft gefangen: dann Marker aufräumen und
      // regulär zum Login. Siehe services/auth/recoveryMode.ts.
      // Der Query-Parameter `restored=1` ist das DETERMINISTISCHE Signal für
      // ResetPasswordScreen, dass diese Navigation aus einer bereits
      // persistierten Recovery-Session stammt und NICHT aus einem frischen
      // Deep-Link. Nur diese eine Stelle setzt ihn — ein echter Recovery-Link
      // von Supabase trägt ihn nie (Redirect-Ziel ist exakt
      // `taskopsmanager(dev)://reset-password`, siehe uri_allow_list). Damit
      // braucht der Hook keine Zeitheuristik mehr, um die beiden Fälle zu
      // unterscheiden. Der Parameter allein berechtigt zu NICHTS: der
      // Restore-Pfad verlangt zusätzlich den aktiven Recovery-Marker UND eine
      // gültige Session.
      redirectTo = session ? "/reset-password?restored=1" : "/login";
    } else if (!session) {
      // Abgemeldete Nutzer landen immer auf der Anmeldung (Login), nicht auf
      // Welcome/Register. Die Registrierung ist von dort nur über eine
      // explizite Nutzeraktion erreichbar (Link "Firma registrieren").
      redirectTo = "/login";
    } else if (profile) {
      // Client-Compatibility-Fundament (20260916120000): UX-Gate, nicht die
      // Sicherheitsgrenze — die ist ausschließlich die serverseitige
      // enforce_min_client_version()-Prüfung. Greift NACH Login/Profil-Laden
      // ("nach Authentifizierung"), VOR jeder rollenbasierten Weiterleitung,
      // damit ein zu alter Build unabhängig von company_id/Rolle blockiert.
      // isVersionBlocked ist fail-open, solange app_config nicht geladen
      // werden konnte — siehe AuthContext.tsx.
      if (isVersionBlocked) redirectTo = "/update-required";
      else if (!profile.company_id) redirectTo = "/setup-company";
      else if (role === "admin") redirectTo = "/(admin-tabs)/dashboard";
      else if (role === "employee") {
        // Einladung noch nicht abgeschlossen (kein eigenes Passwort gesetzt) →
        // zurück zum accept-invite-Screen, statt in die Employee-Tabs. Siehe
        // 20260718000000_employee_invitations.sql (Backfill sorgt dafür, dass
        // bestehende Mitarbeiter hier nie landen).
        redirectTo = profile.invite_accepted_at
          ? "/(employee-tabs)/overview"
          : "/accept-invite";
      }
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
      // Fallback bei fehlgeschlagenem Sign-out: ebenfalls zur Anmeldung, nicht
      // zu Welcome/Register.
      router.replace("/login");
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
            {t("common:bootError.profileFailedTitle")}
          </Text>
          <Text
            style={[styles.errorMessage, { color: theme.colors.onSurfaceVariant }]}
          >
            {t("common:bootError.profileFailedMessage")}
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
                {t("common:actions.retry")}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.logoutBtn}
            onPress={handleLogout}
            activeOpacity={0.7}
          >
            <Text style={[styles.logoutBtnText, { color: theme.colors.error }]}>
              {t("profile:dialogs.logout")}
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
            {t("common:bootError.offlineTitle")}
          </Text>
          <Text
            style={[styles.errorMessage, { color: theme.colors.onSurfaceVariant }]}
          >
            {t("common:bootError.offlineMessage")}
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
                {t("common:actions.retry")}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.logoutBtn}
            onPress={handleLogout}
            activeOpacity={0.7}
          >
            <Text style={[styles.logoutBtnText, { color: theme.colors.error }]}>
              {t("profile:dialogs.logout")}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Während des Auth-Bootstraps liegt der animierte Splash (SplashGate in
  // app/_layout.tsx) als Overlay darüber und verdeckt diesen Platzhalter
  // vollständig. Nur ein dunkler Grund in Marken-Hintergrundfarbe, damit selbst
  // in der kurzen Exit-Überblendung kein heller Frame durchblitzt. jobsLoading
  // blockiert den Root NICHT (Tab-Screens rendern gecachte Jobs, siehe
  // JobContext.loadAll).
  return <View style={[styles.center, styles.bootBackground]} />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  // Marken-Hintergrundfarbe (Splash) — bewusst fix, unabhängig vom Theme.
  bootBackground: {
    backgroundColor: "#0B1220",
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
