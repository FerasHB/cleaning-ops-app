import { supabase } from "@/lib/supabase";
import { Session, User } from "@supabase/supabase-js";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Platform } from "react-native";

// Rollen in der App
type AppRole = "admin" | "employee";

// Das Profil, das wir aus der profiles-Tabelle holen
type AuthProfile = {
  id: string;
  full_name: string;
  company_id: string | null;
  role: AppRole;
  is_active: boolean;
};

// Was unser AuthContext später nach außen gibt
type AuthContextType = {
  session: Session | null;
  user: User | null;
  profile: AuthProfile | null;
  role: AppRole | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

// Context erstellen
const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Globale Notification-Einstellungen
// Hier legen wir fest, wie Push Notifications in der App angezeigt werden
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Holt ein Expo Push Token vom Gerät
async function registerForPushNotificationsAsync(): Promise<string | null> {
  // Auf Web gibt es hier kein normales Push-Handling wie auf iOS / Android
  if (Platform.OS === "web") {
    return null;
  }

  // Für Android muss ein Notification Channel angelegt werden
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#2563EB",
    });
  }

  // Push funktioniert nur auf echten Geräten, nicht sauber im Simulator
  if (!Device.isDevice) {
    console.log("Push notifications require a physical device.");
    return null;
  }

  // Erst aktuelle Berechtigung prüfen
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  // Wenn noch nicht erlaubt → User nach Erlaubnis fragen
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  // Wenn abgelehnt → kein Token holen
  if (finalStatus !== "granted") {
    console.log("Push notification permission was not granted.");
    return null;
  }

  // Expo projectId aus den App-Configs holen
  const projectId =
    Constants?.expoConfig?.extra?.eas?.projectId ??
    Constants?.easConfig?.projectId;

  // Ohne projectId kann Expo kein Push Token erstellen
  if (!projectId) {
    console.log("Expo projectId not found. Skipping push token registration.");
    return null;
  }

  // Expo Push Token holen
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  return token;
}

// Provider für die ganze App
// Hier wird Auth-Status geladen und allen Components verfügbar gemacht
export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Aktuelle Session von Supabase
  const [session, setSession] = useState<Session | null>(null);

  // Aktueller User aus der Session
  const [user, setUser] = useState<User | null>(null);

  // Eigenes Profil aus der profiles-Tabelle
  const [profile, setProfile] = useState<AuthProfile | null>(null);

  // Loading-State für den App-Start
  const [loading, setLoading] = useState(true);

  // Lädt das Profil aus der Datenbank anhand der User-ID
  const loadProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, company_id, role, is_active")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Failed to load profile:", error);
      setProfile(null);
      return;
    }

    setProfile(data as AuthProfile);
  }, []);

  // Holt Push Token und speichert ihn in Supabase beim User-Profil
  const syncPushToken = useCallback(async (userId: string) => {
    try {
      const expoPushToken = await registerForPushNotificationsAsync();

      // Wenn kein Token da ist → nichts speichern
      if (!expoPushToken) {
        return;
      }

      const { error } = await supabase
        .from("profiles")
        .update({ expo_push_token: expoPushToken })
        .eq("id", userId);

      if (error) {
        console.error("Failed to save expo push token:", error);
        return;
      }

      console.log("Expo push token saved successfully.");
    } catch (error) {
      console.error("Failed to register for push notifications:", error);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    // Lädt beim App-Start die aktuelle Session
    const bootstrap = async () => {
      setLoading(true);

      const { data, error } = await supabase.auth.getSession();

      if (error) {
        console.error("Failed to get session:", error);
      }

      const currentSession = data.session ?? null;

      // Falls die Komponente schon unmounted ist → nichts mehr machen
      if (!mounted) return;

      setSession(currentSession);
      setUser(currentSession?.user ?? null);

      // Wenn User eingeloggt ist → Profil laden + Push Token syncen
      if (currentSession?.user?.id) {
        await loadProfile(currentSession.user.id);
        await syncPushToken(currentSession.user.id);
      } else {
        setProfile(null);
      }

      if (mounted) {
        setLoading(false);
      }
    };

    bootstrap();

    // Reagiert auf Login / Logout / Session-Änderungen
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);

      // Wenn wieder ein User da ist → Profil neu laden + Token syncen
      if (newSession?.user?.id) {
        await loadProfile(newSession.user.id);
        await syncPushToken(newSession.user.id);
      } else {
        setProfile(null);
      }

      setLoading(false);
    });

    // Cleanup beim Unmount
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [loadProfile, syncPushToken]);

  // User ausloggen
  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();

    if (error) {
      throw error;
    }

    // Lokale States direkt zurücksetzen
    setSession(null);
    setUser(null);
    setProfile(null);
  }, []);

  // Context-Wert memoized, damit nicht unnötig oft neu gerendert wird
  const value = useMemo(
    () => ({
      session,
      user,
      profile,
      role: profile?.role ?? null,
      loading,
      signOut,
    }),
    [session, user, profile, loading, signOut],
  );

  // Alle Kinder-Komponenten bekommen hier Zugriff auf den AuthContext
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Eigener Hook für einfacheren Zugriff auf den AuthContext
export function useAuth() {
  const context = useContext(AuthContext);

  // Schutz, falls useAuth außerhalb vom Provider verwendet wird
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }

  return context;
}
