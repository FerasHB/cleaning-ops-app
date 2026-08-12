-- =========================================================
-- TEST: admin_correct_assignment_time + employee_time_adjustments
-- (Migration 20260814000000_admin_time_correction_foundation)
-- =========================================================
-- Weist nach:
--   * Ein Admin korrigiert die Zeit EINES Mitarbeiters; attendance zieht
--     mit und ein Pruefpfad-Eintrag entsteht.
--   * Mehrfachzuweisung: die Kollegin bleibt unveraendert, und die
--     GETEILTE Job-Uhr (jobs.started_at/completed_at) wird NICHT angefasst.
--   * jobs.updated_at steigt (Realtime-Kette ueber den bestehenden
--     touch_job_on_assignment_change_trg).
--   * Sicherheit: Mitarbeiter abgelehnt, fremde Firma abgelehnt,
--     employee_time_adjustments ohne Schreibrechte und firmenisoliert.
--   * Validierung: leerer Grund, Ende <= Beginn, beide NULL, nicht
--     abgeschlossener Auftrag, Alt-Auftrag vor dem Phase-1-Grenzwert.
--   * Regression: start_own_job/complete_own_job unveraendert.
--
-- Aufrufe laufen als 'authenticated' (SET ROLE + request.jwt.claims), also
-- ueber denselben Pfad wie die App.
--
-- AUSFUEHREN lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/admin_time_correction_foundation.test.sql
-- Legt Testdaten an, macht am Ende ROLLBACK — KEINE Rueckstaende.
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = g1…1 | Admin A = g2…1 | Ahmad = g2…2 | Maria = g2…3
-- Firma B = g1…2 | Admin B = g2…4 | Bea   = g2…5

do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-0000000000c1','authenticated','authenticated','atc-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-0000000000c2','authenticated','authenticated','atc-ahmad@example.test','{"full_name":"Ahmad"}'),
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-0000000000c3','authenticated','authenticated','atc-maria@example.test','{"full_name":"Maria"}'),
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-0000000000c4','authenticated','authenticated','atc-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-0000000000c5','authenticated','authenticated','atc-bea@example.test','{"full_name":"Bea"}');
end $$;

insert into public.profiles (id, full_name) values
  ('a2000000-0000-0000-0000-0000000000c1','Admin A'),
  ('a2000000-0000-0000-0000-0000000000c2','Ahmad'),
  ('a2000000-0000-0000-0000-0000000000c3','Maria'),
  ('a2000000-0000-0000-0000-0000000000c4','Admin B'),
  ('a2000000-0000-0000-0000-0000000000c5','Bea')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('a1000000-0000-0000-0000-0000000000c1','ATC Firma A','atc-firma-a-test'),
  ('a1000000-0000-0000-0000-0000000000c2','ATC Firma B','atc-firma-b-test');

update public.profiles set company_id='a1000000-0000-0000-0000-0000000000c1', role='admin',    is_active=true where id='a2000000-0000-0000-0000-0000000000c1';
update public.profiles set company_id='a1000000-0000-0000-0000-0000000000c1', role='employee', is_active=true where id in ('a2000000-0000-0000-0000-0000000000c2','a2000000-0000-0000-0000-0000000000c3');
update public.profiles set company_id='a1000000-0000-0000-0000-0000000000c2', role='admin',    is_active=true where id='a2000000-0000-0000-0000-0000000000c4';
update public.profiles set company_id='a1000000-0000-0000-0000-0000000000c2', role='employee', is_active=true where id='a2000000-0000-0000-0000-0000000000c5';

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role','authenticated')::text, true);
end $f$;

create temporary table _atc (
  case_no int, beschreibung text, erwartet text, ergebnis text
) on commit drop;

-- Auftraege. updated_at bewusst auf 2020 gesetzt, damit der spaetere
-- Realtime-Nachweis (updated_at steigt) eindeutig ist.
--   J1 = {Ahmad, Maria}, wird von Maria gestartet+abgeschlossen (NACH Cutoff)
--   J2 = {Ahmad},        Alt-Auftrag, abgeschlossen VOR dem Cutoff
--   J3 = {Ahmad},        bleibt offen (nicht korrigierbar)
--   J4 = Firma B, {Bea}, abgeschlossen NACH Cutoff (Firmengrenze)
insert into public.jobs (id, company_id, assigned_to, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time,
                         is_active, created_at, updated_at) values
  ('a4000000-0000-0000-0000-0000000000c1','a1000000-0000-0000-0000-0000000000c1',null,'a2000000-0000-0000-0000-0000000000c1','Mueller','Unterhaltsreinigung','Hauptstr. 1','open','single',current_date,'08:00',true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00'),
  ('a4000000-0000-0000-0000-0000000000c2','a1000000-0000-0000-0000-0000000000c1',null,'a2000000-0000-0000-0000-0000000000c1','Altkunde','Grundreinigung','Altweg 2','open','single',current_date,'08:00',true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00'),
  ('a4000000-0000-0000-0000-0000000000c3','a1000000-0000-0000-0000-0000000000c1',null,'a2000000-0000-0000-0000-0000000000c1','Offen','Fensterreinigung','Offenweg 3','open','single',current_date,'08:00',true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00'),
  ('a4000000-0000-0000-0000-0000000000c4','a1000000-0000-0000-0000-0000000000c2',null,'a2000000-0000-0000-0000-0000000000c4','Fremd','Glasreinigung','Fremdweg 4','open','single',current_date,'08:00',true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00');

-- Zuweisungen ueber den echten App-Pfad (set_job_assignments).
do $$
begin
  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c1');
  execute 'set local role authenticated';
  perform public.set_job_assignments('a4000000-0000-0000-0000-0000000000c1',
    array['a2000000-0000-0000-0000-0000000000c2','a2000000-0000-0000-0000-0000000000c3']::uuid[]);
  perform public.set_job_assignments('a4000000-0000-0000-0000-0000000000c2',
    array['a2000000-0000-0000-0000-0000000000c2']::uuid[]);
  perform public.set_job_assignments('a4000000-0000-0000-0000-0000000000c3',
    array['a2000000-0000-0000-0000-0000000000c2']::uuid[]);
  execute 'reset role';

  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c4');
  execute 'set local role authenticated';
  perform public.set_job_assignments('a4000000-0000-0000-0000-0000000000c4',
    array['a2000000-0000-0000-0000-0000000000c5']::uuid[]);
  execute 'reset role';
end $$;

-- =========================================================
-- AUSGANGSLAGE: Maria erfasst korrekt, Ahmad vergisst BEIDES.
-- Laeuft ueber die echten RPCs — damit ist die Ausgangslage zugleich der
-- Regressionsnachweis fuer start_own_job/complete_own_job (CASE 20/21).
-- =========================================================
do $$
begin
  -- J1: Maria startet 08:00 und schliesst 12:00 ab (NACH dem Cutoff).
  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c3');
  execute 'set local role authenticated';
  perform public.start_own_job   ('a4000000-0000-0000-0000-0000000000c1', timestamptz '2026-08-20 08:00+00');
  perform public.complete_own_job('a4000000-0000-0000-0000-0000000000c1', timestamptz '2026-08-20 12:00+00');
  execute 'reset role';

  -- J2: Ahmad hat den Alt-Auftrag selbst erledigt — VOR dem Cutoff.
  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c2');
  execute 'set local role authenticated';
  perform public.start_own_job   ('a4000000-0000-0000-0000-0000000000c2', timestamptz '2026-07-01 08:00+00');
  perform public.complete_own_job('a4000000-0000-0000-0000-0000000000c2', timestamptz '2026-07-01 11:00+00');
  execute 'reset role';

  -- J4 (Firma B): Bea erledigt, NACH dem Cutoff.
  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c5');
  execute 'set local role authenticated';
  perform public.start_own_job   ('a4000000-0000-0000-0000-0000000000c4', timestamptz '2026-08-20 09:00+00');
  perform public.complete_own_job('a4000000-0000-0000-0000-0000000000c4', timestamptz '2026-08-20 13:00+00');
  execute 'reset role';
end $$;

-- CASE 20 (Regression): start_own_job hat geteilte Uhr UND Marias
-- Eigenzeit gesetzt — unveraendertes Phase-1-Verhalten.
insert into _atc
select 20, 'Regression: start_own_job setzt geteilte Uhr + Eigenzeit des Ausloesers', 'OK',
  case when (select started_at from public.jobs where id='a4000000-0000-0000-0000-0000000000c1') = timestamptz '2026-08-20 08:00+00'
        and (select employee_started_at from public.job_assignments
             where job_id='a4000000-0000-0000-0000-0000000000c1' and employee_id='a2000000-0000-0000-0000-0000000000c3') = timestamptz '2026-08-20 08:00+00'
       then 'OK' else 'ABWEICHUNG' end;

-- CASE 21 (Regression): complete_own_job ebenso; Ahmad hat als NICHT-Ausloeser
-- weiterhin KEINE Eigenzeit (genau der Anlass fuer die Korrektur).
insert into _atc
select 21, 'Regression: complete_own_job setzt Abschluss; Nicht-Ausloeser bleibt ohne Eigenzeit', 'OK',
  case when (select completed_at from public.jobs where id='a4000000-0000-0000-0000-0000000000c1') = timestamptz '2026-08-20 12:00+00'
        and (select employee_completed_at from public.job_assignments
             where job_id='a4000000-0000-0000-0000-0000000000c1' and employee_id='a2000000-0000-0000-0000-0000000000c3') = timestamptz '2026-08-20 12:00+00'
        and (select employee_started_at   from public.job_assignments
             where job_id='a4000000-0000-0000-0000-0000000000c1' and employee_id='a2000000-0000-0000-0000-0000000000c2') is null
        and (select employee_completed_at from public.job_assignments
             where job_id='a4000000-0000-0000-0000-0000000000c1' and employee_id='a2000000-0000-0000-0000-0000000000c2') is null
       then 'OK' else 'ABWEICHUNG' end;


-- =========================================================
-- SZENARIO 1+2: Admin korrigiert AHMAD (08:00–12:00) auf J1.
-- =========================================================
do $$
declare
  v_assignment uuid;
  v_before_updated timestamptz;
begin
  select id into v_assignment from public.job_assignments
   where job_id='a4000000-0000-0000-0000-0000000000c1' and employee_id='a2000000-0000-0000-0000-0000000000c2';

  select updated_at into v_before_updated from public.jobs where id='a4000000-0000-0000-0000-0000000000c1';
  perform set_config('atc.before_updated', v_before_updated::text, true);
  perform set_config('atc.ahmad_assignment', v_assignment::text, true);

  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c1');
  execute 'set local role authenticated';
  perform public.admin_correct_assignment_time(
    v_assignment,
    timestamptz '2026-08-20 08:00+00',
    timestamptz '2026-08-20 12:00+00',
    'Ahmad hat Start und Abschluss vergessen; Zeiten vom Objektleiter bestaetigt.'
  );
  execute 'reset role';
end $$;

-- CASE 1: Ahmads Zeiten stehen jetzt.
insert into _atc
select 1, 'Ahmads Eigenzeit wurde gesetzt (08:00-12:00)', 'OK',
  case when (select employee_started_at   from public.job_assignments
             where job_id='a4000000-0000-0000-0000-0000000000c1' and employee_id='a2000000-0000-0000-0000-0000000000c2') = timestamptz '2026-08-20 08:00+00'
        and (select employee_completed_at from public.job_assignments
             where job_id='a4000000-0000-0000-0000-0000000000c1' and employee_id='a2000000-0000-0000-0000-0000000000c2') = timestamptz '2026-08-20 12:00+00'
       then 'OK' else 'FALSCH' end;

-- CASE 2: attendance ist mitgezogen -> counts_for_timesheet wird true.
insert into _atc
select 2, 'attendance=completed und counts_for_timesheet=true nach Korrektur', 'completed/true',
  coalesce((select attendance::text || '/' || counts_for_timesheet::text
            from public.job_assignments
            where job_id='a4000000-0000-0000-0000-0000000000c1' and employee_id='a2000000-0000-0000-0000-0000000000c2'), 'KEINE_ZEILE');

-- CASE 3: Pruefpfad-Eintrag mit Alt-/Neuwerten, Admin und Grund.
insert into _atc
select 3, 'Audit-Zeile mit alten NULL-Werten, neuen Zeiten, Admin und Grund', 'OK',
  case when exists (
    select 1 from public.employee_time_adjustments
    where job_id           = 'a4000000-0000-0000-0000-0000000000c1'
      and employee_id      = 'a2000000-0000-0000-0000-0000000000c2'
      and old_started_at   is null
      and old_completed_at is null
      and new_started_at   = timestamptz '2026-08-20 08:00+00'
      and new_completed_at = timestamptz '2026-08-20 12:00+00'
      and changed_by       = 'a2000000-0000-0000-0000-0000000000c1'
      and length(btrim(reason)) > 0
  ) then 'OK' else 'FEHLT' end;

-- CASE 4: MARIA ist unveraendert (Kernanforderung Mehrfachzuweisung).
insert into _atc
select 4, 'Maria bleibt unveraendert (08:00-12:00, attendance=completed)', 'OK',
  case when (select employee_started_at   from public.job_assignments
             where job_id='a4000000-0000-0000-0000-0000000000c1' and employee_id='a2000000-0000-0000-0000-0000000000c3') = timestamptz '2026-08-20 08:00+00'
        and (select employee_completed_at from public.job_assignments
             where job_id='a4000000-0000-0000-0000-0000000000c1' and employee_id='a2000000-0000-0000-0000-0000000000c3') = timestamptz '2026-08-20 12:00+00'
       then 'OK' else 'VERAENDERT' end;

-- CASE 5: Fuer Maria wurde KEIN Pruefpfad-Eintrag erzeugt.
insert into _atc
select 5, 'Keine Audit-Zeile fuer die nicht korrigierte Kollegin', '0',
  (select count(*)::text from public.employee_time_adjustments
    where employee_id='a2000000-0000-0000-0000-0000000000c3');

-- CASE 6: DIE GETEILTE JOB-UHR IST UNANGETASTET.
insert into _atc
select 6, 'jobs.started_at/completed_at unveraendert (geteilte Uhr)', 'OK',
  case when (select started_at   from public.jobs where id='a4000000-0000-0000-0000-0000000000c1') = timestamptz '2026-08-20 08:00+00'
        and (select completed_at from public.jobs where id='a4000000-0000-0000-0000-0000000000c1') = timestamptz '2026-08-20 12:00+00'
        and (select status::text from public.jobs where id='a4000000-0000-0000-0000-0000000000c1') = 'completed'
       then 'OK' else 'VERAENDERT' end;

-- CASE 7: Realtime-Kette ueber den bestehenden
-- touch_job_on_assignment_change_trg (kein zusaetzlicher Schreibvorgang in
-- der RPC).
--
-- WARUM HIER KEIN VORHER/NACHHER-VERGLEICH MOEGLICH IST: now() liefert die
-- TRANSAKTIONS-Startzeit und ist innerhalb dieses Tests (begin … rollback)
-- konstant. Der Trigger schreibt updated_at = now() — ein Vergleich
-- "nachher > vorher" waere deshalb selbst dann gleich, wenn der Trigger
-- korrekt feuert (verifiziert: er tut es, tgtype 29 enthaelt UPDATE).
-- Geprueft wird daher beides, was in einer Transaktion aussagekraeftig ist:
--   a) der Trigger existiert, ist aktiv und feuert auf UPDATE,
--   b) jobs.updated_at traegt die Transaktionszeit statt des geseedeten
--      Werts von 2020 — die Zeile wurde also tatsaechlich angefasst.
insert into _atc
select 7, 'Realtime: touch-Trigger aktiv auf UPDATE + jobs.updated_at angefasst', 'trigger=1/updated=jetzt',
  'trigger=' || (select count(*)::text from pg_trigger
                  where tgrelid = 'public.job_assignments'::regclass
                    and tgname  = 'touch_job_on_assignment_change_trg'
                    and tgenabled = 'O'
                    and (tgtype & 16) = 16)
  || '/updated=' || (case when (select updated_at from public.jobs
                                 where id='a4000000-0000-0000-0000-0000000000c1') = now()
                          then 'jetzt' else 'alt' end);


-- =========================================================
-- SICHERHEIT
-- =========================================================

-- CASE 8: Ein MITARBEITER darf die RPC nicht aufrufen.
do $$
declare abgelehnt boolean := false;
begin
  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c2');
  execute 'set local role authenticated';
  begin
    perform public.admin_correct_assignment_time(
      current_setting('atc.ahmad_assignment')::uuid,
      timestamptz '2026-08-20 06:00+00', timestamptz '2026-08-20 14:00+00', 'Selbstkorrektur');
  exception when others then
    abgelehnt := true;
  end;
  execute 'reset role';

  insert into _atc values (8, 'Mitarbeiter kann die Korrektur-RPC NICHT aufrufen', 'ABGELEHNT',
    case when abgelehnt then 'ABGELEHNT' else 'ERLAUBT' end);
end $$;

-- CASE 9: Admin einer FREMDEN Firma darf nicht korrigieren.
do $$
declare abgelehnt boolean := false;
begin
  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c4');
  execute 'set local role authenticated';
  begin
    perform public.admin_correct_assignment_time(
      current_setting('atc.ahmad_assignment')::uuid,
      timestamptz '2026-08-20 06:00+00', timestamptz '2026-08-20 14:00+00', 'Fremdzugriff');
  exception when others then
    abgelehnt := true;
  end;
  execute 'reset role';

  insert into _atc values (9, 'Admin einer fremden Firma kann NICHT korrigieren', 'ABGELEHNT',
    case when abgelehnt then 'ABGELEHNT' else 'ERLAUBT' end);
end $$;

-- CASE 10: Nach den beiden abgelehnten Versuchen stehen Ahmads Zeiten
-- unveraendert auf dem korrigierten Wert (keine Teilwirkung).
insert into _atc
select 10, 'Abgelehnte Versuche haben nichts veraendert', 'OK',
  case when (select employee_started_at   from public.job_assignments
             where id = current_setting('atc.ahmad_assignment')::uuid) = timestamptz '2026-08-20 08:00+00'
        and (select employee_completed_at from public.job_assignments
             where id = current_setting('atc.ahmad_assignment')::uuid) = timestamptz '2026-08-20 12:00+00'
       then 'OK' else 'VERAENDERT' end;

-- CASE 11: employee_time_adjustments — RLS an, anon rechtelos,
-- authenticated ohne jedes Schreibrecht.
insert into _atc
select 11, 'Audit-Tabelle: RLS aktiv, anon rechtelos, authenticated nur SELECT', 'rls=true/anon=0/schreib=0',
  'rls=' || (select relrowsecurity::text from pg_class where oid='public.employee_time_adjustments'::regclass)
  || '/anon=' || (select count(*)::text from information_schema.role_table_grants
                   where table_name='employee_time_adjustments' and grantee='anon')
  || '/schreib=' || (select count(*)::text from information_schema.role_table_grants
                      where table_name='employee_time_adjustments' and grantee='authenticated'
                        and privilege_type in ('INSERT','UPDATE','DELETE'));

-- CASE 12: Admin B sieht die Korrekturen von Firma A NICHT (RLS).
do $$
declare sichtbar int;
begin
  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c4');
  execute 'set local role authenticated';
  select count(*) into sichtbar from public.employee_time_adjustments;
  execute 'reset role';

  insert into _atc values (12, 'Admin der Fremdfirma sieht keine Korrekturen von Firma A', '0', sichtbar::text);
end $$;

-- CASE 13: Admin A sieht seine eigene Korrektur (Gegenprobe zu CASE 12).
do $$
declare sichtbar int;
begin
  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c1');
  execute 'set local role authenticated';
  select count(*) into sichtbar from public.employee_time_adjustments;
  execute 'reset role';

  insert into _atc values (13, 'Admin der eigenen Firma sieht seine Korrektur', '1', sichtbar::text);
end $$;

-- CASE 14: Ein MITARBEITER sieht keine Korrekturen (keine Employee-Policy).
do $$
declare sichtbar int;
begin
  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c2');
  execute 'set local role authenticated';
  select count(*) into sichtbar from public.employee_time_adjustments;
  execute 'reset role';

  insert into _atc values (14, 'Mitarbeiter sieht keine Korrektur-Eintraege', '0', sichtbar::text);
end $$;


-- =========================================================
-- VALIDIERUNG
-- =========================================================
do $$
declare
  v_assignment uuid := current_setting('atc.ahmad_assignment')::uuid;
  r_leer boolean := false; r_blank boolean := false; r_reihenfolge boolean := false;
  r_beide_null boolean := false; r_legacy boolean := false; r_offen boolean := false;
  v_a2 uuid; v_a3 uuid;
begin
  select id into v_a2 from public.job_assignments where job_id='a4000000-0000-0000-0000-0000000000c2';
  select id into v_a3 from public.job_assignments where job_id='a4000000-0000-0000-0000-0000000000c3';

  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c1');
  execute 'set local role authenticated';

  begin perform public.admin_correct_assignment_time(v_assignment, timestamptz '2026-08-20 08:00+00', timestamptz '2026-08-20 12:00+00', '');
  exception when others then r_leer := true; end;

  begin perform public.admin_correct_assignment_time(v_assignment, timestamptz '2026-08-20 08:00+00', timestamptz '2026-08-20 12:00+00', '    ');
  exception when others then r_blank := true; end;

  begin perform public.admin_correct_assignment_time(v_assignment, timestamptz '2026-08-20 12:00+00', timestamptz '2026-08-20 08:00+00', 'Ende vor Beginn');
  exception when others then r_reihenfolge := true; end;

  begin perform public.admin_correct_assignment_time(v_assignment, null, null, 'Beide leer');
  exception when others then r_beide_null := true; end;

  -- Alt-Auftrag: abgeschlossen am 2026-07-01, also VOR dem Cutoff.
  begin perform public.admin_correct_assignment_time(v_a2, timestamptz '2026-07-01 08:00+00', timestamptz '2026-07-01 11:00+00', 'Alt-Auftrag');
  exception when others then r_legacy := true; end;

  -- Noch offener Auftrag (nie gestartet/abgeschlossen).
  begin perform public.admin_correct_assignment_time(v_a3, timestamptz '2026-08-20 08:00+00', timestamptz '2026-08-20 12:00+00', 'Offener Auftrag');
  exception when others then r_offen := true; end;

  execute 'reset role';

  insert into _atc values
    (15, 'Leerer Grund wird abgelehnt',                              'ABGELEHNT', case when r_leer        then 'ABGELEHNT' else 'AKZEPTIERT' end),
    (16, 'Grund aus reinen Leerzeichen wird abgelehnt',              'ABGELEHNT', case when r_blank       then 'ABGELEHNT' else 'AKZEPTIERT' end),
    (17, 'Ende vor/gleich Beginn wird abgelehnt',                    'ABGELEHNT', case when r_reihenfolge then 'ABGELEHNT' else 'AKZEPTIERT' end),
    (18, 'Beide Zeitstempel NULL wird abgelehnt',                    'ABGELEHNT', case when r_beide_null  then 'ABGELEHNT' else 'AKZEPTIERT' end),
    (19, 'Alt-Auftrag vor Phase-1-Cutoff wird abgelehnt',            'ABGELEHNT', case when r_legacy      then 'ABGELEHNT' else 'AKZEPTIERT' end),
    (22, 'Nicht abgeschlossener Auftrag wird abgelehnt',             'ABGELEHNT', case when r_offen       then 'ABGELEHNT' else 'AKZEPTIERT' end);
end $$;

-- CASE 23: Nach allen abgelehnten Versuchen existiert weiterhin GENAU EIN
-- Audit-Eintrag — kein abgelehnter Aufruf hat geschrieben.
insert into _atc
select 23, 'Abgelehnte Aufrufe erzeugen keinen Audit-Eintrag', '1',
  (select count(*)::text from public.employee_time_adjustments);

-- CASE 24: Alt-Auftrag J2 traegt weiterhin Ahmads urspruengliche Eigenzeit
-- (die Ablehnung hat nichts veraendert).
insert into _atc
select 24, 'Alt-Auftrag bleibt nach Ablehnung unveraendert', 'OK',
  case when (select employee_started_at from public.job_assignments
             where job_id='a4000000-0000-0000-0000-0000000000c2') = timestamptz '2026-07-01 08:00+00'
       then 'OK' else 'VERAENDERT' end;


-- =========================================================
-- TEILKORREKTUR + UEBERSCHREIBEN
-- =========================================================
-- CASE 25: nur Beginn gesetzt -> attendance='started'.
-- CASE 26: eine ZWEITE Korrektur ueberschreibt (kein COALESCE) und legt
--          eine zweite Audit-Zeile an, deren Altwerte die vorherigen
--          Neuwerte sind — die Kette bleibt luecken los nachvollziehbar.
do $$
declare v_assignment uuid := current_setting('atc.ahmad_assignment')::uuid;
begin
  perform pg_temp.act_as('a2000000-0000-0000-0000-0000000000c1');
  execute 'set local role authenticated';
  perform public.admin_correct_assignment_time(
    v_assignment, timestamptz '2026-08-20 07:30+00', null, 'Nur Beginn bekannt.');
  execute 'reset role';
end $$;

insert into _atc
select 25, 'Nur Beginn gesetzt -> attendance=started, Ende NULL', 'started/NULL',
  coalesce((select attendance::text || '/' || coalesce(employee_completed_at::text,'NULL')
            from public.job_assignments where id = current_setting('atc.ahmad_assignment')::uuid), 'KEINE_ZEILE');

insert into _atc
select 26, 'Zweite Korrektur ueberschreibt und protokolliert die Altwerte', 'OK',
  case when (select employee_started_at from public.job_assignments
             where id = current_setting('atc.ahmad_assignment')::uuid) = timestamptz '2026-08-20 07:30+00'
        and exists (
          select 1 from public.employee_time_adjustments
          where assignment_id    = current_setting('atc.ahmad_assignment')::uuid
            and old_started_at   = timestamptz '2026-08-20 08:00+00'
            and old_completed_at = timestamptz '2026-08-20 12:00+00'
            and new_started_at   = timestamptz '2026-08-20 07:30+00'
            and new_completed_at is null
        )
       then 'OK' else 'FALSCH' end;

-- CASE 27: die geteilte Uhr ist AUCH nach der zweiten Korrektur unberuehrt.
insert into _atc
select 27, 'Geteilte Job-Uhr auch nach zweiter Korrektur unveraendert', 'OK',
  case when (select started_at   from public.jobs where id='a4000000-0000-0000-0000-0000000000c1') = timestamptz '2026-08-20 08:00+00'
        and (select completed_at from public.jobs where id='a4000000-0000-0000-0000-0000000000c1') = timestamptz '2026-08-20 12:00+00'
       then 'OK' else 'VERAENDERT' end;

-- CASE 28: job_assignments hat weiterhin KEINE UPDATE-Rechte fuer Clients
-- (das Sicherheitsmodell aus Phase 3 ist unveraendert).
insert into _atc
select 28, 'job_assignments weiterhin ohne Client-Schreibrechte', '0',
  (select count(*)::text from information_schema.role_table_grants
    where table_name='job_assignments' and grantee='authenticated'
      and privilege_type in ('INSERT','UPDATE','DELETE'));


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _atc order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _atc where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'ADMIN TIME CORRECTION TEST: % Fall/Faelle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE FAELLE PASS';
end $$;

rollback;
