import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";
import { classifyClientKey } from "./supabaseKeyGuard";
import { getClientBuildNumber, getClientPlatform } from "@/utils/clientBuild";

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

// ─────────────────────────────────────────────────────────────────
// KOMPATIBILITÄTS-HEADER (Client-Compatibility-Fundament, Migration
// 20260916120000): bei JEDEM REST/RPC-Aufruf mitgeschickt, serverseitig
// über current_setting('request.headers', true) gelesen — empirisch gegen
// Staging verifiziert (echter PostgREST-Roundtrip mit einer temporären,
// sofort wieder entfernten Sonden-Funktion). Einmalig beim Modul-Laden
// berechnet — der native Build ändert sich nicht während der Laufzeit
// eines Prozesses.
//
// PRODUKTENTSCHEIDUNG (nicht nur technische Lücke): Web liefert
// getClientPlatform() = null → bewusst KEINE Header. Job-Schreibpfade
// (start_own_job/complete_own_job/set_job_assignments) sind offiziell nur
// auf nativem iOS/Android supported; Web ist Dev-/QA-Ziel. Fehlende Header
// MÜSSEN weiterhin als nicht unterstützter Client gelten, sobald
// enforcement_enabled=true ist — kein Web-Bypass, auch nicht später. Ein
// Web-Aufruf dieser RPCs bekommt dann also dieselbe 22023-Ablehnung wie ein
// zu alter mobiler Client; das ist beabsichtigt, nicht der weiche
// isVersionBlocked-Hinweis (siehe AuthContext.tsx), der auf Web ohnehin nie
// greift. Vor einer Produktions-Aktivierung von enforcement_enabled prüfen,
// ob echte Web-Nutzung dieser Aktionen existiert (siehe CLAUDE.md).
const clientPlatform = getClientPlatform();
const clientBuild = getClientBuildNumber();
const compatibilityHeaders: Record<string, string> =
  clientPlatform && clientBuild
    ? { "x-taskops-platform": clientPlatform, "x-taskops-build": String(clientBuild) }
    : {};

// Supabase Client erstellen (wird in der ganzen App verwendet)
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    headers: compatibilityHeaders,
  },
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
    // taskopsmanager://reset-password?code=... (Development-Build:
    // taskopsmanagerdev://…, siehe services/auth/authRedirect.ts) zurück und wird über
    // supabase.auth.exchangeCodeForSession(code) eingelöst
    // (siehe features/auth/ResetPasswordScreen.tsx). Ohne pkce würde kein
    // Verifier gespeichert und der Code-Tausch schlüge fehl.
    flowType: "pkce",
  },
});