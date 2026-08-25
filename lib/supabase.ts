import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { AppState, Platform } from "react-native";
import { classifyClientKey } from "./supabaseKeyGuard";
import { AUTH_DIAGNOSTICS_ENABLED } from "@/utils/authDiagnostics";
import { addDiagnosticEvent } from "@/utils/authDiagnosticsBuffer";

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
// TEMPORÄR — NUR FÜR DIE DIAGNOSE DES INTERMITTIERENDEN PKCE-RECOVERY-FEHLERS.
// Vor dem Merge ersatzlos entfernen (siehe utils/authDiagnostics.ts).
//
// Beobachtet den Lebenszyklus GENAU der beiden Storage-Keys, die auth-js für
// PKCE-Recovery verwendet — nicht "wann geprüft", sondern "wann geschrieben/
// gelöscht". Bislang wussten wir nur, ob der code_verifier UNMITTELBAR VOR
// exchangeCodeForSession() vorhanden war; diese Instrumentierung zeigt den
// gesamten Verlauf davor (App-Start, resetPasswordForEmail, ein möglicher
// zweiter Flow, signOut, Session-Refresh).
//
// auth-js/supabase-js leiten den Storage-Key deterministisch aus der
// Projekt-URL ab (siehe @supabase/supabase-js SupabaseClient.ts,
// `sb-${hostname-erstes-Segment}-auth-token`) — dieselbe Ableitung wie
// bereits in features/auth/useAuthLinkSession.ts für CODE_VERIFIER_STORAGE_KEY.
// Der volle, projektspezifische Key wird NIE geloggt — nur die normalisierte
// Kategorie ("code_verifier" / "auth_session"). Jeder andere Key (z.B. die
// separate `-user`-Zeile) wird stillschweigend durchgereicht, OHNE Log-Zeile,
// um den Puffer nicht mit irrelevanten Ereignissen zu fluten.
//
// Reine Beobachtung: jeder Aufruf ruft weiterhin GENAU EINMAL die echte
// AsyncStorage-Methode auf, mit denselben Argumenten, demselben Rückgabewert
// und ohne zusätzliche Verzögerung. Kein Caching, kein Duplizieren, kein
// Umbenennen von Keys, kein Verhindern/Wiederherstellen von Löschungen.
// ─────────────────────────────────────────────────────────────────
const authStorageKeyBase = (() => {
  try {
    return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
  } catch {
    return null;
  }
})();

type AuthStorageCategory = "code_verifier" | "auth_session";

function categorizeAuthStorageKey(key: string): AuthStorageCategory | null {
  if (!authStorageKeyBase) return null;
  if (key === `${authStorageKeyBase}-code-verifier`) return "code_verifier";
  if (key === authStorageKeyBase) return "auth_session";
  return null;
}

function instrumentedAuthStorage(): SupportedStorage {
  return {
    getItem: async (key: string) => {
      const value = await AsyncStorage.getItem(key);
      // Nur code_verifier-GETs loggen (bewusste Lärm-Reduktion) — die
      // Session wird von auth-js sehr häufig gelesen (Refresh-Timer,
      // Lock-Checks) und würde den Puffer sonst dominieren.
      if (categorizeAuthStorageKey(key) === "code_verifier") {
        addDiagnosticEvent(
          "[AuthStorage] code_verifier GET →",
          value ? "PRESENT" : "ABSENT",
          `(AppState:${AppState.currentState})`,
        );
      }
      return value;
    },
    setItem: async (key: string, value: string) => {
      const category = categorizeAuthStorageKey(key);
      await AsyncStorage.setItem(key, value);
      if (category) {
        addDiagnosticEvent(
          `[AuthStorage] ${category} SET`,
          `(AppState:${AppState.currentState})`,
        );
      }
    },
    removeItem: async (key: string) => {
      const category = categorizeAuthStorageKey(key);
      await AsyncStorage.removeItem(key);
      if (category) {
        addDiagnosticEvent(
          `[AuthStorage] ${category} REMOVE`,
          `(AppState:${AppState.currentState})`,
        );
      }
    },
  };
}

// Nur bei aktivierter Diagnose eingesetzt — ohne Flag ist storage exakt
// dasselbe Objekt wie vor dieser Instrumentierung (AsyncStorage direkt).
const nativeAuthStorage: SupportedStorage | undefined =
  Platform.OS === "web"
    ? undefined
    : AUTH_DIAGNOSTICS_ENABLED
      ? instrumentedAuthStorage()
      : AsyncStorage;

// Supabase Client erstellen (wird in der ganzen App verwendet)
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Storage für Session:
    // - Web → Supabase nutzt eigenen Mechanismus
    // - Mobile → AsyncStorage wird verwendet (optional mit Diagnose-Wrapper,
    //   siehe oben — nur wirksam, solange AUTH_DIAGNOSTICS_ENABLED aktiv ist)
    storage: nativeAuthStorage,

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