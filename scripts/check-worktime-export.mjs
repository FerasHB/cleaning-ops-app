// scripts/check-worktime-export.mjs
// Prüft die Formatierung des Arbeitszeit-Exports vor der Firmenlöschung
// (services/account/worktimeExportFormat.ts): CSV-Spalten, Quoting,
// Formel-Injection-Schutz, keine Gesundheits-/Freitext-Spalten, HTML-Escaping.
//
//   npm run test:worktime-export

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWorktimeCsv,
  buildWorktimeHtml,
} from "../services/account/worktimeExportFormat.ts";

const row = (over = {}) => ({
  record_kind: "session",
  employee_id: "11111111-1111-1111-1111-111111111111",
  employee_name: "Emil Eins",
  work_date: "2026-10-27",
  start_local: "2026-10-27 08:00",
  end_local: "2026-10-27 08:30",
  started_at: "2026-10-27T07:00:00+00:00",
  ended_at: "2026-10-27T07:30:00+00:00",
  duration_minutes: 30,
  raw_started_at: "2026-10-27T07:00:00+00:00",
  raw_ended_at: "2026-10-27T08:00:00+00:00",
  corrected: true,
  correction_count: 1,
  last_correction_origin: "admin_reduced",
  last_corrected_at: "2026-10-27T09:00:00+00:00",
  time_adjustment_count: 0,
  job_id: "22222222-2222-2222-2222-222222222222",
  assignment_id: "33333333-3333-3333-3333-333333333333",
  timezone: "Europe/Berlin",
  ...over,
});

const t = (key, opts) => (opts ? `${key}:${JSON.stringify(opts)}` : key);

test("CSV: BOM, Kopfzeile mit festen Spalten, eine Zeile je Datensatz", () => {
  const csv = buildWorktimeCsv([row(), row({ record_kind: "assignment", employee_name: "Zora" })]);
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(
    lines[0],
    "employee_name;employee_id;work_date;start_local;end_local;duration_minutes;record_kind;corrected;correction_count;last_correction_origin;last_corrected_at;raw_started_at;raw_ended_at;started_at;ended_at;time_adjustment_count;job_id;assignment_id;timezone",
  );
  assert.ok(lines[1].startsWith("Emil Eins;11111111-"));
});

test("CSV: keine Gesundheits-, Freitext-, Kunden- oder Kontaktspalten", () => {
  const header = buildWorktimeCsv([]).slice(1).split("\r\n")[0];
  for (const forbidden of ["absence", "sick", "note", "reason", "customer", "address", "service", "email", "phone", "token", "comment", "photo", "vacation"]) {
    assert.ok(!header.toLowerCase().includes(forbidden), `Spalte enthält ${forbidden}`);
  }
});

test("CSV: Quoting und Formel-Injection-Schutz", () => {
  const csv = buildWorktimeCsv([row({ employee_name: '=HYPERLINK("x")' }), row({ employee_name: "Müller; Anna" })]);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"Müller; Anna"'));
});

test("CSV: offene Sitzung ohne Ende -> leere Felder statt null", () => {
  const csv = buildWorktimeCsv([row({ end_local: null, ended_at: null, duration_minutes: null })]);
  assert.ok(!csv.includes("null"));
});

test("HTML: Summe je Mitarbeiter, Escaping, Firmenname", () => {
  const html = buildWorktimeHtml(
    [row(), row({ duration_minutes: 90 }), row({ employee_name: "<script>x</script>", duration_minutes: 15 })],
    "Firma & Co",
    new Date("2026-10-27T10:00:00Z"),
    t,
  );
  assert.ok(html.includes("Firma &amp; Co"));
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(!html.includes("<script>x"));
  assert.ok(html.includes(">2:00<"), "Summe Emil = 30 + 90 min");
});

test("HTML: leerer Export zeigt Hinweis", () => {
  const html = buildWorktimeHtml([], "Firma", new Date(), t);
  assert.ok(html.includes("pdfEmpty"));
});
