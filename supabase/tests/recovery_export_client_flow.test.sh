#!/usr/bin/env bash
# =========================================================
# TEST: Recovery-Export der App gegen die echte Datenbank
# (Work Recovery S1.7, Migration 20261123000000)
# =========================================================
# Führt den ECHTEN App-Ablauf aus services/account/recoveryExport.core.ts
# (Node, --experimental-strip-types) gegen die lokale Datenbank aus:
#   * fetchExportFile  = get_company_recovery_export_file() als Admin
#                        (Rolle authenticated, JWT-Claims wie PostgREST)
#   * writeFile/readFile = echte Datei im Temp-Verzeichnis
#   * sha256Hex        = node:crypto (UTF-8), wie expo-crypto auf dem Gerät
#   * acknowledge      = acknowledge_company_recovery_export() als Admin
# und prüft danach den Firmen-Purge (Probe, zurückgerollt):
#   1. offener Fall → Export möglich, open_case_count = 1, Purge blockiert
#   2. Fall entschieden, Datei geschrieben + geprüft, NICHT bestätigt
#      → Purge: recovery_export_required; userConfirmed=false bestätigt nichts
#   3. bestätigt → Purge möglich
#   4. Nachweis ändert sich → Purge: recovery_export_stale; neue Datei,
#      bestätigen → Purge möglich
#   5. Datei ist der verlustfreie Server-Text (1.50, 20-stellige Ganzzahl)
#
# Fixdaten werden committet und im trap entfernt. ID-Raum 74xxxxxx….
#
# Lokal:
#   bash supabase/tests/recovery_export_client_flow.test.sh
# Braucht Node >= 22.6 (--experimental-strip-types).
# =========================================================
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-supabase_db_cleaning-employee-app-2}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
psql_c() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

CA='74000000-0000-0000-0000-00000000000a'
AA='74000000-0000-0000-0000-000000000001'
EA='74000000-0000-0000-0000-000000000002'
JA='74000000-0000-0000-0001-000000000001'
GA='74000000-0000-0000-0002-000000000001'
KA='74000000-0000-0000-0003-000000000001'
USERS="'$AA','$EA'"
WORK=""

cleanup() {
  psql_c <<SQL >/dev/null 2>&1 || true
begin;
select set_config('taskops.company_purge', 'on', true);
delete from public.company_deletion_exports where company_id = '$CA';
delete from public.work_recovery_events where company_id = '$CA';
delete from public.work_recovery_action_refs where company_id = '$CA';
delete from public.work_recovery_submissions where company_id = '$CA';
delete from public.work_recovery_cases where company_id = '$CA';
delete from public.jobs where company_id = '$CA';
delete from public.profiles where id in ($USERS);
delete from public.companies where id = '$CA';
delete from auth.users where id in ($USERS);
commit;
SQL
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT
cleanup
WORK="$(mktemp -d)"

psql_c <<SQL >/dev/null
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','$AA','authenticated','authenticated','recf-admin@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$EA','authenticated','authenticated','recf-emp@x.test','{}');
insert into public.companies (id, name, slug) values ('$CA','RECF Firma','recf-firma');
insert into public.profiles (id, full_name, role, company_id, is_active) values
 ('$AA','RECF Admin','admin','$CA',true), ('$EA','RECF Emil','employee','$CA',true)
on conflict (id) do update set full_name=excluded.full_name, role=excluded.role,
  company_id=excluded.company_id, is_active=excluded.is_active;
insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                         status, job_type, date, start_time, is_active)
values ('$JA','$CA','$AA','K','Reinigung','Weg 1','open','single',current_date,'08:00',true);
insert into public.job_assignments (id, job_id, employee_id, employee_name_snapshot)
values ('$GA','$JA','$EA','RECF Emil');
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source)
values ('$KA','$CA','$JA','$GA','$EA','legacy_queue');
insert into public.work_recovery_submissions (id, case_id, company_id, submitted_by, claimed_ops,
  client_platform, client_build, failure_code, failure_message, request_hash)
values ('74000000-0000-0000-0004-000000000001','$KA','$CA','$EA',
  '[{"type":"start_job","timestamp":"2026-11-20T08:00:00Z","seq":12345678901234567890,"km":1.50}]',
  'android','42','22023','abgelehnt',repeat('d',64));
insert into public.work_recovery_events (case_id, company_id, event_type, actor_id, to_state)
values ('$KA','$CA','case_opened','$EA','open');
SQL

cat > "$WORK/driver.mjs" <<'JS'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repo, container, work, admin, company, caseId] = process.argv.slice(2);
const core = await import(pathToFileURL(join(repo, "services/account/recoveryExport.core.ts")).href);
const { prepareRecoveryExport, acknowledgeRecoveryExport } = core;

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`PASS  ${name}`); };

function psql(sql) {
  try {
    return execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-qtA"], { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]+)/.exec(String(e.stderr));
    const err = new Error(m ? m[2] : String(e.stderr));
    err.code = m ? m[1] : "";
    throw err;
  }
}
const asAdmin = (sql) => psql(`begin;
select set_config('request.jwt.claims', json_build_object('sub','${admin}','role','authenticated')::text, true);
set local role authenticated;
${sql}
commit;`);

const purgeProbe = () => {
  try {
    psql(`begin; select public.purge_company_for_last_admin('${admin}','${company}'); rollback;`);
    return "OK";
  } catch (e) { return e.message; }
};

const deps = {
  platform: "ios",
  async fetchExportFile() {
    // Wie PostgREST/supabase-js: jsonb-Antwort → JSON.parse (file_text ist ein String, verlustfrei).
    return JSON.parse(asAdmin("select public.get_company_recovery_export_file()::text;").split("\n").pop());
  },
  async writeFile(name, text) { const p = join(work, name); writeFileSync(p, text, "utf8"); return { uri: p }; },
  async readFile(uri) { return readFileSync(uri, "utf8"); },
  async sha256Hex(text) { return createHash("sha256").update(text, "utf8").digest("hex"); },
  async acknowledge(id) { asAdmin(`select public.acknowledge_company_recovery_export('${id}'::uuid);`); },
};
const NOW = new Date("2026-11-21T10:00:00Z");

// 1. offener Fall
const p0 = await prepareRecoveryExport(deps, "RECF Firma", NOW);
ok("1: Export bei offenem Fall möglich, open_case_count = 1, Datei geprüft", () => {
  assert.equal(p0.openCaseCount, 1);
  assert.equal(p0.verified, true);
});
ok("1: Purge bei offenem Fall blockiert", () => assert.equal(purgeProbe(), "open_recovery_cases"));

// Fall entscheiden (wie der spätere Resolve-Slice).
psql(`begin; select set_config('taskops.work_recovery_rpc','on',true);
update public.work_recovery_cases set state='approved', decided_at=now(), revision=revision+1 where id='${caseId}';
commit;`);

// 2. neue Datei, nicht bestätigt
const p1 = await prepareRecoveryExport(deps, "RECF Firma", NOW);
ok("2: Datei = exakter Server-Text, verlustfrei (1.50, 20-stellige Ganzzahl)", () => {
  const onDisk = readFileSync(p1.uri, "utf8");
  assert.equal(onDisk, p1.fileText);
  assert.match(onDisk, /"km": 1\.50/);
  assert.match(onDisk, /12345678901234567890/);
  assert.equal(createHash("sha256").update(onDisk, "utf8").digest("hex"), p1.fileSha256);
  assert.equal(JSON.parse(onDisk).export_id, p1.exportId);
  assert.deepEqual(p1.counts, { cases: 1, submissions: 1, action_refs: 0, events: 1 });
});
ok("2: nur exportiert (nicht bestätigt) → Purge: recovery_export_required",
  () => assert.equal(purgeProbe(), "recovery_export_required"));
await assert.rejects(acknowledgeRecoveryExport(deps, p1, false), (e) => e.kind === "not_confirmed");
ok("2: userConfirmed=false bestätigt serverseitig nichts", () => {
  assert.equal(psql(`select count(acknowledged_at) from public.company_deletion_exports where company_id='${company}';`), "0");
  assert.equal(purgeProbe(), "recovery_export_required");
});

// 3. bestätigt
await acknowledgeRecoveryExport(deps, p1, true);
ok("3: bestätigt → Purge möglich", () => assert.equal(purgeProbe(), "OK"));

// 4. Nachweis ändert sich nach der Bestätigung
psql(`insert into public.work_recovery_events (case_id, company_id, event_type, actor_id, detail)
      values ('${caseId}','${company}','note_added','${admin}','{"note":"nachträglich"}');`);
ok("4: Änderung nach Bestätigung → Purge: recovery_export_stale", () => assert.equal(purgeProbe(), "recovery_export_stale"));
await assert.rejects(acknowledgeRecoveryExport(deps, p1, true), (e) => e.kind === "stale");
ok("4: alte Datei erneut bestätigen → stale (App verlangt neuen Export)", () => {});
const p2 = await prepareRecoveryExport(deps, "RECF Firma", NOW);
ok("4: neuer Export hat neue export_id und zählt das neue Ereignis", () => {
  assert.notEqual(p2.exportId, p1.exportId);
  assert.equal(p2.counts.events, 2);
});
await acknowledgeRecoveryExport(deps, p2, true);
ok("4: neuer Export bestätigt → Purge möglich", () => assert.equal(purgeProbe(), "OK"));

console.log(`TESTRESULT recovery_export_client_flow: ${pass} PASS`);
JS

node --experimental-strip-types --no-warnings "$WORK/driver.mjs" "$REPO_ROOT" "$DB_CONTAINER" "$WORK" "$AA" "$CA" "$KA"
