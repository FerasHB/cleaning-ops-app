import { supabase } from "@/lib/supabase";
import { isNetworkError } from "@/utils/networkError";

export type AppRole = "admin" | "employee";

export type AuthProfile = {
  id: string;
  full_name: string;
  company_id: string | null;
  role: AppRole;
  is_active: boolean;
};

// Unterscheidet "kein Netz" (erwartbar, retryt sich von selbst beim
// nächsten Reconnect) von einem echten Server-/RLS-/Datenfehler (sollte
// dem Nutzer sichtbar gemacht werden, statt endlos zu laden).
export type ProfileFetchErrorKind = "network" | "server" | null;

export type ProfileFetchResult = {
  profile: AuthProfile | null;
  errorKind: ProfileFetchErrorKind;
};

export async function getProfileByUserId(
  userId: string,
): Promise<ProfileFetchResult> {
  // try/catch, weil der Supabase-Aufruf offline auch ROH werfen kann (nicht nur
  // { error }). Diese Funktion läuft u. a. bei Auth-Events (z. B. Token-Refresh-
  // Versuche beim WLAN-Umschalten) — ein roher Throw würde sonst zu einer
  // unbehandelten Promise-Rejection und einem Dev-Error-Overlay führen.
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, company_id, role, is_active")
      .eq("id", userId)
      .single();

    if (error) {
      if (isNetworkError(error)) {
        return { profile: null, errorKind: "network" };
      }
      console.error("Failed to load profile:", error);
      return { profile: null, errorKind: "server" };
    }

    return { profile: data as AuthProfile, errorKind: null };
  } catch (err) {
    if (isNetworkError(err)) {
      return { profile: null, errorKind: "network" };
    }
    console.error("Failed to load profile:", err);
    return { profile: null, errorKind: "server" };
  }
}
