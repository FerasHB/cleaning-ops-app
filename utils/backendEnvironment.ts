// utils/backendEnvironment.ts
// Leitet ein rein beobachtendes Backend-Umgebungs-Label (PROD/STAGING/
// UNKNOWN) aus der ohnehin vorhandenen EXPO_PUBLIC_SUPABASE_URL ab — KEINE
// neue Env-Variable, kein Duplikat. Ziel: Entwickler/QA sollen auf einen
// Blick sehen, mit welchem Backend ein Build gerade tatsächlich spricht, um
// stille Umgebungs-Verwechslungen (Staging vs. Production) zu vermeiden —
// siehe Phase 11 Invite-Limbo-Diagnose, wo genau das den ersten
// Recovery-Test unbemerkt gegen das falsche Backend laufen ließ.
//
// Absichtlich seiteneffektfrei, ohne RN-/Expo-Imports (gleiches Muster wie
// lib/supabaseKeyGuard.ts) — dadurch isoliert testbar, u.a. direkt per
// `node --experimental-strip-types scripts/check-backend-environment-label.mjs`
// (kein Jest/RTL im Projekt vorhanden).
//
// Die beiden Projekt-Refs sind KEINE Geheimnisse: sie stehen bereits offen
// in der URL selbst (https://<ref>.supabase.co) und in der Projekt-Doku.
// Diese Datei gibt niemals den anon-/publishable-Key oder die volle URL
// zurück — ausschließlich die Klassifikation.

export type BackendEnvironmentLabel = "PROD" | "STAGING" | "UNKNOWN";

const PROD_REF = "ivzsbspopudqgobunsdv";
const STAGING_REF = "legzogskvcmicdgowyax";

// Bewusst per String-Suche auf den Projekt-Ref, nicht per exaktem
// URL-Vergleich — überlebt z. B. einen Wechsel des Ports/Protokolls in
// lokalen Tunneling-Szenarien, solange der Ref selbst in der Host-URL steht.
export function deriveBackendEnvironmentLabel(
  supabaseUrl: string | undefined | null,
): BackendEnvironmentLabel {
  if (typeof supabaseUrl !== "string" || supabaseUrl.trim().length === 0) {
    return "UNKNOWN";
  }
  if (supabaseUrl.includes(PROD_REF)) return "PROD";
  if (supabaseUrl.includes(STAGING_REF)) return "STAGING";
  return "UNKNOWN";
}

// Sichtbarkeitsregel — bewusst NICHT an APP_VARIANT/IS_DEV (app.config.js)
// gekoppelt: die "preview"-Profile lösen dieselbe Konfiguration wie ein
// echtes Produktions-Release auf (IS_DEV=false, gleiches Schema/Bundle-ID),
// zeigen aber teils absichtlich auf Staging (siehe eas.json
// "preview-staging") — genau der Fall, den dieser Indikator abdecken soll.
// "Internal QA only" lässt sich in dieser Build-Architektur also NICHT
// zuverlässig am Build-Profil festmachen.
//
// Stattdessen: sichtbar in JEDEM Dev-/Metro-Kontext (__DEV__, unabhängig vom
// Backend — auch "PROD" als bewusste Erinnerung) ODER immer dann, wenn das
// Backend NICHT Produktion ist (deckt jeden Nicht-Dev-Build ab, der auf
// Staging/unbekannt zeigt). Ein echtes Produktions-Release ist niemals
// __DEV__ UND zeigt per Definition auf PROD — beide Bedingungen sind dort
// gleichzeitig falsch, der Indikator bleibt dort also immer unsichtbar.
export function shouldShowBackendEnvironmentIndicator(
  label: BackendEnvironmentLabel,
  isDev: boolean,
): boolean {
  return isDev || label !== "PROD";
}
