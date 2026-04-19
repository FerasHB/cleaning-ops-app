import { supabase } from "@/lib/supabase";
import { registerForPushNotifications } from "@/services/notificationService";
import {
  getProfileByUserId,
  type AppRole,
  type AuthProfile,
} from "@/services/profileService";
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

type AuthContextType = {
  session: Session | null;
  user: User | null;
  profile: AuthProfile | null;
  role: AppRole | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const isMountedRef = useRef(true);
  const lastHandledUserIdRef = useRef<string | null>(null);
  const isBootstrappingRef = useRef(true);

  const refreshProfile = useCallback(async () => {
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();

    if (!currentUser) {
      setProfile(null);
      return;
    }

    const nextProfile = await getProfileByUserId(currentUser.id);
    setProfile(nextProfile);
  }, []);

  const syncPushToken = useCallback(async (userId: string) => {
    try {
      const expoPushToken = await registerForPushNotifications();

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
        lastHandledUserIdRef.current = null;
        return;
      }

      const nextProfile = await getProfileByUserId(nextUserId);

      if (!isMountedRef.current) {
        return;
      }

      setProfile(nextProfile);
      lastHandledUserIdRef.current = nextUserId;

      if (syncToken) {
        await syncPushToken(nextUserId);
      }
    },
    [syncPushToken],
  );

  useEffect(() => {
    isMountedRef.current = true;

    const bootstrap = async () => {
      try {
        setLoading(true);

        const { data, error } = await supabase.auth.getSession();

        if (error) {
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

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();

    if (error) {
      throw error;
    }

    setSession(null);
    setUser(null);
    setProfile(null);
    lastHandledUserIdRef.current = null;
  }, []);

  const value = useMemo(
    () => ({
      session,
      user,
      profile,
      role: profile?.role ?? null,
      loading,
      signOut,
      refreshProfile,
    }),
    [session, user, profile, loading, signOut, refreshProfile],
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
