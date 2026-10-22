// app.config.js
// ─────────────────────────────────────────────────────────────────
// Dynamische Expo-Konfiguration. Zwei Aufgaben:
//
//  1. Firebase-Datei für Android aus der EAS-Dateivariable ziehen
//     (google-services.json ist gitignored, öffentliches Repo).
//
//  2. App-Variante: Der Development-Build bekommt eine EIGENE iOS-Bundle-ID
//     und einen eigenen Namen, damit er PARALLEL zur TestFlight-App auf
//     demselben iPhone leben kann. Vorher teilten sich beide
//     com.ferash.taskopsmanager — die Installation des TestFlight-Builds hat
//     den Development-Client also schlicht überschrieben. Danach öffnete die
//     Metro-URL (exp+cleaning-employee-app-2://expo-development-client/?url=…)
//     die Produktions-App, die keinen Dev-Launcher enthält: expo-router
//     interpretierte den Pfad als Route -> „Unmatched Route".
//
// Die Variante wird AUSSCHLIESSLICH über APP_VARIANT gesteuert, gesetzt im
// EAS-Build-Profil "development" (eas.json) und in `npm start` (damit auch
// das Metro-Manifest des Dev-Clients die Variante kennt). Ohne die Variable
// gelten Produktions-Identität und -Schema (preview und production).
// EAS Update ist für beide Varianten aktiv, siehe unten.
// ─────────────────────────────────────────────────────────────────

const IS_DEV = process.env.APP_VARIANT === "development";
const EAS_UPDATE_URL = "https://u.expo.dev/e746276f-fbd7-49bd-aab6-dc3176e7661a";

// Supabase-Projekt-Refs (öffentlich, stehen ohnehin in jeder App-URL).
const PRODUCTION_SUPABASE_REF = "ivzsbspopudqgobunsdv";
const STAGING_SUPABASE_REF = "legzogskvcmicdgowyax";

// Umgebungs-Guard: Variante und Backend müssen zusammenpassen (Regel aus
// CLAUDE.md: Dev-Schema ⇒ Staging, Produktion ⇒ Produktions-Backend). Greift
// nur im EAS-Build (EAS_BUILD=true) und in den OTA-Skripten
// (TASKOPS_ENV_GUARD=1, package.json ota:*) — lokale Entwicklung bleibt
// unberührt, dort überschreibt .env.local bewusst auf Staging. Ein
// unbekanntes oder fehlendes Backend wird hier nicht bewertet.
function assertBackendMatchesVariant() {
  const active =
    process.env.EAS_BUILD === "true" || process.env.TASKOPS_ENV_GUARD === "1";
  if (!active) return;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
  const forbiddenRef = IS_DEV ? PRODUCTION_SUPABASE_REF : STAGING_SUPABASE_REF;
  if (url.includes(forbiddenRef)) {
    throw new Error(
      IS_DEV
        ? "[env-guard] Development-/Staging-Variante (APP_VARIANT=development) " +
          "zeigt auf das PRODUKTIONS-Supabase-Projekt. Abbruch — Dev-Schema-Builds " +
          "und Staging-Updates müssen gegen Staging laufen (EAS-Umgebung development)."
        : "[env-guard] Produktions-Variante (APP_VARIANT nicht gesetzt) zeigt auf das " +
          "STAGING-Supabase-Projekt. Abbruch — Produktions-Builds/-Updates nur mit " +
          "EAS-Umgebung production (--environment production, ohne .env.local)."
    );
  }
}

module.exports = ({ config }) => {
  assertBackendMatchesVariant();
  return buildConfig(config);
};

const buildConfig = (config) => ({
  ...config,

  // Klar unterscheidbar im Homescreen und im App-Switcher.
  name: IS_DEV ? "TaskOps Manager Dev" : config.name,

  // Eigenes URL-Schema, damit taskopsmanager://-Links (z. B. aus der
  // Produktions-App) nicht versehentlich im Dev-Build landen, wenn beide
  // Apps installiert sind.
  //
  // ACHTUNG: Das Dev-Client-Schema exp+<slug> wird vom expo-dev-client-Plugin
  // aus dem SLUG abgeleitet, nicht aus Bundle-ID oder scheme — es bleibt
  // deshalb bei beiden Apps identisch. Siehe Hinweis im PR: zum Verbinden
  // notfalls die Dev-Client-App direkt öffnen statt den QR-Code zu scannen.
  scheme: IS_DEV ? "taskopsmanagerdev" : config.scheme,

  // EAS Update für BEIDE Varianten (gleiches EAS-Projekt, gleiche URL).
  // Getrennt werden Staging und Produktion über den Build-Kanal (eas.json:
  // preview-staging → "staging", production → "production") und über die
  // Fingerprint-Runtime (Bundle-ID/Schema/Name unterscheiden sich → andere
  // Runtime). Produktions-OTA nur mit `--environment production`
  // veröffentlichen — siehe docs/ota-updates.md.
  updates: { ...config.updates, url: EAS_UPDATE_URL },
  runtimeVersion: { policy: "fingerprint" },

  ios: {
    ...config.ios,
    bundleIdentifier: IS_DEV
      ? "com.ferash.taskopsmanager.dev"
      : config.ios.bundleIdentifier,
  },

  android: {
    ...config.android,
    // Der Android-PACKAGE-NAME bleibt bewusst unverändert — auch für die
    // Dev-Variante. google-services.json enthält genau einen Client für
    // com.ferash.taskopsmanager; ein abweichendes Package ließe den
    // Google-Services-Schritt im Build scheitern („No matching client found")
    // und FCM-Push wäre tot. Eine getrennte Android-Variante bräuchte einen
    // zweiten Firebase-Client — bewusst nicht Teil dieser Änderung.
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
  },
});
