#!/usr/bin/env node

/**
 * Fokussierter Regressionstest für die Zusammenführung von Phase 14
 * (umgebungsabhängiges Deep-Link-Schema) mit der bestehenden, unverändert zu
 * erhaltenden Einladung/Wiederherstellung-Verzweigung in
 * supabase/functions/resend-invite/index.ts.
 *
 * Analog zu scripts/check-create-employee-reconciliation.mjs: resend-invite/
 * index.ts läuft unter Deno (`Deno.serve(...)` beim Modul-Laden) — ein
 * direkter Node-Import würde sofort mit "Deno is not defined" abstürzen.
 * Zwei getrennte, node-taugliche Prüfungen:
 *
 *   A. supabase/functions/_shared/appUrlScheme.ts (reine Funktion, keine
 *      Deno-Spezifika) direkt importiert und gegen beide Projekt-Refs geprüft.
 *   B. resend-invite/index.ts als TEXT gelesen und auf die strukturellen
 *      Marker BEIDER Aspekte geprüft: das schema-abgeleitete Redirect-Paar
 *      (Phase 14) UND die unveränderte Einladung/Wiederherstellung-
 *      Verzweigung (bestehendes, absichtliches Verhalten — siehe
 *      services/employees/resendInvite.ts::ResendInviteMode) — inklusive der
 *      Zuordnung "unbestätigt -> INVITE_REDIRECT_TO (inviteUserByEmail)" und
 *      "bestätigt/Invite-Limbo -> PASSWORD_RESET_REDIRECT_TO
 *      (resetPasswordForEmail)", damit eine künftige Änderung nicht versehentlich
 *      welche Redirect-Konstante zu welchem Zweig gehört vertauscht.
 *
 * Ausführen (Node >= 22.6): node --experimental-strip-types
 *   scripts/check-resend-invite-reconciliation.mjs
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

// ── A. resolveAppUrlScheme (Phase 14, per Projekt-Ref) — identische Ableitung
//    wie create-employee, aus derselben Datei importiert. ──
check(
  "Staging-SUPABASE_URL -> taskopsmanagerdev-Schema",
  resolveAppUrlScheme(STAGING_URL),
  DEVELOPMENT_APP_SCHEME,
);
check(
  "Produktions-SUPABASE_URL -> taskopsmanager-Schema",
  resolveAppUrlScheme(PROD_URL),
  PRODUCTION_APP_SCHEME,
);
check(
  "Unbekannte/leere URL faellt PROD-sicher zurueck",
  resolveAppUrlScheme(undefined),
  PRODUCTION_APP_SCHEME,
);

// ── B. Struktur-Marker in resend-invite/index.ts ──
const indexPath = fileURLToPath(
  new URL("../supabase/functions/resend-invite/index.ts", import.meta.url),
);
const source = readFileSync(indexPath, "utf8");

function checkIncludes(label, needle) {
  check(label, source.includes(needle), true);
}
function checkNotIncludes(label, needle) {
  check(label, source.includes(needle), false);
}

// Phase 14: umgebungsabhaengiges Schema fuer BEIDE Redirect-Ziele.
checkIncludes(
  "importiert resolveAppUrlScheme aus _shared/appUrlScheme.ts",
  'import { resolveAppUrlScheme } from "../_shared/appUrlScheme.ts";',
);
checkIncludes(
  "leitet APP_URL_SCHEME aus SUPABASE_URL ab",
  'const APP_URL_SCHEME = resolveAppUrlScheme(Deno.env.get("SUPABASE_URL"));',
);
checkIncludes(
  "INVITE_REDIRECT_TO nutzt APP_URL_SCHEME (Staging -> taskopsmanagerdev://accept-invite)",
  "const INVITE_REDIRECT_TO = `${APP_URL_SCHEME}://accept-invite`;",
);
checkIncludes(
  "PASSWORD_RESET_REDIRECT_TO nutzt APP_URL_SCHEME (Staging -> taskopsmanagerdev://reset-password)",
  "const PASSWORD_RESET_REDIRECT_TO = `${APP_URL_SCHEME}://reset-password`;",
);
checkNotIncludes(
  "KEIN hart codiertes taskopsmanager://accept-invite mehr",
  'const INVITE_REDIRECT_TO = "taskopsmanager://accept-invite";',
);
checkNotIncludes(
  "KEIN hart codiertes taskopsmanager://reset-password mehr",
  'const PASSWORD_RESET_REDIRECT_TO = "taskopsmanager://reset-password";',
);

// Bestehendes, UNVERAENDERT zu erhaltendes Verhalten: Einladung/Wiederherstellung.
checkIncludes(
  "isConfirmed-Erkennung (Invite-Limbo) unveraendert vorhanden",
  "const isConfirmed = Boolean(",
);
checkIncludes(
  "isConfirmed prueft confirmed_at ?? email_confirmed_at",
  "authUser.user.confirmed_at ?? authUser.user.email_confirmed_at",
);
checkIncludes(
  "bestaetigt/Invite-Limbo-Zweig nutzt weiterhin resetPasswordForEmail",
  "await adminClient.auth\n        .resetPasswordForEmail(authUser.user.email, {",
);
checkIncludes(
  "resetPasswordForEmail nutzt weiterhin PASSWORD_RESET_REDIRECT_TO",
  "redirectTo: PASSWORD_RESET_REDIRECT_TO,",
);
checkIncludes(
  "Erfolgsantwort des Recovery-Zweigs bleibt mode: \"recovery\"",
  '{ success: true, mode: "recovery" }',
);
checkIncludes(
  "unbestaetigter Zweig nutzt weiterhin inviteUserByEmail",
  "await adminClient.auth.admin\n      .inviteUserByEmail(authUser.user.email, {",
);
checkIncludes(
  "inviteUserByEmail nutzt weiterhin INVITE_REDIRECT_TO",
  "redirectTo: INVITE_REDIRECT_TO,",
);
checkIncludes(
  "Erfolgsantwort des Invite-Zweigs bleibt mode: \"invite\"",
  '{ success: true, mode: "invite", invitedAt }',
);
checkIncludes(
  "invite_accepted_at-Guard (bereits angenommen -> 400) unveraendert",
  "if (targetProfile.invite_accepted_at) {",
);

if (failures > 0) {
  console.error(`\n${failures} Fall/Fälle FEHLGESCHLAGEN`);
  process.exit(1);
}
console.log("\nALLE FÄLLE PASS");
