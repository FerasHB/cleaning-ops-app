// scripts/check-recovery-export-file-security.mjs
// Work Recovery S1.8: Dateisicherheit und Lebenszyklus der lokalen
// Recovery-Exportdatei.
//
// Prüft:
//   * fail closed: ohne bestätigten Backup-Ausschluss wird nichts geschrieben;
//     scheitert der Schutz der geschriebenen Datei, wird sie wieder gelöscht;
//   * "Lokale Kopie löschen": nur nach Server-Bestätigung UND eigener
//     Bestätigung, nur die Datei dieses Exports, wiederholbar, ohne RPC;
//   * Dateinamen: kein Pfadwechsel, keine fremden Dateien;
//   * native Quellen (iOS-Flag setzen + zurücklesen, Android-Regelprüfung),
//     Autolinking und das Android-Config-Plugin inklusive eines echten
//     `expo prebuild` in einem temporären Verzeichnis;
//   * Verdrahtung in Komponente und Screen, Übersetzungen.
//
// CI kann NICHT beweisen, dass ein Gerät die Datei wirklich aus Backups
// heraushält — das bleibt ein Pflichttest auf echten iOS-/Android-Builds.
//
// Ausführen: node --experimental-strip-types --test scripts/check-recovery-export-file-security.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acknowledgeRecoveryExport,
  deleteLocalRecoveryCopy,
  isLocalCopyDeletable,
  isRecoveryExportFileName,
  prepareRecoveryExport,
  RECOVERY_EXPORT_DIR_NAME,
  recoveryExportFileName,
} from "../services/account/recoveryExport.core.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const require = createRequire(import.meta.url);
const plugin = require("../plugins/withRecoveryExportBackupRules.js");

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const ID_A = "0b6c3a52-1111-4222-8333-444455556666";
const ID_B = "9f00e1aa-1111-4222-8333-444455556666";
const NOW = new Date("2026-11-22T10:00:00Z");

function response(exportId = ID_A) {
  const doc = {
    export_id: exportId,
    fingerprint: "a".repeat(64),
    open_case_count: 0,
    people: {},
    record_counts: { cases: 1, submissions: 0, action_refs: 0, events: 0 },
    recovery: { format: "work_recovery_export_v1", cases: [{ note: "intern" }], submissions: [], action_refs: [], events: [] },
  };
  const text = JSON.stringify(doc);
  return {
    format: "work_recovery_export_file_v1",
    export_id: exportId,
    fingerprint: "a".repeat(64),
    generated_at: "2026-11-22T10:00:00Z",
    record_counts: doc.record_counts,
    open_case_count: 0,
    file_text: text,
    file_sha256: sha(text),
  };
}

// Fake-Gerät mit einem Exportverzeichnis (Map Name → Text).
function device(over = {}) {
  const calls = [];
  const files = new Map();
  let nextId = ID_A;
  const deps = {
    platform: "ios",
    async fetchExportFile() { calls.push("fetch"); return response(nextId); },
    async ensureSecureDirectory() { calls.push("secure"); return true; },
    async writeFile(name, text) { calls.push("write"); files.set(name, text); return { uri: `file:///docs/${RECOVERY_EXPORT_DIR_NAME}/${name}` }; },
    async protectFile() { calls.push("protect"); return true; },
    async readFile(uri) { calls.push("read"); return files.get(uri.split("/").pop()); },
    async sha256Hex(text) { return sha(text); },
    async acknowledge(id) { calls.push(`ack:${id}`); },
    async fileExists(name) { return files.has(name); },
    async deleteFile(name) { calls.push(`delete:${name}`); files.delete(name); },
    ...over,
  };
  return { deps, calls, files, setNextId: (id) => { nextId = id; } };
}

const rpcCalls = (calls) => calls.filter((c) => c === "fetch" || c.startsWith("ack"));

// ── fail closed ─────────────────────────────────────────────

test("kein bestätigter Backup-Ausschluss → insecure_storage, kein einziges Byte geschrieben", async () => {
  for (const ensure of [async () => false, async () => undefined, async () => "true", async () => { throw new Error("native"); }]) {
    const { deps, calls, files } = device({ async ensureSecureDirectory() { calls.push("secure"); return ensure(); } });
    await assert.rejects(prepareRecoveryExport(deps, "Firma", NOW), (e) => e.kind === "insecure_storage");
    assert.ok(!calls.includes("write"), "nichts geschrieben");
    assert.equal(files.size, 0);
  }
});

test("Datei nicht geschützt → Datei wieder gelöscht, insecure_storage, keine Bestätigung möglich", async () => {
  for (const protect of [async () => false, async () => { throw new Error("flag"); }]) {
    const { deps, calls, files } = device({ async protectFile() { calls.push("protect"); return protect(); } });
    await assert.rejects(prepareRecoveryExport(deps, "Firma", NOW), (e) => e.kind === "insecure_storage");
    assert.equal(files.size, 0, "geschriebene Datei entfernt");
    assert.ok(!calls.some((c) => c.startsWith("ack")));
  }
});

test("Reihenfolge: Ausschluss vor dem Schreiben, Dateischutz vor der Prüfung; Hash-Prüfung bleibt", async () => {
  const { deps, calls } = device();
  const p = await prepareRecoveryExport(deps, "Firma", NOW);
  assert.deepEqual(calls, ["fetch", "secure", "write", "protect", "read"]);
  assert.equal(p.verified, true);
  const bad = device({ async sha256Hex() { return "b".repeat(64); } });
  await assert.rejects(prepareRecoveryExport(bad.deps, "Firma", NOW), (e) => e.kind === "verify_failed");
});

test("ältere Dateien im Ordner: Ausschluss wird bei JEDEM Export neu gesetzt", async () => {
  const { deps, calls, setNextId } = device();
  await prepareRecoveryExport(deps, "Firma", NOW);
  setNextId(ID_B);
  await prepareRecoveryExport(deps, "Firma", NOW);
  assert.equal(calls.filter((c) => c === "secure").length, 2);
});

// ── Dateinamen ──────────────────────────────────────────────

test("Dateiname: id-Präfix immer klein, nur das strikte Muster, passend zur export_id", () => {
  const upper = ID_A.toUpperCase();
  const name = recoveryExportFileName("Müller & Söhne GmbH", upper, NOW);
  assert.equal(name, "taskops-recovery-Mu-ller-So-hne-GmbH-2026-11-22-0b6c3a52.json");
  assert.ok(isRecoveryExportFileName(name, ID_A));
  assert.ok(isRecoveryExportFileName(name, upper));
  const long = recoveryExportFileName("x".repeat(80), ID_A, NOW);
  assert.ok(isRecoveryExportFileName(long, ID_A));
  const bad = [
    "../taskops-recovery-Firma-2026-11-22-0b6c3a52.json",
    "taskops-recovery-../../x-2026-11-22-0b6c3a52.json",
    "taskops-recovery-Fi/rma-2026-11-22-0b6c3a52.json",
    "taskops-recovery-Fi%2Frma-2026-11-22-0b6c3a52.json",
    "/docs/recovery-exports/taskops-recovery-Firma-2026-11-22-0b6c3a52.json",
    "file:///taskops-recovery-Firma-2026-11-22-0b6c3a52.json",
    "taskops-recovery-Firma-2026-11-22-0B6C3A52.json",
    "taskops-recovery-Firma-2026-11-22-9f00e1aa.json", // fremde export_id
    "taskops-recovery-Firma-2026-11-22-0b6c3a52.json.bak",
    "worktime-2026-11.pdf",
    "",
    null,
  ];
  for (const n of bad) assert.equal(isRecoveryExportFileName(n, ID_A), false, String(n));
  assert.equal(isRecoveryExportFileName(name, "keine-uuid"), false);
});

// ── Lokale Kopie löschen ────────────────────────────────────

async function acknowledged(env = device()) {
  const p = await prepareRecoveryExport(env.deps, "Firma", NOW);
  await acknowledgeRecoveryExport(env.deps, p, true);
  return { ...env, p };
}

test("Löschen erst nach Server-Bestätigung und nur mit ausdrücklichem true", async () => {
  const { deps, files, p } = await acknowledged();
  assert.equal(isLocalCopyDeletable(p, false), false);
  assert.equal(isLocalCopyDeletable(p, true), true);
  await assert.rejects(deleteLocalRecoveryCopy(deps, p, { acknowledged: false, userConfirmed: true }), (e) => e.kind === "not_acknowledged");
  for (const userConfirmed of [false, undefined, "true", 1]) {
    await assert.rejects(deleteLocalRecoveryCopy(deps, p, { acknowledged: true, userConfirmed }), (e) => e.kind === "not_confirmed");
  }
  assert.equal(files.size, 1, "Abbruch löscht nichts");
});

test("Löschen: nur Datei dieses Exports, ohne RPC, wiederholbar", async () => {
  const { deps, calls, files, p } = await acknowledged();
  const before = rpcCalls(calls).length;
  assert.equal(await deleteLocalRecoveryCopy(deps, p, { acknowledged: true, userConfirmed: true }), "deleted");
  assert.equal(files.size, 0);
  assert.equal(await deleteLocalRecoveryCopy(deps, p, { acknowledged: true, userConfirmed: true }), "already_gone");
  assert.equal(rpcCalls(calls).length, before, "keine Server-Aufrufe beim Löschen");
  assert.deepEqual(calls.filter((c) => c.startsWith("delete:")), [`delete:${p.fileName}`]);
});

test("manipulierter/fremder Dateiname oder ungeprüfte Datei → invalid_file_name, nichts gelöscht", async () => {
  const { deps, calls, p } = await acknowledged();
  const tampered = [
    { ...p, fileName: "../profile.json" },
    { ...p, fileName: "taskops-recovery-Firma-2026-11-22-9f00e1aa.json" },
    { ...p, fileName: null },
    { ...p, verified: false },
    { ...p, uri: null },
    { ...p, required: false },
    null,
  ];
  for (const t of tampered) {
    await assert.rejects(deleteLocalRecoveryCopy(deps, t, { acknowledged: true, userConfirmed: true }), (e) => e.kind === "invalid_file_name");
  }
  assert.ok(!calls.some((c) => c.startsWith("delete:")));
});

test("Löschfehler werden gemeldet, Datei bleibt erhalten und Wiederholung ist möglich", async () => {
  const env = device();
  const { deps, files, p } = await acknowledged(env);
  const failing = [
    { ...deps, async deleteFile() { throw new Error("busy"); } },
    { ...deps, async deleteFile() { /* tut nichts */ } },
    { ...deps, async fileExists() { throw new Error("io"); } },
  ];
  for (const d of failing) {
    await assert.rejects(deleteLocalRecoveryCopy(d, p, { acknowledged: true, userConfirmed: true }), (e) => e.kind === "delete_failed");
    assert.equal(files.size, 1);
  }
  assert.equal(await deleteLocalRecoveryCopy(deps, p, { acknowledged: true, userConfirmed: true }), "deleted");
});

test("mehrere Exporte: getrennte Dateien; Löschen der einen lässt die andere unberührt", async () => {
  const env = device();
  const a = await acknowledged(env);
  env.setNextId(ID_B);
  const b = await prepareRecoveryExport(env.deps, "Firma", NOW);
  await acknowledgeRecoveryExport(env.deps, b, true);
  assert.notEqual(a.p.fileName, b.fileName);
  assert.equal(env.files.size, 2);
  await deleteLocalRecoveryCopy(env.deps, b, { acknowledged: true, userConfirmed: true });
  assert.deepEqual([...env.files.keys()], [a.p.fileName]);
  // Der alte Export darf seine Datei nicht über die neue export_id löschen.
  await assert.rejects(
    deleteLocalRecoveryCopy(env.deps, { ...a.p, fileName: b.fileName }, { acknowledged: true, userConfirmed: true }),
    (e) => e.kind === "invalid_file_name",
  );
});

// ── Gerätecode (fail closed, feste Pfade) ───────────────────

test("Gerät: fehlendes Modul oder fremde Plattform → nie sicher; Löschen nur im festen Verzeichnis", () => {
  const dev = read("services/account/recoveryExport.ts");
  const ensure = dev.slice(dev.indexOf("async ensureSecureDirectory"), dev.indexOf("async protectFile"));
  const protect = dev.slice(dev.indexOf("async protectFile"), dev.indexOf("async fileExists"));
  for (const block of [ensure, protect]) {
    assert.match(block, /if \(!BackupExclusion\) return false;/);
    assert.match(block, /return false;\s*\},\s*$/);
  }
  // Android: Regeln prüfen, bevor das Verzeichnis entsteht.
  assert.ok(ensure.indexOf("verifyBackupRules") < ensure.indexOf("dir.create"));
  // iOS: Verzeichnis-Flag setzen UND zurücklesen.
  assert.match(ensure, /excludeFromBackup\(dir\.uri\)\) === true &&\s*\(await BackupExclusion\.isExcludedFromBackup\(dir\.uri\)\) === true/);
  assert.match(protect, /excludeFromBackup\(uri\)\) === true &&\s*\(await BackupExclusion\.isExcludedFromBackup\(uri\)\) === true/);
  // Löschen/Prüfen nur über exportFile(fileName) — nie über eine URI.
  assert.match(dev, /async fileExists\(fileName\) \{\s*return exportFile\(fileName\)\.exists;/);
  assert.match(dev, /async deleteFile\(fileName\) \{\s*const file = exportFile\(fileName\);/);
  assert.match(dev, /if \(file\.uri !== `\$\{base\}\/\$\{fileName\}`\) throw new Error\("invalid_file_name"\);/);
  // Kein Auflisten des Ordners, kein Sammel-Löschen.
  assert.doesNotMatch(dev, /\.list\(|\.delete\(\)[\s\S]*Directory\(.*\)\.delete/);
  assert.doesNotMatch(dev, /exportDirectory\(\)\.delete|dir\.delete/);
  assert.doesNotMatch(dev, /console\./);
});

// ── Native Quellen und Autolinking ──────────────────────────

test("iOS-Modul: setzt NSURLIsExcludedFromBackupKey und liest es frisch zurück", () => {
  const swift = read("modules/backup-exclusion/ios/BackupExclusionModule.swift");
  assert.match(swift, /Name\("BackupExclusion"\)/);
  assert.match(swift, /values\.isExcludedFromBackup = true/);
  assert.match(swift, /try target\.setResourceValues\(values\)/);
  assert.match(swift, /return try BackupExclusionModule\.readExcluded\(url\)/);
  assert.match(swift, /removeAllCachedResourceValues\(\)/);
  assert.match(swift, /resourceValues\(forKeys: \[\.isExcludedFromBackupKey\]\)/);
  assert.match(swift, /guard url\.isFileURL else \{ return false \}/);
  assert.match(read("modules/backup-exclusion/ios/BackupExclusion.podspec"), /s\.name\s*=\s*'BackupExclusion'/);
});

test("Android-Modul: verlangt Ausschluss in cloud-backup, device-transfer und full-backup-content", () => {
  const kt = read("modules/backup-exclusion/android/src/main/java/expo/modules/backupexclusion/BackupExclusionModule.kt");
  assert.match(kt, /Name\("BackupExclusion"\)/);
  for (const s of ['"cloud-backup"', '"device-transfer"', '"full-backup-content"', 'if (name == "include") return null']) {
    assert.ok(kt.includes(s), s);
  }
  assert.ok(kt.includes(`DATA_EXTRACTION_RULES = "taskops_data_extraction_rules"`));
  assert.ok(kt.includes(`FULL_BACKUP_CONTENT = "taskops_full_backup_content"`));
  assert.ok(kt.includes(`EXCLUDED_PATH = "${plugin.EXCLUDED_PATH}"`));
  assert.equal(plugin.EXCLUDED_PATH, `${RECOVERY_EXPORT_DIR_NAME}/`);
});

test("Autolinking findet das lokale Modul für iOS und Android", () => {
  const resolve = (platform) =>
    JSON.parse(execFileSync("npx", ["expo-modules-autolinking", "resolve", "--platform", platform, "--json"], { cwd: ROOT, encoding: "utf8" }));
  const apple = resolve("apple").modules.find((m) => m.packageName === "backup-exclusion");
  assert.ok(apple, "iOS: nicht verlinkt");
  assert.deepEqual(apple.modules, ["BackupExclusionModule"]);
  assert.equal(apple.pods[0].podName, "BackupExclusion");
  const android = resolve("android").modules.find((m) => m.packageName === "backup-exclusion");
  assert.ok(android, "Android: nicht verlinkt");
  assert.deepEqual(android.projects[0].modules, ["expo.modules.backupexclusion.BackupExclusionModule"]);
});

// ── Android-Config-Plugin ───────────────────────────────────

const manifest = (attrs = {}) => ({
  manifest: { application: [{ $: { "android:name": ".MainApplication", "android:allowBackup": "true", ...attrs } }] },
});

test("Plugin: setzt beide Regel-Attribute, lässt allowBackup unverändert, idempotent", () => {
  const m = plugin.applyBackupRulesToManifest(manifest());
  const app = m.manifest.application[0].$;
  assert.equal(app["android:dataExtractionRules"], "@xml/taskops_data_extraction_rules");
  assert.equal(app["android:fullBackupContent"], "@xml/taskops_full_backup_content");
  assert.equal(app["android:allowBackup"], "true");
  assert.deepEqual(plugin.applyBackupRulesToManifest(m), m);
});

test("Plugin: fremde Regeln werden nie still überschrieben", () => {
  for (const attrs of [{ "android:dataExtractionRules": "@xml/other" }, { "android:fullBackupContent": "@xml/other" }]) {
    assert.throws(() => plugin.applyBackupRulesToManifest(manifest(attrs)), /zusammenführen statt überschreiben/);
  }
});

test("Plugin-XML: Ausschluss in jedem Modus, kein <include>", () => {
  const ex = `<exclude domain="file" path="${RECOVERY_EXPORT_DIR_NAME}/"/>`;
  const rules = plugin.DATA_EXTRACTION_XML;
  for (const section of ["cloud-backup", "device-transfer"]) {
    const body = rules.slice(rules.indexOf(`<${section}>`), rules.indexOf(`</${section}>`));
    assert.ok(body.includes(ex), section);
  }
  assert.ok(plugin.FULL_BACKUP_XML.includes(ex));
  for (const xml of [rules, plugin.FULL_BACKUP_XML]) {
    assert.doesNotMatch(xml, /<include/);
    assert.doesNotMatch(xml, /disableIfNoEncryptionCapabilities/);
  }
});

test("app.json: Plugin registriert, als letztes Plugin", () => {
  const plugins = JSON.parse(read("app.json")).expo.plugins;
  assert.equal(plugins.at(-1), "./plugins/withRecoveryExportBackupRules");
});

test("echter expo prebuild (Android): Manifest verweist auf die Regeln, XML-Dateien erzeugt", { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "taskops-prebuild-"));
  try {
    for (const p of ["app.json", "app.config.js", "package.json", "assets", "plugins", "modules"]) {
      cpSync(join(ROOT, p), join(dir, p), { recursive: true });
    }
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    // Platzhalter: nur für den Google-Services-Schritt, keine echten Werte.
    writeFileSync(join(dir, "google-services.json"), JSON.stringify({
      project_info: { project_number: "0", project_id: "placeholder" },
      client: [{ client_info: { mobilesdk_app_id: "1:0:android:0", android_client_info: { package_name: "com.ferash.taskopsmanager" } }, api_key: [{ current_key: "placeholder" }] }],
      configuration_version: "1",
    }));
    const env = { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1", EXPO_OFFLINE: "1" };
    delete env.GOOGLE_SERVICES_JSON;
    delete env.EAS_BUILD;
    execFileSync("npx", ["expo", "prebuild", "--platform", "android", "--no-install"], { cwd: dir, env, stdio: "pipe" });
    const main = join(dir, "android", "app", "src", "main");
    const xml = readFileSync(join(main, "AndroidManifest.xml"), "utf8");
    assert.match(xml, /android:dataExtractionRules="@xml\/taskops_data_extraction_rules"/);
    assert.match(xml, /android:fullBackupContent="@xml\/taskops_full_backup_content"/);
    assert.match(xml, /android:allowBackup="true"/);
    assert.equal(readFileSync(join(main, "res", "xml", "taskops_data_extraction_rules.xml"), "utf8"), plugin.DATA_EXTRACTION_XML);
    assert.equal(readFileSync(join(main, "res", "xml", "taskops_full_backup_content.xml"), "utf8"), plugin.FULL_BACKUP_XML);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(dir), false);
});

// ── Verdrahtung UI ──────────────────────────────────────────

test("Komponente: Löschen nur nach Bestätigung im eigenen Dialog; Sperrformel unverändert", () => {
  const src = read("features/profile/components/RecoveryExportSection.tsx");
  const del = src.slice(src.indexOf("const handleDeleteLocal"), src.indexOf("const counts = prepared?.counts;"));
  assert.match(del, /if \(busy \|\| disabled \|\| phase !== "acknowledged"\) return;/);
  assert.match(del, /if \(!isLocalCopyDeletable\(prepared, true\)\) return;/);
  assert.match(del, /await confirmDialog\(\{[\s\S]*deleteLocalConfirmTitle[\s\S]*destructive: true/);
  assert.match(del, /if \(!confirmed\) return;/);
  assert.match(del, /acknowledged: true,\s*userConfirmed: confirmed,/);
  assert.doesNotMatch(del, /acknowledgeRecoveryExport|prepareRecoveryExport|supabase/);
  // Button nur im Zustand "acknowledged".
  assert.match(src, /\{phase === "acknowledged" && localCopy !== "deleted" && isLocalCopyDeletable\(prepared, true\) && \(/);
  // Sperrformel aus S1.7 unverändert; Löschen der lokalen Kopie zählt als busy.
  assert.match(src, /\(required && \(phase !== "acknowledged" \|\| \(prepared\?\.openCaseCount \?\? 0\) > 0\)\)/);
  assert.match(src, /const busy = phase === "exporting" \|\| phase === "acknowledging" \|\| localCopy === "deleting";/);
  // Reset (anderes Konto/Pfadwechsel) und neuer Export setzen den Zustand zurück.
  const reset = src.slice(src.indexOf("const firstReset"), src.indexOf("const required ="));
  assert.match(reset, /setPrepared\(null\);[\s\S]*setLocalCopy\("present"\);/);
  assert.doesNotMatch(src, /console\./);
});

test("keine automatische Löschung: Teilen, Abmelden, Konto-/Firmenlöschung löschen nichts", () => {
  const section = read("features/profile/components/RecoveryExportSection.tsx");
  const share = section.slice(section.indexOf("const handleShare"), section.indexOf("const handleAcknowledge"));
  const ack = section.slice(section.indexOf("const handleAcknowledge"), section.indexOf("const handleDeleteLocal"));
  for (const block of [share, ack]) assert.doesNotMatch(block, /deleteLocalRecoveryCopy|deleteFile/);
  const screen = read("features/profile/DeleteAccountScreen.tsx");
  assert.doesNotMatch(screen, /deleteLocalRecoveryCopy|deleteFile|recovery-exports\b.*delete/);
  assert.doesNotMatch(read("context/AuthContext.tsx"), /recovery-exports|deleteLocalRecoveryCopy/);
  // Der einzige Aufruf von deleteLocalRecoveryCopy liegt in handleDeleteLocal.
  assert.equal((section.match(/deleteLocalRecoveryCopy\(/g) ?? []).length, 1);
});

test("Übersetzungen: neue Schlüssel in de/en/ar/tr, {{name}} im Dialog, keine Behauptung einer externen Kopie", () => {
  const keys = ["insecureStorage", "deleteLocalHint", "deleteLocalButton", "deleteLocalConfirmTitle", "deleteLocalConfirmMessage", "deleteLocalConfirmAction", "deleteLocalDone", "deleteLocalFailed"];
  for (const lang of ["de", "en", "ar", "tr"]) {
    const rec = JSON.parse(read(`i18n/locales/${lang}/profile.json`)).deleteAccount.recovery;
    for (const k of keys) assert.ok(typeof rec[k] === "string" && rec[k].trim().length > 0, `${lang}.${k}`);
    assert.match(rec.deleteLocalConfirmMessage, /\{\{name\}\}/, lang);
  }
  const en = JSON.parse(read("i18n/locales/en/profile.json")).deleteAccount.recovery;
  assert.match(en.deleteLocalConfirmMessage, /does not prove that you have a copy outside this device/);
  const de = JSON.parse(read("i18n/locales/de/profile.json")).deleteAccount.recovery;
  assert.match(de.deleteLocalConfirmMessage, /beweist nicht, dass du eine Kopie außerhalb dieses Geräts hast/);
});
