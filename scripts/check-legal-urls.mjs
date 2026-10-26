#!/usr/bin/env node
// scripts/check-legal-urls.mjs
// Release-Gate (Store-Compliance): prüft, dass die in app.json unter
// expo.extra.legal hinterlegten öffentlichen Seiten erreichbar sind
// (HTTP 2xx nach Redirects). Vor JEDEM Store-Build ausführen — die URLs
// werden in die Binary eingebacken, eine tote Datenschutz-Seite ist ein
// Apple-/Google-Ablehnungsgrund.
//
//   npm run check:legal-urls
//
// Exit-Code 1, sobald eine URL fehlt oder nicht erreichbar ist.

import { readFileSync } from "node:fs";

const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
const legal = app?.expo?.extra?.legal ?? {};
const keys = ["privacyPolicyUrl", "accountDeletionUrl", "supportUrl"];

let failed = false;
for (const key of keys) {
  const url = legal[key];
  if (typeof url !== "string" || !url.startsWith("https://")) {
    console.error(`FEHLT  ${key}: kein https-URL in app.json (expo.extra.legal)`);
    failed = true;
    continue;
  }
  try {
    const res = await fetch(url, { redirect: "follow" });
    const ok = res.status >= 200 && res.status < 300;
    console.log(`${ok ? "OK    " : "FEHLER"} ${key}: ${url} -> HTTP ${res.status}`);
    if (!ok) failed = true;
  } catch (error) {
    console.error(`FEHLER ${key}: ${url} -> ${error instanceof Error ? error.message : error}`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
