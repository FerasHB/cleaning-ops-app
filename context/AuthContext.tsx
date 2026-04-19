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

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      setLoading(true);

      const { data, error } = await supabase.auth.getSession();

      if (error) {
        console.error("Failed to get session:", error);
      }

      const currentSession = data.session ?? null;

      if (!mounted) return;

      setSession(currentSession);
      setUser(currentSession?.user ?? null);

      if (currentSession?.user?.id) {
        const nextProfile = await getProfileByUserId(currentSession.user.id);
        setProfile(nextProfile);
        await syncPushToken(currentSession.user.id);
      } else {
        setProfile(null);
      }

      if (mounted) {
        setLoading(false);
      }
    };

    bootstrap();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);

      if (newSession?.user?.id) {
        const nextProfile = await getProfileByUserId(newSession.user.id);
        setProfile(nextProfile);
        await syncPushToken(newSession.user.id);
      } else {
        setProfile(null);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [syncPushToken]);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();

    if (error) {
      throw error;
    }

    setSession(null);
    setUser(null);
    setProfile(null);
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
