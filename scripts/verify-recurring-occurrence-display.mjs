#!/usr/bin/env node
// Verifikation der reinen TS-Helfer rund um Dauerauftrags-Termine:
//   * isDetachedOccurrence (utils/recurringRule.ts) — „Abweichender Termin"
//   * localDateTimeFrom   (utils/date.ts)           — Formular-Vorbelegung
//
// WARUM DIESES SKRIPT EXISTIERT
//   Das Projekt hat (bewusst) keinen JS-Test-Runner. Die eigentliche
//   Regression zum Serien-Duplikat liegt in der Datenbank und wird von
//   supabase/tests/recurring_series_occurrence_identity.test.sql abgedeckt.
//   Zwei Dinge lassen sich dort aber nicht prüfen, weil sie im Client liegen:
//
//   1. WANN die Oberfläche „Abweichender Termin" schreibt. Nach der Migration
//      20260916000000 folgt ein regulärer Termin der Regel-Uhrzeit — er darf
//      also NICHT mehr markiert werden. Nur ein einzeln angepasster Termin
//      (oder einer, dessen Wochentag/Zeitraum nicht mehr passt) darf es.
//
//   2. Dass das Bearbeitungsformular einen Termin nicht versehentlich
//      verschiebt. EditJobScreen belegte das Datum-/Uhrzeit-Feld früher aus
//      `scheduled_start` vor. Diese Spalte wird serverseitig per einfacher
//      Konkatenation in UTC geschrieben; `new Date(...)` rendert sie lokal und
//      verschiebt die Uhrzeit um den UTC-Versatz (19:30 → 21:30 in
//      Deutschland). Schon das Speichern eines unbeteiligten Feldes hätte die
//      Uhrzeit verstellt — und den Termin damit dauerhaft zum einzeln
//      angepassten „Abweichender Termin" gemacht.
//
//   Beide Funktionen werden aus der ECHTEN Quelle kompiliert, nicht kopiert.
//
// AUSFÜHREN
//   node scripts/verify-recurring-occurrence-display.mjs
//   (oder npm run test:recurring-occurrence)

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// BEWUSST innerhalb von root (nicht os.tmpdir()): recurringRule.ts/
// jobAssignees.ts importieren seit der Mehrsprachigkeit `i18next` aus
// "@/i18n" — ein System-Temp-Verzeichnis liegt außerhalb jeder
// node_modules-Ahnenkette, der nackte Node-Import von "i18next" &Co. aus
// dem kompilierten Output würde dort fehlschlagen. Siehe .gitignore.
const out = mkdtempSync(join(root, ".verify-recurring-occ-tmp-"));

// Die Vorbelegungs-Prüfung ist nur dann aussagekräftig, wenn die Zeitzone
// einen UTC-Versatz hat — sonst fällt der Fehler gar nicht auf.
process.env.TZ = "Europe/Berlin";

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
};

try {
  const cfg = join(out, "tsconfig.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: false,
        outDir: join(out, "js"),
        module: "es2020",
        moduleResolution: "node",
        target: "es2020",
        skipLibCheck: true,
        types: [],
        baseUrl: root,
        paths: { "@/*": ["./*"] },
        // jobAssignees.ts/recurringRule.ts importieren seit der
        // Mehrsprachigkeit `i18next` aus "@/i18n" (siehe dort), das
        // wiederum alle locales/*.json bündelt — ohne diese beiden Flags
        // bricht der Compile hier, obwohl das echte Projekt-tsconfig sie
        // über expo/tsconfig.base bereits mitbringt.
        resolveJsonModule: true,
        esModuleInterop: true,
      },
      include: [
        join(root, "utils/recurringRule.ts"),
        join(root, "utils/date.ts"),
        // transitive Laufzeit-Importe (reine Typ-Importe erzeugt tsc nicht)
        join(root, "utils/jobAssignees.ts"),
        join(root, "utils/jobSchedule.ts"),
        join(root, "utils/recurrence.ts"),
        // seit der Mehrsprachigkeit importiert jobAssignees.ts/
        // recurringRule.ts `i18next` aus "@/i18n" (Modul-Singleton, siehe
        // dort) — ohne diesen Einstiegspunkt fehlt sein kompiliertes JS.
        join(root, "i18n/index.ts"),
      ],
    }),
  );

  execFileSync("npx", ["tsc", "-p", cfg], { cwd: root, stdio: "pipe" });

  // tsc schreibt weder den Pfad-Alias `@/` noch relative Spezifizierer auf
  // konkrete .js-Dateien um (bewusst — das ist Aufgabe des Bundlers/der
  // moduleResolution). Für den nackten node-ESM-Import hier deshalb
  // nachträglich auf file:-URLs auflösen. Rekursiv, seit der Compile-Umfang
  // über utils/ hinaus auch i18n/ (config.ts/resolveLocale.ts/rtl.ts/
  // storage.ts/locales/*.json, alle mit eigenen relativen Imports) erfasst.
  const jsDir = join(out, "js");
  writeFileSync(join(jsDir, "package.json"), JSON.stringify({ type: "module" }));
  const jsFiles = [];
  const walk = (dir) => {
    for (const rel of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, rel.name);
      if (rel.isDirectory()) walk(full);
      else if (rel.name.endsWith(".js")) jsFiles.push(full);
    }
  };
  walk(jsDir);
  // "…/date" -> …/date.js (direkte Datei). "…/i18n" -> ein Verzeichnis-
  // Import, den natives ESM (anders als CommonJS) nicht automatisch auf
  // index.js abbildet — hier von Hand nachholen.
  const resolveJs = (absPath) => {
    // Resolve emitted files only: TypeScript was already compiled above.
    const ext = extname(absPath);
    const candidates = ext === ".ts" || ext === ".tsx"
      ? [absPath.replace(/\.tsx?$/, ".js")]
      : ext ? [absPath] : [`${absPath}.js`, join(absPath, "index.js")];
    const file = candidates.find((p) => existsSync(p) && statSync(p).isFile());
    if (!file || ![".js", ".json"].includes(extname(file))) {
      throw new Error(`Cannot resolve emitted module: ${absPath}`);
    }
    return file;
  };
  // The real i18n graph also imports native adapters, which Node cannot parse.
  // These pure-helper tests never call them: fail loudly if that changes.
  const nativeStub = join(jsDir, "native-test-adapters.js");
  writeFileSync(nativeStub, `
    const unavailable = () => { throw new Error("Native adapter called in pure-helper test"); };
    export const Platform = { OS: "web" };
    export const I18nManager = { getConstants: unavailable, allowRTL: unavailable, forceRTL: unavailable };
    export const getLocales = unavailable;
    export default { getItem: unavailable, setItem: unavailable };
  `);
  const nativeModules = new Set([
    "react-native", "expo-localization", "@react-native-async-storage/async-storage",
  ]);
  for (const file of jsFiles) {
    const src = readFileSync(file, "utf8").replace(
      /(\bfrom\s+|\bimport\s*)(["'])(@\/[^"']+|\.\.?\/[^"']+|react-native|expo-localization|@react-native-async-storage\/async-storage)\2/g,
      (_m, prefix, q, spec) => {
        if (nativeModules.has(spec)) return `${prefix}${q}${pathToFileURL(nativeStub).href}${q}`;
        const absNoExt = spec.startsWith("@/")
          ? join(jsDir, spec.slice(2))
          : join(dirname(file), spec);
        const target = resolveJs(absNoExt);
        // Native Node ESM requires a JSON import attribute; Metro does not.
        return `${prefix}${q}${pathToFileURL(target).href}${q}${target.endsWith(".json") ? ' with { type: "json" }' : ""}`;
      },
    );
    writeFileSync(file, src);
  }

  const { isDetachedOccurrence } = await import(
    pathToFileURL(join(out, "js/utils/recurringRule.js")).href
  );
  const { localDateTimeFrom, formatTimeHHmm, formatDateISO } = await import(
    pathToFileURL(join(out, "js/utils/date.js")).href
  );

  // ── 1. „Abweichender Termin" ────────────────────────────────────────
  // Regel nach der Serien-Änderung: Mo–Fr um 20:30 (vorher 19:30).
  const rule = {
    recurringDays: ["mon", "tue", "wed", "thu", "fri"],
    startTime: "20:30",
    recurrenceStartDate: "2026-08-28",
    recurrenceEndDate: "2026-12-31",
  };
  const wed = "2026-09-16"; // Mittwoch
  const sat = "2026-09-19"; // Samstag — nicht in der Regel

  console.log("isDetachedOccurrence — nach der Serien-Änderung 19:30 → 20:30");

  ok("verschobener regulärer Termin (20:30) gilt NICHT als abweichend", () => {
    assert.equal(
      isDetachedOccurrence({ parentJobId: "r1", date: wed, startTime: "20:30:00" }, rule),
      false,
    );
  });

  ok("zurückgebliebener 19:30-Termin wäre abweichend (Zustand vor dem Fix)", () => {
    assert.equal(
      isDetachedOccurrence({ parentJobId: "r1", date: wed, startTime: "19:30:00" }, rule),
      true,
    );
  });

  ok("einzeln auf 21:00 gelegter Termin gilt als abweichend", () => {
    assert.equal(
      isDetachedOccurrence({ parentJobId: "r1", date: wed, startTime: "21:00:00" }, rule),
      true,
    );
  });

  ok("Termin an einem entfernten Wochentag gilt als abweichend", () => {
    assert.equal(
      isDetachedOccurrence({ parentJobId: "r1", date: sat, startTime: "20:30:00" }, rule),
      true,
    );
  });

  ok("Termin nach dem Enddatum der Regel gilt als abweichend", () => {
    assert.equal(
      isDetachedOccurrence({ parentJobId: "r1", date: "2027-01-06", startTime: "20:30:00" }, rule),
      true,
    );
  });

  ok("normaler Einzeljob (ohne Regel) wird nie markiert", () => {
    assert.equal(
      isDetachedOccurrence({ parentJobId: null, date: wed, startTime: "07:00:00" }, rule),
      false,
    );
  });

  // ── 2. Formular-Vorbelegung ─────────────────────────────────────────
  console.log(`localDateTimeFrom — Vorbelegung ohne Zeitzonen-Versatz (TZ=${process.env.TZ})`);

  ok("date + start_time werden exakt übernommen", () => {
    const d = localDateTimeFrom("2026-09-16", "19:30:00");
    assert.equal(formatDateISO(d), "2026-09-16");
    assert.equal(formatTimeHHmm(d), "19:30");
  });

  ok("der alte Weg über scheduled_start hätte die Uhrzeit verschoben", () => {
    // So schreibt generate_job_occurrences die Spalte: date || ' ' || time,
    // interpretiert in der Zeitzone der Datenbank (UTC).
    const viaScheduledStart = new Date("2026-09-16 19:30:00+00");
    assert.notEqual(formatTimeHHmm(viaScheduledStart), "19:30");
    // …und genau diese Verschiebung darf die Vorbelegung nicht mehr erben.
    assert.equal(formatTimeHHmm(localDateTimeFrom("2026-09-16", "19:30:00")), "19:30");
  });

  ok("verkürzte Uhrzeit HH:mm wird ebenso akzeptiert", () => {
    assert.equal(formatTimeHHmm(localDateTimeFrom("2026-09-16", "08:05")), "08:05");
  });

  ok("ohne Datum gibt es keine Vorbelegung (Fallback greift im Screen)", () => {
    assert.equal(localDateTimeFrom(null, "08:00"), null);
    assert.equal(localDateTimeFrom(undefined, "08:00"), null);
  });

  ok("ohne Uhrzeit wird Mitternacht angenommen", () => {
    assert.equal(formatTimeHHmm(localDateTimeFrom("2026-09-16", null)), "00:00");
  });

  console.log(`\nALLE ${passed} FÄLLE PASS`);
} catch (err) {
  console.error("\nFEHLGESCHLAGEN:", err?.stdout?.toString?.() || err?.message || err);
  process.exitCode = 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
