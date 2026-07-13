import { supabase } from "@/lib/supabase";
import { registerForPushNotifications } from "@/services/notificationService";
import {
  getProfileByUserId,
  type AppRole,
  type AuthProfile,
  type ProfileFetchErrorKind,
} from "@/services/profileService";
import { isNetworkError } from "@/utils/networkError";
import NetInfo from "@react-native-community/netinfo";
import { Session, User } from "@supabase/supabase-js";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, AppState } from "react-native";

type AuthContextType = {
  session: Session | null;
  user: User | null;
  profile: AuthProfile | null;
  role: AppRole | null;
  loading: boolean;
  // Echter Server-/RLS-Fehler beim Laden des Profils (nicht "offline") —
  // siehe app/index.tsx für die dazugehörige Fehler-/Retry-UI.
  profileError: ProfileFetchErrorKind;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [profileError, setProfileError] = useState<ProfileFetchErrorKind>(null);
  const [loading, setLoading] = useState(true);

  const isMountedRef = useRef(true);
  const lastHandledUserIdRef = useRef<string | null>(null);
  const isBootstrappingRef = useRef(true);
  // Verhindert doppelte Alerts/Sign-outs, falls sowohl der Realtime-Kanal
  // als auch ein nachfolgender applySession-Durchlauf die Deaktivierung
  // gleichzeitig bemerken.
  const deactivationHandledRef = useRef(false);
  // Begrenzt die automatischen Reconnect-Retries (siehe Effect unten) —
  // verhindert, dass ein dauerhafter Server-/RLS-Fehler die App bei jedem
  // NetInfo-Event erneut anfragen lässt. Manuelles Retry über die UI bleibt
  // unbegrenzt möglich.
  const autoRetryCountRef = useRef(0);
  const MAX_AUTO_RETRIES = 3;

  // Löscht den eigenen Push-Token best effort — darf Logout/Deaktivierung
  // nie blockieren, egal was schiefgeht.
  const clearOwnPushTokenBestEffort = useCallback(async () => {
    try {
      await supabase.rpc("clear_my_push_token");
    } catch (err) {
      if (__DEV__) {
        console.warn("Failed to clear push token:", err);
      }
    }
  }, []);

  // Wird ausgelöst, sobald ein Profil als deaktiviert erkannt wird — sowohl
  // beim initialen Laden/Bootstrap als auch live über den Realtime-Kanal
  // unten (Deaktivierung während die App bereits offen ist). Zeigt eine
  // klare deutsche Meldung, räumt den Push-Token auf und meldet danach ab.
  const forceSignOutDueToDeactivation = useCallback(async () => {
    if (deactivationHandledRef.current) {
      return;
    }
    deactivationHandledRef.current = true;

    Alert.alert(
      "Konto deaktiviert",
      "Dein Zugang wurde von einem Administrator deaktiviert. Du wirst jetzt abgemeldet.",
    );

    await clearOwnPushTokenBestEffort();

    try {
      await supabase.auth.signOut();
    } catch (err) {
      if (__DEV__) {
        console.warn("Sign-out after deactivation failed:", err);
      }
    }

    if (isMountedRef.current) {
      setSession(null);
      setUser(null);
      setProfile(null);
      setProfileError(null);
    }
    lastHandledUserIdRef.current = null;
    autoRetryCountRef.current = 0;

    // Zurücksetzen, damit ein späterer, neuer Login wieder normal geprüft wird.
    deactivationHandledRef.current = false;
  }, [clearOwnPushTokenBestEffort]);

  const refreshProfile = useCallback(async () => {
    // supabase.auth.getUser() macht selbst einen Netzwerk-Call und kann offline
    // ROH werfen. Da refreshProfile jetzt auch aus dem AppState-Foreground-
    // Recheck und dem NetInfo-Retry aufgerufen wird, darf es niemals werfen —
    // sonst gäbe es unbehandelte Promise-Rejections. Netzwerkfehler werden wie
    // errorKind "network" behandelt (Offline-Wartezustand in app/index.tsx).
    let currentUser: User | null;
    try {
      const { data } = await supabase.auth.getUser();
      currentUser = data.user;
    } catch (err) {
      if (!isMountedRef.current) {
        return;
      }
      setProfileError(isNetworkError(err) ? "network" : "server");
      return;
    }

    if (!currentUser) {
      setProfile(null);
      setProfileError(null);
      return;
    }

    const result = await getProfileByUserId(currentUser.id);

    if (!isMountedRef.current) {
      return;
    }

    if (result.profile && result.profile.is_active === false) {
      await forceSignOutDueToDeactivation();
      return;
    }

    if (result.profile) {
      autoRetryCountRef.current = 0;
    }

    setProfile(result.profile);
    setProfileError(result.errorKind);
  }, [forceSignOutDueToDeactivation]);

  const syncPushToken = useCallback(async () => {
    try {
      const expoPushToken = await registerForPushNotifications();

      if (!expoPushToken) {
        return;
      }

      // Über die RPC speichern (SECURITY DEFINER, setzt nur die eigene Zeile
      // per auth.uid()). Employees haben KEINE direkte UPDATE-Policy auf
      // profiles — ein direktes .update() würde für sie still fehlschlagen und
      // der Push-Token bliebe leer. Die RPC umgeht das sicher.
      // Schlägt außerdem serverseitig fehl, wenn das Profil inaktiv ist
      // (siehe update_my_push_token in lib/schema.sql) — ein deaktivierter
      // Mitarbeiter kann sich so keinen frischen Token mehr registrieren.
      const { error } = await supabase.rpc("update_my_push_token", {
        new_token: expoPushToken,
      });

      if (error) {
        // Offline ist erwartbar — Push-Token wird beim nächsten Login/Online
        // ohnehin erneut gespeichert. Kein Redbox für Netzwerkfehler.
        if (!isNetworkError(error)) {
          console.error("Failed to save expo push token:", error);
        }
        return;
      }

      if (__DEV__) {
        console.log("Expo push token saved successfully.");
      }
    } catch (error) {
      if (!isNetworkError(error)) {
        console.error("Failed to register for push notifications:", error);
      }
    }
  }, []);

  const applySession = useCallback(
    async (nextSession: Session | null, options?: { syncToken?: boolean }) => {
      const syncToken = options?.syncToken ?? false;

      if (!isMountedRef.current) {
        return;
      }

      setSession(nextSession);
      setUser(nextSession?.user ?? null);

      const nextUserId = nextSession?.user?.id ?? null;

      if (!nextUserId) {
        setProfile(null);
        setProfileError(null);
        lastHandledUserIdRef.current = null;
        return;
      }

      const result = await getProfileByUserId(nextUserId);

      if (!isMountedRef.current) {
        return;
      }

      if (result.profile && result.profile.is_active === false) {
        await forceSignOutDueToDeactivation();
        return;
      }

      if (result.profile) {
        autoRetryCountRef.current = 0;
      }

      setProfile(result.profile);
      setProfileError(result.errorKind);
      lastHandledUserIdRef.current = nextUserId;

      if (syncToken) {
        await syncPushToken();
      }
    },
    [syncPushToken, forceSignOutDueToDeactivation],
  );

  useEffect(() => {
    isMountedRef.current = true;

    const bootstrap = async () => {
      try {
        setLoading(true);

        const { data, error } = await supabase.auth.getSession();

        if (error && !isNetworkError(error)) {
          console.error("Failed to get session:", error);
        }

        await applySession(data.session ?? null, { syncToken: true });
      } finally {
        isBootstrappingRef.current = false;

        if (isMountedRef.current) {
          setLoading(false);
        }
      }
    };

    bootstrap();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      // INITIAL_SESSION ignorieren, weil bootstrap das schon übernimmt
      if (event === "INITIAL_SESSION") {
        return;
      }

      // Während bootstrap noch läuft, keine doppelte Verarbeitung
      if (isBootstrappingRef.current) {
        return;
      }

      const nextUserId = newSession?.user?.id ?? null;
      const lastUserId = lastHandledUserIdRef.current;

      // Bei gleichem User nicht unnötig alles doppelt laden
      // Ausnahme: SIGNED_OUT muss trotzdem sauber verarbeitet werden
      if (event !== "SIGNED_OUT" && nextUserId && nextUserId === lastUserId) {
        return;
      }

      try {
        setLoading(true);
        await applySession(newSession, { syncToken: !!nextUserId });
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
        }
      }
    });

    return () => {
      isMountedRef.current = false;
      subscription.unsubscribe();
    };
  }, [applySession]);

  // Begrenzter Auto-Retry: kommt die Internetverbindung zurück, während wir
  // eine Session, aber (noch) kein Profil haben, automatisch erneut
  // versuchen — deckt den Fall ab, dass der erste Profil-Fetch offline lief
  // oder an einem vorübergehenden Serverfehler scheiterte. Höchstens
  // MAX_AUTO_RETRIES Versuche, danach nur noch manuelles Retry über die UI
  // (siehe app/index.tsx) — verhindert Dauerfeuer bei echtem Serverfehler.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (!state.isConnected) {
        return;
      }
      if (
        session &&
        !profile &&
        !loading &&
        autoRetryCountRef.current < MAX_AUTO_RETRIES
      ) {
        autoRetryCountRef.current += 1;
        refreshProfile().catch(() => {
          // Fehler wird bereits über profileError sichtbar gemacht.
        });
      }
    });

    return () => unsubscribe();
  }, [session, profile, loading, refreshProfile]);

  // Live-Deaktivierung — REALTIME-Pfad (schnelle Reaktion, aber nur wirksam,
  // wenn profiles in der supabase_realtime-Publication liegt; das richtet die
  // Migration 20260713_… ein). "employee read own profile" (id = auth.uid())
  // ist is_active-unabhängig → der deaktivierte Nutzer darf seine eigene Zeile
  // weiter lesen und bekommt das UPDATE-Event zugestellt. Dieser Pfad ist eine
  // Optimierung; die VERLÄSSLICHE Absicherung ist der AppState-Recheck unten,
  // der ohne Realtime/Publication auskommt.
  useEffect(() => {
    const uid = session?.user?.id;

    if (!uid) {
      return;
    }

    const channel = supabase
      .channel(`profile-active-${uid}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "profiles",
          filter: `id=eq.${uid}`,
        },
        (payload) => {
          const nextRow = payload.new as { is_active?: boolean } | undefined;
          if (nextRow && nextRow.is_active === false) {
            forceSignOutDueToDeactivation();
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session?.user?.id, forceSignOutDueToDeactivation]);

  // Live-Deaktivierung — VERLÄSSLICHER, realtime-UNABHÄNGIGER Pfad.
  // Bei jedem Wechsel der App in den Vordergrund wird das eigene Profil neu
  // geladen; ist es inzwischen deaktiviert, greift forceSignOutDueToDeactivation
  // (über refreshProfile). Das funktioniert auch dann, wenn Realtime nicht
  // konfiguriert ist oder die Verbindung im Hintergrund abgerissen ist — der
  // Nutzer wird spätestens beim nächsten Antippen der App gesperrt.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && session) {
        refreshProfile().catch(() => {
          // Fehler landen über profileError in der UI; hier bewusst schlucken,
          // damit ein Foreground-Wechsel nie zu einer unbehandelten Rejection wird.
        });
      }
    });

    return () => subscription.remove();
  }, [session, refreshProfile]);

  const signOut = useCallback(async () => {
    // Push-Token IMMER zuerst best effort löschen — auch wenn signOut() selbst
    // fehlschlägt, darf auf einem geteilten Gerät kein Token des vorherigen
    // Nutzers stehen bleiben. Fehler hier blockieren den Logout nicht.
    await clearOwnPushTokenBestEffort();

    const { error } = await supabase.auth.signOut();

    if (error) {
      throw error;
    }

    setSession(null);
    setUser(null);
    setProfile(null);
    setProfileError(null);
    lastHandledUserIdRef.current = null;
    autoRetryCountRef.current = 0;
  }, [clearOwnPushTokenBestEffort]);

  const value = useMemo(
    () => ({
      session,
      user,
      profile,
      role: profile?.role ?? null,
      loading,
      profileError,
      signOut,
      refreshProfile,
    }),
    [session, user, profile, loading, profileError, signOut, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }

  return context;
}
