#!/usr/bin/env node

/**
 * Fokussierter Test für utils/backendEnvironment.ts — importiert die ECHTE
 * Quelldatei direkt (kein Jest/RTL in diesem Projekt, siehe
 * scripts/check-accept-invite-back-to-login.js für dasselbe Vorgehen bei
 * einer RN-Komponente ohne diese Möglichkeit). Da dieses Modul KEINE
 * RN-/Expo-Importe hat, kann Node es mit nativer Typ-Entfernung direkt
 * ausführen — kein Reimplementierungs-Risiko, kein neues Abhängigkeits-Paket.
 *
 * Ausführen: node --experimental-strip-types
 *   scripts/check-backend-environment-label.mjs
 * Exit-Code 0 = OK, 1 = Regression erkannt.
 */

import {
  deriveBackendEnvironmentLabel,
  shouldShowBackendEnvironmentIndicator,
} from "../utils/backendEnvironment.ts";

const PROD_URL = "https://ivzsbspopudqgobunsdv.supabase.co";
const STAGING_URL = "https://legzogskvcmicdgowyax.supabase.co";

let failures = 0;

function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> ${actual} (erwartet ${expected})`);
}

// ── deriveBackendEnvironmentLabel ──
check(
  "Production-URL -> PROD",
  deriveBackendEnvironmentLabel(PROD_URL),
  "PROD",
);
check(
  "Staging-URL -> STAGING",
  deriveBackendEnvironmentLabel(STAGING_URL),
  "STAGING",
);
check(
  "unbekannte URL -> UNKNOWN",
  deriveBackendEnvironmentLabel("https://example.com"),
  "UNKNOWN",
);
check(
  "undefined -> UNKNOWN",
  deriveBackendEnvironmentLabel(undefined),
  "UNKNOWN",
);
check(
  "leerer String -> UNKNOWN",
  deriveBackendEnvironmentLabel(""),
  "UNKNOWN",
);

// ── shouldShowBackendEnvironmentIndicator ──
check(
  "echtes Produktions-Release (isDev=false, PROD) -> NIE sichtbar",
  shouldShowBackendEnvironmentIndicator("PROD", false),
  false,
);
check(
  "Nicht-Dev-Build auf STAGING -> sichtbar (genau der Schutzfall)",
  shouldShowBackendEnvironmentIndicator("STAGING", false),
  true,
);
check(
  "Dev-Kontext auf PROD -> trotzdem sichtbar (Erinnerung)",
  shouldShowBackendEnvironmentIndicator("PROD", true),
  true,
);
check(
  "Nicht-Dev-Build auf UNKNOWN -> sichtbar",
  shouldShowBackendEnvironmentIndicator("UNKNOWN", false),
  true,
);

if (failures > 0) {
  console.error(`\n${failures} Fall/Fälle FEHLGESCHLAGEN`);
  process.exit(1);
}

console.log("\nALLE FÄLLE PASS");
