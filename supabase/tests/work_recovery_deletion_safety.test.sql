-- =========================================================
-- TEST: Work-Recovery Lösch- und Export-Sicherheit
--       (Migration 20261121000000, Phase 3 / S1.5)
-- =========================================================
-- Deckt ab:
--   G  Grants/RLS: Export-Nachweis-Tabelle ohne Client-Zugriff, interne
--      Funktionen ohne EXECUTE, Export/Bestätigung nur authenticated,
--      Purge nur service_role; SECURITY DEFINER + search_path gesetzt
--   Z  Firma OHNE Recovery-Zeilen: Purge ohne Bestätigung wie bisher
--   E  Export: nur aktive Admins der eigenen Firma (Mitarbeiter, anon,
--      ohne Sitzung, deaktivierter Admin abgelehnt), nur eigene Zeilen,
--      vollständig (Fälle/Einreichungen/Referenzen/Events, interne Notiz),
--      Fingerabdruck zeitzonenunabhängig
--   O  Regel A: offene/under_review-Fälle blockieren den Purge immer —
--      auch mit Export-Bestätigung; abgelehnter Purge ändert nichts
--   R  Regel B: ohne Bestätigung blockiert; unbestätigter Export zählt
--      nicht; Bestätigung eines anderen Admins zählt nicht; fremde
--      Export-ID nicht bestätigbar (Firma/Admin); Änderung nach der
--      Bestätigung (neues Event, Konto-Löschung → SET NULL) macht sie
--      veraltet; erneutes Bestätigen eines veralteten Exports abgelehnt
--   H  Happy Path: alle Fälle entschieden + aktuelle Bestätigung → Purge
--      gelingt, Recovery-Zeilen + Export-Nachweise der Firma weg, Firma B
--      unverändert, Purge-Flag leer; zweiter Purge → profile_not_found
--   A  Append-only-Schutz außerhalb des Purge unverändert
--
-- AUSFÜHREN (lokal):
--   docker exec -i supabase_db_cleaning-employee-app-2 psql -U postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/work_recovery_deletion_safety.test.sql
-- Endet mit ROLLBACK. Jede FAIL-Zeile lässt scripts/ci/run-sql-tests.sh
-- scheitern, zusätzlich bricht ein abschließender Check mit Exception ab.
-- Nebenläufigkeit: work_recovery_purge_concurrency.test.sh
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
    case when uid is null then ''
         else json_build_object('sub', uid::text, 'role','authenticated')::text end, true);
end $f$;

-- Führt SQL unter einer Rolle aus; 'OK' oder 'SQLSTATE: Meldung'. Erfolg
-- BLEIBT bestehen (Subtransaktion wird übernommen).
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

-- Wie msg(), aber ein Erfolg wird zurückgerollt (Probe-Purge).
create function pg_temp.probe(p_role text, p_sql text) returns text
language plpgsql as $f$
begin
  begin
    execute format('set local role %I', p_role);
    execute p_sql;
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    reset role;
    if sqlerrm = 'PROBE_ROLLBACK' then
      return 'OK';
    end if;
    return sqlstate || ': ' || sqlerrm;
  end;
end $f$;

create function pg_temp.purge(p_admin uuid, p_company uuid) returns text
language sql as $f$
  select pg_temp.probe('postgres', format(
    'select public.purge_company_for_last_admin(%L, %L)', p_admin, p_company));
$f$;

-- Recovery-Zeilen + Export-Nachweise einer Firma als Zählerstring.
create function pg_temp.counts(p_company uuid) returns text
language sql as $f$
  select (select count(*) from public.work_recovery_cases where company_id = p_company)::text
    || '/' || (select count(*) from public.work_recovery_submissions where company_id = p_company)::text
    || '/' || (select count(*) from public.work_recovery_action_refs where company_id = p_company)::text
    || '/' || (select count(*) from public.work_recovery_events where company_id = p_company)::text
    || '/' || (select count(*) from public.company_deletion_exports where company_id = p_company)::text;
$f$;

-- Export als Admin (Rolle authenticated) → export_id
create function pg_temp.export_as(p_uid uuid) returns uuid
language plpgsql as $f$
declare v jsonb;
begin
  perform pg_temp.act_as(p_uid);
  set local role authenticated;
  v := public.get_company_recovery_export();
  reset role;
  return (v ->> 'export_id')::uuid;
end $f$;

create function pg_temp.ack_as(p_uid uuid, p_export uuid) returns text
language plpgsql as $f$
begin
  perform pg_temp.act_as(p_uid);
  return pg_temp.msg('authenticated',
    format('select public.acknowledge_company_recovery_export(%L)', p_export));
end $f$;

-- ── IDs ──────────────────────────────────────────────────
-- Firma A = 7d…0a (Recovery), Firma B = 7e…0b (Recovery, fremd),
-- Firma C = 7f…0c (keine Recovery-Zeilen)
-- A: 1 Admin Ada, 2 Admin Arne (zweiter Admin), 3 Emil, 4 Zora
-- B: 1 Admin Berta, 2 Bea   C: 1 Admin Cleo
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000','7d000000-0000-0000-0000-000000000001','authenticated','authenticated','rd-ada@example.test'),
  ('00000000-0000-0000-0000-000000000000','7d000000-0000-0000-0000-000000000002','authenticated','authenticated','rd-arne@example.test'),
  ('00000000-0000-0000-0000-000000000000','7d000000-0000-0000-0000-000000000003','authenticated','authenticated','rd-emil@example.test'),
  ('00000000-0000-0000-0000-000000000000','7d000000-0000-0000-0000-000000000004','authenticated','authenticated','rd-zora@example.test'),
  ('00000000-0000-0000-0000-000000000000','7e000000-0000-0000-0000-000000000001','authenticated','authenticated','rd-berta@example.test'),
  ('00000000-0000-0000-0000-000000000000','7e000000-0000-0000-0000-000000000002','authenticated','authenticated','rd-bea@example.test'),
  ('00000000-0000-0000-0000-000000000000','7f000000-0000-0000-0000-000000000001','authenticated','authenticated','rd-cleo@example.test');

-- Lokale Baselines ohne handle_new_user-Trigger (siehe Projekt-Memory).
insert into public.profiles (id, full_name)
select id, email from auth.users where email like 'rd-%@example.test'
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('7d000000-0000-0000-0000-00000000000a','RD Firma A','rd-firma-a'),
  ('7e000000-0000-0000-0000-00000000000b','RD Firma B','rd-firma-b'),
  ('7f000000-0000-0000-0000-00000000000c','RD Firma C','rd-firma-c');

update public.profiles p set role = v.role::public.app_role, company_id = v.company_id::uuid,
       is_active = true, full_name = v.n
from (values
  ('7d000000-0000-0000-0000-000000000001','admin',   '7d000000-0000-0000-0000-00000000000a','Ada Admin'),
  ('7d000000-0000-0000-0000-000000000002','admin',   '7d000000-0000-0000-0000-00000000000a','Arne Admin'),
  ('7d000000-0000-0000-0000-000000000003','employee','7d000000-0000-0000-0000-00000000000a','Emil Eins'),
  ('7d000000-0000-0000-0000-000000000004','employee','7d000000-0000-0000-0000-00000000000a','Zora Zwei'),
  ('7e000000-0000-0000-0000-000000000001','admin',   '7e000000-0000-0000-0000-00000000000b','Berta Admin'),
  ('7e000000-0000-0000-0000-000000000002','employee','7e000000-0000-0000-0000-00000000000b','Bea B'),
  ('7f000000-0000-0000-0000-000000000001','admin',   '7f000000-0000-0000-0000-00000000000c','Cleo Admin')
) as v(id, role, company_id, n)
where p.id = v.id::uuid;

insert into public.jobs (id, company_id, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time, is_active)
values
  ('7d000000-0000-0000-0001-000000000001','7d000000-0000-0000-0000-00000000000a','7d000000-0000-0000-0000-000000000001','Kunde RD','Reinigung','Weg 1','open','single',current_date,'08:00',true),
  ('7e000000-0000-0000-0001-000000000001','7e000000-0000-0000-0000-00000000000b','7e000000-0000-0000-0000-000000000001','Kunde RD','Reinigung','Weg 2','open','single',current_date,'08:00',true),
  ('7f000000-0000-0000-0001-000000000001','7f000000-0000-0000-0000-00000000000c','7f000000-0000-0000-0000-000000000001','Kunde RD','Reinigung','Weg 3','open','single',current_date,'08:00',true);

insert into public.job_assignments (id, job_id, employee_id, employee_name_snapshot) values
  ('7d000000-0000-0000-0002-000000000001','7d000000-0000-0000-0001-000000000001','7d000000-0000-0000-0000-000000000003','Emil Eins'),
  ('7d000000-0000-0000-0002-000000000002','7d000000-0000-0000-0001-000000000001','7d000000-0000-0000-0000-000000000004','Zora Zwei'),
  ('7e000000-0000-0000-0002-000000000001','7e000000-0000-0000-0001-000000000001','7e000000-0000-0000-0000-000000000002','Bea B');

-- Fälle (als Tabelleneigentümer, wie später die S2-RPCs)
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source) values
  ('7d000000-0000-0000-0003-000000000001','7d000000-0000-0000-0000-00000000000a','7d000000-0000-0000-0001-000000000001','7d000000-0000-0000-0002-000000000001','7d000000-0000-0000-0000-000000000003','legacy_queue'),
  ('7d000000-0000-0000-0003-000000000002','7d000000-0000-0000-0000-00000000000a','7d000000-0000-0000-0001-000000000001','7d000000-0000-0000-0002-000000000002','7d000000-0000-0000-0000-000000000004','work_journal'),
  ('7e000000-0000-0000-0003-000000000001','7e000000-0000-0000-0000-00000000000b','7e000000-0000-0000-0001-000000000001','7e000000-0000-0000-0002-000000000001','7e000000-0000-0000-0000-000000000002','legacy_queue');

insert into public.work_recovery_submissions (id, case_id, company_id, submitted_by, claimed_ops,
                                              client_platform, client_build, failure_code,
                                              failure_message, request_hash) values
  ('7d000000-0000-0000-0004-000000000001','7d000000-0000-0000-0003-000000000001','7d000000-0000-0000-0000-00000000000a','7d000000-0000-0000-0000-000000000003',
   '[{"type":"start_job","timestamp":"2026-11-20T08:00:00Z"}]','ios','42','22023','abgelehnt',repeat('a',64)),
  ('7e000000-0000-0000-0004-000000000001','7e000000-0000-0000-0003-000000000001','7e000000-0000-0000-0000-00000000000b','7e000000-0000-0000-0000-000000000002',
   '[{"type":"start_job","timestamp":"2026-11-20T08:00:00Z"}]','android','42','22023','abgelehnt',repeat('b',64));

insert into public.work_recovery_action_refs (submission_id, client_action_id) values
  ('7d000000-0000-0000-0004-000000000001','act-emil-1'),
  ('7e000000-0000-0000-0004-000000000001','act-bea-1');

insert into public.work_recovery_events (case_id, company_id, event_type, actor_id, to_state) values
  ('7d000000-0000-0000-0003-000000000001','7d000000-0000-0000-0000-00000000000a','case_opened','7d000000-0000-0000-0000-000000000003','open'),
  ('7d000000-0000-0000-0003-000000000002','7d000000-0000-0000-0000-00000000000a','case_opened','7d000000-0000-0000-0000-000000000004','open'),
  ('7e000000-0000-0000-0003-000000000001','7e000000-0000-0000-0000-00000000000b','case_opened','7e000000-0000-0000-0000-000000000002','open');

-- Zweiter Fall in Firma A → under_review mit interner Admin-Notiz.
select set_config('taskops.work_recovery_rpc', 'on', true);
update public.work_recovery_cases set state = 'under_review', revision = revision + 1,
       admin_note = 'INTERN: Rückfrage beim Kunden'
 where id = '7d000000-0000-0000-0003-000000000002';
select set_config('taskops.work_recovery_rpc', '', true);

-- =========================================================
-- G — Grants / RLS / Funktions-Eigenschaften
-- =========================================================
select pg_temp.chk('G1', 'company_deletion_exports: RLS an, keine Policy', 'true/0',
  (select c.relrowsecurity::text || '/' ||
          (select count(*) from pg_policies where tablename = 'company_deletion_exports')::text
     from pg_class c where c.oid = 'public.company_deletion_exports'::regclass));
select pg_temp.chk('G2', 'company_deletion_exports: keine Tabellenrechte für anon/authenticated/service_role', 'false/false/false',
  (select has_table_privilege('anon','public.company_deletion_exports','select,insert,update,delete')::text
     || '/' || has_table_privilege('authenticated','public.company_deletion_exports','select,insert,update,delete')::text
     || '/' || has_table_privilege('service_role','public.company_deletion_exports','select,insert,update,delete')::text));
select pg_temp.chk('G3', 'interne Funktionen: kein EXECUTE für anon/authenticated/service_role', 'false/false/false/false/false/false',
  (select string_agg(has_function_privilege(r, f, 'execute')::text, '/' order by f, r)
     from unnest(array['public._work_recovery_export_doc(uuid)','public._work_recovery_fingerprint(jsonb)']) f,
          unnest(array['anon','authenticated','service_role']) r));
select pg_temp.chk('G4', 'Export/Bestätigung: authenticated ja, anon nein', 'true/false/true/false',
  (select has_function_privilege('authenticated','public.get_company_recovery_export()','execute')::text
     || '/' || has_function_privilege('anon','public.get_company_recovery_export()','execute')::text
     || '/' || has_function_privilege('authenticated','public.acknowledge_company_recovery_export(uuid)','execute')::text
     || '/' || has_function_privilege('anon','public.acknowledge_company_recovery_export(uuid)','execute')::text));
select pg_temp.chk('G5', 'Purge: nur service_role', 'false/false/true',
  (select has_function_privilege('anon','public.purge_company_for_last_admin(uuid,uuid)','execute')::text
     || '/' || has_function_privilege('authenticated','public.purge_company_for_last_admin(uuid,uuid)','execute')::text
     || '/' || has_function_privilege('service_role','public.purge_company_for_last_admin(uuid,uuid)','execute')::text));
select pg_temp.chk('G6', 'neue RPCs + Purge: SECURITY DEFINER mit search_path', '3/3',
  (select count(*) filter (where p.prosecdef)::text || '/' ||
          count(*) filter (where p.proconfig::text like '%search_path=public, pg_temp%')::text
     from pg_proc p
    where p.oid in ('public.get_company_recovery_export()'::regprocedure,
                    'public.acknowledge_company_recovery_export(uuid)'::regprocedure,
                    'public.purge_company_for_last_admin(uuid,uuid)'::regprocedure)));
select pg_temp.chk('G7', 'genau eine Purge-Überladung', '1',
  (select count(*)::text from pg_proc where proname = 'purge_company_for_last_admin'));

-- =========================================================
-- Z — Firma ohne Recovery-Zeilen: unverändert
-- =========================================================
select pg_temp.chk('Z1', 'Firma C ohne Recovery-Zeilen: Purge ohne Export-Bestätigung OK (wie bisher)', 'OK',
  pg_temp.purge('7f000000-0000-0000-0000-000000000001','7f000000-0000-0000-0000-00000000000c'));
select pg_temp.chk('Z2', 'Probe-Purge zurückgerollt: Firma C existiert', '1',
  (select count(*)::text from public.companies where id = '7f000000-0000-0000-0000-00000000000c'));

-- =========================================================
-- E — Export-Autorisierung und -Inhalt
-- =========================================================
select pg_temp.act_as('7d000000-0000-0000-0000-000000000003');
select pg_temp.chk('E1', 'Mitarbeiter: Export abgelehnt', '42501: not_authorized',
  pg_temp.msg('authenticated', 'select public.get_company_recovery_export()'));
select pg_temp.chk('E2', 'Mitarbeiter: Bestätigung abgelehnt', '42501: not_authorized',
  pg_temp.msg('authenticated', format('select public.acknowledge_company_recovery_export(%L)', gen_random_uuid())));
select pg_temp.act_as(null);
select pg_temp.chk('E3', 'anon: Export ohne Grant', '42501: permission denied for function get_company_recovery_export',
  pg_temp.msg('anon', 'select public.get_company_recovery_export()'));
select pg_temp.chk('E4', 'authenticated ohne Sitzung (auth.uid() NULL)', '28000: unauthenticated',
  pg_temp.msg('authenticated', 'select public.get_company_recovery_export()'));
update public.profiles set is_active = false where id = '7d000000-0000-0000-0000-000000000002';
select pg_temp.act_as('7d000000-0000-0000-0000-000000000002');
select pg_temp.chk('E5', 'deaktivierter Admin: Export abgelehnt', '42501: not_authorized',
  pg_temp.msg('authenticated', 'select public.get_company_recovery_export()'));
update public.profiles set is_active = true where id = '7d000000-0000-0000-0000-000000000002';

select pg_temp.act_as('7d000000-0000-0000-0000-000000000001');
set local role authenticated;
create temp table _e_a as select public.get_company_recovery_export() as r;
reset role;
select pg_temp.chk('E6', 'Export A vollständig (Fälle/Einreichungen/Referenzen/Events, offen)', '2/1/1/2/2',
  (select (r #>> '{record_counts,cases}') || '/' || (r #>> '{record_counts,submissions}') || '/' ||
          (r #>> '{record_counts,action_refs}') || '/' || (r #>> '{record_counts,events}') || '/' ||
          (r ->> 'open_case_count') from _e_a));
select pg_temp.chk('E7', 'Export A enthält nur Firma A', 'true',
  (select bool_and(x ->> 'company_id' = '7d000000-0000-0000-0000-00000000000a')::text
     from _e_a, lateral (
       select jsonb_array_elements(r #> '{recovery,cases}') union all
       select jsonb_array_elements(r #> '{recovery,submissions}') union all
       select jsonb_array_elements(r #> '{recovery,action_refs}') union all
       select jsonb_array_elements(r #> '{recovery,events}')) t(x)));
select pg_temp.chk('E8', 'Export A enthält interne Admin-Notiz + Roh-Operationen', 'true/true',
  (select (r::text like '%INTERN: Rückfrage beim Kunden%')::text || '/' ||
          (r #> '{recovery,submissions,0,claimed_ops}' is not null)::text from _e_a));
select pg_temp.chk('E9', 'Export-Nachweis angelegt, unbestätigt, Fingerabdruck = Antwort', '1/null/true',
  (select count(*)::text || '/' || coalesce(max(e.acknowledged_at)::text, 'null') || '/' ||
          bool_and(e.fingerprint = (select r ->> 'fingerprint' from _e_a))::text
     from public.company_deletion_exports e
    where e.id = (select (r ->> 'export_id')::uuid from _e_a)));
set local timezone = 'America/New_York';
select pg_temp.chk('E10', 'Fingerabdruck unabhängig von der Sitzungs-Zeitzone', 'true',
  (select (public._work_recovery_fingerprint(public._work_recovery_export_doc(
             '7d000000-0000-0000-0000-00000000000a')) = (r ->> 'fingerprint'))::text from _e_a));
set local timezone = 'UTC';
select pg_temp.act_as('7d000000-0000-0000-0000-000000000001');
set local role authenticated;
create temp table _e_a2 as select public.get_company_recovery_export() as r;
reset role;
select pg_temp.chk('E10b', 'erneuter Export bei unverändertem Stand: gleicher Nachweis, keine neue Zeile', 'true/1',
  (select ((select r ->> 'export_id' from _e_a2) = (select r ->> 'export_id' from _e_a))::text || '/' ||
          (select count(*) from public.company_deletion_exports
            where company_id = '7d000000-0000-0000-0000-00000000000a')::text));
select pg_temp.act_as('7e000000-0000-0000-0000-000000000001');
set local role authenticated;
create temp table _e_b as select public.get_company_recovery_export() as r;
reset role;
select pg_temp.chk('E11', 'Admin B sieht nur Firma B (1 Fall, kein A-Inhalt)', '1/false',
  (select (r #>> '{record_counts,cases}') || '/' ||
          (r::text like '%7d000000-0000-0000-0003%')::text from _e_b));

-- =========================================================
-- O — Regel A: offene Fälle blockieren
-- =========================================================
-- Arne (zweiter Admin) exportiert + bestätigt, danach Arne deaktiviert →
-- Ada ist letzte Admin.
create temp table _arne as select pg_temp.export_as('7d000000-0000-0000-0000-000000000002') as id;
select pg_temp.chk('O0', 'Bestätigung trotz offener Fälle möglich (Export ist nur Nachweis)', 'OK',
  pg_temp.ack_as('7d000000-0000-0000-0000-000000000002', (select id from _arne)));
update public.profiles set is_active = false where id = '7d000000-0000-0000-0000-000000000002';
create temp table _o_before as select pg_temp.counts('7d000000-0000-0000-0000-00000000000a') as c;
select pg_temp.chk('O1', 'offener + under_review-Fall: Purge blockiert', 'P0001: open_recovery_cases',
  pg_temp.purge('7d000000-0000-0000-0000-000000000001','7d000000-0000-0000-0000-00000000000a'));
select pg_temp.chk('O2', 'abgelehnter Purge ändert nichts (Recovery/Export-Nachweise)', 'true',
  (select (pg_temp.counts('7d000000-0000-0000-0000-00000000000a') = c)::text from _o_before));
select pg_temp.chk('O3', 'Purge-Flag nach Ablehnung leer', '',
  coalesce(current_setting('taskops.company_purge', true), ''));
-- nur noch under_review offen
select set_config('taskops.work_recovery_rpc', 'on', true);
update public.work_recovery_cases set state = 'approved', decided_at = now(), revision = revision + 1
 where id = '7d000000-0000-0000-0003-000000000001';
select set_config('taskops.work_recovery_rpc', '', true);
select pg_temp.chk('O4', 'ein under_review-Fall genügt zur Sperre', 'P0001: open_recovery_cases',
  pg_temp.purge('7d000000-0000-0000-0000-000000000001','7d000000-0000-0000-0000-00000000000a'));
select set_config('taskops.work_recovery_rpc', 'on', true);
update public.work_recovery_cases set state = 'declined', decided_at = now(), revision = revision + 1,
       employee_message = 'Kein Nachweis für diesen Einsatz.'
 where id = '7d000000-0000-0000-0003-000000000002';
select set_config('taskops.work_recovery_rpc', '', true);

-- =========================================================
-- R — Regel B: Bestätigung, Aktualität, Bindung an Admin + Firma
-- =========================================================
select pg_temp.chk('R1', 'alle Fälle entschieden, aber Ada hat nichts bestätigt (Arnes Bestätigung zählt nicht)', 'P0001: recovery_export_required',
  pg_temp.purge('7d000000-0000-0000-0000-000000000001','7d000000-0000-0000-0000-00000000000a'));
create temp table _x1 as select pg_temp.export_as('7d000000-0000-0000-0000-000000000001') as id;
select pg_temp.chk('R2', 'Export erzeugt, nicht bestätigt: weiterhin blockiert', 'P0001: recovery_export_required',
  pg_temp.purge('7d000000-0000-0000-0000-000000000001','7d000000-0000-0000-0000-00000000000a'));
select pg_temp.chk('R3', 'Ada kann Arnes Export nicht bestätigen', '42501: export_not_found',
  pg_temp.ack_as('7d000000-0000-0000-0000-000000000001', (select id from _arne)));
select pg_temp.chk('R4', 'Admin B kann Adas Export nicht bestätigen (fremde Firma)', '42501: export_not_found',
  pg_temp.ack_as('7e000000-0000-0000-0000-000000000001', (select id from _x1)));
select pg_temp.chk('R5', 'Admin B bestätigt eigenen Export → zählt nicht für Firma A', 'OK',
  pg_temp.ack_as('7e000000-0000-0000-0000-000000000001', (select (r ->> 'export_id')::uuid from _e_b)));
select pg_temp.chk('R6', 'Ada: alter Export (vor Entscheidung) veraltet → Bestätigung abgelehnt', 'P0001: recovery_export_stale',
  pg_temp.ack_as('7d000000-0000-0000-0000-000000000001', (select (r ->> 'export_id')::uuid from _e_a)));
select pg_temp.chk('R7', 'Ada bestätigt aktuellen Export', 'OK',
  pg_temp.ack_as('7d000000-0000-0000-0000-000000000001', (select id from _x1)));
select pg_temp.chk('R8', 'Bestätigung idempotent', 'OK',
  pg_temp.ack_as('7d000000-0000-0000-0000-000000000001', (select id from _x1)));
select pg_temp.chk('R9', 'mit aktueller Bestätigung: Purge möglich (Probe, zurückgerollt)', 'OK',
  pg_temp.purge('7d000000-0000-0000-0000-000000000001','7d000000-0000-0000-0000-00000000000a'));
-- Regel A gilt auch MIT aktueller Bestätigung des letzten Admins.
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source) values
  ('7d000000-0000-0000-0003-000000000003','7d000000-0000-0000-0000-00000000000a','7d000000-0000-0000-0001-000000000001','7d000000-0000-0000-0002-000000000001','7d000000-0000-0000-0000-000000000003','work_journal');
select pg_temp.chk('R9b', 'neuer offener Fall trotz Bestätigung: Regel A vor Regel B', 'P0001: open_recovery_cases',
  pg_temp.purge('7d000000-0000-0000-0000-000000000001','7d000000-0000-0000-0000-00000000000a'));
select set_config('taskops.work_recovery_rpc', 'on', true);
update public.work_recovery_cases set state = 'superseded', decided_at = now(), revision = revision + 1
 where id = '7d000000-0000-0000-0003-000000000003';
select set_config('taskops.work_recovery_rpc', '', true);
-- Änderung NACH der Bestätigung: neues Event auf entschiedenem Fall
insert into public.work_recovery_events (case_id, company_id, event_type, actor_id, detail) values
  ('7d000000-0000-0000-0003-000000000001','7d000000-0000-0000-0000-00000000000a','note_added',
   '7d000000-0000-0000-0000-000000000001','{"note":"nachträglich"}');
select pg_temp.chk('R10', 'neues Event nach Bestätigung: Bestätigung veraltet', 'P0001: recovery_export_stale',
  pg_temp.purge('7d000000-0000-0000-0000-000000000001','7d000000-0000-0000-0000-00000000000a'));
select pg_temp.chk('R11', 'veralteten Export erneut bestätigen abgelehnt', 'P0001: recovery_export_stale',
  pg_temp.ack_as('7d000000-0000-0000-0000-000000000001', (select id from _x1)));
create temp table _x2 as select pg_temp.export_as('7d000000-0000-0000-0000-000000000001') as id;
select pg_temp.ack_as('7d000000-0000-0000-0000-000000000001', (select id from _x2));
-- Konto-Löschung eines Mitarbeiters (FK SET NULL) ändert die Nachweise
delete from auth.users where id = '7d000000-0000-0000-0000-000000000004';
select pg_temp.chk('R12', 'Konto-Löschung (SET NULL) nach Bestätigung: veraltet', 'P0001: recovery_export_stale',
  pg_temp.purge('7d000000-0000-0000-0000-000000000001','7d000000-0000-0000-0000-00000000000a'));
select pg_temp.chk('R13', 'Nachweise des gelöschten Kontos bleiben (Fall vorhanden, employee_id NULL)', '1',
  (select count(*)::text from public.work_recovery_cases
    where id = '7d000000-0000-0000-0003-000000000002' and employee_id is null));

-- =========================================================
-- A — Append-only außerhalb des Purge unverändert
-- =========================================================
select pg_temp.chk('A1', 'Event löschen ohne Purge-Flag', '23514',
  (select split_part(pg_temp.msg('postgres', $q$delete from public.work_recovery_events
     where company_id = '7d000000-0000-0000-0000-00000000000a'$q$), ':', 1)));
select pg_temp.chk('A2', 'Fall löschen ohne Purge-Flag', '23514',
  (select split_part(pg_temp.msg('postgres', $q$delete from public.work_recovery_cases
     where company_id = '7d000000-0000-0000-0000-00000000000a'$q$), ':', 1)));

-- =========================================================
-- H — Happy Path (echter Purge, bleibt bis zum ROLLBACK bestehen)
-- =========================================================
-- Alle bisherigen Exporte entstanden in DIESER Transaktion und tragen
-- dasselbe now() als created_at/acknowledged_at. Der Purge wählt die
-- neueste Bestätigung (acknowledged_at desc, created_at desc); bei
-- Gleichstand wäre die Wahl zufällig (veraltete Bestätigung → stale,
-- Test flackert je nach physischer Zeilenreihenfolge). In Produktion ist
-- jede Bestätigung ein eigener Request/eine eigene Transaktion. Das bilden
-- wir hier nach, indem die früheren Exporte älter gemacht werden.
update public.company_deletion_exports
   set created_at = created_at - interval '1 hour',
       acknowledged_at = acknowledged_at - interval '1 hour'
 where company_id = '7d000000-0000-0000-0000-00000000000a';
create temp table _x3 as select pg_temp.export_as('7d000000-0000-0000-0000-000000000001') as id;
select pg_temp.chk('H0', 'aktuellen Export bestätigen', 'OK',
  pg_temp.ack_as('7d000000-0000-0000-0000-000000000001', (select id from _x3)));
create temp table _b_before as select pg_temp.counts('7e000000-0000-0000-0000-00000000000b') as c;
select pg_temp.act_as(null);
select pg_temp.chk('H1', 'Purge Firma A gelingt', 'OK',
  pg_temp.msg('postgres', $q$select public.purge_company_for_last_admin(
    '7d000000-0000-0000-0000-000000000001','7d000000-0000-0000-0000-00000000000a')$q$));
select pg_temp.chk('H2', 'Recovery-Zeilen + Export-Nachweise von A weg', '0/0/0/0/0',
  pg_temp.counts('7d000000-0000-0000-0000-00000000000a'));
select pg_temp.chk('H3', 'Firma B unverändert', 'true',
  (select (pg_temp.counts('7e000000-0000-0000-0000-00000000000b') = c)::text from _b_before));
select pg_temp.chk('H4', 'Purge-Flag leer', '',
  coalesce(current_setting('taskops.company_purge', true), ''));
select pg_temp.chk('H5', 'zweiter Purge-Aufruf: profile_not_found', 'P0001: profile_not_found',
  pg_temp.purge('7d000000-0000-0000-0000-000000000001','7d000000-0000-0000-0000-00000000000a'));
select pg_temp.chk('H6', 'Firma B: offener Fall blockiert weiterhin', 'P0001: open_recovery_cases',
  pg_temp.purge('7e000000-0000-0000-0000-000000000001','7e000000-0000-0000-0000-00000000000b'));

-- =========================================================
-- Ergebnis
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis, verdikt from _results order by case_no;

do $$
declare v_fail int; v_total int;
begin
  select count(*) filter (where verdikt = 'FAIL'), count(*) into v_fail, v_total from _results;
  raise notice 'work_recovery_deletion_safety: % checks, % failed', v_total, v_fail;
  if v_fail > 0 then
    raise exception 'work_recovery_deletion_safety: % of % checks FAILED', v_fail, v_total;
  end if;
end $$;

rollback;
