#!/usr/bin/env node
// Verifikation der reinen Zuweisungs-Helfer aus utils/jobAssignees.ts.
//
// WARUM DIESES SKRIPT EXISTIERT
//   Das Projekt hat (bewusst) keinen JS-Test-Runner. Die Fallback-Ableitung
//   `buildLegacyAssignees()` ist aber sicherheitsrelevant fuer die Anzeige:
//   sie entscheidet, was nach einem erfolgreichen Schreibvorgang mit
//   fehlgeschlagenem Nachlesen in State UND AsyncStorage landet. Ein
//   Review-Befund (H3/M-1) entstand genau dort. Deshalb wird die Funktion
//   isoliert kompiliert und gegen die ECHTE Quelle geprueft — keine Kopie
//   der Logik, kein Mock.
//
// AUSFUEHREN
//   node scripts/verify-job-assignees.mjs
//
// Was NICHT hier geprueft wird (weil es Netzwerk/Supabase braucht):
//   * dass die beiden Fehlerpfade in readBackJob() geloggt werden
//   * dass ein erfolgreiches Nachlesen die vollstaendige Menge liefert
//   Beides ist gegen PostgREST manuell verifiziert; die Vorgehensweise steht
//   in docs/phase5-react-native-read-path.md.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "verify-assignees-"));

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
      },
      include: [join(root, "utils/jobAssignees.ts")],
    }),
  );

  execFileSync("npx", ["tsc", "-p", cfg], { cwd: root, stdio: "pipe" });

  const mod = await import(
    pathToFileURL(join(out, "js/utils/jobAssignees.js")).href
  );
  const { buildLegacyAssignees, formatAssigneesShort, formatAssigneesFull } = mod;

  let n = 0;
  const ok = (name, fn) => {
    fn();
    n += 1;
    console.log(`  PASS  ${name}`);
  };

  console.log("buildLegacyAssignees — Fallback nach erfolgreichem Schreibvorgang");

  // createJob-Fallback: Embed lieferte [], Legacy-Zeiger steht auf Erika.
  ok("create-Fallback liefert einen Legacy-Zugewiesenen statt []", () => {
    const r = buildLegacyAssignees({
      id: "job-1",
      employeeId: "emp-erika",
      employeeName: "Erika",
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].employeeId, "emp-erika");
    assert.equal(r[0].fullName, "Erika");
    assert.equal(r[0].isDeleted, false);
    assert.notDeepEqual(r, []);
  });

  // updateJob-Fallback: Embed trug noch den ALTEN, assigned_to den NEUEN.
  ok("update-Fallback liefert den NEUEN, nicht den alten Zugewiesenen", () => {
    const r = buildLegacyAssignees({
      id: "job-1",
      employeeId: "emp-zoe",
      employeeName: "Zoe",
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].employeeId, "emp-zoe");
    assert.ok(!r.some((a) => a.employeeId === "emp-erika"));
  });

  ok("erfindet nie mehr als einen Zugewiesenen", () => {
    for (const id of ["a", "b", "c"]) {
      assert.ok(
        buildLegacyAssignees({ id: "j", employeeId: id, employeeName: "X" })
          .length <= 1,
      );
    }
  });

  // Kontoloeschung setzt jobs.assigned_to auf NULL -> nichts abzuleiten.
  ok("geloeschtes Konto (assigned_to NULL) -> leer, kein Platzhalter", () => {
    assert.deepEqual(
      buildLegacyAssignees({ id: "j", employeeId: null, employeeName: null }),
      [],
    );
    assert.deepEqual(
      buildLegacyAssignees({ id: "j", employeeId: undefined, employeeName: "W" }),
      [],
    );
  });

  ok("leerer Name faellt auf 'Unbekannt' zurueck", () => {
    assert.equal(
      buildLegacyAssignees({ id: "j", employeeId: "e", employeeName: "   " })[0]
        .fullName,
      "Unbekannt",
    );
    assert.equal(
      buildLegacyAssignees({ id: "j", employeeId: "e", employeeName: null })[0]
        .fullName,
      "Unbekannt",
    );
  });

  ok("assignmentId ist als abgeleitet erkennbar und stabil", () => {
    const a = buildLegacyAssignees({ id: "j", employeeId: "e", employeeName: "N" });
    const b = buildLegacyAssignees({ id: "j", employeeId: "e", employeeName: "N" });
    assert.equal(a[0].assignmentId, b[0].assignmentId);
    assert.ok(a[0].assignmentId.startsWith("legacy:"));
  });

  // L-1: keine erfundenen Abrechnungs-/Anwesenheitsdaten mehr.
  ok("traegt keine Abrechnungs-/Anwesenheitsfelder", () => {
    const r = buildLegacyAssignees({ id: "j", employeeId: "e", employeeName: "N" });
    assert.deepEqual(Object.keys(r[0]).sort(), [
      "assignmentId",
      "employeeId",
      "fullName",
      "isDeleted",
    ]);
  });

  ok("Fallback-Ergebnis rendert korrekt in den Anzeige-Helfern", () => {
    const job = {
      assignees: buildLegacyAssignees({
        id: "j",
        employeeId: "e",
        employeeName: "Erika",
      }),
    };
    assert.equal(formatAssigneesShort(job), "Erika");
    assert.equal(formatAssigneesFull(job), "Erika");
    assert.equal(formatAssigneesFull({ assignees: [] }), "Nicht zugewiesen");
  });

  console.log(`\n${n}/${n} Zusicherungen erfuellt.`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
