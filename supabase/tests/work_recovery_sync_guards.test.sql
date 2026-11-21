-- =========================================================
-- TEST: Work-Recovery S1.6 — Recovery-Guards & Zuweisungs-Abgleich
-- (Migration 20261122000000)
-- =========================================================
-- Deckt ab:
--   S  Struktur: Index, Lock-Helfer ohne Client-Zugriff, Funktionsrümpfe
--   I  inherit_occurrence_assignments (über update_job_occurrences):
--      Zuweisung mit OFFENEM bzw. ABGESCHLOSSENEM Fall bleibt, alle anderen
--      Zuweisungen (andere Mitarbeiter, andere Termine) werden abgeglichen
--   P  PRUNE: Termin mit offenem/abgeschlossenem Fall bleibt, übrige
--      Termine des entfernten Wochentags werden gelöscht
--   L  compat_sync_assignments_from_legacy (Alt-Client schreibt assigned_to):
--      offener Fall + jeder abgeschlossene Zustand
--   H  Horizont-Worker: Regel mit Fall läuft ohne Fehler durch
--   B  Firma B ohne Fall: Verhalten unverändert (Abgleich löscht normal)
--   E  Expliziter Admin-Eingriff (set_job_assignments / Auftrag löschen)
--      scheitert weiterhin sichtbar — jetzt auch bei abgeschlossenem Fall
--      mit klarer 22023-Meldung statt 23503
--   R  Idempotenz: wiederholter Abgleich ändert nichts mehr
--   W  Keine Nebenwirkung: Arbeitszeit/Status der geschützten Zeilen,
--      Fall-Daten (Fingerprint), Invariante assigned_to gedeckt
--
-- Termine liegen ab heute+7, damit kein Lauf nahe Mitternacht (UTC bzw.
-- Firmenzeitzone) einen Termin aus "date >= current_date" fallen lässt.
--
-- AUSFÜHREN (lokal):
--   docker exec -i supabase_db_cleaning-employee-app-2 psql -U postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/work_recovery_sync_guards.test.sql
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
    json_build_object('sub', uid::text, 'role','authenticated')::text, true);
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

-- ── IDs ──────────────────────────────────────────────────
-- Firma A 71000000-…-00000000000a: Admin …01, Emil …02, Zora …03, Ida …04
-- Firma B 71000000-…-00000000000b: Admin …11, Bea …12, Ben …13
-- Regeln …-0001-…: RA …01, RH …02 (Horizont), RB …03 (Firma B)
-- Einzelaufträge …-0001-0000000001xx, Fälle …-0003-…
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000','71000000-0000-0000-0000-000000000001','authenticated','authenticated','sg-admin-a@example.test'),
  ('00000000-0000-0000-0000-000000000000','71000000-0000-0000-0000-000000000002','authenticated','authenticated','sg-emil@example.test'),
  ('00000000-0000-0000-0000-000000000000','71000000-0000-0000-0000-000000000003','authenticated','authenticated','sg-zora@example.test'),
  ('00000000-0000-0000-0000-000000000000','71000000-0000-0000-0000-000000000004','authenticated','authenticated','sg-ida@example.test'),
  ('00000000-0000-0000-0000-000000000000','71000000-0000-0000-0000-000000000011','authenticated','authenticated','sg-admin-b@example.test'),
  ('00000000-0000-0000-0000-000000000000','71000000-0000-0000-0000-000000000012','authenticated','authenticated','sg-bea@example.test'),
  ('00000000-0000-0000-0000-000000000000','71000000-0000-0000-0000-000000000013','authenticated','authenticated','sg-ben@example.test');

insert into public.profiles (id, full_name) values
  ('71000000-0000-0000-0000-000000000001','Anna Admin'),
  ('71000000-0000-0000-0000-000000000002','Emil'),
  ('71000000-0000-0000-0000-000000000003','Zora'),
  ('71000000-0000-0000-0000-000000000004','Ida'),
  ('71000000-0000-0000-0000-000000000011','Berta Admin'),
  ('71000000-0000-0000-0000-000000000012','Bea'),
  ('71000000-0000-0000-0000-000000000013','Ben')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('71000000-0000-0000-0000-00000000000a','SG Firma A','sg-firma-a'),
  ('71000000-0000-0000-0000-00000000000b','SG Firma B','sg-firma-b');

update public.profiles p set role = v.role::public.app_role, company_id = v.company_id::uuid,
       is_active = true, full_name = v.n
from (values
  ('71000000-0000-0000-0000-000000000001','admin',   '71000000-0000-0000-0000-00000000000a','Anna Admin'),
  ('71000000-0000-0000-0000-000000000002','employee','71000000-0000-0000-0000-00000000000a','Emil'),
  ('71000000-0000-0000-0000-000000000003','employee','71000000-0000-0000-0000-00000000000a','Zora'),
  ('71000000-0000-0000-0000-000000000004','employee','71000000-0000-0000-0000-00000000000a','Ida'),
  ('71000000-0000-0000-0000-000000000011','admin',   '71000000-0000-0000-0000-00000000000b','Berta Admin'),
  ('71000000-0000-0000-0000-000000000012','employee','71000000-0000-0000-0000-00000000000b','Bea'),
  ('71000000-0000-0000-0000-000000000013','employee','71000000-0000-0000-0000-00000000000b','Ben')
) as v(id, role, company_id, n)
where p.id = v.id::uuid;

-- ── Helfer ───────────────────────────────────────────────
-- Zuweisungsmenge eines Auftrags als "Name,Name" (sortiert), leer = LEER.
create function pg_temp.menge(p_job uuid) returns text language sql as $f$
  select coalesce(string_agg(p.full_name, ',' order by p.full_name), 'LEER')
  from public.job_assignments ja join public.profiles p on p.id = ja.employee_id
  where ja.job_id = p_job;
$f$;

-- Termin einer Regel an Datum.
create function pg_temp.occ(p_rule uuid, p_date date) returns uuid language sql as $f$
  select id from public.jobs where parent_job_id = p_rule and occurrence_date = p_date;
$f$;

create function pg_temp.assignment(p_job uuid, p_emp uuid) returns uuid language sql as $f$
  select id from public.job_assignments where job_id = p_job and employee_id = p_emp;
$f$;

create function pg_temp.mk_case(p_id uuid, p_job uuid, p_emp uuid) returns void
language sql as $f$
  insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source)
  select p_id, j.company_id, p_job, pg_temp.assignment(p_job, p_emp), p_emp, 'legacy_queue'
  from public.jobs j where j.id = p_job;
$f$;

-- Fall abschließen wie der spätere Resolve-Slice (RPC-Flag, Revision +1).
create function pg_temp.close_case(p_id uuid, p_state text) returns void
language plpgsql as $f$
begin
  perform set_config('taskops.work_recovery_rpc', 'on', true);
  update public.work_recovery_cases
     set state = p_state, decided_at = now(), revision = revision + 1,
         employee_message = case when p_state in ('partially_approved','declined')
                                 then 'Begründung für den Test' end
   where id = p_id;
  perform set_config('taskops.work_recovery_rpc', '', true);
end $f$;

create function pg_temp.mk_rule(p_id uuid, p_company uuid, p_admin uuid) returns void
language sql as $f$
  insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                           status, job_type, recurring_days, start_time, recurrence_start_date, is_active)
  values (p_id, p_company, p_admin, 'Kunde SG', 'Reinigung', 'Weg 1', 'open', 'recurring',
          array['mon','tue','wed','thu','fri','sat','sun'], '08:00', current_date + 7, true);
$f$;

create function pg_temp.mk_single(p_id uuid, p_company uuid, p_admin uuid) returns void
language sql as $f$
  insert into public.jobs (id, company_id, created_by, customer_name, service_name,
                           location_address, status, job_type, date, start_time, is_active)
  values (p_id, p_company, p_admin, 'Kunde SG', 'Reinigung', 'Weg 1',
          'open', 'single', current_date + 7, '08:00', true);
$f$;

create temp table _d as select current_date + 7 as d1;

-- =========================================================
-- Fixtures Firma A
-- =========================================================
-- RA: Regel mit Emil, Zora, Ida; Termine ab heute+7 (3 Monate).
select pg_temp.mk_rule('71000000-0000-0000-0001-000000000001','71000000-0000-0000-0000-00000000000a','71000000-0000-0000-0000-000000000001');
select pg_temp.act_as('71000000-0000-0000-0000-000000000001');
select public.set_job_assignments('71000000-0000-0000-0001-000000000001',
  array['71000000-0000-0000-0000-000000000002','71000000-0000-0000-0000-000000000003',
        '71000000-0000-0000-0000-000000000004']::uuid[]);
select public.generate_job_occurrences('71000000-0000-0000-0001-000000000001');

-- O1 = d1, O3 = d1+1 (anderer Wochentag), O2 = d1+7, O4 = d1+14 (gleicher
-- Wochentag wie O1), O5 = d1+21 (gleicher Wochentag, OHNE Fall).
-- Fälle:
--   K1 offen        Emil @ O1  (I: Emil wird aus der Regel entfernt)
--   K2 approved     Zora @ O3  (I: Zora wird aus der Regel entfernt)
--   K3 offen        Ida  @ O2  (P: Wochentag von O1 wird entfernt)
--   K4 declined     Ida  @ O4  (P)
select pg_temp.mk_case('71000000-0000-0000-0003-000000000001',
  pg_temp.occ('71000000-0000-0000-0001-000000000001', (select d1 from _d)),      '71000000-0000-0000-0000-000000000002');
select pg_temp.mk_case('71000000-0000-0000-0003-000000000002',
  pg_temp.occ('71000000-0000-0000-0001-000000000001', (select d1 + 1 from _d)),  '71000000-0000-0000-0000-000000000003');
select pg_temp.close_case('71000000-0000-0000-0003-000000000002', 'approved');
select pg_temp.mk_case('71000000-0000-0000-0003-000000000003',
  pg_temp.occ('71000000-0000-0000-0001-000000000001', (select d1 + 7 from _d)),  '71000000-0000-0000-0000-000000000004');
select pg_temp.mk_case('71000000-0000-0000-0003-000000000004',
  pg_temp.occ('71000000-0000-0000-0001-000000000001', (select d1 + 14 from _d)), '71000000-0000-0000-0000-000000000004');
select pg_temp.close_case('71000000-0000-0000-0003-000000000004', 'declined');

create temp table _o as
select (select d1 from _d) as d1,
       pg_temp.occ('71000000-0000-0000-0001-000000000001', (select d1 from _d))      as o1,
       pg_temp.occ('71000000-0000-0000-0001-000000000001', (select d1 + 1 from _d))  as o3,
       pg_temp.occ('71000000-0000-0000-0001-000000000001', (select d1 + 7 from _d))  as o2,
       pg_temp.occ('71000000-0000-0000-0001-000000000001', (select d1 + 14 from _d)) as o4,
       pg_temp.occ('71000000-0000-0000-0001-000000000001', (select d1 + 21 from _d)) as o5,
       pg_temp.occ('71000000-0000-0000-0001-000000000001', (select d1 + 2 from _d))  as o6;

-- L: Einzelaufträge mit Legacy-Zeiger Emil, Zuweisungen Emil + Zora.
--    …0101 offen, …0102 approved, …0103 partially_approved,
--    …0104 declined, …0105 superseded (Fall jeweils auf Emil).
do $$
declare i int; j uuid; st text;
begin
  for i in 1..5 loop
    j := ('71000000-0000-0000-0001-00000000010' || i)::uuid;
    perform pg_temp.mk_single(j, '71000000-0000-0000-0000-00000000000a', '71000000-0000-0000-0000-000000000001');
    perform public.set_job_assignments(j, array['71000000-0000-0000-0000-000000000002',
                                                '71000000-0000-0000-0000-000000000003']::uuid[]);
    perform pg_temp.mk_case(('71000000-0000-0000-0003-00000000010' || i)::uuid, j,
                            '71000000-0000-0000-0000-000000000002');
    st := (array['open','approved','partially_approved','declined','superseded'])[i];
    if st <> 'open' then
      perform pg_temp.close_case(('71000000-0000-0000-0003-00000000010' || i)::uuid, st);
    end if;
  end loop;
end $$;

-- H: Regel RH mit Emil + Zora, nur bis heute+20 erzeugt (Horizont fällig).
select pg_temp.mk_rule('71000000-0000-0000-0001-000000000002','71000000-0000-0000-0000-00000000000a','71000000-0000-0000-0000-000000000001');
select public.set_job_assignments('71000000-0000-0000-0001-000000000002',
  array['71000000-0000-0000-0000-000000000002','71000000-0000-0000-0000-000000000003']::uuid[]);
select public._materialize_recurring_occurrences('71000000-0000-0000-0001-000000000002', current_date + 20);
select pg_temp.mk_case('71000000-0000-0000-0003-000000000201',
  pg_temp.occ('71000000-0000-0000-0001-000000000002', (select d1 from _d)), '71000000-0000-0000-0000-000000000002');

-- =========================================================
-- Fixtures Firma B (kein Fall)
-- =========================================================
select pg_temp.mk_rule('71000000-0000-0000-0001-000000000003','71000000-0000-0000-0000-00000000000b','71000000-0000-0000-0000-000000000011');
select pg_temp.act_as('71000000-0000-0000-0000-000000000011');
select public.set_job_assignments('71000000-0000-0000-0001-000000000003',
  array['71000000-0000-0000-0000-000000000012','71000000-0000-0000-0000-000000000013']::uuid[]);
select public.generate_job_occurrences('71000000-0000-0000-0001-000000000003');

-- ── Baselines ────────────────────────────────────────────
create temp table _fp_before as
select public._work_recovery_fingerprint(public._work_recovery_export_doc('71000000-0000-0000-0000-00000000000a')) as fp,
       (select count(*) from public.work_recovery_cases) as n_cases,
       (select count(*) from public.work_recovery_events) as n_events;

create temp table _prot_before as
select ja.id, ja.employee_started_at, ja.employee_completed_at, ja.attendance::text as attendance,
       ja.work_revision, j.status::text as status, j.started_at, j.completed_at
from public.work_recovery_cases c
join public.job_assignments ja on ja.id = c.assignment_id
join public.jobs j on j.id = ja.job_id;

-- =========================================================
-- S — Struktur
-- =========================================================
select pg_temp.chk('S1', 'Index work_recovery_cases(assignment_id) vorhanden (nicht partiell)', 'true',
  (select exists(select 1 from pg_indexes where schemaname = 'public'
     and indexname = 'work_recovery_cases_assignment_idx'
     and indexdef not ilike '%where%')::text));

select pg_temp.chk('S2', 'Lock-Helfer: kein EXECUTE für anon/authenticated/service_role, INVOKER, search_path fix',
  'anon=false/auth=false/service=false/definer=false/path=true',
  (select 'anon=' || has_function_privilege('anon', p.oid, 'execute')::text
       || '/auth=' || has_function_privilege('authenticated', p.oid, 'execute')::text
       || '/service=' || has_function_privilege('service_role', p.oid, 'execute')::text
       || '/definer=' || p.prosecdef::text
       || '/path=' || (p.proconfig @> array['search_path=public, pg_temp'])::text
     from pg_proc p where p.oid = 'public._lock_company_for_recovery_write(uuid)'::regprocedure));

select pg_temp.chk('S3', 'Lock-Helfer: unbekannte Firma klar abgelehnt', 'P0002: recovery_company_not_found',
  pg_temp.msg('postgres', $q$select public._lock_company_for_recovery_write(gen_random_uuid())$q$));
select pg_temp.chk('S4', 'Lock-Helfer: bestehende Firma OK', 'OK',
  pg_temp.msg('postgres', $q$select public._lock_company_for_recovery_write('71000000-0000-0000-0000-00000000000a')$q$));

select pg_temp.chk('S5', 'alle drei Abgleichspfade prüfen work_recovery_cases', 'inherit=true/compat=true/update=true',
  (select 'inherit=' || (pg_get_functiondef('public.inherit_occurrence_assignments(uuid,uuid)'::regprocedure) ilike '%work_recovery_cases%')::text
       || '/compat=' || (pg_get_functiondef('public.compat_sync_assignments_from_legacy()'::regprocedure) ilike '%work_recovery_cases%')::text
       || '/update=' || (pg_get_functiondef('public.update_job_occurrences(uuid)'::regprocedure) ilike '%work_recovery_cases%')::text));

select pg_temp.chk('S6', 'EXECUTE der geänderten Funktionen unverändert (anon nie)',
  'inherit_auth=false/update_auth=true/update_anon=false',
  (select 'inherit_auth=' || has_function_privilege('authenticated','public.inherit_occurrence_assignments(uuid,uuid)','execute')::text
       || '/update_auth=' || has_function_privilege('authenticated','public.update_job_occurrences(uuid)','execute')::text
       || '/update_anon=' || has_function_privilege('anon','public.update_job_occurrences(uuid)','execute')::text));

-- =========================================================
-- I — inherit: Emil (offener Fall auf O1) und Zora (approved auf O3)
--     werden aus der Regel entfernt
-- =========================================================
select pg_temp.act_as('71000000-0000-0000-0000-000000000001');
select pg_temp.chk('I1', 'Regel-Menge auf {Ida} setzen + Abgleich: kein Fehler', 'OK',
  pg_temp.msg('authenticated', $q$
    select public.set_job_assignments('71000000-0000-0000-0001-000000000001',
      array['71000000-0000-0000-0000-000000000004']::uuid[]);
    select public.update_job_occurrences('71000000-0000-0000-0001-000000000001')$q$));

select pg_temp.chk('I2', 'O1: Emil (offener Fall) bleibt, Zora entfernt, Ida bleibt', 'Emil,Ida',
  (select pg_temp.menge(o1) from _o));
select pg_temp.chk('I3', 'O3: Zora (abgeschlossener Fall) bleibt, Emil entfernt', 'Ida,Zora',
  (select pg_temp.menge(o3) from _o));
select pg_temp.chk('I4', 'Termin ohne Fall (O6): nur noch Ida', 'Ida',
  (select pg_temp.menge(o6) from _o));
select pg_temp.chk('I5', 'Emil/Zora ausserhalb der Fall-Termine überall entfernt', '0',
  (select count(*)::text from public.job_assignments ja join public.jobs j on j.id = ja.job_id
    where j.parent_job_id = '71000000-0000-0000-0001-000000000001'
      and ja.employee_id in ('71000000-0000-0000-0000-000000000002','71000000-0000-0000-0000-000000000003')
      and j.id not in (select o1 from _o union all select o3 from _o)));
select pg_temp.chk('I6', 'Ida auf jedem Termin der Regel', '0',
  (select count(*)::text from public.jobs j
    where j.parent_job_id = '71000000-0000-0000-0001-000000000001'
      and pg_temp.assignment(j.id, '71000000-0000-0000-0000-000000000004') is null));

-- =========================================================
-- P — PRUNE: Wochentag von O1 entfernen
-- =========================================================
update public.jobs
   set recurring_days = array_remove(recurring_days,
         (array['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from (select d1 from _d))::int])
 where id = '71000000-0000-0000-0001-000000000001';

create temp table _p_before as
select count(*) as n from public.jobs
 where parent_job_id = '71000000-0000-0000-0001-000000000001'
   and extract(isodow from occurrence_date) = extract(isodow from (select d1 from _d));

select pg_temp.chk('P1', 'Abgleich nach Wochentag-Entfernung: kein Fehler', 'OK',
  pg_temp.msg('authenticated', $q$select public.update_job_occurrences('71000000-0000-0000-0001-000000000001')$q$));
select pg_temp.chk('P2', 'O1 (offen), O2 (offen), O4 (declined) bleiben; O5 ohne Fall gelöscht',
  'o1=true/o2=true/o4=true/o5=false',
  (select 'o1=' || exists(select 1 from public.jobs where id = o1)::text
       || '/o2=' || exists(select 1 from public.jobs where id = o2)::text
       || '/o4=' || exists(select 1 from public.jobs where id = o4)::text
       || '/o5=' || exists(select 1 from public.jobs where id = o5)::text from _o));
select pg_temp.chk('P3', 'vom entfernten Wochentag bleiben genau die 3 Fall-Termine', '3',
  (select count(*)::text from public.jobs
    where parent_job_id = '71000000-0000-0000-0001-000000000001'
      and extract(isodow from occurrence_date) = extract(isodow from (select d1 from _d))));
select pg_temp.chk('P4', 'vorher gab es mehr Termine dieses Wochentags (PRUNE hat gelöscht)', 'true',
  (select (n > 3)::text from _p_before));
select pg_temp.chk('P5', 'andere Wochentage unberührt (O3 + O6 vorhanden)', 'true/true',
  (select exists(select 1 from public.jobs where id = o3)::text || '/'
       || exists(select 1 from public.jobs where id = o6)::text from _o));
select pg_temp.chk('P6', 'kein Grabstein für übersprungene Fall-Termine', '0',
  (select count(*)::text from public.job_occurrence_skips s, _o
    where s.parent_job_id = '71000000-0000-0000-0001-000000000001'
      and s.occurrence_date in (_o.d1, _o.d1 + 7, _o.d1 + 14)));

-- =========================================================
-- L — Alt-Client schreibt assigned_to = Ida
-- =========================================================
select pg_temp.chk('L1', 'Legacy-Schreibvorgang auf 5 Aufträge mit Fall (offen + 4 Endzustände): kein Fehler', 'OK',
  pg_temp.msg('postgres', $q$update public.jobs set assigned_to = '71000000-0000-0000-0000-000000000004'
    where id::text like '71000000-0000-0000-0001-00000000010_'$q$));
select pg_temp.chk('L2', 'je Auftrag: Emil (Fall) bleibt, Zora entfernt, Ida neu', 'Emil,Ida|Emil,Ida|Emil,Ida|Emil,Ida|Emil,Ida',
  (select string_agg(pg_temp.menge(id), '|' order by id) from public.jobs
    where id::text like '71000000-0000-0000-0001-00000000010_'));
select pg_temp.chk('L3', 'Legacy-Zeiger = Ida und gedeckt', 'Ida:true|Ida:true|Ida:true|Ida:true|Ida:true',
  (select string_agg(p.full_name || ':' || (pg_temp.assignment(j.id, j.assigned_to) is not null)::text, '|' order by j.id)
     from public.jobs j join public.profiles p on p.id = j.assigned_to
    where j.id::text like '71000000-0000-0000-0001-00000000010_'));

-- =========================================================
-- H — Horizont-Worker (Cron-Kontext): Emil aus RH entfernt, Fall auf O1
-- =========================================================
select public.set_job_assignments('71000000-0000-0000-0001-000000000002',
  array['71000000-0000-0000-0000-000000000003']::uuid[]);
select set_config('request.jwt.claims', '', true);
create temp table _run as select public.extend_recurring_horizons() as r;
select pg_temp.chk('H1', 'Worker-Lauf: keine Fehler', '0',
  (select r ->> 'errors' from _run));
select pg_temp.chk('H2', 'RH erweitert (Horizont >= heute+83)', 'true',
  (select (max(occurrence_date) >= current_date + 83)::text from public.jobs
    where parent_job_id = '71000000-0000-0000-0001-000000000002'));
select pg_temp.chk('H3', 'RH O1: Emil (offener Fall) bleibt neben Zora', 'Emil,Zora',
  pg_temp.menge(pg_temp.occ('71000000-0000-0000-0001-000000000002', (select d1 from _d))));
select pg_temp.chk('H4', 'RH: Emil auf keinem anderen Termin', '0',
  (select count(*)::text from public.job_assignments ja join public.jobs j on j.id = ja.job_id
    where j.parent_job_id = '71000000-0000-0000-0001-000000000002'
      and ja.employee_id = '71000000-0000-0000-0000-000000000002'
      and j.occurrence_date <> (select d1 from _d)));
select pg_temp.chk('H5', 'RH: neue Termine erben Zora', '0',
  (select count(*)::text from public.jobs j
    where j.parent_job_id = '71000000-0000-0000-0001-000000000002'
      and pg_temp.assignment(j.id, '71000000-0000-0000-0000-000000000003') is null));

-- =========================================================
-- B — Firma B ohne Fall: Abgleich unverändert
-- =========================================================
select pg_temp.act_as('71000000-0000-0000-0000-000000000011');
select pg_temp.chk('B1', 'Firma B: Ben entfernen + Abgleich', 'OK',
  pg_temp.msg('authenticated', $q$
    select public.set_job_assignments('71000000-0000-0000-0001-000000000003',
      array['71000000-0000-0000-0000-000000000012']::uuid[]);
    select public.update_job_occurrences('71000000-0000-0000-0001-000000000003')$q$));
select pg_temp.chk('B2', 'Firma B: Ben auf keinem Termin mehr, Bea überall', '0/0',
  (select (select count(*) from public.job_assignments ja join public.jobs j on j.id = ja.job_id
            where j.parent_job_id = '71000000-0000-0000-0001-000000000003'
              and ja.employee_id = '71000000-0000-0000-0000-000000000013')::text
       || '/' || (select count(*) from public.jobs j
            where j.parent_job_id = '71000000-0000-0000-0001-000000000003'
              and pg_temp.assignment(j.id, '71000000-0000-0000-0000-000000000012') is null)::text));

-- =========================================================
-- E — expliziter Admin-Eingriff scheitert weiterhin sichtbar
-- =========================================================
select pg_temp.act_as('71000000-0000-0000-0000-000000000001');
select pg_temp.chk('E1', 'set_job_assignments: Zora (approved) von O3 entfernen → klare 22023',
  '22023: Zuweisung hat einen abgeschlossenen Prüffall (Nachweis) und kann nicht entfernt werden.',
  (select pg_temp.msg('authenticated', format($q$select public.set_job_assignments(%L,
     array['71000000-0000-0000-0000-000000000004']::uuid[])$q$, o3)) from _o));
select pg_temp.chk('E2', 'set_job_assignments: Emil (offen) von O1 entfernen → Meldung unverändert',
  '22023: Zuweisung hat eine offene Nacharbeitung (Prüffall) und kann nicht entfernt werden.',
  (select pg_temp.msg('authenticated', format($q$select public.set_job_assignments(%L,
     array['71000000-0000-0000-0000-000000000004']::uuid[])$q$, o1)) from _o));
select pg_temp.chk('E3', 'Admin löscht Termin O4 (declined) → 22023, nichts gelöscht', '22023',
  (select left(pg_temp.msg('authenticated', format($q$delete from public.jobs where id = %L$q$, o4)), 5) from _o));
select pg_temp.chk('E4', 'nach E1–E3 alles unverändert', 'Ida,Zora|Emil,Ida|true',
  (select pg_temp.menge(o3) || '|' || pg_temp.menge(o1) || '|'
       || exists(select 1 from public.jobs where id = o4)::text from _o));

-- =========================================================
-- R — Idempotenz
-- =========================================================
create temp table _r_before as
select id, md5(row(j.*)::text) as h from public.jobs j
 where j.company_id = '71000000-0000-0000-0000-00000000000a';
create temp table _ra_before as
select ja.id from public.job_assignments ja join public.jobs j on j.id = ja.job_id
 where j.company_id = '71000000-0000-0000-0000-00000000000a';

select pg_temp.chk('R1', 'Abgleich 2x wiederholt: kein Fehler', 'OK',
  pg_temp.msg('authenticated', $q$
    select public.update_job_occurrences('71000000-0000-0000-0001-000000000001');
    select public.update_job_occurrences('71000000-0000-0000-0001-000000000001');
    update public.jobs set assigned_to = '71000000-0000-0000-0000-000000000004'
     where id::text like '71000000-0000-0000-0001-00000000010_'$q$));
select pg_temp.chk('R2', 'Aufträge (Zeilen-md5) und Zuweisungen identisch', 'jobs_diff=0/assign_diff=0',
  (select 'jobs_diff=' || (select count(*) from (
            (select id, h from _r_before)
            except (select id, md5(row(j.*)::text) from public.jobs j
                     where j.company_id = '71000000-0000-0000-0000-00000000000a')) x)::text
       || '/assign_diff=' || (select count(*) from (
            (select id from _ra_before)
            except (select ja.id from public.job_assignments ja join public.jobs j on j.id = ja.job_id
                     where j.company_id = '71000000-0000-0000-0000-00000000000a')) y)::text));

-- =========================================================
-- W — keine Nebenwirkung
-- =========================================================
select pg_temp.chk('W1', 'alle geschützten Zuweisungen vorhanden', '0',
  (select count(*)::text from _prot_before b
    where not exists (select 1 from public.job_assignments ja where ja.id = b.id)));
select pg_temp.chk('W2', 'Arbeitszeit/Anwesenheit/Status der geschützten Zeilen unverändert', '0',
  (select count(*)::text from _prot_before b
     join public.job_assignments ja on ja.id = b.id
     join public.jobs j on j.id = ja.job_id
    where ja.employee_started_at   is distinct from b.employee_started_at
       or ja.employee_completed_at is distinct from b.employee_completed_at
       or ja.attendance::text      is distinct from b.attendance
       or ja.work_revision         is distinct from b.work_revision
       or j.status::text           is distinct from b.status
       or j.started_at             is distinct from b.started_at
       or j.completed_at           is distinct from b.completed_at));
select pg_temp.chk('W3', 'Fall-Daten unverändert (Fingerprint, Anzahl Fälle/Events)', 'true/true/true',
  (select (public._work_recovery_fingerprint(public._work_recovery_export_doc('71000000-0000-0000-0000-00000000000a')) = fp)::text
       || '/' || ((select count(*) from public.work_recovery_cases) = n_cases)::text
       || '/' || ((select count(*) from public.work_recovery_events) = n_events)::text
     from _fp_before));
select pg_temp.chk('W4', 'kein Fall wurde geschlossen oder geändert (Zustände)', 'approved:2,declined:2,open:4,partially_approved:1,superseded:1',
  (select string_agg(state || ':' || n, ',' order by state) from (
     select state, count(*) n from public.work_recovery_cases
      where company_id = '71000000-0000-0000-0000-00000000000a' group by state) s));
select pg_temp.chk('W5', 'Invariante: assigned_to IS NULL oder durch Zuweisung gedeckt', '0',
  (select count(*)::text from public.jobs j
    where j.company_id in ('71000000-0000-0000-0000-00000000000a','71000000-0000-0000-0000-00000000000b')
      and j.assigned_to is not null
      and pg_temp.assignment(j.id, j.assigned_to) is null));
select pg_temp.chk('W6', 'keine doppelten (job_id, employee_id)', '0',
  (select count(*)::text from (
     select ja.job_id, ja.employee_id from public.job_assignments ja join public.jobs j on j.id = ja.job_id
      where j.company_id in ('71000000-0000-0000-0000-00000000000a','71000000-0000-0000-0000-00000000000b')
      group by 1, 2 having count(*) > 1) d));
select pg_temp.chk('W7', 'kein Auftrag der Firmen gestartet/abgeschlossen', '0',
  (select count(*)::text from public.jobs
    where company_id in ('71000000-0000-0000-0000-00000000000a','71000000-0000-0000-0000-00000000000b')
      and (status <> 'open' or started_at is not null or completed_at is not null)));

-- =========================================================
-- Ergebnis
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis, verdikt from _results order by case_no;

do $$
declare v_fail int; v_total int;
begin
  select count(*) filter (where verdikt = 'FAIL'), count(*) into v_fail, v_total from _results;
  raise notice 'work_recovery_sync_guards: % checks, % failed', v_total, v_fail;
  if v_fail > 0 then
    raise exception 'work_recovery_sync_guards: % of % checks FAILED', v_fail, v_total;
  end if;
end $$;

rollback;
