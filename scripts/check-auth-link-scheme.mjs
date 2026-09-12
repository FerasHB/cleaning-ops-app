#!/usr/bin/env node

/**
 * Fokussierter Test für die Deep-Link-Isolation Staging/Produktion (Phase 14):
 * utils/authLinkScheme.ts (Client) und supabase/functions/_shared/appUrlScheme.ts
 * (Edge Functions), plus Gleichlauf mit app.config.js. Importiert die ECHTEN
 * Quelldateien (beide ohne RN-/Expo-/Deno-Imports) — gleiches Vorgehen wie
 * scripts/check-backend-environment-label.mjs.
 *
 * Ausführen (Node >= 22.6): node --experimental-strip-types
 *   scripts/check-auth-link-scheme.mjs
 * Exit-Code 0 = OK, 1 = Regression erkannt.
 */

import { createRequire } from "node:module";
import {
  DEVELOPMENT_APP_SCHEME as EDGE_DEV,
  PRODUCTION_APP_SCHEME as EDGE_PROD,
  resolveAppUrlScheme,
} from "../supabase/functions/_shared/appUrlScheme.ts";
import {
  DEVELOPMENT_APP_SCHEME as CLIENT_DEV,
  PRODUCTION_APP_SCHEME as CLIENT_PROD,
  resolveAuthLinkScheme,
} from "../utils/authLinkScheme.ts";

const require = createRequire(import.meta.url);

const PROD_URL = "https://ivzsbspopudqgobunsdv.supabase.co";
const STAGING_URL = "https://legzogskvcmicdgowyax.supabase.co";

let failures = 0;

function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> ${actual} (erwartet ${expected})`);
}

// app.config.js liest APP_VARIANT beim Laden — pro Variante frisch laden.
function loadAppConfig(variant) {
  const path = require.resolve("../app.config.js");
  delete require.cache[path];
  if (variant) process.env.APP_VARIANT = variant;
  else delete process.env.APP_VARIANT;
  const { expo } = require("../app.json");
  const resolved = require(path)({ config: expo });
  delete process.env.APP_VARIANT;
  return resolved;
}

// ── Client: resolveAuthLinkScheme ──
check(
  "Produktions-Release (eingebettet taskopsmanager) -> Produktion",
  resolveAuthLinkScheme(false, "taskopsmanager"),
  "taskopsmanager",
);
check(
  "Release ohne eingebettetes Schema -> Produktion (bisheriges Verhalten)",
  resolveAuthLinkScheme(false, undefined),
  "taskopsmanager",
);
check(
  "Release mit Schema-Array -> erstes Schema",
  resolveAuthLinkScheme(false, ["taskopsmanager", "other"]),
  "taskopsmanager",
);
check(
  "Release mit unbekanntem Schema -> Produktion",
  resolveAuthLinkScheme(false, "something-else"),
  "taskopsmanager",
);
check(
  "Release mit eingebetteter Dev-Variante -> Dev",
  resolveAuthLinkScheme(false, "taskopsmanagerdev"),
  "taskopsmanagerdev",
);
check(
  "Dev-Build, Metro OHNE APP_VARIANT (Phase-14-Fall) -> Dev",
  resolveAuthLinkScheme(true, "taskopsmanager"),
  "taskopsmanagerdev",
);
check(
  "Dev-Build, Metro MIT APP_VARIANT -> Dev",
  resolveAuthLinkScheme(true, "taskopsmanagerdev"),
  "taskopsmanagerdev",
);

// ── Edge Functions: resolveAppUrlScheme ──
check("Edge: Produktions-Projekt -> Produktion", resolveAppUrlScheme(PROD_URL), "taskopsmanager");
check("Edge: Staging-Projekt -> Dev", resolveAppUrlScheme(STAGING_URL), "taskopsmanagerdev");
check(
  "Edge: lokales functions serve -> Produktion (unverändert)",
  resolveAppUrlScheme("http://kong:8000"),
  "taskopsmanager",
);
check("Edge: SUPABASE_URL fehlt -> Produktion", resolveAppUrlScheme(undefined), "taskopsmanager");

// ── Gleichlauf: Client ↔ Edge ↔ app.config.js (natives Schema) ──
check("Client-/Edge-Produktions-Schema identisch", EDGE_PROD, CLIENT_PROD);
check("Client-/Edge-Dev-Schema identisch", EDGE_DEV, CLIENT_DEV);
check(
  "app.config.js ohne APP_VARIANT registriert das Produktions-Schema",
  loadAppConfig(undefined).scheme,
  CLIENT_PROD,
);
check(
  "app.config.js mit APP_VARIANT=development registriert das Dev-Schema",
  loadAppConfig("development").scheme,
  CLIENT_DEV,
);

if (failures > 0) {
  console.error(`\n${failures} Fall/Fälle FEHLGESCHLAGEN`);
  process.exit(1);
}

console.log("\nALLE FÄLLE PASS");
