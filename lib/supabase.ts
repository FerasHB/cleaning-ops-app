import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";
import { classifyClientKey } from "./supabaseKeyGuard";

// Supabase URL und Key aus den Env Variablen holen
// (!) bedeutet: wir gehen davon aus, dass sie sicher vorhanden sind
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

// ─────────────────────────────────────────────────────────────────
// SICHERHEITS-GUARD (FAIL CLOSED): Im Client darf AUSSCHLIESSLICH ein
// Publishable-/Legacy-anon-Key stehen — niemals ein Secret-/Service-Role-Key.
// Ein Secret-Key im Client (EXPO_PUBLIC_ landet im App-Bundle) würde RLS für
// ALLE Nutzer aushebeln. Hintergrund: EXPO_PUBLIC_SUPABASE_ANON_KEY enthielt
// versehentlich einen sb_secret_-Key.
//
// Verhalten (Dev UND Produktion identisch): Ist der Key kein sicher als
// öffentlich erkannter Key, wird der Supabase-Client GAR NICHT erst erzeugt,
// sondern ein klarer Fehler geworfen. Lieber ein App-Start-Fehler als ein
// weltweit offengelegter Secret-Key. Der Key-Wert wird NIEMALS geloggt —
// nur die Klassifikation (public/secret/unknown/missing).
//
// Die reine Klassifikationslogik liegt in ./supabaseKeyGuard (seiteneffektfrei,
// isoliert testbar). Hier passiert nur die App-weite Konsequenz (throw).
// ─────────────────────────────────────────────────────────────────
const keyVerdict = classifyClientKey(supabaseAnonKey);
if (keyVerdict === "secret" || keyVerdict === "unknown") {
  // Der geworfene Fehler enthält nur die Klassifikation, nie den Key-Wert.
  throw new Error(
    "SICHERHEIT: EXPO_PUBLIC_SUPABASE_ANON_KEY ist kein zulässiger öffentlicher " +
      `Client-Key (erkannt als: ${keyVerdict}). Im Client sind ausschließlich ` +
      "Publishable-Keys (sb_publishable_…) oder der Legacy-anon-Key erlaubt. " +
      "Secret-/Service-Role-Keys gehören ausschließlich serverseitig (Edge Functions).",
  );
}
// "missing" wird bewusst nicht hier abgefangen: createClient wirft dafür
// bereits einen eindeutigen "supabaseKey is required"-Fehler.

// Supabase Client erstellen (wird in der ganzen App verwendet)
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Storage für Session:
    // - Web → Supabase nutzt eigenen Mechanismus
    // - Mobile → AsyncStorage wird verwendet
    storage: Platform.OS === "web" ? undefined : AsyncStorage,

    // Token automatisch erneuern (wichtig für Login dauerhaft)
    autoRefreshToken: true,

    // Session speichern (User bleibt eingeloggt)
    persistSession: true,

    // Für Web: erkennt Session aus URL (z.B. nach Redirect/Login)
    detectSessionInUrl: Platform.OS === "web",

    // PKCE-Flow für native Deep-Links (z.B. Passwort-Reset).
    // Damit hängt resetPasswordForEmail einen code_challenge an und speichert
    // den zugehörigen code_verifier lokal. Der Recovery-Link kommt dann als
    // taskopsmanager://reset-password?code=... zurück und wird über
    // supabase.auth.exchangeCodeForSession(code) eingelöst
    // (siehe features/auth/ResetPasswordScreen.tsx). Ohne pkce würde kein
    // Verifier gespeichert und der Code-Tausch schlüge fehl.
    flowType: "pkce",
  },
});