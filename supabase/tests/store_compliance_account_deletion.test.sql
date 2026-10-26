-- =========================================================
-- TEST: Store-Compliance-Kontolöschung
-- (Migration 20261026000000_store_compliance_account_deletion)
-- =========================================================
-- Deckt ab:
--   1  Mitarbeiter-Löschung (normaler Pfad): Profil weg, Firma bleibt
--   2  Snapshots: notification_outbox trägt danach "Gelöschtes Konto";
--      job_assignments/employee_absences BEHALTEN den Namens-Snapshot
--      (Arbeitszeit-/Abwesenheitsnachweis, Aufzeichnungspflicht) — die
--      Lösch-UI sagt das ausdrücklich; Kommentar-Autor NULL
--   3  get_account_deletion_context(): Solo-Admin = letzter Admin,
--      Duo-Admin = nicht letzter Admin, Mitarbeiter = nie letzter Admin
--   4  Zwei Admins: Purge wird mit not_last_admin abgelehnt, nichts gelöscht
--   5  Gefälschte Firmen-ID (fremder Mandant): company_mismatch, beide
--      Mandanten unverändert
--   6  Letzter Admin: Purge löscht Firma, Aufträge (inkl. Dauerauftrag mit
--      abgeschlossenem Termin), Zuweisungen, Arbeitszeit (Sessions/
--      Korrekturen/Receipts), Abwesenheiten, AU-Nachweise, Urlaub,
--      Kommentare, Foto-Zeilen, Outbox, ALLE Konten der Firma (auth +
--      profiles, auch inaktive) und liefert die Storage-Pfade zurück
--   7  Fremde Mandanten bleiben nach dem Purge vollständig erhalten
--   8  Wiederholter Purge: profile_not_found (kein Teil-Effekt)
--   9  authenticated darf purge_company_for_last_admin NICHT ausführen
--  10  Ohne Purge-Flag bleiben die Guards scharf
--  11  Mitarbeiter-Löschung mit aufgezeichneter Arbeitszeit: Session-Zeilen
--      bleiben (Betriebsdaten), Zuweisung anonymisiert
--  12  Nicht-Admin / inaktiver Admin können den Purge nicht auslösen
--
-- AUSFÜHREN (lokal):
--   docker exec -i supabase_db_cleaning-employee-app-2 psql -U postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/store_compliance_account_deletion.test.sql
-- oder komplett im Supabase SQL Editor. Endet mit ROLLBACK — keine Testdaten
-- bleiben zurück. Ergebnis: Tabelle (case_no | beschreibung | erwartet |
-- ergebnis | verdikt) + Zeile "TOTAL".
-- =========================================================

begin;

create temp table _results (
  case_no int, beschreibung text, erwartet text, ergebnis text, verdikt text
);

create function pg_temp.chk(n int, d text, e text, r text) returns void
language sql as $f$
  insert into _results values (n, d, e, coalesce(r,'<null>'),
    case when e = coalesce(r,'<null>') then 'PASS' else 'FAIL' end);
$f$;

create function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role','authenticated')::text, true);
end $f$;

-- Führt den Purge aus und liefert 'OK' oder den Fehlertext.
create function pg_temp.purge(p_caller uuid, p_company uuid) returns text
language plpgsql as $f$
begin
  perform public.purge_company_for_last_admin(p_caller, p_company);
  return 'OK';
exception when others then
  return sqlerrm;
end $f$;

-- ── IDs ──────────────────────────────────────────────────
-- Firma A (Solo-Admin + 2 Mitarbeiter, einer inaktiv) = 5a000000-…-00000000000a
-- Firma B (2 Admins + 1 Mitarbeiter)                 = 5b000000-…-00000000000b
-- Firma C (fremder Mandant, Solo-Admin, unbeteiligt)  = 5c000000-…-00000000000c
-- Firma D (inaktiver Admin + aktiver Admin)           = 5d000000-…-00000000000d
-- Personen: <firma>000000-0000-0000-0000-00000000000<n>
-- Aufträge: <firma>000000-0000-0000-0001-00000000000<n>
-- Zuweisungen: <firma>000000-0000-0000-0002-…, Sessions: …-0003-…
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000','5a000000-0000-0000-0000-000000000001','authenticated','authenticated','sc-admin-a@example.test'),
  ('00000000-0000-0000-0000-000000000000','5a000000-0000-0000-0000-000000000002','authenticated','authenticated','sc-emp-a1@example.test'),
  ('00000000-0000-0000-0000-000000000000','5a000000-0000-0000-0000-000000000003','authenticated','authenticated','sc-emp-a2@example.test'),
  ('00000000-0000-0000-0000-000000000000','5b000000-0000-0000-0000-000000000001','authenticated','authenticated','sc-admin-b1@example.test'),
  ('00000000-0000-0000-0000-000000000000','5b000000-0000-0000-0000-000000000002','authenticated','authenticated','sc-admin-b2@example.test'),
  ('00000000-0000-0000-0000-000000000000','5b000000-0000-0000-0000-000000000003','authenticated','authenticated','sc-emp-b@example.test'),
  ('00000000-0000-0000-0000-000000000000','5c000000-0000-0000-0000-000000000001','authenticated','authenticated','sc-admin-c@example.test'),
  ('00000000-0000-0000-0000-000000000000','5d000000-0000-0000-0000-000000000001','authenticated','authenticated','sc-admin-d1@example.test'),
  ('00000000-0000-0000-0000-000000000000','5d000000-0000-0000-0000-000000000002','authenticated','authenticated','sc-admin-d2@example.test');

-- Lokale Baselines ohne handle_new_user-Trigger (siehe Projekt-Memory).
insert into public.profiles (id, full_name) values
  ('5a000000-0000-0000-0000-000000000001','Anna Admin'),
  ('5a000000-0000-0000-0000-000000000002','Emil Eins'),
  ('5a000000-0000-0000-0000-000000000003','Zora Zwei'),
  ('5b000000-0000-0000-0000-000000000001','Berta Admin'),
  ('5b000000-0000-0000-0000-000000000002','Bodo Admin'),
  ('5b000000-0000-0000-0000-000000000003','Bea Mitarbeiterin'),
  ('5c000000-0000-0000-0000-000000000001','Carl Admin'),
  ('5d000000-0000-0000-0000-000000000001','Dora Inaktiv'),
  ('5d000000-0000-0000-0000-000000000002','Dirk Aktiv')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('5a000000-0000-0000-0000-00000000000a','SC Firma A','sc-firma-a'),
  ('5b000000-0000-0000-0000-00000000000b','SC Firma B','sc-firma-b'),
  ('5c000000-0000-0000-0000-00000000000c','SC Firma C','sc-firma-c'),
  ('5d000000-0000-0000-0000-00000000000d','SC Firma D','sc-firma-d');

update public.profiles p set role = v.role::public.app_role, company_id = v.company_id::uuid, is_active = v.active
from (values
  ('5a000000-0000-0000-0000-000000000001','admin',   '5a000000-0000-0000-0000-00000000000a', true),
  ('5a000000-0000-0000-0000-000000000002','employee','5a000000-0000-0000-0000-00000000000a', true),
  ('5a000000-0000-0000-0000-000000000003','employee','5a000000-0000-0000-0000-00000000000a', true),
  ('5b000000-0000-0000-0000-000000000001','admin',   '5b000000-0000-0000-0000-00000000000b', true),
  ('5b000000-0000-0000-0000-000000000002','admin',   '5b000000-0000-0000-0000-00000000000b', true),
  ('5b000000-0000-0000-0000-000000000003','employee','5b000000-0000-0000-0000-00000000000b', true),
  ('5c000000-0000-0000-0000-000000000001','admin',   '5c000000-0000-0000-0000-00000000000c', true),
  ('5d000000-0000-0000-0000-000000000001','admin',   '5d000000-0000-0000-0000-00000000000d', false),
  ('5d000000-0000-0000-0000-000000000002','admin',   '5d000000-0000-0000-0000-00000000000d', true)
) as v(id, role, company_id, active)
where p.id = v.id::uuid;

-- ── Fixture-Helfer: Auftrag + Zuweisung (+ optional Session-Arbeitszeit) ──
create function pg_temp.job_with_assignment(
  p_job uuid, p_company uuid, p_admin uuid, p_assignment uuid,
  p_employee uuid, p_name text, p_session uuid default null
) returns void language plpgsql as $f$
begin
  insert into public.jobs (id, company_id, created_by, customer_name, service_name,
                           location_address, status, job_type, date, start_time, is_active)
  values (p_job, p_company, p_admin, 'Kunde '||p_name, 'Reinigung', 'Weg 1',
          'open', 'single', current_date, '08:00', true);
  insert into public.job_assignments (id, job_id, employee_id, employee_name_snapshot)
  values (p_assignment, p_job, p_employee, p_name);
  if p_session is not null then
    perform set_config('taskops.work_session_rpc','on',true);
    update public.job_assignments set time_tracking_mode='sessions' where id=p_assignment;
    update public.job_assignments
       set employee_started_at = now() - interval '2 hours', attendance='started'
     where id=p_assignment;
    insert into public.work_sessions (id, job_assignment_id, employee_id, started_at, ended_at)
    values (p_session, p_assignment, p_employee, now() - interval '2 hours', now() - interval '1 hour');
    perform set_config('taskops.work_session_rpc','off',true);
  end if;
end $f$;

-- Firma A: voller Datenbestand
select pg_temp.job_with_assignment(
  '5a000000-0000-0000-0001-000000000001','5a000000-0000-0000-0000-00000000000a',
  '5a000000-0000-0000-0000-000000000001','5a000000-0000-0000-0002-000000000001',
  '5a000000-0000-0000-0000-000000000002','Emil Eins','5a000000-0000-0000-0003-000000000001');

insert into public.session_time_corrections (correction_id, work_session_id, job_assignment_id, job_id,
  employee_id, revision_no, origin, raw_started_at, raw_ended_at, raw_duration_seconds,
  effective_started_at, effective_ended_at, effective_duration_seconds, performed_by, reason)
values ('5a000000-0000-0000-0004-000000000001','5a000000-0000-0000-0003-000000000001',
  '5a000000-0000-0000-0002-000000000001','5a000000-0000-0000-0001-000000000001',
  '5a000000-0000-0000-0000-000000000002', 1, 'admin_reduced',
  now() - interval '2 hours', now() - interval '1 hour', 3600,
  now() - interval '2 hours', now() - interval '90 minutes', 1800,
  '5a000000-0000-0000-0000-000000000001', 'Test-Korrektur');

insert into public.work_operation_receipts (operation_id, actor_id, job_assignment_id,
  operation_type, request_payload, result_payload)
values ('5a000000-0000-0000-0005-000000000001','5a000000-0000-0000-0000-000000000002',
  '5a000000-0000-0000-0002-000000000001','start','{}','{}');

-- Dauerauftrag-Regel mit abgeschlossenem Termin (protect_recurring_job_history)
insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                         status, job_type, start_time, recurring_days, is_active)
values ('5a000000-0000-0000-0001-000000000002','5a000000-0000-0000-0000-00000000000a',
        '5a000000-0000-0000-0000-000000000001','Kunde Regel','Reinigung','Weg 2',
        'open','recurring','09:00', array['mon','tue','wed','thu','fri','sat','sun'], true);
insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                         status, job_type, date, start_time, is_active, parent_job_id,
                         started_at, completed_at)
values ('5a000000-0000-0000-0001-000000000003','5a000000-0000-0000-0000-00000000000a',
        '5a000000-0000-0000-0000-000000000001','Kunde Regel','Reinigung','Weg 2',
        'completed','single', current_date - 3, '09:00', true,
        '5a000000-0000-0000-0001-000000000002', now() - interval '3 days', now() - interval '3 days' + interval '1 hour');

insert into public.job_comments (id, company_id, job_id, author_id, message)
values ('5a000000-0000-0000-0006-000000000001','5a000000-0000-0000-0000-00000000000a',
        '5a000000-0000-0000-0001-000000000001','5a000000-0000-0000-0000-000000000002','Erledigt');

insert into public.job_photos (id, job_id, company_id, uploaded_by, storage_path, file_name)
values ('5a000000-0000-0000-0007-000000000001','5a000000-0000-0000-0001-000000000001',
        '5a000000-0000-0000-0000-00000000000a','5a000000-0000-0000-0000-000000000002',
        '5a000000-0000-0000-0000-00000000000a/5a000000-0000-0000-0001-000000000001/1_abc.jpg','1_abc.jpg');

insert into public.employee_absences (id, company_id, employee_id, employee_name_snapshot, type, status,
                                      start_date, end_date, created_by)
values ('5a000000-0000-0000-0008-000000000001','5a000000-0000-0000-0000-00000000000a',
        '5a000000-0000-0000-0000-000000000002','Emil Eins','sickness','reported',
        current_date - 1, current_date, '5a000000-0000-0000-0000-000000000002');
insert into public.absence_evidence (company_id, absence_id)
values ('5a000000-0000-0000-0000-00000000000a','5a000000-0000-0000-0008-000000000001');

insert into public.vacation_years (id, company_id, employee_id, year)
values ('5a000000-0000-0000-0009-000000000001','5a000000-0000-0000-0000-00000000000a',
        '5a000000-0000-0000-0000-000000000002', extract(year from current_date)::int);

insert into public.notification_outbox (company_id, event_type, job_id, employee_id, employee_name)
values ('5a000000-0000-0000-0000-00000000000a','job_started','5a000000-0000-0000-0001-000000000001',
        '5a000000-0000-0000-0000-000000000002','Emil Eins');

-- Firma B: ein Auftrag für Bea (Session-Arbeitszeit) — Mitarbeiter-Löschpfad
select pg_temp.job_with_assignment(
  '5b000000-0000-0000-0001-000000000001','5b000000-0000-0000-0000-00000000000b',
  '5b000000-0000-0000-0000-000000000001','5b000000-0000-0000-0002-000000000001',
  '5b000000-0000-0000-0000-000000000003','Bea Mitarbeiterin','5b000000-0000-0000-0003-000000000001');
insert into public.job_comments (id, company_id, job_id, author_id, message)
values ('5b000000-0000-0000-0006-000000000001','5b000000-0000-0000-0000-00000000000b',
        '5b000000-0000-0000-0001-000000000001','5b000000-0000-0000-0000-000000000003','Bin da');
insert into public.employee_absences (id, company_id, employee_id, employee_name_snapshot, type, status,
                                      start_date, end_date, created_by)
values ('5b000000-0000-0000-0008-000000000001','5b000000-0000-0000-0000-00000000000b',
        '5b000000-0000-0000-0000-000000000003','Bea Mitarbeiterin','vacation','requested',
        current_date + 10, current_date + 12, '5b000000-0000-0000-0000-000000000003');
insert into public.notification_outbox (company_id, event_type, job_id, employee_id, employee_name)
values ('5b000000-0000-0000-0000-00000000000b','job_started','5b000000-0000-0000-0001-000000000001',
        '5b000000-0000-0000-0000-000000000003','Bea Mitarbeiterin');

-- Firma C: unbeteiligter Mandant mit eigenem Auftrag + Foto-Zeile
insert into public.jobs (id, company_id, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time, is_active)
values ('5c000000-0000-0000-0001-000000000001','5c000000-0000-0000-0000-00000000000c',
        '5c000000-0000-0000-0000-000000000001','Kunde C','Reinigung','Weg C',
        'open','single', current_date, '10:00', true);
insert into public.job_photos (id, job_id, company_id, uploaded_by, storage_path, file_name)
values ('5c000000-0000-0000-0007-000000000001','5c000000-0000-0000-0001-000000000001',
        '5c000000-0000-0000-0000-00000000000c','5c000000-0000-0000-0000-000000000001',
        '5c000000-0000-0000-0000-00000000000c/5c000000-0000-0000-0001-000000000001/1_c.jpg','1_c.jpg');

-- ── 3) Kontext-RPC ───────────────────────────────────────
do $$
declare v jsonb;
begin
  perform pg_temp.act_as('5a000000-0000-0000-0000-000000000001');
  set local role authenticated;
  v := public.get_account_deletion_context();
  reset role;
  perform pg_temp.chk(3, 'Kontext Solo-Admin A: is_last_admin', 'true', v->>'is_last_admin');
  perform pg_temp.chk(3, 'Kontext Solo-Admin A: company_name', 'SC Firma A', v->>'company_name');
  perform pg_temp.chk(3, 'Kontext Solo-Admin A: other_member_count', '2', v->>'other_member_count');

  perform pg_temp.act_as('5b000000-0000-0000-0000-000000000001');
  set local role authenticated;
  v := public.get_account_deletion_context();
  reset role;
  perform pg_temp.chk(3, 'Kontext Duo-Admin B1: is_last_admin', 'false', v->>'is_last_admin');

  perform pg_temp.act_as('5a000000-0000-0000-0000-000000000002');
  set local role authenticated;
  v := public.get_account_deletion_context();
  reset role;
  perform pg_temp.chk(3, 'Kontext Mitarbeiter: is_last_admin', 'false', v->>'is_last_admin');

  -- Aktiver Admin D2 neben inaktivem D1: D2 ist letzter AKTIVER Admin
  perform pg_temp.act_as('5d000000-0000-0000-0000-000000000002');
  set local role authenticated;
  v := public.get_account_deletion_context();
  reset role;
  perform pg_temp.chk(3, 'Kontext D2 (anderer Admin inaktiv): is_last_admin', 'true', v->>'is_last_admin');
end $$;

-- ── 9) authenticated darf den Purge nicht aufrufen ───────
do $$
declare r text;
begin
  perform pg_temp.act_as('5a000000-0000-0000-0000-000000000001');
  set local role authenticated;
  begin
    perform public.purge_company_for_last_admin(
      '5a000000-0000-0000-0000-000000000001','5a000000-0000-0000-0000-00000000000a');
    r := 'AUSGEFÜHRT';
  exception when insufficient_privilege then r := 'VERWEIGERT';
  end;
  reset role;
  perform pg_temp.chk(9, 'authenticated -> purge_company_for_last_admin', 'VERWEIGERT', r);

  set local role anon;
  begin
    perform public.purge_company_for_last_admin(
      '5a000000-0000-0000-0000-000000000001','5a000000-0000-0000-0000-00000000000a');
    r := 'AUSGEFÜHRT';
  exception when insufficient_privilege then r := 'VERWEIGERT';
  end;
  reset role;
  perform pg_temp.chk(9, 'anon -> purge_company_for_last_admin', 'VERWEIGERT', r);
end $$;

-- ── 10) Guards ohne Purge-Flag weiter scharf ─────────────
do $$
declare r text;
begin
  begin
    delete from public.work_sessions where id = '5a000000-0000-0000-0003-000000000001';
    r := 'GELÖSCHT';
  exception when others then r := 'ABGELEHNT';
  end;
  perform pg_temp.chk(10, 'work_sessions DELETE ohne Purge-Flag', 'ABGELEHNT', r);

  begin
    delete from public.session_time_corrections where correction_id = '5a000000-0000-0000-0004-000000000001';
    r := 'GELÖSCHT';
  exception when others then r := 'ABGELEHNT';
  end;
  perform pg_temp.chk(10, 'session_time_corrections DELETE ohne Purge-Flag', 'ABGELEHNT', r);

  begin
    delete from public.jobs where id = '5a000000-0000-0000-0001-000000000002';
    r := 'GELÖSCHT';
  exception when others then r := 'ABGELEHNT';
  end;
  perform pg_temp.chk(10, 'Dauerauftrag mit abgeschlossenem Termin DELETE ohne Flag', 'ABGELEHNT', r);

  begin
    delete from public.companies where id = '5a000000-0000-0000-0000-00000000000a';
    r := 'GELÖSCHT';
  exception when others then r := 'ABGELEHNT';
  end;
  perform pg_temp.chk(10, 'Rohes companies-DELETE (Kaskade) weiterhin blockiert', 'ABGELEHNT', r);
end $$;

-- ── 4) Zwei Admins: kein Firmen-Purge ────────────────────
select pg_temp.chk(4, 'Purge durch Admin B1 (B2 aktiv)', 'not_last_admin',
  pg_temp.purge('5b000000-0000-0000-0000-000000000001','5b000000-0000-0000-0000-00000000000b'));
select pg_temp.chk(4, 'Firma B danach noch vorhanden', '1',
  (select count(*)::text from public.companies where id='5b000000-0000-0000-0000-00000000000b'));
select pg_temp.chk(4, 'Admin B1 danach noch vorhanden', '1',
  (select count(*)::text from auth.users where id='5b000000-0000-0000-0000-000000000001'));

-- ── 12) Nicht-Admin / inaktiver Admin ────────────────────
select pg_temp.chk(12, 'Purge durch Mitarbeiter', 'not_admin',
  pg_temp.purge('5a000000-0000-0000-0000-000000000002','5a000000-0000-0000-0000-00000000000a'));
select pg_temp.chk(12, 'Purge durch inaktiven Admin D1', 'inactive_account',
  pg_temp.purge('5d000000-0000-0000-0000-000000000001','5d000000-0000-0000-0000-00000000000d'));
select pg_temp.chk(12, 'Purge ohne Aufrufer', 'unauthenticated',
  pg_temp.purge(null,'5a000000-0000-0000-0000-00000000000a'));

-- ── 5) Gefälschte Firmen-ID ──────────────────────────────
select pg_temp.chk(5, 'Admin A bestätigt fremde Firma C', 'company_mismatch',
  pg_temp.purge('5a000000-0000-0000-0000-000000000001','5c000000-0000-0000-0000-00000000000c'));
select pg_temp.chk(5, 'Admin C bestätigt Firma A (fremder Admin)', 'company_mismatch',
  pg_temp.purge('5c000000-0000-0000-0000-000000000001','5a000000-0000-0000-0000-00000000000a'));
select pg_temp.chk(5, 'Admin A ohne Bestätigungs-ID', 'company_mismatch',
  pg_temp.purge('5a000000-0000-0000-0000-000000000001', null));
select pg_temp.chk(5, 'Firmen A + C nach Fälschungsversuchen intakt', '2',
  (select count(*)::text from public.companies
    where id in ('5a000000-0000-0000-0000-00000000000a','5c000000-0000-0000-0000-00000000000c')));
select pg_temp.chk(5, 'Aufträge A nach Fälschungsversuchen intakt', '3',
  (select count(*)::text from public.jobs where company_id='5a000000-0000-0000-0000-00000000000a'));

-- ── 1/2/11) Mitarbeiter-Löschung (normaler Pfad, wie auth.admin.deleteUser) ──
delete from auth.users where id = '5b000000-0000-0000-0000-000000000003';

select pg_temp.chk(1, 'Profil Bea gelöscht', '0',
  (select count(*)::text from public.profiles where id='5b000000-0000-0000-0000-000000000003'));
select pg_temp.chk(1, 'Firma B bleibt', '1',
  (select count(*)::text from public.companies where id='5b000000-0000-0000-0000-00000000000b'));
select pg_temp.chk(2, 'job_assignments-Snapshot bleibt (Nachweis)', 'Bea Mitarbeiterin',
  (select employee_name_snapshot from public.job_assignments where id='5b000000-0000-0000-0002-000000000001'));
select pg_temp.chk(2, 'job_assignments.employee_id NULL', '<null>',
  (select employee_id::text from public.job_assignments where id='5b000000-0000-0000-0002-000000000001'));
select pg_temp.chk(2, 'Abwesenheits-Snapshot bleibt (Nachweis)', 'Bea Mitarbeiterin',
  (select employee_name_snapshot from public.employee_absences where id='5b000000-0000-0000-0008-000000000001'));
select pg_temp.chk(2, 'Outbox-Name anonymisiert', 'Gelöschtes Konto',
  (select string_agg(distinct coalesce(employee_name,'<null>'), ',')
     from public.notification_outbox
    where company_id='5b000000-0000-0000-0000-00000000000b' and event_type='job_started'));
select pg_temp.chk(2, 'Kommentar bleibt, Autor NULL', '1|<null>',
  (select count(*)::text || '|' || coalesce(max(author_id::text),'<null>')
     from public.job_comments where id='5b000000-0000-0000-0006-000000000001'));
select pg_temp.chk(2, 'Abwesenheit employee_id NULL', '<null>',
  (select employee_id::text from public.employee_absences where id='5b000000-0000-0000-0008-000000000001'));
select pg_temp.chk(11, 'Session-Arbeitszeit bleibt (anonym)', '1|<null>',
  (select count(*)::text || '|' || coalesce(max(employee_id::text),'<null>')
     from public.work_sessions where id='5b000000-0000-0000-0003-000000000001'));

-- ── 6) Letzter Admin: Firma A wird vollständig gelöscht ───
create temp table _purge as
select public.purge_company_for_last_admin(
  '5a000000-0000-0000-0000-000000000001','5a000000-0000-0000-0000-00000000000a') as r;

select pg_temp.chk(6, 'Rückgabe company_id', '5a000000-0000-0000-0000-00000000000a',
  (select r->>'company_id' from _purge));
select pg_temp.chk(6, 'Rückgabe: 3 gelöschte Konten', '3',
  (select jsonb_array_length(r->'deleted_user_ids')::text from _purge));
select pg_temp.chk(6, 'Rückgabe: Storage-Pfad des Fotos', '5a000000-0000-0000-0000-00000000000a/5a000000-0000-0000-0001-000000000001/1_abc.jpg',
  (select r->'storage_paths'->>0 from _purge));
select pg_temp.chk(6, 'Firma A gelöscht', '0',
  (select count(*)::text from public.companies where id='5a000000-0000-0000-0000-00000000000a'));
select pg_temp.chk(6, 'Auth-Konten A gelöscht (inkl. Aufrufer)', '0',
  (select count(*)::text from auth.users where id::text like '5a000000-%'));
select pg_temp.chk(6, 'Profile A gelöscht', '0',
  (select count(*)::text from public.profiles where id::text like '5a000000-%'));
select pg_temp.chk(6, 'Aufträge/Zuweisungen/Sessions/Korrekturen/Receipts A gelöscht', '0|0|0|0|0',
  (select concat_ws('|',
     (select count(*) from public.jobs where id::text like '5a000000-%'),
     (select count(*) from public.job_assignments where id::text like '5a000000-%'),
     (select count(*) from public.work_sessions where id::text like '5a000000-%'),
     (select count(*) from public.session_time_corrections where correction_id::text like '5a000000-%'),
     (select count(*) from public.work_operation_receipts where operation_id::text like '5a000000-%'))));
select pg_temp.chk(6, 'Kommentare/Fotos/Abwesenheiten/Nachweise/Urlaub/Outbox A gelöscht', '0|0|0|0|0|0',
  (select concat_ws('|',
     (select count(*) from public.job_comments where company_id='5a000000-0000-0000-0000-00000000000a'),
     (select count(*) from public.job_photos where company_id='5a000000-0000-0000-0000-00000000000a'),
     (select count(*) from public.employee_absences where company_id='5a000000-0000-0000-0000-00000000000a'),
     (select count(*) from public.absence_evidence where company_id='5a000000-0000-0000-0000-00000000000a'),
     (select count(*) from public.vacation_years where company_id='5a000000-0000-0000-0000-00000000000a'),
     (select count(*) from public.notification_outbox where company_id='5a000000-0000-0000-0000-00000000000a'))));
select pg_temp.chk(6, 'Keine Occurrence-Tombstones für A entstanden', '0',
  (select count(*)::text from public.job_occurrence_skips where parent_job_id::text like '5a000000-%'));
select pg_temp.chk(6, 'Purge-Flag nach Aufruf zurückgesetzt', 'false',
  (select public.company_purge_active()::text));

-- ── 7) Fremde Mandanten unverändert ──────────────────────
select pg_temp.chk(7, 'Firma B/C/D unverändert vorhanden', '3',
  (select count(*)::text from public.companies
    where id in ('5b000000-0000-0000-0000-00000000000b','5c000000-0000-0000-0000-00000000000c','5d000000-0000-0000-0000-00000000000d')));
select pg_temp.chk(7, 'Admins B1/B2/C/D1/D2 unverändert vorhanden', '5',
  (select count(*)::text from auth.users where id in (
     '5b000000-0000-0000-0000-000000000001','5b000000-0000-0000-0000-000000000002',
     '5c000000-0000-0000-0000-000000000001','5d000000-0000-0000-0000-000000000001',
     '5d000000-0000-0000-0000-000000000002')));
select pg_temp.chk(7, 'Auftrag + Session-Arbeitszeit B unverändert', '1|1',
  (select concat_ws('|',
     (select count(*) from public.jobs where id='5b000000-0000-0000-0001-000000000001'),
     (select count(*) from public.work_sessions where id='5b000000-0000-0000-0003-000000000001'))));
select pg_temp.chk(7, 'Auftrag + Foto-Zeile C unverändert', '1|1',
  (select concat_ws('|',
     (select count(*) from public.jobs where id='5c000000-0000-0000-0001-000000000001'),
     (select count(*) from public.job_photos where id='5c000000-0000-0000-0007-000000000001'))));

-- ── 8) Wiederholter Purge ────────────────────────────────
select pg_temp.chk(8, 'Zweiter Purge-Aufruf', 'profile_not_found',
  pg_temp.purge('5a000000-0000-0000-0000-000000000001','5a000000-0000-0000-0000-00000000000a'));

-- ── Ergebnis ─────────────────────────────────────────────
select case_no, beschreibung, erwartet, ergebnis, verdikt from _results order by case_no;
select 'TOTAL' as summary,
       count(*) filter (where verdikt='PASS') as pass,
       count(*) filter (where verdikt='FAIL') as fail
from _results;

rollback;
