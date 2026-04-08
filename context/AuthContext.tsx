import { supabase } from "@/lib/supabase";
import { Session, User } from "@supabase/supabase-js";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type AppRole = "admin" | "employee";

type AuthProfile = {
  id: string;
  full_name: string;
  company_id: string | null;
  role: AppRole;
  is_active: boolean;
};

type AuthContextType = {
  session: Session | null;
  user: User | null;
  profile: AuthProfile | null;
  role: AppRole | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [loading, setLoading] = useState(true);

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
        await loadProfile(currentSession.user.id);
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
        await loadProfile(newSession.user.id);
      } else {
        setProfile(null);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [loadProfile]);

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
    }),
    [session, user, profile, loading, signOut],
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
