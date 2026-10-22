// fingerprint.config.js
// ─────────────────────────────────────────────────────────────────
// Steuert, welche Eingaben in die Fingerprint-Runtime (app.config.js:
// runtimeVersion.policy = "fingerprint") einfließen. Ein OTA-Update erreicht
// nur Builds mit exakt gleicher Runtime — jede Lockerung hier kann ein
// JS-Bundle auf eine inkompatible native Binary schicken. NICHT leichtfertig
// erweitern; siehe docs/ota-updates.md.
//
// Zwei bewusst enge Ausnahmen:
//
//  1. package.json "scripts" (SourceSkips.PackageJsonScriptsAll): npm-Skripte
//     (z. B. ota:production) landen nicht in der Binary. Abhängigkeiten und
//     alle anderen package.json-Felder bleiben im Fingerprint.
//
//  2. eas.json: NUR die Kanal-Zuordnung build.<profil>.channel wird vor dem
//     Hashen entfernt (reines EAS-Update-Routing). eas.json wird NICHT
//     komplett ignoriert — Felder wie env, environment, buildConfiguration,
//     gradleCommand oder buildType können die native Ausgabe beeinflussen und
//     bleiben deshalb fingerprint-relevant. Ist eas.json kein gültiges JSON,
//     wird der Originalinhalt gehasht (fail-safe).
// ─────────────────────────────────────────────────────────────────

/* global __dirname */
const path = require("path");
const { Buffer } = require("buffer");
const { SourceSkips } = require("expo/fingerprint");

const EAS_JSON = path.resolve(__dirname, "eas.json");

// Nur Felder, die ausschließlich das Update-Routing steuern.
const ROUTING_ONLY_BUILD_FIELDS = ["channel"];

function stripRoutingFields(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  for (const profile of Object.values(parsed?.build ?? {})) {
    if (profile && typeof profile === "object") {
      for (const field of ROUTING_ONLY_BUILD_FIELDS) delete profile[field];
    }
  }
  return JSON.stringify(parsed);
}

let easJsonChunks = [];

/** @type {import('expo/fingerprint').Config} */
module.exports = {
  // Ersetzt den Default (PackageJsonAndroidAndIosScriptsIfNotContainRun) —
  // daher beide Bits.
  sourceSkips:
    SourceSkips.PackageJsonAndroidAndIosScriptsIfNotContainRun |
    SourceSkips.PackageJsonScriptsAll,

  fileHookTransform: (source, chunk, isEndOfFile, encoding) => {
    if (source.type !== "file" || path.resolve(__dirname, source.filePath) !== EAS_JSON) {
      return chunk;
    }
    // Ganze Datei puffern, erst am Ende transformiert ausgeben.
    if (!isEndOfFile) {
      if (chunk != null) {
        easJsonChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      return null;
    }
    const raw = Buffer.concat(easJsonChunks).toString("utf8");
    easJsonChunks = [];
    return stripRoutingFields(raw);
  },
};
