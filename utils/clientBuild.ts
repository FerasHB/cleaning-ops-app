// utils/clientBuild.ts
// Einzige Quelle für "welcher Build läuft hier wirklich" — liest den
// NATIVEN Build (Application.nativeBuildVersion), nicht das JS-gebündelte
// app.json-Manifest (Constants.expoConfig?.ios?.buildNumber). Dieses Projekt
// nutzt EAS' Remote-Versionierung (eas.json: production.autoIncrement) —
// app.json trägt gar kein ios.buildNumber/android.versionCode, EAS schreibt
// die Nummer nur in die native Binary, nie zurück ins Manifest. Genutzt von
// lib/supabase.ts (Compatibility-Header) und AuthContext.tsx (Telemetrie),
// damit beide garantiert denselben Wert sehen.

import Application from "expo-application";
import { Platform } from "react-native";

export type ClientPlatform = "ios" | "android";

/** null für Web/sonstige Plattformen — die Durchsetzung gilt nur mobil. */
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
  const raw = Application.nativeBuildVersion;
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
