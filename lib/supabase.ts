import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";

// Supabase URL und Key aus den Env Variablen holen
// (!) bedeutet: wir gehen davon aus, dass sie sicher vorhanden sind
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

// ─────────────────────────────────────────────────────────────────
// SICHERHEITS-GUARD: Im Client darf AUSSCHLIESSLICH ein Publishable-/Anon-Key
// stehen — niemals ein Secret-/Service-Role-Key. Ein Secret-Key im Client
// (EXPO_PUBLIC_ landet im App-Bundle) würde RLS für alle Nutzer aushebeln.
// Hintergrund: EXPO_PUBLIC_SUPABASE_ANON_KEY enthielt versehentlich einen
// sb_secret_-Key. Dieser Guard erkennt den Fehler früh beim App-Start.
// Es wird NIEMALS der Key-Wert geloggt.
// ─────────────────────────────────────────────────────────────────
function jwtRoleClaim(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const g = globalThis as { atob?: (s: string) => string };
    const json = typeof g.atob === "function" ? g.atob(b64) : "";
    const m = json.match(/"role"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function assertClientKeyIsPublic(key: string | undefined): void {
  if (!key) return;
  const looksLikeSecret =
    key.startsWith("sb_secret_") || jwtRoleClaim(key) === "service_role";
  if (!looksLikeSecret) return;

  const message =
    "SICHERHEIT: EXPO_PUBLIC_SUPABASE_ANON_KEY ist ein Secret-/Service-Role-Key. " +
    "Im Client ausschließlich den Publishable-/Anon-Key verwenden (Service-Key nur serverseitig).";
  // Dev: harter Abbruch. Produktion: fail-closed-Hinweis ohne die App komplett
  // zu bricken (das Problem muss aber vor dem Release behoben werden).
  if (__DEV__) {
    throw new Error(message);
  }
  console.error(message);
}

assertClientKeyIsPublic(supabaseAnonKey);

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