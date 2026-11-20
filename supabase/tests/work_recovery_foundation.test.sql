-- =========================================================
-- TEST: Work-Recovery-Fundament (Migration 20261120000000, Phase 3 / S1)
-- =========================================================
-- Deckt ab:
--   G  Kein Client-Zugriff: RLS an, keine Grants, kein EXECUTE auf die
--      neuen Funktionen für anon/authenticated
--   C  Konsistenz beim Einfügen (Firma/Auftrag/Zuweisung/Mitarbeiter,
--      Startzustand) und Zustands-Form (Begründung bei Ablehnung)
--   U  Eindeutigkeit: ein offener Fall je Zuweisung, viele Einreichungen,
--      Idempotenz der Einreichungs-ID, Aktions-ID je Mitarbeiter einmal
--   I  Append-only: Einreichungen/Referenzen/Events unveränderlich,
--      Fälle nur über das RPC-Flag, Purge-Flag erlaubt nur DELETE
--   F  Zuweisungs-/Auftragslöschung bei offenem Fall abgelehnt
--   S  set_job_assignments: offener Fall blockiert Entfernen, sonst unverändert
--   A  Konto-Löschung: Nachweise bleiben, Personen-Spalten werden NULL
--   D  profiles.deactivated_at (trigger-gepflegt, nicht schreibbar)
--   N  S1 ändert KEINE Anmeldung: Deaktivierung/Reaktivierung lassen
--      auth.sessions, auth.refresh_tokens und banned_until unverändert; kein
--      Trigger/keine Funktion der Migration schreibt ins auth-Schema
--      (Entzug von Zugangsdaten = eigenes, späteres Release)
--   W  Keine Nebenwirkung auf Arbeitszeit/Auftragsstatus
--   P  Firmen-Purge: offene Fälle blockieren, ohne Export-Bestätigung
--      blockiert (S1.5); danach löscht er alle Recovery-Daten der Firma,
--      fremde bleiben
--
-- AUSFÜHREN (lokal):
--   docker exec -i supabase_db_cleaning-employee-app-2 psql -U postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/work_recovery_foundation.test.sql
-- Endet mit ROLLBACK. Ergebnis: Tabelle (case_no | beschreibung | erwartet |
-- ergebnis | verdikt); jede FAIL-Zeile lässt scripts/ci/run-sql-tests.sh
-- scheitern, zusätzlich bricht ein abschließender Check mit Exception ab.
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

-- Führt SQL unter einer Rolle aus; liefert 'OK' oder den SQLSTATE.
create function pg_temp.st(p_role text, p_sql text) returns text
language plpgsql as $f$
begin
  execute format('set local role %I', p_role);
  execute p_sql;
  reset role;
  return 'OK';
exception when others then
  reset role;
  return sqlstate;
end $f$;

-- Wie st(), aber liefert bei Fehler 'SQLSTATE: Meldung'.
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
-- Firma A = 7a000000-0000-0000-0000-00000000000a, Firma B = 7b…-00000000000b
-- Personen 7a000000-0000-0000-0000-00000000000<n>
--   A: 1 Admin, 2 Emil, 3 Zora, 4 Ida  /  B: 1 Admin, 2 Bea
-- Aufträge 7?000000-0000-0000-0001-…, Zuweisungen …-0002-…, Fälle …-0003-…,
-- Einreichungen …-0004-…, Sessions (auth) …-0005-…
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000','7a000000-0000-0000-0000-000000000001','authenticated','authenticated','wr-admin-a@example.test'),
  ('00000000-0000-0000-0000-000000000000','7a000000-0000-0000-0000-000000000002','authenticated','authenticated','wr-emil@example.test'),
  ('00000000-0000-0000-0000-000000000000','7a000000-0000-0000-0000-000000000003','authenticated','authenticated','wr-zora@example.test'),
  ('00000000-0000-0000-0000-000000000000','7a000000-0000-0000-0000-000000000004','authenticated','authenticated','wr-ida@example.test'),
  ('00000000-0000-0000-0000-000000000000','7b000000-0000-0000-0000-000000000001','authenticated','authenticated','wr-admin-b@example.test'),
  ('00000000-0000-0000-0000-000000000000','7b000000-0000-0000-0000-000000000002','authenticated','authenticated','wr-bea@example.test');

-- Lokale Baselines ohne handle_new_user-Trigger (siehe Projekt-Memory).
insert into public.profiles (id, full_name) values
  ('7a000000-0000-0000-0000-000000000001','Anna Admin'),
  ('7a000000-0000-0000-0000-000000000002','Emil Eins'),
  ('7a000000-0000-0000-0000-000000000003','Zora Zwei'),
  ('7a000000-0000-0000-0000-000000000004','Ida Drei'),
  ('7b000000-0000-0000-0000-000000000001','Berta Admin'),
  ('7b000000-0000-0000-0000-000000000002','Bea Mitarbeiterin')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('7a000000-0000-0000-0000-00000000000a','WR Firma A','wr-firma-a'),
  ('7b000000-0000-0000-0000-00000000000b','WR Firma B','wr-firma-b');

update public.profiles p set role = v.role::public.app_role, company_id = v.company_id::uuid,
       is_active = true, full_name = v.n
from (values
  ('7a000000-0000-0000-0000-000000000001','admin',   '7a000000-0000-0000-0000-00000000000a','Anna Admin'),
  ('7a000000-0000-0000-0000-000000000002','employee','7a000000-0000-0000-0000-00000000000a','Emil Eins'),
  ('7a000000-0000-0000-0000-000000000003','employee','7a000000-0000-0000-0000-00000000000a','Zora Zwei'),
  ('7a000000-0000-0000-0000-000000000004','employee','7a000000-0000-0000-0000-00000000000a','Ida Drei'),
  ('7b000000-0000-0000-0000-000000000001','admin',   '7b000000-0000-0000-0000-00000000000b','Berta Admin'),
  ('7b000000-0000-0000-0000-000000000002','employee','7b000000-0000-0000-0000-00000000000b','Bea Mitarbeiterin')
) as v(id, role, company_id, n)
where p.id = v.id::uuid;

create function pg_temp.mk_job(p_job uuid, p_company uuid, p_admin uuid) returns void
language sql as $f$
  insert into public.jobs (id, company_id, created_by, customer_name, service_name,
                           location_address, status, job_type, date, start_time, is_active)
  values (p_job, p_company, p_admin, 'Kunde WR', 'Reinigung', 'Weg 1',
          'open', 'single', current_date, '08:00', true);
$f$;

create function pg_temp.mk_assignment(p_id uuid, p_job uuid, p_emp uuid, p_name text) returns void
language sql as $f$
  insert into public.job_assignments (id, job_id, employee_id, employee_name_snapshot)
  values (p_id, p_job, p_emp, p_name);
$f$;

-- Firma A: Auftrag J1 (Emil, Zora, Ida), Auftrag J2 (Emil), Auftrag J3 (Emil)
select pg_temp.mk_job('7a000000-0000-0000-0001-000000000001','7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0000-000000000001');
select pg_temp.mk_job('7a000000-0000-0000-0001-000000000002','7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0000-000000000001');
select pg_temp.mk_job('7a000000-0000-0000-0001-000000000003','7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0000-000000000001');
select pg_temp.mk_assignment('7a000000-0000-0000-0002-000000000001','7a000000-0000-0000-0001-000000000001','7a000000-0000-0000-0000-000000000002','Emil Eins');
select pg_temp.mk_assignment('7a000000-0000-0000-0002-000000000002','7a000000-0000-0000-0001-000000000001','7a000000-0000-0000-0000-000000000003','Zora Zwei');
select pg_temp.mk_assignment('7a000000-0000-0000-0002-000000000003','7a000000-0000-0000-0001-000000000001','7a000000-0000-0000-0000-000000000004','Ida Drei');
select pg_temp.mk_assignment('7a000000-0000-0000-0002-000000000004','7a000000-0000-0000-0001-000000000002','7a000000-0000-0000-0000-000000000002','Emil Eins');
select pg_temp.mk_assignment('7a000000-0000-0000-0002-000000000005','7a000000-0000-0000-0001-000000000003','7a000000-0000-0000-0000-000000000002','Emil Eins');
-- Firma B: Auftrag JB (Bea)
select pg_temp.mk_job('7b000000-0000-0000-0001-000000000001','7b000000-0000-0000-0000-00000000000b','7b000000-0000-0000-0000-000000000001');
select pg_temp.mk_assignment('7b000000-0000-0000-0002-000000000001','7b000000-0000-0000-0001-000000000001','7b000000-0000-0000-0000-000000000002','Bea Mitarbeiterin');

-- Ausgangszustand der Arbeitszeit/Status für die Nebenwirkungsprüfung (W).
create temp table _baseline as
select ja.id, ja.employee_started_at, ja.employee_completed_at, ja.attendance::text as attendance,
       ja.work_revision, j.status::text as status, j.started_at, j.completed_at
  from public.job_assignments ja join public.jobs j on j.id = ja.job_id
 where j.company_id in ('7a000000-0000-0000-0000-00000000000a','7b000000-0000-0000-0000-00000000000b');

-- ── Fixture-Fälle (als Tabelleneigentümer, wie später die RPCs) ─────────
-- K1: offener Fall auf Emil @ J1 (Zuweisung …0002-…01)
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source)
values ('7a000000-0000-0000-0003-000000000001','7a000000-0000-0000-0000-00000000000a',
        '7a000000-0000-0000-0001-000000000001','7a000000-0000-0000-0002-000000000001',
        '7a000000-0000-0000-0000-000000000002','legacy_queue');
-- KB: offener Fall Firma B
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source)
values ('7b000000-0000-0000-0003-000000000001','7b000000-0000-0000-0000-00000000000b',
        '7b000000-0000-0000-0001-000000000001','7b000000-0000-0000-0002-000000000001',
        '7b000000-0000-0000-0000-000000000002','legacy_queue');

create function pg_temp.mk_submission(p_id uuid, p_case uuid, p_company uuid, p_by uuid) returns void
language sql as $f$
  insert into public.work_recovery_submissions (id, case_id, company_id, submitted_by, claimed_ops,
                                                client_platform, client_build, failure_code,
                                                failure_message, request_hash)
  values (p_id, p_case, p_company, p_by,
          '[{"type":"start_job","timestamp":"2026-11-20T08:00:00Z"},{"type":"complete_job","timestamp":"2026-11-20T10:00:00Z"}]',
          'ios', '42', '22023', 'Auftrag bereits abgeschlossen', repeat('a', 64));
$f$;

select pg_temp.mk_submission('7a000000-0000-0000-0004-000000000001','7a000000-0000-0000-0003-000000000001',
  '7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0000-000000000002');
select pg_temp.mk_submission('7b000000-0000-0000-0004-000000000001','7b000000-0000-0000-0003-000000000001',
  '7b000000-0000-0000-0000-00000000000b','7b000000-0000-0000-0000-000000000002');

insert into public.work_recovery_action_refs (submission_id, company_id, employee_id, client_action_id)
values ('7a000000-0000-0000-0004-000000000001', null, null, '1732089600000-abc');

insert into public.work_recovery_events (case_id, company_id, event_type, actor_id, to_state)
values ('7a000000-0000-0000-0003-000000000001','7a000000-0000-0000-0000-00000000000a',
        'case_opened','7a000000-0000-0000-0000-000000000002','open'),
       ('7b000000-0000-0000-0003-000000000001','7b000000-0000-0000-0000-00000000000b',
        'case_opened','7b000000-0000-0000-0000-000000000002','open');

-- =========================================================
-- G — kein Client-Zugriff
-- =========================================================
select pg_temp.chk('G1', 'RLS auf allen 4 Recovery-Tabellen', '4',
  (select count(*)::text from pg_class
    where relnamespace = 'public'::regnamespace and relrowsecurity
      and relname in ('work_recovery_cases','work_recovery_submissions',
                      'work_recovery_action_refs','work_recovery_events')));

select pg_temp.chk('G2', 'keine Tabellen-Grants für anon/authenticated/service_role', '0',
  (select count(*)::text from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('work_recovery_cases','work_recovery_submissions',
                         'work_recovery_action_refs','work_recovery_events')
      and grantee in ('anon','authenticated','service_role','PUBLIC')));

select pg_temp.act_as('7a000000-0000-0000-0000-000000000001');
select pg_temp.chk('G3-' || r || '-' || t || '-' || op,
  'kein ' || op || ' auf ' || t || ' als ' || r, '42501',
  pg_temp.st(r, case op
    when 'select' then format('select 1 from public.%I limit 1', t)
    when 'delete' then format('delete from public.%I', t)
    when 'update' then format('update public.%I set company_id = company_id', t)
  end))
from unnest(array['anon','authenticated','service_role']) r,
     unnest(array['work_recovery_cases','work_recovery_submissions',
                  'work_recovery_action_refs','work_recovery_events']) t,
     unnest(array['select','update','delete']) op;

select pg_temp.chk('G4', 'kein INSERT eines Falls als authenticated (Admin A)', '42501',
  pg_temp.st('authenticated', $q$insert into public.work_recovery_cases
    (company_id, job_id, assignment_id, employee_id, source)
    values ('7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0001-000000000002',
            '7a000000-0000-0000-0002-000000000004','7a000000-0000-0000-0000-000000000002','legacy_queue')$q$));

select pg_temp.chk('G5', 'kein EXECUTE der neuen Funktionen für anon/authenticated', '0',
  (select count(*)::text
     from pg_proc p, unnest(array['anon','authenticated']) r
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('work_recovery_case_before_insert','work_recovery_submission_before_insert',
                        'work_recovery_action_ref_before_insert','work_recovery_event_before_insert',
                        'guard_work_recovery_append_only','guard_work_recovery_case_write',
                        'guard_assignment_open_recovery_case','set_profile_deactivated_at')
      and has_function_privilege(r, p.oid, 'EXECUTE')));

select pg_temp.chk('G6', 'keine neue Funktion ist SECURITY DEFINER (nur der unveränderte Purge)', '0',
  (select count(*)::text from pg_proc
    where pronamespace = 'public'::regnamespace and prosecdef
      and proname in ('work_recovery_case_before_insert','work_recovery_submission_before_insert',
                      'work_recovery_action_ref_before_insert','work_recovery_event_before_insert',
                      'guard_work_recovery_append_only','guard_work_recovery_case_write',
                      'guard_assignment_open_recovery_case','set_profile_deactivated_at')));

select pg_temp.chk('N1', 'kein Trigger auf profiles/job_assignments ruft eine Funktion mit auth-Schema-Schreibzugriff', '0',
  (select count(*)::text
     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid in ('public.profiles'::regclass, 'public.job_assignments'::regclass)
      and not t.tgisinternal
      and p.prosrc ~* '(delete\s+from|update|insert\s+into)\s+auth\.'));

select pg_temp.chk('N2', 'keine Funktion namens revoke_auth_access_on_profile_active_change', '0',
  (select count(*)::text from pg_proc where proname = 'revoke_auth_access_on_profile_active_change'));

-- =========================================================
-- C — Konsistenz und Zustands-Form
-- =========================================================
select pg_temp.chk('C1', 'Fall mit falscher Firma abgelehnt', '23514',
  pg_temp.st('postgres', $q$insert into public.work_recovery_cases
    (company_id, job_id, assignment_id, employee_id, source)
    values ('7b000000-0000-0000-0000-00000000000b','7a000000-0000-0000-0001-000000000002',
            '7a000000-0000-0000-0002-000000000004','7a000000-0000-0000-0000-000000000002','legacy_queue')$q$));

select pg_temp.chk('C2', 'Zuweisung eines anderen Auftrags abgelehnt', '23514',
  pg_temp.st('postgres', $q$insert into public.work_recovery_cases
    (company_id, job_id, assignment_id, employee_id, source)
    values ('7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0001-000000000002',
            '7a000000-0000-0000-0002-000000000002','7a000000-0000-0000-0000-000000000003','legacy_queue')$q$));

select pg_temp.chk('C3', 'Mitarbeiter passt nicht zur Zuweisung', '23514',
  pg_temp.st('postgres', $q$insert into public.work_recovery_cases
    (company_id, job_id, assignment_id, employee_id, source)
    values ('7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0001-000000000002',
            '7a000000-0000-0000-0002-000000000004','7a000000-0000-0000-0000-000000000003','legacy_queue')$q$));

select pg_temp.chk('C4', 'Fall darf nicht entschieden starten', '23514',
  pg_temp.st('postgres', $q$insert into public.work_recovery_cases
    (company_id, job_id, assignment_id, employee_id, source, state, decided_at)
    values ('7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0001-000000000002',
            '7a000000-0000-0000-0002-000000000004','7a000000-0000-0000-0000-000000000002','legacy_queue',
            'approved', now())$q$));

select pg_temp.chk('C5', 'unbekannte Quelle abgelehnt', '23514',
  pg_temp.st('postgres', $q$insert into public.work_recovery_cases
    (company_id, job_id, assignment_id, employee_id, source)
    values ('7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0001-000000000002',
            '7a000000-0000-0000-0002-000000000004','7a000000-0000-0000-0000-000000000002','auto_accept')$q$));

select pg_temp.chk('C6', 'claimed_ops muss ein nicht-leeres Array sein', '23514',
  pg_temp.st('postgres', $q$insert into public.work_recovery_submissions
    (id, case_id, company_id, submitted_by, claimed_ops, request_hash)
    values (gen_random_uuid(),'7a000000-0000-0000-0003-000000000001','7a000000-0000-0000-0000-00000000000a',
            '7a000000-0000-0000-0000-000000000002','{}', repeat('b',64))$q$));

select pg_temp.chk('C7', 'Einreichung mit falscher Firma abgelehnt', '23514',
  pg_temp.st('postgres', $q$insert into public.work_recovery_submissions
    (id, case_id, company_id, submitted_by, claimed_ops, request_hash)
    values (gen_random_uuid(),'7a000000-0000-0000-0003-000000000001','7b000000-0000-0000-0000-00000000000b',
            '7a000000-0000-0000-0000-000000000002','[{"type":"start_job"}]', repeat('b',64))$q$));

select pg_temp.chk('C8', 'Einreichung durch fremden Mitarbeiter abgelehnt', '23514',
  pg_temp.st('postgres', $q$insert into public.work_recovery_submissions
    (id, case_id, company_id, submitted_by, claimed_ops, request_hash)
    values (gen_random_uuid(),'7a000000-0000-0000-0003-000000000001','7a000000-0000-0000-0000-00000000000a',
            '7a000000-0000-0000-0000-000000000003','[{"type":"start_job"}]', repeat('b',64))$q$));

select pg_temp.chk('C9', 'Event mit falscher Firma abgelehnt', '23514',
  pg_temp.st('postgres', $q$insert into public.work_recovery_events (case_id, company_id, event_type)
    values ('7a000000-0000-0000-0003-000000000001','7b000000-0000-0000-0000-00000000000b','note_added')$q$));

select pg_temp.chk('C10', 'Aktions-Referenz: Firma/Mitarbeiter aus dem Fall abgeleitet', 'A/Emil',
  (select (case when company_id = '7a000000-0000-0000-0000-00000000000a' then 'A' else 'x' end)
          || '/' || (case when employee_id = '7a000000-0000-0000-0000-000000000002' then 'Emil' else 'x' end)
     from public.work_recovery_action_refs where client_action_id = '1732089600000-abc'));

select pg_temp.chk('C11', 'Geräte-Plattform nur ios/android', '23514',
  pg_temp.st('postgres', $q$insert into public.work_recovery_submissions
    (id, case_id, company_id, submitted_by, claimed_ops, client_platform, request_hash)
    values (gen_random_uuid(),'7a000000-0000-0000-0003-000000000001','7a000000-0000-0000-0000-00000000000a',
            '7a000000-0000-0000-0000-000000000002','[{"type":"start_job"}]','web', repeat('b',64))$q$));

-- =========================================================
-- U — Eindeutigkeit
-- =========================================================
select pg_temp.chk('U1', 'zweiter offener Fall derselben Zuweisung abgelehnt', '23505',
  pg_temp.st('postgres', $q$insert into public.work_recovery_cases
    (company_id, job_id, assignment_id, employee_id, source)
    values ('7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0001-000000000001',
            '7a000000-0000-0000-0002-000000000001','7a000000-0000-0000-0000-000000000002','work_journal')$q$));

select pg_temp.chk('U2', 'offene Fälle verschiedener Zuweisungen desselben Auftrags erlaubt', 'OK',
  pg_temp.st('postgres', $q$insert into public.work_recovery_cases
    (id, company_id, job_id, assignment_id, employee_id, source)
    values ('7a000000-0000-0000-0003-000000000002','7a000000-0000-0000-0000-00000000000a',
            '7a000000-0000-0000-0001-000000000001','7a000000-0000-0000-0002-000000000002',
            '7a000000-0000-0000-0000-000000000003','legacy_queue')$q$));

select pg_temp.mk_submission('7a000000-0000-0000-0004-000000000002','7a000000-0000-0000-0003-000000000001',
  '7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0000-000000000002');
select pg_temp.mk_submission('7a000000-0000-0000-0004-000000000003','7a000000-0000-0000-0003-000000000001',
  '7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0000-000000000002');
select pg_temp.chk('U3', 'mehrere Einreichungen je Fall', '3',
  (select count(*)::text from public.work_recovery_submissions
    where case_id = '7a000000-0000-0000-0003-000000000001'));

select pg_temp.chk('U4', 'doppelte Einreichungs-ID (Idempotenzschlüssel) abgelehnt', '23505',
  pg_temp.st('postgres', $q$select pg_temp.mk_submission('7a000000-0000-0000-0004-000000000001',
    '7a000000-0000-0000-0003-000000000001','7a000000-0000-0000-0000-00000000000a',
    '7a000000-0000-0000-0000-000000000002')$q$));

select pg_temp.chk('U5', 'dieselbe Client-Aktion desselben Mitarbeiters nur einmal', '23505',
  pg_temp.st('postgres', $q$insert into public.work_recovery_action_refs (submission_id, client_action_id)
    values ('7a000000-0000-0000-0004-000000000002','1732089600000-abc')$q$));

select pg_temp.mk_submission('7a000000-0000-0000-0004-000000000004','7a000000-0000-0000-0003-000000000002',
  '7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0000-000000000003');
select pg_temp.chk('U6', 'gleiche Aktions-ID eines ANDEREN Mitarbeiters blockiert nicht', 'OK',
  pg_temp.st('postgres', $q$insert into public.work_recovery_action_refs (submission_id, client_action_id)
    values ('7a000000-0000-0000-0004-000000000004','1732089600000-abc')$q$));

-- =========================================================
-- I — append-only / Zustandsänderungen
-- =========================================================
select pg_temp.chk('I1', 'Einreichung UPDATE abgelehnt (auch als Eigentümer)', '23514',
  pg_temp.st('postgres', $q$update public.work_recovery_submissions set failure_message = 'x'
    where id = '7a000000-0000-0000-0004-000000000001'$q$));
select pg_temp.chk('I2', 'Einreichung DELETE abgelehnt', '23514',
  pg_temp.st('postgres', $q$delete from public.work_recovery_submissions
    where id = '7a000000-0000-0000-0004-000000000003'$q$));
select pg_temp.chk('I3', 'Event UPDATE abgelehnt', '23514',
  pg_temp.st('postgres', $q$update public.work_recovery_events set to_state = 'approved'
    where case_id = '7a000000-0000-0000-0003-000000000001'$q$));
select pg_temp.chk('I4', 'Event DELETE abgelehnt', '23514',
  pg_temp.st('postgres', $q$delete from public.work_recovery_events
    where case_id = '7a000000-0000-0000-0003-000000000001'$q$));
select pg_temp.chk('I5', 'Aktions-Referenz UPDATE abgelehnt', '23514',
  pg_temp.st('postgres', $q$update public.work_recovery_action_refs set client_action_id = 'zzz'
    where client_action_id = '1732089600000-abc'$q$));
select pg_temp.chk('I6', 'Fall DELETE abgelehnt', '23514',
  pg_temp.st('postgres', $q$delete from public.work_recovery_cases
    where id = '7a000000-0000-0000-0003-000000000001'$q$));
select pg_temp.chk('I7', 'Fall-Zustand ohne RPC-Flag nicht änderbar', '23514',
  pg_temp.st('postgres', $q$update public.work_recovery_cases set state = 'approved', decided_at = now(),
    revision = revision + 1 where id = '7a000000-0000-0000-0003-000000000001'$q$));
select pg_temp.chk('I8', 'Personen-Spalte darf nicht auf eine ANDERE Person zeigen', '23514',
  pg_temp.st('postgres', $q$update public.work_recovery_submissions
    set submitted_by = '7a000000-0000-0000-0000-000000000003'
    where id = '7a000000-0000-0000-0004-000000000001'$q$));

-- Purge-Flag erlaubt NUR DELETE, kein UPDATE und keinen Client-Zugriff.
select set_config('taskops.company_purge', 'on', true);
select pg_temp.chk('I9', 'Purge-Flag erlaubt kein UPDATE einer Einreichung', '23514',
  pg_temp.st('postgres', $q$update public.work_recovery_submissions set failure_message = 'x'
    where id = '7a000000-0000-0000-0004-000000000001'$q$));
select pg_temp.chk('I10', 'Purge-Flag hilft authenticated nicht (keine Grants)', '42501',
  pg_temp.st('authenticated', $q$delete from public.work_recovery_events$q$));
select set_config('taskops.company_purge', '', true);

-- Mit RPC-Flag (wie künftige Resolve-RPCs): Regeln greifen weiterhin.
select set_config('taskops.work_recovery_rpc', 'on', true);
select pg_temp.chk('I11', 'Revision muss genau um 1 steigen', '23514',
  pg_temp.st('postgres', $q$update public.work_recovery_cases set state = 'under_review'
    where id = '7a000000-0000-0000-0003-000000000002'$q$));
select pg_temp.chk('I12', 'Identität (Zuweisung) unveränderlich', '23514',
  pg_temp.st('postgres', $q$update public.work_recovery_cases
    set assignment_id = '7a000000-0000-0000-0002-000000000003', revision = revision + 1
    where id = '7a000000-0000-0000-0003-000000000002'$q$));
select pg_temp.chk('I13', 'Ablehnung ohne Begründung für den Mitarbeiter verletzt Zustands-Form', '23514',
  pg_temp.st('postgres', $q$update public.work_recovery_cases
    set state = 'declined', decided_at = now(), revision = revision + 1
    where id = '7a000000-0000-0000-0003-000000000002'$q$));
select pg_temp.chk('I14', 'Ablehnung mit Begründung erlaubt', 'OK',
  pg_temp.st('postgres', $q$update public.work_recovery_cases
    set state = 'declined', decided_at = now(), decided_by = '7a000000-0000-0000-0000-000000000001',
        employee_message = 'Kein Nachweis für diesen Einsatz.', revision = revision + 1
    where id = '7a000000-0000-0000-0003-000000000002'$q$));
select pg_temp.chk('I15', 'entschiedener Fall ist endgültig', '23514',
  pg_temp.st('postgres', $q$update public.work_recovery_cases
    set state = 'approved', revision = revision + 1
    where id = '7a000000-0000-0000-0003-000000000002'$q$));
select set_config('taskops.work_recovery_rpc', '', true);

select pg_temp.chk('I16', 'Einreichung zu entschiedenem Fall abgelehnt', '23514',
  pg_temp.st('postgres', $q$select pg_temp.mk_submission(gen_random_uuid(),
    '7a000000-0000-0000-0003-000000000002','7a000000-0000-0000-0000-00000000000a',
    '7a000000-0000-0000-0000-000000000003')$q$));

select pg_temp.chk('I17', 'nach Entscheidung: neuer offener Fall für dieselbe Zuweisung möglich', 'OK',
  pg_temp.st('postgres', $q$insert into public.work_recovery_cases
    (company_id, job_id, assignment_id, employee_id, source)
    values ('7a000000-0000-0000-0000-00000000000a','7a000000-0000-0000-0001-000000000001',
            '7a000000-0000-0000-0002-000000000002','7a000000-0000-0000-0000-000000000003','legacy_queue')$q$));

-- =========================================================
-- F — Löschschutz
-- =========================================================
select pg_temp.chk('F1', 'Zuweisung mit offenem Fall nicht löschbar (klare Meldung)',
  '22023: Zuweisung hat eine offene Nacharbeitung (Prüffall) und kann nicht entfernt werden.',
  pg_temp.msg('postgres', $q$delete from public.job_assignments
    where id = '7a000000-0000-0000-0002-000000000001'$q$));

select pg_temp.act_as('7a000000-0000-0000-0000-000000000001');
select pg_temp.chk('F2', 'Admin kann Auftrag mit offenem Fall nicht löschen', '22023',
  pg_temp.st('authenticated', $q$delete from public.jobs
    where id = '7a000000-0000-0000-0001-000000000001'$q$));
select pg_temp.chk('F3', 'Auftrag + Zuweisung + Fall danach unverändert vorhanden', '1/3/1',
  (select (select count(*) from public.jobs where id = '7a000000-0000-0000-0001-000000000001')::text
       || '/' || (select count(*) from public.job_assignments where job_id = '7a000000-0000-0000-0001-000000000001')::text
       || '/' || (select count(*) from public.work_recovery_cases where id = '7a000000-0000-0000-0003-000000000001')::text));

-- Zuweisung von Zora trägt nur noch einen ENTSCHIEDENEN Fall (K2) + einen
-- offenen (I17). Ida hat keinen Fall; Auftrag J3 ohne Fall bleibt löschbar.
select pg_temp.chk('F4', 'Auftrag ohne Fall bleibt für den Admin löschbar', 'OK',
  pg_temp.st('authenticated', $q$delete from public.jobs
    where id = '7a000000-0000-0000-0001-000000000003'$q$));

-- =========================================================
-- S — set_job_assignments (Admin A, authenticated)
-- =========================================================
select pg_temp.chk('S1', 'Entfernen eines Mitarbeiters mit offenem Fall abgelehnt',
  '22023: Zuweisung hat eine offene Nacharbeitung (Prüffall) und kann nicht entfernt werden.',
  pg_temp.msg('authenticated', $q$select * from public.set_job_assignments(
    '7a000000-0000-0000-0001-000000000001',
    array['7a000000-0000-0000-0000-000000000003','7a000000-0000-0000-0000-000000000004']::uuid[])$q$));
select pg_temp.chk('S2', 'nach S1: alle drei Zuweisungen noch da', '3',
  (select count(*)::text from public.job_assignments where job_id = '7a000000-0000-0000-0001-000000000001'));

-- Zoras offener Fall (I17) blockiert ebenfalls — beide behalten, Ida entfernen.
select pg_temp.chk('S3', 'Entfernen eines Mitarbeiters OHNE Fall weiterhin möglich', 'OK',
  pg_temp.msg('authenticated', $q$select * from public.set_job_assignments(
    '7a000000-0000-0000-0001-000000000001',
    array['7a000000-0000-0000-0000-000000000002','7a000000-0000-0000-0000-000000000003']::uuid[])$q$));
select pg_temp.chk('S4', 'nach S3: Ida entfernt, Emil + Zora unverändert', 'Emil Eins,Zora Zwei',
  (select string_agg(employee_name_snapshot, ',' order by employee_name_snapshot)
     from public.job_assignments where job_id = '7a000000-0000-0000-0001-000000000001'));

-- Bestehende Regel "bereits gestartet" bleibt unverändert (J2, Emil, ohne Fall).
update public.job_assignments set employee_started_at = now() - interval '1 hour', attendance = 'started'
 where id = '7a000000-0000-0000-0002-000000000004';
update _baseline b set employee_started_at = ja.employee_started_at, attendance = ja.attendance::text,
       work_revision = ja.work_revision
  from public.job_assignments ja where ja.id = b.id and b.id = '7a000000-0000-0000-0002-000000000004';
update _baseline b set status = j.status::text, started_at = j.started_at
  from public.jobs j where j.id = '7a000000-0000-0000-0001-000000000002'
   and b.id = '7a000000-0000-0000-0002-000000000004';
select pg_temp.chk('S5', 'gestarteter Mitarbeiter ohne Fall: bisherige 22023-Regel unverändert', '22023',
  pg_temp.st('authenticated', $q$select * from public.set_job_assignments(
    '7a000000-0000-0000-0001-000000000002',
    array['7a000000-0000-0000-0000-000000000003']::uuid[])$q$));

select pg_temp.act_as('7b000000-0000-0000-0000-000000000001');
select pg_temp.chk('S6', 'fremder Admin (Firma B) kann Firma-A-Zuweisungen nicht ändern', '42501',
  pg_temp.st('authenticated', $q$select * from public.set_job_assignments(
    '7a000000-0000-0000-0001-000000000001',
    array['7a000000-0000-0000-0000-000000000003']::uuid[])$q$));

-- =========================================================
-- W — keine Nebenwirkung auf Arbeitszeit/Auftragsstatus
-- =========================================================
select pg_temp.chk('W1', 'Arbeitszeit/Status aller verbleibenden Zuweisungen unverändert', '0',
  (select count(*)::text
     from _baseline b
     join public.job_assignments ja on ja.id = b.id
     join public.jobs j on j.id = ja.job_id
    where ja.employee_started_at is distinct from b.employee_started_at
       or ja.employee_completed_at is distinct from b.employee_completed_at
       or ja.attendance::text is distinct from b.attendance
       or ja.work_revision is distinct from b.work_revision
       or j.status::text is distinct from b.status
       or j.started_at is distinct from b.started_at
       or j.completed_at is distinct from b.completed_at));
select pg_temp.chk('W2', 'keine Zeit-Anpassungen/Sessions durch Recovery-Zeilen erzeugt', '0/0',
  (select (select count(*) from public.employee_time_adjustments ea
             join public.jobs j on j.id = ea.job_id
            where j.company_id in ('7a000000-0000-0000-0000-00000000000a','7b000000-0000-0000-0000-00000000000b'))::text
       || '/' || (select count(*) from public.work_sessions ws
             join public.job_assignments ja on ja.id = ws.job_assignment_id
             join public.jobs j on j.id = ja.job_id
            where j.company_id in ('7a000000-0000-0000-0000-00000000000a','7b000000-0000-0000-0000-00000000000b'))::text));

-- =========================================================
-- D / N — Deaktivierung (ohne Eingriff in die Anmeldung)
-- =========================================================
-- Sessions + Refresh-Tokens für Zora (wird deaktiviert) und Ida (bleibt aktiv).
insert into auth.sessions (id, user_id, created_at) values
  ('7a000000-0000-0000-0005-000000000001','7a000000-0000-0000-0000-000000000003', now()),
  ('7a000000-0000-0000-0005-000000000002','7a000000-0000-0000-0000-000000000003', now()),
  ('7a000000-0000-0000-0005-000000000003','7a000000-0000-0000-0000-000000000004', now());
insert into auth.refresh_tokens (token, user_id, session_id, revoked, created_at) values
  ('wr-tok-zora-1','7a000000-0000-0000-0000-000000000003','7a000000-0000-0000-0005-000000000001', false, now()),
  ('wr-tok-zora-2','7a000000-0000-0000-0000-000000000003','7a000000-0000-0000-0005-000000000002', false, now()),
  ('wr-tok-zora-legacy','7a000000-0000-0000-0000-000000000003', null, false, now()),
  ('wr-tok-ida-1','7a000000-0000-0000-0000-000000000004','7a000000-0000-0000-0005-000000000003', false, now());

select pg_temp.chk('D0', 'aktives Konto: deactivated_at NULL', '<null>',
  (select deactivated_at::text from public.profiles where id = '7a000000-0000-0000-0000-000000000003'));

-- Admin A deaktiviert Zora — wie die App: direktes UPDATE als authenticated.
select pg_temp.act_as('7a000000-0000-0000-0000-000000000001');
select pg_temp.chk('D1', 'Admin deaktiviert Mitarbeiterin (authenticated, RLS-Pfad)', 'OK',
  pg_temp.msg('authenticated', $q$update public.profiles set is_active = false
    where id = '7a000000-0000-0000-0000-000000000003'$q$));
select pg_temp.chk('D2', 'deactivated_at gesetzt (= jetzt)', 'true',
  (select (deactivated_at = now())::text from public.profiles where id = '7a000000-0000-0000-0000-000000000003'));

select pg_temp.chk('N3', 'Deaktivierung lässt Sessions + Refresh-Tokens (inkl. Legacy) unverändert', '2/3',
  (select (select count(*) from auth.sessions where user_id = '7a000000-0000-0000-0000-000000000003')::text
       || '/' || (select count(*) from auth.refresh_tokens where user_id = '7a000000-0000-0000-0000-000000000003')::text));
select pg_temp.chk('N4', 'Deaktivierung setzt keine Anmeldesperre (banned_until bleibt NULL)', '<null>',
  (select banned_until::text from auth.users where id = '7a000000-0000-0000-0000-000000000003'));
select pg_temp.chk('N5', 'andere Nutzer unberührt (Ida: Session, Token, keine Sperre)', '1/1/<null>',
  (select (select count(*) from auth.sessions where user_id = '7a000000-0000-0000-0000-000000000004')::text
       || '/' || (select count(*) from auth.refresh_tokens where user_id = '7a000000-0000-0000-0000-000000000004')::text
       || '/' || coalesce((select banned_until::text from auth.users where id = '7a000000-0000-0000-0000-000000000004'), '<null>')));

-- Wert bleibt bei weiteren Änderungen stabil (auch nicht direkt schreibbar).
update public.profiles set deactivated_at = '2000-01-01', full_name = 'Zora Zwei'
 where id = '7a000000-0000-0000-0000-000000000003';
select pg_temp.chk('D3', 'direkt geschriebenes deactivated_at wird ignoriert', 'true',
  (select (deactivated_at = now())::text from public.profiles where id = '7a000000-0000-0000-0000-000000000003'));
select pg_temp.chk('D4', 'false → false ändert deactivated_at nicht', 'true',
  (select pg_temp.st('postgres', $q$update public.profiles set is_active = false
       where id = '7a000000-0000-0000-0000-000000000003'$q$) = 'OK'
      and (select deactivated_at = now() from public.profiles where id = '7a000000-0000-0000-0000-000000000003'))::text);
update public.profiles set deactivated_at = now()
 where id = '7a000000-0000-0000-0000-000000000004';
select pg_temp.chk('D5', 'aktives Konto: direkt geschriebenes deactivated_at bleibt NULL', '<null>',
  (select deactivated_at::text from public.profiles where id = '7a000000-0000-0000-0000-000000000004'));

-- Mitarbeiter versucht, sein eigenes deactivated_at zu setzen.
select pg_temp.act_as('7a000000-0000-0000-0000-000000000004');
select pg_temp.st('authenticated', $q$update public.profiles set deactivated_at = now()
   where id = '7a000000-0000-0000-0000-000000000004'$q$);
select pg_temp.chk('D6', 'Mitarbeiter kann eigenes deactivated_at nicht setzen', '<null>',
  (select deactivated_at::text from public.profiles where id = '7a000000-0000-0000-0000-000000000004'));

-- Reaktivierung durch Admin A.
select pg_temp.act_as('7a000000-0000-0000-0000-000000000001');
select pg_temp.chk('D7', 'Admin reaktiviert', 'OK',
  pg_temp.msg('authenticated', $q$update public.profiles set is_active = true
    where id = '7a000000-0000-0000-0000-000000000003'$q$));
select pg_temp.chk('N6', 'Reaktivierung: keine Sperre, deactivated_at NULL, Sessions unverändert', '<null>/<null>/2',
  (select coalesce((select banned_until::text from auth.users where id = '7a000000-0000-0000-0000-000000000003'), '<null>')
       || '/' || coalesce((select deactivated_at::text from public.profiles where id = '7a000000-0000-0000-0000-000000000003'), '<null>')
       || '/' || (select count(*) from auth.sessions where user_id = '7a000000-0000-0000-0000-000000000003')::text));

select pg_temp.act_as('7a000000-0000-0000-0000-000000000004');
select pg_temp.chk('D8', 'Mitarbeiter kann keinen Kollegen deaktivieren', 'false',
  (select pg_temp.st('authenticated', $q$update public.profiles set is_active = false
       where id = '7a000000-0000-0000-0000-000000000003'$q$) is not null
      and (select is_active from public.profiles where id = '7a000000-0000-0000-0000-000000000003') = false)::text);

-- =========================================================
-- A — Konto-Löschung eines Mitarbeiters mit Nachweisen (Emil)
-- =========================================================
select pg_temp.chk('A1', 'Konto mit offenem Fall + Einreichungen + Events löschbar', 'OK',
  pg_temp.msg('postgres', $q$delete from auth.users where id = '7a000000-0000-0000-0000-000000000002'$q$));
select pg_temp.chk('A2', 'Nachweise bleiben, Personen-Spalten NULL (Fall/Einreichung/Referenz/Event)', '1:null/3:null/1:null/1:null',
  (select (select count(*)::text || ':' || coalesce(max(employee_id::text), 'null')
             from public.work_recovery_cases where id = '7a000000-0000-0000-0003-000000000001')
       || '/' || (select count(*)::text || ':' || coalesce(max(submitted_by::text), 'null')
             from public.work_recovery_submissions where case_id = '7a000000-0000-0000-0003-000000000001')
       || '/' || (select count(*)::text || ':' || coalesce(max(r.employee_id::text), 'null')
             from public.work_recovery_action_refs r
            where r.submission_id = '7a000000-0000-0000-0004-000000000001')
       || '/' || (select count(*)::text || ':' || coalesce(max(actor_id::text), 'null')
             from public.work_recovery_events where case_id = '7a000000-0000-0000-0003-000000000001')));

-- =========================================================
-- P — Firmen-Purge
-- =========================================================
-- Seit S1.5 (20261121000000): offene Fälle blockieren, danach ist eine
-- aktuelle Export-Bestätigung Pflicht. Ausführlich:
-- supabase/tests/work_recovery_deletion_safety.test.sql
select pg_temp.chk('P0a', 'Purge Firma A mit offenen Fällen blockiert', 'P0001: open_recovery_cases',
  (select pg_temp.msg('postgres', $q$select public.purge_company_for_last_admin(
     '7a000000-0000-0000-0000-000000000001','7a000000-0000-0000-0000-00000000000a')$q$)));
select set_config('taskops.work_recovery_rpc', 'on', true);
update public.work_recovery_cases
   set state = 'approved', decided_at = now(), revision = revision + 1
 where company_id = '7a000000-0000-0000-0000-00000000000a'
   and state in ('open', 'under_review');
select set_config('taskops.work_recovery_rpc', '', true);
select pg_temp.chk('P0b', 'ohne Export-Bestätigung blockiert', 'P0001: recovery_export_required',
  (select pg_temp.msg('postgres', $q$select public.purge_company_for_last_admin(
     '7a000000-0000-0000-0000-000000000001','7a000000-0000-0000-0000-00000000000a')$q$)));
select pg_temp.act_as('7a000000-0000-0000-0000-000000000001');
create temp table _p_export as select public.get_company_recovery_export() as r;
select public.acknowledge_company_recovery_export((select (r ->> 'export_id')::uuid from _p_export));
select pg_temp.chk('P1', 'Purge Firma A (letzter Admin, Fälle entschieden, Export bestätigt) gelingt', 'OK',
  (select pg_temp.msg('postgres', $q$select public.purge_company_for_last_admin(
     '7a000000-0000-0000-0000-000000000001','7a000000-0000-0000-0000-00000000000a')$q$)));
select pg_temp.chk('P2', 'keine Recovery-Zeilen von Firma A übrig', '0/0/0/0',
  (select (select count(*) from public.work_recovery_cases where company_id = '7a000000-0000-0000-0000-00000000000a')::text
       || '/' || (select count(*) from public.work_recovery_submissions where company_id = '7a000000-0000-0000-0000-00000000000a')::text
       || '/' || (select count(*) from public.work_recovery_action_refs where company_id = '7a000000-0000-0000-0000-00000000000a')::text
       || '/' || (select count(*) from public.work_recovery_events where company_id = '7a000000-0000-0000-0000-00000000000a')::text));
select pg_temp.chk('P3', 'Firma B unverändert (Fall/Einreichung/Event)', '1/1/1',
  (select (select count(*) from public.work_recovery_cases where company_id = '7b000000-0000-0000-0000-00000000000b')::text
       || '/' || (select count(*) from public.work_recovery_submissions where company_id = '7b000000-0000-0000-0000-00000000000b')::text
       || '/' || (select count(*) from public.work_recovery_events where company_id = '7b000000-0000-0000-0000-00000000000b')::text));
select pg_temp.chk('P4', 'Purge-Flag nach dem Purge wieder leer', '',
  coalesce(current_setting('taskops.company_purge', true), ''));

-- =========================================================
-- Ergebnis
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis, verdikt from _results order by case_no;

do $$
declare v_fail int; v_total int;
begin
  select count(*) filter (where verdikt = 'FAIL'), count(*) into v_fail, v_total from _results;
  raise notice 'work_recovery_foundation: % checks, % failed', v_total, v_fail;
  if v_fail > 0 then
    raise exception 'work_recovery_foundation: % of % checks FAILED', v_fail, v_total;
  end if;
end $$;

rollback;
