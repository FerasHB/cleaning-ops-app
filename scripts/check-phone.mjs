#!/usr/bin/env node

/**
 * Fokussierter Test für utils/phone.ts — importiert die ECHTE Quelldatei
 * direkt (kein Jest/RTL im Projekt, siehe scripts/check-backend-environment-
 * label.mjs für dasselbe Vorgehen). utils/phone.ts hat keine RN-/Expo-Importe.
 *
 * Ausführen (Node >= 22.6): node --experimental-strip-types
 *   scripts/check-phone.mjs
 * Exit-Code 0 = OK, 1 = Regression erkannt.
 */

import {
  E164_PATTERN,
  formatPhoneForDisplay,
  isValidPhone,
  normalizePhone,
} from "../utils/phone.ts";

let failures = 0;
function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> ${JSON.stringify(actual)} (erwartet ${JSON.stringify(expected)})`);
}

// ── normalizePhone: DE-Eingaben ──
check("DE national 0170…", normalizePhone("0170 1234567"), "+491701234567");
check("DE national mit Trennern", normalizePhone("0170/123-45 67"), "+491701234567");
check("DE 00-Präfix", normalizePhone("0049 170 1234567"), "+491701234567");
check("bereits E.164", normalizePhone("+491701234567"), "+491701234567");
check("E.164 mit Leerzeichen", normalizePhone("+49 170 1234567"), "+491701234567");
check("Festnetz 030…", normalizePhone("030 12345678"), "+493012345678");
check("reine Ziffern mit CC", normalizePhone("491701234567"), "+491701234567");
check("Klammern/Plus", normalizePhone("+49 (0)170 1234567"), "+4901701234567");

// ── normalizePhone: ungültig ──
check("leer", normalizePhone(""), null);
check("null", normalizePhone(null), null);
check("undefined", normalizePhone(undefined), null);
check("zu kurz", normalizePhone("12345"), null);
check("Buchstaben", normalizePhone("abcdef"), null);
check("nur 0", normalizePhone("0"), null);
check("+0…", normalizePhone("+0123456789"), null);
check("zu lang (16 Ziffern)", normalizePhone("+1234567890123456"), null);

// ── isValidPhone ──
check("isValidPhone gut", isValidPhone("0170 1234567"), true);
check("isValidPhone leer", isValidPhone(""), false);
check("isValidPhone Müll", isValidPhone("foo"), false);

// ── formatPhoneForDisplay ──
check("format E.164 DE", formatPhoneForDisplay("+491701234567"), "+49 170 1234567");
check("format aus roher DE-Eingabe", formatPhoneForDisplay("0170 1234567"), "+49 170 1234567");
check("format undeutbar -> unverändert", formatPhoneForDisplay("foo"), "foo");
check("format leer -> ''", formatPhoneForDisplay(""), "");
check("format null -> ''", formatPhoneForDisplay(null), "");

// ── E164_PATTERN deckungsgleich mit dem DB-CHECK ──
check("Pattern: +491701234567", E164_PATTERN.test("+491701234567"), true);
check("Pattern: +0…", E164_PATTERN.test("+0170"), false);
check("Pattern: ohne +", E164_PATTERN.test("491701234567"), false);

if (failures > 0) {
  console.error(`\n${failures} Fall/Fälle FEHLGESCHLAGEN`);
  process.exit(1);
}
console.log("\nALLE FÄLLE PASS");
