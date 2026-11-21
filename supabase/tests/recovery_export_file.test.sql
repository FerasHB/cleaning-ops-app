-- =========================================================
-- TEST: Work-Recovery S1.7 — verlustfreie Export-Datei + Client-Ablauf
-- (Migration 20261123000000)
-- =========================================================
-- Deckt ab:
--   G  Rechte: nur authenticated EXECUTE, SECURITY DEFINER, fester search_path
--   Z  Zugriff: Mitarbeiter, deaktivierter Admin, ohne Anmeldung abgelehnt;
--      deaktivierter / herabgestufter Admin kann auch nicht bestätigen
--   F  Datei: file_text ist exakt die S1.5-Antwort, SHA-256 passt, Zahlen
--      bleiben verlustfrei (1.50, 20-stellige Ganzzahl), nur eigene Firma
--   K  Client-Ablauf wie die App: Datei holen → bestätigen → Purge gelingt;
--      Änderung zwischen Export und Bestätigung → recovery_export_stale →
--      neuer Export → bestätigen → Purge gelingt; ohne Bestätigung blockiert
--
-- AUSFÜHREN (lokal):
--   docker exec -i supabase_db_cleaning-employee-app-2 psql -U postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/recovery_export_file.test.sql
-- Endet mit ROLLBACK.
-- =========================================================

begin;

create temp table _results (
  case_no text, beschreibung text, erwartet text, ergebnis text, verdikt text
);
grant select, insert on _results to authenticated, anon, service_role;

create function pg_temp.chk(n text, d text, e text, r text) returns void
language sql as $f$
  insert into _results values (n, d, e, coalesce(r,'<null>'),
    case when e = coalesce(r,'<null>') then 'PASS' else 'FAIL' end);
$f$;

create function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    case when uid is null then '' else
      json_build_object('sub', uid::text, 'role','authenticated')::text end, true);
end $f$;

create function pg_temp.msg(p_role text, p_sql text) returns text
language plpgsql as $f$
begin
  execute format('set local role %I', p_role);
  execute p_sql;
  reset role;
  return 'OK';
exception when others then
  reset role;
  return sqlstate || ': ' || sqlerrm;
end $f$;

-- Purge als Probe: Erfolg wird zurückgerollt.
create function pg_temp.purge(p_admin uuid, p_company uuid) returns text
language plpgsql as $f$
begin
  begin
    perform public.purge_company_for_last_admin(p_admin, p_company);
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm = 'PROBE_ROLLBACK' then return 'OK'; end if;
    return sqlstate || ': ' || sqlerrm;
  end;
end $f$;

-- Datei-Antwort als Admin (Rolle authenticated).
create function pg_temp.file_as(p_uid uuid) returns jsonb
language plpgsql as $f$
declare v jsonb;
begin
  perform pg_temp.act_as(p_uid);
  set local role authenticated;
  v := public.get_company_recovery_export_file();
  reset role;
  return v;
end $f$;

create function pg_temp.ack_as(p_uid uuid, p_export text) returns text
language plpgsql as $f$
begin
  perform pg_temp.act_as(p_uid);
  return pg_temp.msg('authenticated',
    format('select public.acknowledge_company_recovery_export(%L::uuid)', p_export));
end $f$;

-- ── IDs: Firma A 73…0a (Recovery), Firma B 73…0b (fremd) ─────────────
-- A: 1 Admin Ada, 2 Emil, 3 Admin Arne (wird deaktiviert), 4 Admin Ole (wird herabgestuft)
-- B: 11 Admin Berta, 12 Bea
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000','73000000-0000-0000-0000-000000000001','authenticated','authenticated','ref-ada@example.test'),
  ('00000000-0000-0000-0000-000000000000','73000000-0000-0000-0000-000000000002','authenticated','authenticated','ref-emil@example.test'),
  ('00000000-0000-0000-0000-000000000000','73000000-0000-0000-0000-000000000003','authenticated','authenticated','ref-arne@example.test'),
  ('00000000-0000-0000-0000-000000000000','73000000-0000-0000-0000-000000000004','authenticated','authenticated','ref-ole@example.test'),
  ('00000000-0000-0000-0000-000000000000','73000000-0000-0000-0000-000000000011','authenticated','authenticated','ref-berta@example.test'),
  ('00000000-0000-0000-0000-000000000000','73000000-0000-0000-0000-000000000012','authenticated','authenticated','ref-bea@example.test');

insert into public.profiles (id, full_name)
select id, email from auth.users where email like 'ref-%@example.test'
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('73000000-0000-0000-0000-00000000000a','REF Firma A','ref-firma-a'),
  ('73000000-0000-0000-0000-00000000000b','REF Firma B','ref-firma-b');

update public.profiles p set role = v.role::public.app_role, company_id = v.company_id::uuid,
       is_active = true, full_name = v.n
from (values
  ('73000000-0000-0000-0000-000000000001','admin',   '73000000-0000-0000-0000-00000000000a','Ada Admin'),
  ('73000000-0000-0000-0000-000000000002','employee','73000000-0000-0000-0000-00000000000a','Emil Eins'),
  ('73000000-0000-0000-0000-000000000003','admin',   '73000000-0000-0000-0000-00000000000a','Arne Admin'),
  ('73000000-0000-0000-0000-000000000004','admin',   '73000000-0000-0000-0000-00000000000a','Ole Admin'),
  ('73000000-0000-0000-0000-000000000011','admin',   '73000000-0000-0000-0000-00000000000b','Berta Admin'),
  ('73000000-0000-0000-0000-000000000012','employee','73000000-0000-0000-0000-00000000000b','Bea B')
) as v(id, role, company_id, n)
where p.id = v.id::uuid;

insert into public.jobs (id, company_id, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time, is_active) values
  ('73000000-0000-0000-0001-000000000001','73000000-0000-0000-0000-00000000000a','73000000-0000-0000-0000-000000000001','Kunde','Reinigung','Weg 1','open','single',current_date,'08:00',true),
  ('73000000-0000-0000-0001-000000000011','73000000-0000-0000-0000-00000000000b','73000000-0000-0000-0000-000000000011','Kunde','Reinigung','Weg 2','open','single',current_date,'08:00',true);
insert into public.job_assignments (id, job_id, employee_id, employee_name_snapshot) values
  ('73000000-0000-0000-0002-000000000001','73000000-0000-0000-0001-000000000001','73000000-0000-0000-0000-000000000002','Emil Eins'),
  ('73000000-0000-0000-0002-000000000011','73000000-0000-0000-0001-000000000011','73000000-0000-0000-0000-000000000012','Bea B');

insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source) values
  ('73000000-0000-0000-0003-000000000001','73000000-0000-0000-0000-00000000000a','73000000-0000-0000-0001-000000000001','73000000-0000-0000-0002-000000000001','73000000-0000-0000-0000-000000000002','legacy_queue'),
  ('73000000-0000-0000-0003-000000000011','73000000-0000-0000-0000-00000000000b','73000000-0000-0000-0001-000000000011','73000000-0000-0000-0002-000000000011','73000000-0000-0000-0000-000000000012','legacy_queue');

-- Nachweis mit Zahlen, die JavaScript nicht exakt darstellt, und Umlauten.
insert into public.work_recovery_submissions (id, case_id, company_id, submitted_by, claimed_ops,
                                              client_platform, client_build, failure_code,
                                              failure_message, request_hash) values
  ('73000000-0000-0000-0004-000000000001','73000000-0000-0000-0003-000000000001','73000000-0000-0000-0000-00000000000a','73000000-0000-0000-0000-000000000002',
   '[{"type":"start_job","timestamp":"2026-11-20T08:00:00Z","seq":12345678901234567890,"km":1.50,"note":"Grüße ä ö ü ß"}]',
   'ios','42','22023','abgelehnt',repeat('c',64));
insert into public.work_recovery_events (case_id, company_id, event_type, actor_id, to_state) values
  ('73000000-0000-0000-0003-000000000001','73000000-0000-0000-0000-00000000000a','case_opened','73000000-0000-0000-0000-000000000002','open'),
  ('73000000-0000-0000-0003-000000000011','73000000-0000-0000-0000-00000000000b','case_opened','73000000-0000-0000-0000-000000000012','open');

-- =========================================================
-- G — Rechte
-- =========================================================
select pg_temp.chk('G1', 'EXECUTE nur authenticated, SECURITY DEFINER, search_path fix',
  'anon=false/auth=true/service=false/definer=true/path=true',
  (select 'anon=' || has_function_privilege('anon', p.oid, 'execute')::text
       || '/auth=' || has_function_privilege('authenticated', p.oid, 'execute')::text
       || '/service=' || has_function_privilege('service_role', p.oid, 'execute')::text
       || '/definer=' || p.prosecdef::text
       || '/path=' || (p.proconfig @> array['search_path=public, pg_temp'])::text
     from pg_proc p where p.oid = 'public.get_company_recovery_export_file()'::regprocedure));

-- =========================================================
-- Z — Zugriff
-- =========================================================
select pg_temp.act_as('73000000-0000-0000-0000-000000000002');
select pg_temp.chk('Z1', 'Mitarbeiter: abgelehnt', '42501: not_authorized',
  pg_temp.msg('authenticated', 'select public.get_company_recovery_export_file()'));
select pg_temp.act_as(null);
select pg_temp.chk('Z2', 'ohne Anmeldung: abgelehnt', '28000: unauthenticated',
  pg_temp.msg('authenticated', 'select public.get_company_recovery_export_file()'));
select pg_temp.chk('Z3', 'anon: kein EXECUTE', '42501',
  left(pg_temp.msg('anon', 'select public.get_company_recovery_export_file()'), 5));

-- =========================================================
-- F — Datei
-- =========================================================
create temp table _f1 as select pg_temp.file_as('73000000-0000-0000-0000-000000000001') as r;

select pg_temp.chk('F1', 'Hash passt zum Text (SHA-256, UTF-8)', 'true',
  (select (encode(sha256(convert_to(r ->> 'file_text', 'UTF8')), 'hex') = r ->> 'file_sha256')::text from _f1));
select pg_temp.chk('F2', 'Datei-Text ist die vollständige S1.5-Antwort (gleicher Export-Nachweis)', 'true/true/true',
  (select ((r ->> 'file_text')::jsonb ->> 'export_id' = r ->> 'export_id')::text || '/'
       || ((r ->> 'file_text')::jsonb ->> 'fingerprint' = r ->> 'fingerprint')::text || '/'
       || ((r ->> 'file_text')::jsonb -> 'recovery' =
           public._work_recovery_export_doc('73000000-0000-0000-0000-00000000000a'))::text from _f1));
select pg_temp.chk('F3', 'Zahlen und Umlaute im Text verlustfrei', 'true/true/true',
  (select (position('12345678901234567890' in r ->> 'file_text') > 0)::text || '/'
       || (position('"km": 1.50' in r ->> 'file_text') > 0)::text || '/'
       || (position('Grüße ä ö ü ß' in r ->> 'file_text') > 0)::text from _f1));
select pg_temp.chk('F4', 'Zähler und offene Fälle im Kopf', '1/1/0/1|1',
  (select (r -> 'record_counts' ->> 'cases') || '/' || (r -> 'record_counts' ->> 'submissions') || '/'
       || (r -> 'record_counts' ->> 'action_refs') || '/' || (r -> 'record_counts' ->> 'events')
       || '|' || (r ->> 'open_case_count') from _f1));
select pg_temp.chk('F5', 'nur eigene Firma (kein Firma-B-Fall im Text)', 'false',
  (select (position('73000000-0000-0000-0003-000000000011' in r ->> 'file_text') > 0)::text from _f1));
select pg_temp.chk('F6', 'unbestätigter Export-Nachweis angelegt', '1/0',
  (select count(*)::text || '/' || count(acknowledged_at)::text from public.company_deletion_exports
    where company_id = '73000000-0000-0000-0000-00000000000a'));
select pg_temp.chk('F7', 'erneuter Abruf bei gleichem Stand: gleiche export_id + gleicher Hash, keine neue Zeile', 'true/true/1',
  (select ((pg_temp.file_as('73000000-0000-0000-0000-000000000001') ->> 'export_id') = (select r ->> 'export_id' from _f1))::text
       || '/' || ((pg_temp.file_as('73000000-0000-0000-0000-000000000001') ->> 'file_sha256') = (select r ->> 'file_sha256' from _f1))::text
       || '/' || (select count(*) from public.company_deletion_exports
                   where company_id = '73000000-0000-0000-0000-00000000000a')::text));

-- =========================================================
-- K — Client-Ablauf
-- =========================================================
-- Fall entscheiden (offene Fälle blockieren den Purge immer, Regel A).
select set_config('taskops.work_recovery_rpc', 'on', true);
update public.work_recovery_cases set state = 'approved', decided_at = now(), revision = revision + 1
 where id = '73000000-0000-0000-0003-000000000001';
select set_config('taskops.work_recovery_rpc', '', true);

-- Nur Ada als Admin übrig lassen (Purge = letzter Admin).
update public.profiles set role = 'employee'
 where id in ('73000000-0000-0000-0000-000000000003','73000000-0000-0000-0000-000000000004');

select pg_temp.act_as(null);
select pg_temp.chk('K1', 'Datei nur heruntergeladen, nicht bestätigt: Purge blockiert', 'P0001: recovery_export_required',
  (select pg_temp.purge('73000000-0000-0000-0000-000000000001','73000000-0000-0000-0000-00000000000a')
     from (select pg_temp.file_as('73000000-0000-0000-0000-000000000001')) x));

create temp table _f2 as select pg_temp.file_as('73000000-0000-0000-0000-000000000001') as r;
-- Änderung NACH dem Export, VOR der Bestätigung.
insert into public.work_recovery_events (case_id, company_id, event_type, actor_id, detail) values
  ('73000000-0000-0000-0003-000000000001','73000000-0000-0000-0000-00000000000a','note_added',
   '73000000-0000-0000-0000-000000000001','{"note":"nachträglich"}');
select pg_temp.chk('K2', 'Bestätigung eines inzwischen veralteten Exports abgelehnt', 'P0001: recovery_export_stale',
  (select pg_temp.ack_as('73000000-0000-0000-0000-000000000001', r ->> 'export_id') from _f2));
select pg_temp.act_as(null);
select pg_temp.chk('K3', 'nach abgelehnter Bestätigung: Purge blockiert', 'P0001: recovery_export_required',
  pg_temp.purge('73000000-0000-0000-0000-000000000001','73000000-0000-0000-0000-00000000000a'));

create temp table _f3 as select pg_temp.file_as('73000000-0000-0000-0000-000000000001') as r;
select pg_temp.chk('K4', 'neuer Export hat neue export_id und neuen Hash', 'true/true',
  (select ((select r ->> 'export_id' from _f3) <> (select r ->> 'export_id' from _f2))::text || '/'
       || ((select r ->> 'file_sha256' from _f3) <> (select r ->> 'file_sha256' from _f2))::text));
select pg_temp.chk('K5', 'deaktivierter Admin kann den Export nicht bestätigen', '42501: not_authorized',
  (select pg_temp.ack_as('73000000-0000-0000-0000-000000000003', r ->> 'export_id') from _f3
     where (select pg_temp.msg('postgres', $q$update public.profiles set role = 'admin', is_active = false
              where id = '73000000-0000-0000-0000-000000000003'$q$)) = 'OK'));
select pg_temp.chk('K6', 'herabgestufter Admin (jetzt Mitarbeiter) kann nicht bestätigen', '42501: not_authorized',
  (select pg_temp.ack_as('73000000-0000-0000-0000-000000000004', r ->> 'export_id') from _f3));
select pg_temp.chk('K7', 'Ada bestätigt den neuen Export', 'OK',
  (select pg_temp.ack_as('73000000-0000-0000-0000-000000000001', r ->> 'export_id') from _f3));
select pg_temp.act_as(null);
select pg_temp.chk('K8', 'Purge gelingt nach aktuellem, bestätigtem Export', 'OK',
  pg_temp.purge('73000000-0000-0000-0000-000000000001','73000000-0000-0000-0000-00000000000a'));
select pg_temp.chk('K9', 'Firma B unverändert (kein Export-Nachweis, Fall da)', '0/1',
  (select (select count(*) from public.company_deletion_exports where company_id = '73000000-0000-0000-0000-00000000000b')::text
       || '/' || (select count(*) from public.work_recovery_cases where company_id = '73000000-0000-0000-0000-00000000000b')::text));

-- =========================================================
-- Ergebnis
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis, verdikt from _results order by case_no;

do $$
declare v_fail int; v_total int;
begin
  select count(*) filter (where verdikt = 'FAIL'), count(*) into v_fail, v_total from _results;
  raise notice 'recovery_export_file: % checks, % failed', v_total, v_fail;
  if v_fail > 0 then
    raise exception 'recovery_export_file: % of % checks FAILED', v_fail, v_total;
  end if;
end $$;

rollback;
