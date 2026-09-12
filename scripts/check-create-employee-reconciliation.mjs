#!/usr/bin/env node

/**
 * Fokussierter Regressionstest für die Zusammenführung von Phase 14
 * (umgebungsabhängiges Deep-Link-Schema) und Phase 15 (optionale
 * Mitarbeiter-Telefonnummer) in supabase/functions/create-employee/index.ts.
 *
 * Grund für diesen Test: create-employee/index.ts läuft unter Deno
 * (`Deno.serve(...)` beim Modul-Laden) — ein direkter Node-Import würde sofort
 * mit "Deno is not defined" abstürzen. Zwei getrennte, node-taugliche Prüfungen:
 *
 *   A. supabase/functions/_shared/appUrlScheme.ts hat KEINE Deno-Spezifika
 *      (reine Funktion) und wird direkt importiert + gegen beide Projekt-Refs
 *      geprüft — identisch zum Muster aus scripts/check-auth-link-scheme.mjs
 *      (Phase 14).
 *   B. create-employee/index.ts wird als TEXT gelesen und auf die
 *      strukturellen Marker BEIDER Phasen geprüft (Import + schema-abgeleitetes
 *      INVITE_REDIRECT_TO für Phase 14; Telefon-Typ/-Normalisierung/-Upsert für
 *      Phase 15) — analog zum bestehenden Muster "pg_get_functiondef(...) LIKE
 *      '%is_assigned_to_job%'" in den SQL-Tests, nur auf TS-Quelltext statt SQL.
 *
 * Ausführen (Node >= 22.6): node --experimental-strip-types
 *   scripts/check-create-employee-reconciliation.mjs
 * Exit-Code 0 = OK, 1 = Regression erkannt.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEVELOPMENT_APP_SCHEME,
  PRODUCTION_APP_SCHEME,
  resolveAppUrlScheme,
} from "../supabase/functions/_shared/appUrlScheme.ts";

const PROD_URL = "https://ivzsbspopudqgobunsdv.supabase.co";
const STAGING_URL = "https://legzogskvcmicdgowyax.supabase.co";

let failures = 0;
function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> ${JSON.stringify(actual)} (erwartet ${JSON.stringify(expected)})`);
}

// ── A. resolveAppUrlScheme (Phase 14, per Projekt-Ref) ──
check(
  "Staging-SUPABASE_URL -> taskopsmanagerdev://accept-invite-Schema",
  resolveAppUrlScheme(STAGING_URL),
  DEVELOPMENT_APP_SCHEME,
);
check(
  "Produktions-SUPABASE_URL -> taskopsmanager://accept-invite-Schema",
  resolveAppUrlScheme(PROD_URL),
  PRODUCTION_APP_SCHEME,
);
check("Dev-Schema-Konstante", DEVELOPMENT_APP_SCHEME, "taskopsmanagerdev");
check("Prod-Schema-Konstante", PRODUCTION_APP_SCHEME, "taskopsmanager");
check(
  "Unbekannte/leere URL faellt PROD-sicher zurueck",
  resolveAppUrlScheme(undefined),
  PRODUCTION_APP_SCHEME,
);

// ── B. Struktur-Marker in create-employee/index.ts (beide Phasen vorhanden) ──
const indexPath = fileURLToPath(
  new URL("../supabase/functions/create-employee/index.ts", import.meta.url),
);
const source = readFileSync(indexPath, "utf8");

function checkIncludes(label, needle) {
  check(label, source.includes(needle), true);
}
function checkNotIncludes(label, needle) {
  check(label, source.includes(needle), false);
}

// Phase 14: umgebungsabhaengiges Schema.
checkIncludes(
  "importiert resolveAppUrlScheme aus _shared/appUrlScheme.ts",
  'import { resolveAppUrlScheme } from "../_shared/appUrlScheme.ts";',
);
checkIncludes(
  "leitet APP_URL_SCHEME aus SUPABASE_URL ab",
  "const APP_URL_SCHEME = resolveAppUrlScheme(Deno.env.get(\"SUPABASE_URL\"));",
);
checkIncludes(
  "INVITE_REDIRECT_TO nutzt APP_URL_SCHEME (nicht mehr hart codiert)",
  "const INVITE_REDIRECT_TO = `${APP_URL_SCHEME}://accept-invite`;",
);
checkNotIncludes(
  "KEIN hart codiertes taskopsmanager://accept-invite mehr (Regression aus Phase 15)",
  'const INVITE_REDIRECT_TO = "taskopsmanager://accept-invite";',
);

// Phase 15: optionale Telefonnummer bleibt vollstaendig erhalten.
checkIncludes("CreateEmployeeBody hat optionales phone-Feld", "phone?: string;");
checkIncludes("E.164-Normalisierungsfunktion vorhanden", "function normalizePhoneE164(");
checkIncludes("Telefon wird aus body.phone normalisiert", "normalizePhoneE164(body.phone)");
checkIncludes(
  "Upsert setzt phone nur bei gueltiger Nummer (loescht bestehende nicht)",
  "...(phone ? { phone } : {})",
);

if (failures > 0) {
  console.error(`\n${failures} Fall/Fälle FEHLGESCHLAGEN`);
  process.exit(1);
}
console.log("\nALLE FÄLLE PASS");
