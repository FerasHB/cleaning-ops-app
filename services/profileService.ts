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

export async function getProfileByUserId(
  userId: string,
): Promise<AuthProfile | null> {
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
      // Offline-/Netzwerkfehler ruhig behandeln (kein Redbox); nur echte Fehler
      // loggen. In beiden Fällen null zurückgeben (kein Profil verfügbar).
      if (!isNetworkError(error)) {
        console.error("Failed to load profile:", error);
      }
      return null;
    }

    return data as AuthProfile;
  } catch (err) {
    if (!isNetworkError(err)) {
      console.error("Failed to load profile:", err);
    }
    return null;
  }
}