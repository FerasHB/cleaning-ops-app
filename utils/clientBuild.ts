// utils/clientBuild.ts
// Einzige Quelle für "welcher Build läuft hier wirklich" — liest den
// NATIVEN Build (Application.nativeBuildVersion), nicht das JS-gebündelte
// app.json-Manifest (Constants.expoConfig?.ios?.buildNumber). Dieses Projekt
// nutzt EAS' Remote-Versionierung (eas.json: production.autoIncrement) —
// app.json trägt gar kein ios.buildNumber/android.versionCode, EAS schreibt
// die Nummer nur in die native Binary, nie zurück ins Manifest. Genutzt von
// lib/supabase.ts (Compatibility-Header) und AuthContext.tsx (Telemetrie),
// damit beide garantiert denselben Wert sehen.

// WICHTIG: expo-application hat KEINEN Default-Export — nativeBuildVersion
// ist ein NAMED export, einmalig beim Modul-Laden zu string|null ausgewertet
// (siehe node_modules/expo-application/src/Application.ts). Ein Default-
// Import (`import Application from "expo-application"`) bindet hier an
// undefined statt an ein Objekt — genau das crashte beim ersten Web-QA-
// Durchlauf dieser Migration die gesamte App direkt beim Modul-Laden
// (lib/supabase.ts importiert diese Datei ganz oben), bevor ueberhaupt
// irgendein Screen rendern konnte.
import { nativeBuildVersion } from "expo-application";
import { Platform } from "react-native";

export type ClientPlatform = "ios" | "android";

/**
 * null für Web/sonstige Plattformen — Produktentscheidung, kein Lückenfall:
 * Job-Schreibpfade sind offiziell nur auf nativem iOS/Android supported, Web
 * ist Dev-/QA-Ziel. Absichtlich NICHT um "web" erweitern, auch nicht als
 * Bypass für die Server-Durchsetzung — fehlende Header müssen einen nicht
 * unterstützten Client identifizieren können, sobald enforcement_enabled
 * aktiv ist (siehe lib/supabase.ts, CLAUDE.md).
 */
export function getClientPlatform(): ClientPlatform | null {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return null;
}

/**
 * Nativer Build als positive Ganzzahl, oder null wenn nicht ermittelbar
 * (Web, Simulator-Edgecases, nicht-numerischer Wert). Defensiv geparst —
 * ein fehlender/kaputter Wert soll nie einen harten Fehler auslösen,
 * sondern einfach wie ein Alt-Client ohne Header behandelt werden.
 */
export function getClientBuildNumber(): number | null {
  if (!nativeBuildVersion) return null;
  const parsed = parseInt(nativeBuildVersion, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
