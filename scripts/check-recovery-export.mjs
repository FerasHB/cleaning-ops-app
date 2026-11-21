// scripts/check-recovery-export.mjs
// Work Recovery S1.7: Export der Prüffall-Nachweise vor der Firmenlöschung.
// Prüft services/account/recoveryExport.core.ts mit eingespeisten
// Abhängigkeiten (Datei, Hash, Server), dazu die Verdrahtung im Screen und
// die Übersetzungen.
//
// Kernregeln:
//   * Bestätigt wird NUR nach geschriebener + zurückgelesener + per SHA-256
//     geprüfter Datei UND ausdrücklicher Bestätigung (userConfirmed === true).
//   * Abbruch, Schreib-/Lesefehler, Abweichung, Web → keine Bestätigung.
//   * Die Datei ist der exakte Server-Text (verlustfrei, auch 1.50 und große
//     Ganzzahlen), nie ein neu serialisiertes Objekt.
//   * Kein Inhalt landet in console.* (interne Notizen, Personendaten).
//
// Ausführen: node --experimental-strip-types --test scripts/check-recovery-export.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  acknowledgeRecoveryExport,
  classifyRecoveryExportError,
  prepareRecoveryExport,
  RecoveryExportError,
  recoveryExportFileName,
  validateRecoveryExportResponse,
} from "../services/account/recoveryExport.core.ts";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const EXPORT_ID = "0b6c3a52-8a1e-4c55-9d10-6f1f6f0a1a11";
const FP = "a".repeat(64);
const SECRET = "INTERN: Rückfrage beim Kunden";

// Exakt so, wie Postgres jsonb::text rendert (Leerzeichen nach , und :) —
// inklusive Werten, die JSON.parse verfälschen würde.
function serverText({ cases = 1, submissions = 1, actionRefs = 1, events = 2, open = 0, exportId = EXPORT_ID } = {}) {
  const caseRows = Array.from({ length: cases }, (_, i) =>
    `{"id": "c${i}", "state": "approved", "admin_note": "${SECRET}"}`).join(", ");
  const subRows = Array.from({ length: submissions }, (_, i) =>
    `{"id": "s${i}", "claimed_ops": [{"km": 1.50, "seq": 12345678901234567890, "note": "Grüße"}]}`).join(", ");
  const refRows = Array.from({ length: actionRefs }, (_, i) => `{"client_action_id": "a${i}"}`).join(", ");
  const evRows = Array.from({ length: events }, (_, i) => `{"id": ${i + 1}, "event_type": "case_opened"}`).join(", ");
  return `{"people": {"p1": "Emil Eins"}, "recovery": {"cases": [${caseRows}], "events": [${evRows}], "format": "work_recovery_export_v1", "company_id": "x", "action_refs": [${refRows}], "submissions": [${subRows}]}, "export_id": "${exportId}", "fingerprint": "${FP}", "generated_at": "2026-11-21T10:00:00+00:00", "record_counts": {"cases": ${cases}, "events": ${events}, "action_refs": ${actionRefs}, "submissions": ${submissions}}, "open_case_count": ${open}}`;
}

function response(over = {}, textOpts = {}) {
  const text = over.file_text ?? serverText(textOpts);
  return {
    format: "work_recovery_export_file_v1",
    export_id: EXPORT_ID,
    fingerprint: FP,
    generated_at: "2026-11-21T11:00:00+01:00",
    record_counts: {
      cases: textOpts.cases ?? 1,
      submissions: textOpts.submissions ?? 1,
      action_refs: textOpts.actionRefs ?? 1,
      events: textOpts.events ?? 2,
    },
    open_case_count: textOpts.open ?? 0,
    file_text: text,
    file_sha256: sha(text),
    ...over,
  };
}

// Fake-Gerät: protokolliert die Reihenfolge aller Aufrufe.
function fakeDeps(over = {}) {
  const calls = [];
  const files = new Map();
  const deps = {
    platform: "ios",
    async fetchExportFile() { calls.push("fetch"); return response(); },
    async writeFile(name, text) { calls.push("write"); files.set(`file://${name}`, text); return { uri: `file://${name}` }; },
    async readFile(uri) { calls.push("read"); return files.get(uri); },
    async sha256Hex(text) { calls.push("hash"); return sha(text); },
    async acknowledge(id) { calls.push(`ack:${id}`); },
    ...over,
  };
  return { deps, calls, files };
}

const NOW = new Date("2026-11-21T10:00:00Z");

// ── Validierung ─────────────────────────────────────────────

test("gültige Antwort: Zähler, offene Fälle, Text unverändert", () => {
  const v = validateRecoveryExportResponse(response());
  assert.equal(v.exportId, EXPORT_ID);
  assert.equal(v.totalRecords, 5);
  assert.equal(v.openCaseCount, 0);
  assert.equal(v.fileText, serverText());
});

test("unvollständige oder widersprüchliche Antworten werden abgelehnt", () => {
  const bad = [
    null,
    response({ format: "x" }),
    response({ export_id: "nope" }),
    response({ fingerprint: "zz" }),
    response({ file_sha256: "123" }),
    response({ file_text: "" }),
    response({ file_text: "{kein json" }),
    response({ record_counts: { cases: 1, submissions: 1, action_refs: 1 } }),
    // Kopf sagt 2 Fälle, Datei enthält 1
    response({ record_counts: { cases: 2, submissions: 1, action_refs: 1, events: 2 } }),
    // export_id in der Datei passt nicht zum Kopf
    response({ file_text: serverText({ exportId: "11111111-1111-1111-1111-111111111111" }) }),
    response({ open_case_count: 3 }),
  ];
  for (const raw of bad) {
    assert.throws(() => validateRecoveryExportResponse(raw), (e) => e instanceof RecoveryExportError && e.kind === "invalid_response");
  }
});

test("Dateiname: Firmen-Slug, Datum, export_id-Präfix, .json", () => {
  assert.equal(recoveryExportFileName("Müller & Söhne GmbH", EXPORT_ID, NOW),
    "taskops-recovery-Mu-ller-So-hne-GmbH-2026-11-21-0b6c3a52.json");
});

// ── Vorbereiten (Datei schreiben + prüfen) ──────────────────

test("Erfolg: holen → schreiben → zurücklesen → Hash; NIE bestätigt", async () => {
  const { deps, calls, files } = fakeDeps();
  const p = await prepareRecoveryExport(deps, "Firma", NOW);
  assert.deepEqual(calls, ["fetch", "write", "read", "hash"]);
  assert.equal(p.required, true);
  assert.equal(p.verified, true);
  // Datei = exakter Server-Text, verlustfrei
  const written = files.get(p.uri);
  assert.equal(written, serverText());
  assert.match(written, /"km": 1\.50/);
  assert.match(written, /12345678901234567890/);
});

test("keine Nachweise: nichts geschrieben, nichts zu bestätigen", async () => {
  const empty = response({}, { cases: 0, submissions: 0, actionRefs: 0, events: 0 });
  const { deps, calls } = fakeDeps({ async fetchExportFile() { calls.push("fetch"); return empty; } });
  const p = await prepareRecoveryExport(deps, "Firma", NOW);
  assert.equal(p.required, false);
  assert.deepEqual(calls, ["fetch"]);
  await assert.rejects(acknowledgeRecoveryExport(deps, p, true), (e) => e.kind === "not_required");
  assert.ok(!calls.some((c) => c.startsWith("ack")));
});

test("Web: abgelehnt, bevor irgendetwas abgerufen wird", async () => {
  const { deps, calls } = fakeDeps({ platform: "web" });
  await assert.rejects(prepareRecoveryExport(deps, "Firma", NOW), (e) => e.kind === "unsupported_platform");
  assert.deepEqual(calls, []);
});

test("Schreibfehler / Lesefehler / Abweichung / falscher Hash → keine verwertbare Datei", async () => {
  const cases = [
    [{ async writeFile() { throw new Error("disk full"); } }, "write_failed"],
    [{ async readFile() { throw new Error("gone"); } }, "verify_failed"],
    [{ async readFile(uri) { return serverText().slice(0, -1); } }, "verify_failed"],
    [{ async sha256Hex() { return "b".repeat(64); } }, "verify_failed"],
    [{ async sha256Hex() { throw new Error("crypto"); } }, "verify_failed"],
  ];
  for (const [over, kind] of cases) {
    const { deps, calls } = fakeDeps(over);
    await assert.rejects(prepareRecoveryExport(deps, "Firma", NOW), (e) => e.kind === kind);
    assert.ok(!calls.some((c) => c.startsWith("ack")), `kein ack bei ${kind}`);
  }
});

test("Serverfehler beim Export werden zugeordnet", async () => {
  const map = [
    [{ code: "42501", message: "not_authorized" }, "not_authorized"],
    [{ code: "28000", message: "unauthenticated" }, "unauthenticated"],
    [new TypeError("Network request failed"), "transport"],
  ];
  for (const [err, kind] of map) {
    const { deps } = fakeDeps({ async fetchExportFile() { throw err; } });
    await assert.rejects(prepareRecoveryExport(deps, "Firma", NOW), (e) => e.kind === kind);
  }
});

// ── Bestätigen ──────────────────────────────────────────────

test("Bestätigung nur mit geprüfter Datei UND ausdrücklichem true", async () => {
  const { deps, calls } = fakeDeps();
  const p = await prepareRecoveryExport(deps, "Firma", NOW);
  for (const confirmed of [false, undefined, "true", 1]) {
    await assert.rejects(acknowledgeRecoveryExport(deps, p, confirmed), (e) => e.kind === "not_confirmed");
  }
  await assert.rejects(acknowledgeRecoveryExport(deps, { ...p, verified: false }, true), (e) => e.kind === "verify_failed");
  await assert.rejects(acknowledgeRecoveryExport(deps, { ...p, uri: null }, true), (e) => e.kind === "verify_failed");
  await assert.rejects(acknowledgeRecoveryExport(deps, null, true), (e) => e.kind === "not_required");
  assert.ok(!calls.some((c) => c.startsWith("ack")));
  await acknowledgeRecoveryExport(deps, p, true);
  assert.deepEqual(calls.filter((c) => c.startsWith("ack")), [`ack:${EXPORT_ID}`]);
});

test("veraltet beim Bestätigen → stale; Wiederholung nach Netzfehler mit derselben export_id", async () => {
  const stale = fakeDeps({ async acknowledge() { throw { code: "P0001", message: "recovery_export_stale" }; } });
  const p1 = await prepareRecoveryExport(stale.deps, "Firma", NOW);
  await assert.rejects(acknowledgeRecoveryExport(stale.deps, p1, true), (e) => e.kind === "stale");

  let attempt = 0;
  const ids = [];
  const flaky = fakeDeps({
    async acknowledge(id) { ids.push(id); attempt += 1; if (attempt === 1) throw new TypeError("Network request failed"); },
  });
  const p2 = await prepareRecoveryExport(flaky.deps, "Firma", NOW);
  await assert.rejects(acknowledgeRecoveryExport(flaky.deps, p2, true), (e) => e.kind === "transport");
  await acknowledgeRecoveryExport(flaky.deps, p2, true);
  assert.deepEqual(ids, [EXPORT_ID, EXPORT_ID]);
});

test("Fehlerzuordnung: fremder/unbekannter Export ist not_authorized", () => {
  assert.equal(classifyRecoveryExportError({ code: "42501", message: "export_not_found" }), "not_authorized");
  assert.equal(classifyRecoveryExportError({ code: "P0001", message: "recovery_export_stale" }), "stale");
  assert.equal(classifyRecoveryExportError(new Error("boom")), "unknown");
});

// ── Kein Inhalt in Logs ─────────────────────────────────────

test("kein console.* während aller Abläufe; Fehlermeldungen ohne Inhalt", async () => {
  const seen = [];
  const orig = {};
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    orig[m] = console[m];
    console[m] = (...args) => seen.push(args.join(" "));
  }
  try {
    const ok = fakeDeps();
    const p = await prepareRecoveryExport(ok.deps, "Firma", NOW);
    await acknowledgeRecoveryExport(ok.deps, p, true);
    const bad = fakeDeps({ async readFile() { return "manipuliert"; } });
    const err = await prepareRecoveryExport(bad.deps, "Firma", NOW).catch((e) => e);
    assert.equal(err.message, "recovery_export_verify_failed");
    assert.ok(!err.message.includes(SECRET));
  } finally {
    for (const m of Object.keys(orig)) console[m] = orig[m];
  }
  assert.deepEqual(seen, []);
});

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("Quelltext: kein console.* in Service, Kern und Komponente", () => {
  for (const p of [
    "services/account/recoveryExport.core.ts",
    "services/account/recoveryExport.ts",
    "features/profile/components/RecoveryExportSection.tsx",
  ]) {
    assert.doesNotMatch(read(p), /console\.\w+\(/, p);
  }
});

// ── Verdrahtung ─────────────────────────────────────────────

test("Komponente: Bestätigung nur im eigenen Button mit Checkbox; Teilen bestätigt nichts", () => {
  const src = read("features/profile/components/RecoveryExportSection.tsx");
  const ackCalls = src.match(/acknowledgeRecoveryExport\(/g) ?? [];
  assert.equal(ackCalls.length, 1);
  assert.match(src, /acknowledgeRecoveryExport\(recoveryExportDeps, prepared, savedOutside\)/);
  const share = src.slice(src.indexOf("const handleShare"), src.indexOf("const handleAcknowledge"));
  assert.doesNotMatch(share, /acknowledge|setPhase\("acknowledged"\)|setSavedOutside\(true\)/);
  assert.doesNotMatch(src, /Alert\.alert/);
  assert.doesNotMatch(src, /\bt\(\s*"[^"]*"\s*\)\s*\?\?/);
});

test("Screen: Löschen gesperrt, solange der Recovery-Abschnitt sperrt; Reset bei Pfadwechsel", () => {
  const src = read("features/profile/DeleteAccountScreen.tsx");
  assert.match(src, /confirmedCompany && acknowledgedRetention && !recoveryBlocking/);
  assert.match(src, /<RecoveryExportSection[\s\S]*onBlockingChange=\{setRecoveryBlocking\}/);
  const reset = src.slice(src.indexOf("const resetAfterPathChange"), src.indexOf("const email ="));
  assert.match(reset, /setRecoveryResetKey\(\(k\) => k \+ 1\)/);
  // Server-Ablehnung (Export fehlt/veraltet, Fälle offen) hält die Sperre auch
  // nach dem Reset: kein Ablehnen-Wiederholen-Kreislauf.
  const deny = src.slice(src.indexOf('result.code === "recovery_cases_open"'), src.indexOf("result.message kommt aus"));
  assert.equal((deny.match(/setRecoveryRequiredByServer\(true\)/g) ?? []).length, 2);
  assert.match(src, /requiredByServer=\{recoveryRequiredByServer\}/);
  const section = read("features/profile/components/RecoveryExportSection.tsx");
  assert.match(section, /const required = recordsKnown \|\| \(requiredByServer && phase !== "notRequired"\);/);
  assert.match(section, /\(required && \(phase !== "acknowledged"/);
  // Arbeitszeit-Export unverändert vorhanden
  assert.match(src, /handleExport\("pdf"\)/);
  assert.match(src, /handleExport\("csv"\)/);
});

test("Gerät: fehlgeschlagenes Schreiben entfernt die unvollständige Datei", () => {
  const dev = read("services/account/recoveryExport.ts");
  const w = dev.slice(dev.indexOf("async writeFile"), dev.indexOf("async readFile"));
  assert.match(w, /catch \(err\) \{[\s\S]*file\.delete\(\)[\s\S]*throw err;/);
});

test("Übersetzungen: gleiche Schlüssel + Platzhalter in de/en/ar/tr, nichts leer", () => {
  const load = (l) => JSON.parse(read(`i18n/locales/${l}/profile.json`)).deleteAccount.recovery;
  const de = load("de");
  const keys = Object.keys(de).sort();
  const ph = (s) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(",");
  for (const l of ["en", "ar", "tr"]) {
    const other = load(l);
    assert.deepEqual(Object.keys(other).sort(), keys, l);
    for (const k of keys) {
      assert.ok(typeof other[k] === "string" && other[k].trim().length > 0, `${l}.${k}`);
      assert.equal(ph(other[k]), ph(de[k]), `${l}.${k} Platzhalter`);
    }
  }
  // Jeder im Code verwendete Schlüssel existiert.
  const used = new Set();
  for (const p of ["features/profile/components/RecoveryExportSection.tsx", "services/account/recoveryExport.ts"]) {
    for (const m of read(p).matchAll(/profile:deleteAccount\.recovery\.(\w+)/g)) used.add(m[1]);
  }
  const src = read("features/profile/components/RecoveryExportSection.tsx");
  for (const m of src.matchAll(/:\s*"(\w+)",?\n/g)) if (keys.includes(m[1])) used.add(m[1]);
  for (const k of used) assert.ok(keys.includes(k), `fehlender Schlüssel ${k}`);
  for (const k of ["unsupportedPlatform", "notAuthorized", "failed", "writeFailed", "verifyFailed", "stale"]) {
    assert.ok(used.has(k), `Fehlertext ${k} wird nicht verwendet`);
  }
});
