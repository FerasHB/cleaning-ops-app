#!/usr/bin/env node

/**
 * Statischer Regressions-Wächter für den "Zurück zum Login"-Button auf
 * AcceptInviteScreens Ungültig-Bildschirm (siehe Kommentar dort,
 * handleBackToLogin).
 *
 * HINTERGRUND (Geräte-QA, Staging 2026-09): der Button navigierte früher
 * ohne vorheriges Sign-out. Solange eine echte (Nicht-Recovery-)Session
 * besteht, entfernt app/_layout.tsx (<Stack.Protected guard={!hasSession}>)
 * die login-Route komplett aus dem Navigations-Stack — router.replace(
 * "/login") war dadurch ein STILLES No-Op, der Nutzer blieb sichtbar auf
 * dem Ungültig-Bildschirm hängen (genau reproduziert auf einem echten
 * iPhone nach Force-Close + Neustart mit noch aktiver Einladungs-Sitzung).
 *
 * Es gibt in diesem Repo keinen JS-Test-Runner (kein Jest/RTL) und
 * app/_layout.tsxs Stack.Protected-Verhalten lässt sich ohne einen echten
 * Navigator kaum sinnvoll mocken — ein bewusst simples, dependency-freies
 * Text-Wächter-Skript statt eines neuen Test-Frameworks nur für diesen
 * einen Fall. Prüft rein strukturell, dass der Button-Handler weiterhin
 * ZUERST supabase.auth.signOut() aufruft und ERST DANACH zur Login-Route
 * navigiert.
 *
 * Ausführen: node scripts/check-accept-invite-back-to-login.js
 * Exit-Code 0 = OK, 1 = Regression erkannt.
 */

const fs = require("fs");
const path = require("path");

const filePath = path.join(
  __dirname,
  "..",
  "features",
  "auth",
  "AcceptInviteScreen.tsx",
);

const source = fs.readFileSync(filePath, "utf8");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

// 1) handleBackToLogin muss existieren und signOut() VOR router.replace("/login") aufrufen.
const handlerMatch = source.match(
  /const handleBackToLogin = async \(\) => \{([\s\S]*?)\};/,
);

if (!handlerMatch) {
  fail("handleBackToLogin() wurde nicht gefunden — Regressions-Wächter kann nicht prüfen.");
} else {
  const body = handlerMatch[1];
  const signOutIndex = body.indexOf("supabase.auth.signOut()");
  const replaceIndex = body.indexOf('router.replace("/login")');

  if (signOutIndex === -1) {
    fail("handleBackToLogin() ruft supabase.auth.signOut() nicht mehr auf.");
  } else if (replaceIndex === -1) {
    fail('handleBackToLogin() navigiert nicht mehr zu router.replace("/login").');
  } else if (signOutIndex > replaceIndex) {
    fail("handleBackToLogin() navigiert VOR dem Sign-out — genau der ursprüngliche Fehler.");
  }
}

// 2) Der "Zurück zum Login"-Button im Ungültig-Zustand muss handleBackToLogin
//    verwenden, nicht direkt (wieder) einen bloßen router.replace(...).
const invalidBlockMatch = source.match(
  /status === "invalid"[\s\S]*?Zurück zum Login/,
);

if (!invalidBlockMatch) {
  fail('"Zurück zum Login"-Button im Ungültig-Zustand nicht gefunden.');
} else if (!/onPress=\{handleBackToLogin\}/.test(invalidBlockMatch[0])) {
  fail(
    '"Zurück zum Login" ruft nicht mehr handleBackToLogin auf (onPress zeigt evtl. wieder direkt auf router.replace).',
  );
}

if (process.exitCode === 1) {
  process.exit(1);
}

console.log("OK: AcceptInviteScreen \"Zurück zum Login\" meldet vor der Navigation korrekt ab.");
