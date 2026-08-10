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
// EAS-Build-Profil "development" (eas.json). Ohne die Variable bleibt alles
// exakt wie bisher — preview und production sind damit unverändert.
// ─────────────────────────────────────────────────────────────────

const IS_DEV = process.env.APP_VARIANT === "development";

module.exports = ({ config }) => ({
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
