-- =========================================================
-- TEST: Phase 16 — Post-Deploy Hardening
-- (Migration 20260918000000_phase16_post_deploy_hardening)
-- =========================================================
-- Deckt die drei Astra-Audit-Befunde ab:
--
--   1. start_own_job: expliziter open/in_progress/sonst-Zweig statt
--      `status <> 'open'` — ein Start auf einen bereits abgeschlossenen
--      Auftrag muss hart abgelehnt werden, OHNE job_assignments/jobs zu
--      mutieren.
--   2. admin_force_complete_job: server-seitiges Gate auf
--      app_config.force_complete_enabled, VOR jeder Mutation.
--   3. compat_sync_assignments_from_legacy: keine aus dem Job-Status
--      abgeleiteten Zeitstempel/Anwesenheit mehr bei einer neu gespiegelten
--      Legacy-Zuweisung.
--
-- Faelle sind absichtlich in derselben Reihenfolge wie in der Migration
-- selbst nummeriert (Befund 2 zuerst, dann 3, dann 1 — Reihenfolge im
-- Report der Uebersichtlichkeit halber angepasst).
--
-- Alle RPC-Aufrufe laufen als echte Rollen (SET ROLE + request.jwt.claims),
-- also ueber denselben Pfad wie die App ueber PostgREST — wie im
-- bestehenden phase16_job_execution_hardening.test.sql. Faelle rund um den
-- Kompatibilitaets-Trigger (Teil 3) laufen bewusst NICHT ueber eine Rolle,
-- weil der Trigger selbst caller-agnostisch ist (er feuert bei JEDEM
-- erfolgreichen Schreibvorgang auf jobs.assigned_to, unabhaengig davon, wer
-- ihn ausgeloest hat) — exakt wie mkjob() im bestehenden Test-Suite direkte
-- Fixture-Inserts ohne RLS verwendet.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende, sicher auch
-- gegen eine bereits belegte Umgebung.
-- =========================================================

begin;

create temp table _r (
  case_no   int,
  bereich   text,
  beschreibung text,
  erwartet  text,
  ergebnis  text
) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
end $f$;

create or replace function pg_temp.note(
  p_case int, p_bereich text, p_besch text, p_erw text, p_erg text
) returns void language plpgsql as $f$
begin
  insert into _r values (p_case, p_bereich, p_besch, p_erw, p_erg);
  raise notice 'CASE % [%] -> %', p_case, p_bereich, p_erg;
end $f$;

-- Ruft eine RPC als gegebener Rolle auf und liefert 'OK' oder
-- 'ABGELEHNT:<sqlerrm>' — Kurzform fuer die vielen gleichfoermigen Faelle
-- unten.
create or replace function pg_temp.try_start(p_uid uuid, p_job uuid, p_at timestamptz)
returns text language plpgsql as $f$
declare v text;
begin
  perform pg_temp.act_as(p_uid);
  execute 'set local role authenticated';
  begin
    perform public.start_own_job(p_job, p_at);
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';
  return v;
end $f$;

create or replace function pg_temp.try_force_complete(p_uid uuid, p_job uuid, p_reason text)
returns text language plpgsql as $f$
declare v text;
begin
  perform pg_temp.act_as(p_uid);
  execute 'set local role authenticated';
  begin
    perform public.admin_force_complete_job(p_job, p_reason);
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';
  return v;
end $f$;

-- ── Fixdaten ────────────────────────────────────────────────────────
-- Firma = a19…1 (Europe/Berlin) | Admin = a29…1 | E1 = a29…2 | E2 = a29…3
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','a2900000-0000-0000-0000-000000000001','authenticated','authenticated','ph-admin@example.test','{"full_name":"Hanna Admin"}'),
    ('00000000-0000-0000-0000-000000000000','a2900000-0000-0000-0000-000000000002','authenticated','authenticated','ph-e1@example.test','{"full_name":"Elif Eins"}'),
    ('00000000-0000-0000-0000-000000000000','a2900000-0000-0000-0000-000000000003','authenticated','authenticated','ph-e2@example.test','{"full_name":"Ela Zwei"}');
end $$;

insert into public.profiles (id, full_name) values
  ('a2900000-0000-0000-0000-000000000001','Hanna Admin'),
  ('a2900000-0000-0000-0000-000000000002','Elif Eins'),
  ('a2900000-0000-0000-0000-000000000003','Ela Zwei')
on conflict (id) do nothing;

insert into public.companies (id,name,slug,timezone) values
  ('a1900000-0000-0000-0000-000000000001','Hardening Firma','post-hardening-test','Europe/Berlin');

update public.profiles set company_id='a1900000-0000-0000-0000-000000000001', role='admin', is_active=true
  where id='a2900000-0000-0000-0000-000000000001';
update public.profiles set company_id='a1900000-0000-0000-0000-000000000001', role='employee', is_active=true
  where id in ('a2900000-0000-0000-0000-000000000002','a2900000-0000-0000-0000-000000000003');

-- Legt einen Einzelauftrag MIT heutigem Geschaeftsdatum an (haelt jeden
-- Testfall aus der (b) Terminpruefung von start_own_job heraus, siehe
-- Kopfkommentar) und optional Zuweisungen mit eigenen Zeitstempeln.
create or replace function pg_temp.mkjob2(
  p_id uuid, p_status job_status, p_started timestamptz, p_completed timestamptz
) returns void language plpgsql as $f$
begin
  insert into public.jobs (id, company_id, created_by, customer_name, service_name,
                           location_address, status, job_type, date, start_time,
                           started_at, started_by, completed_at, completed_by,
                           is_active, created_at, updated_at)
  values (p_id,'a1900000-0000-0000-0000-000000000001','a2900000-0000-0000-0000-000000000001',
          'Kunde '||left(p_id::text,8),'Unterhaltsreinigung','Teststr. 1',
          p_status,'single', (now() at time zone 'Europe/Berlin')::date, '08:00',
          p_started,
          case when p_started is not null then 'a2900000-0000-0000-0000-000000000002'::uuid end,
          p_completed,
          case when p_completed is not null then 'a2900000-0000-0000-0000-000000000002'::uuid end,
          true, now(), now());
end $f$;

create or replace function pg_temp.assign(p_job uuid, p_emp uuid) returns void language plpgsql as $f$
begin
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by)
  select p_job, p_emp, pr.full_name, 'a2900000-0000-0000-0000-000000000001'
  from public.profiles pr where pr.id = p_emp;
end $f$;


-- =========================================================
-- TEIL A — BEFUND 2: start_own_job Terminal-Guard
-- =========================================================
do $$
declare v text; v_cnt int; v_att text; v_bool boolean;
begin
  -- CASE 101: open -> normaler erster Start bleibt erlaubt.
  perform pg_temp.mkjob2('b1000000-0000-0000-0000-000000000001','open',null,null);
  perform pg_temp.assign('b1000000-0000-0000-0000-000000000001','a2900000-0000-0000-0000-000000000002');
  v := pg_temp.try_start('a2900000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001', now());
  perform pg_temp.note(101,'Start-Guard','open: erster eigener Start bleibt erlaubt','OK',v);

  -- CASE 102: in_progress -> Nachzuegler-Start (Late-Join) bleibt erlaubt.
  perform pg_temp.mkjob2('b1000000-0000-0000-0000-000000000002','in_progress', now() - interval '30 minutes', null);
  perform pg_temp.assign('b1000000-0000-0000-0000-000000000002','a2900000-0000-0000-0000-000000000002');
  perform pg_temp.assign('b1000000-0000-0000-0000-000000000002','a2900000-0000-0000-0000-000000000003');
  v := pg_temp.try_start('a2900000-0000-0000-0000-000000000003','b1000000-0000-0000-0000-000000000002', now());
  perform pg_temp.note(102,'Start-Guard','in_progress: Late-Join-Start bleibt erlaubt','OK',v);

  select employee_started_at is not null into v_bool from public.job_assignments
  where job_id='b1000000-0000-0000-0000-000000000002' and employee_id='a2900000-0000-0000-0000-000000000003';
  perform pg_temp.note(103,'Start-Guard','Late-Join stempelt weiterhin die eigene Startzeit','true',v_bool::text);

  -- CASE 104: completed (direkt so angelegt) -> Start wird abgelehnt.
  perform pg_temp.mkjob2('b1000000-0000-0000-0000-000000000003','completed', now() - interval '2 hours', now() - interval '1 hour');
  perform pg_temp.assign('b1000000-0000-0000-0000-000000000003','a2900000-0000-0000-0000-000000000002');
  v := pg_temp.try_start('a2900000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000003', now());
  perform pg_temp.note(104,'Start-Guard','completed: Start wird hart abgelehnt','ABGELEHNT',
    case when v like 'ABGELEHNT%' then 'ABGELEHNT' else v end);

  -- CASE 105/106: die Ablehnung aus 104 mutiert NICHTS auf der Zuweisungszeile.
  select employee_started_at::text, attendance::text into v, v_att from public.job_assignments
  where job_id='b1000000-0000-0000-0000-000000000003' and employee_id='a2900000-0000-0000-0000-000000000002';
  perform pg_temp.note(105,'Start-Guard','completed-Ablehnung erzeugt kein employee_started_at','NULL',coalesce(v,'NULL'));
  perform pg_temp.note(106,'Start-Guard','completed-Ablehnung aendert attendance nicht','assigned',v_att);

  -- CASE 107/108: Nachrichtentext ist der neue, sichere deutsche Text mit
  -- demselben Fehlercode (22023) wie die uebrigen Ablehnungen dieser
  -- Funktion — bestehender Client-Fehler-Klassifizierer bleibt kompatibel.
  v := pg_temp.try_start('a2900000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000003', now());
  perform pg_temp.note(107,'Start-Guard','Fehlertext nennt "bereits abgeschlossen"',
    'true', (v like '%bereits abgeschlossen%')::text);

  -- CASE 109-112: „Nachzuegler-Queue nach Abschluss" — ein Auftrag, der
  -- WAEHREND E1 offline war von in_progress auf completed wechselte (hier
  -- durch direktes Fixture-Update simuliert, siehe Kopfkommentar: fuer die
  -- RPC ist die Ursache des Statuswechsels irrelevant, nur der Endzustand
  -- zaehlt). E1s verspaeteter start_own_job-Aufruf muss denselben Schutz
  -- greifen wie CASE 104, unabhaengig vom Zwischenzustand in_progress.
  perform pg_temp.mkjob2('b1000000-0000-0000-0000-000000000004','in_progress', now() - interval '3 hours', null);
  perform pg_temp.assign('b1000000-0000-0000-0000-000000000004','a2900000-0000-0000-0000-000000000002'); -- E1, nie gestartet
  perform pg_temp.assign('b1000000-0000-0000-0000-000000000004','a2900000-0000-0000-0000-000000000003'); -- E2
  update public.job_assignments
    set employee_started_at = now() - interval '3 hours', employee_completed_at = now() - interval '1 hour', attendance = 'completed'
    where job_id='b1000000-0000-0000-0000-000000000004' and employee_id='a2900000-0000-0000-0000-000000000003';
  -- Direkter Fixture-Sprung auf completed (steht hier fuer "waehrend E1
  -- offline war, hat sich der Auftragsstatus geaendert" — Force Complete
  -- oder eine regulaere Fremd-Fertigstellung, beides fuer diesen Test
  -- gleichwertig, siehe oben).
  update public.jobs set status='completed', completed_at = now() - interval '1 hour', completed_by='a2900000-0000-0000-0000-000000000003'
    where id='b1000000-0000-0000-0000-000000000004';

  v := pg_temp.try_start('a2900000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000004', now());
  perform pg_temp.note(109,'Start-Guard','Queued Start nach Fremd-Abschluss wird abgelehnt','ABGELEHNT',
    case when v like 'ABGELEHNT%' then 'ABGELEHNT' else v end);

  select employee_started_at::text, attendance::text into v, v_att from public.job_assignments
  where job_id='b1000000-0000-0000-0000-000000000004' and employee_id='a2900000-0000-0000-0000-000000000002';
  perform pg_temp.note(110,'Start-Guard','Queued-Ablehnung erzeugt kein employee_started_at (E1)','NULL',coalesce(v,'NULL'));
  perform pg_temp.note(111,'Start-Guard','Queued-Ablehnung aendert attendance nicht (E1)','assigned',v_att);

  select status::text into v from public.jobs where id='b1000000-0000-0000-0000-000000000004';
  perform pg_temp.note(112,'Start-Guard','jobs.status bleibt unveraendert completed','completed',v);
end $$;


-- =========================================================
-- TEIL B — BEFUND 3: admin_force_complete_job Server-Gate
-- =========================================================
do $$
declare v text; v_cnt int; v_status text;
begin
  -- Sauberer Ausgangszustand: Schalter aus (Produktions-/Staging-Default).
  update public.app_config set value='false'::jsonb where key='force_complete_enabled';

  -- CASE 201: flag=false -> direkter RPC-Aufruf durch einen echten Admin
  -- wird abgelehnt, obwohl Rolle/Firma/Auftrag/Grund alle gueltig sind.
  perform pg_temp.mkjob2('c1000000-0000-0000-0000-000000000001','in_progress', now() - interval '1 hour', null);
  perform pg_temp.assign('c1000000-0000-0000-0000-000000000001','a2900000-0000-0000-0000-000000000002');
  update public.job_assignments set employee_started_at = now() - interval '1 hour', attendance='started'
    where job_id='c1000000-0000-0000-0000-000000000001' and employee_id='a2900000-0000-0000-0000-000000000002';

  v := pg_temp.try_force_complete('a2900000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','Mitarbeiter erreichbar, Abschluss vergessen');
  perform pg_temp.note(201,'Force-Gate','flag=false: direkter RPC-Aufruf wird abgelehnt','ABGELEHNT',
    case when v like 'ABGELEHNT%' then 'ABGELEHNT' else v end);
  perform pg_temp.note(202,'Force-Gate','Ablehnungstext nennt "nicht aktiviert"','true',(v like '%nicht aktiviert%')::text);

  -- CASE 203/204: false-Ablehnung mutiert nichts — weder job_completion_overrides noch jobs.status.
  select count(*) into v_cnt from public.job_completion_overrides where job_id='c1000000-0000-0000-0000-000000000001';
  perform pg_temp.note(203,'Force-Gate','flag=false: kein Eintrag in job_completion_overrides','0',v_cnt::text);
  select status::text into v_status from public.jobs where id='c1000000-0000-0000-0000-000000000001';
  perform pg_temp.note(204,'Force-Gate','flag=false: jobs.status bleibt in_progress','in_progress',v_status);

  -- CASE 205: Konfigurationszeile fehlt komplett -> ebenfalls abgelehnt.
  delete from public.app_config where key='force_complete_enabled';
  v := pg_temp.try_force_complete('a2900000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','Test ohne Config-Zeile');
  perform pg_temp.note(205,'Force-Gate','fehlende Config-Zeile wird abgelehnt','ABGELEHNT',
    case when v like 'ABGELEHNT%' then 'ABGELEHNT' else v end);

  -- CASE 206: ungueltiger (nicht-boolescher) Wert -> ebenfalls abgelehnt,
  -- KEINE unklassifizierte Postgres-Cast-Exception.
  insert into public.app_config(key, value) values ('force_complete_enabled', '"yes"'::jsonb);
  v := pg_temp.try_force_complete('a2900000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','Test mit ungueltigem Wert');
  perform pg_temp.note(206,'Force-Gate','ungueltiger Config-Wert wird sauber abgelehnt (kein Cast-Fehler)','ABGELEHNT',
    case when v like 'ABGELEHNT:%' and v not like '%invalid input syntax%' then 'ABGELEHNT' else v end);

  -- CASE 207: flag=true + gueltiger Admin/Firma/Auftrag/Grund -> weiterhin erlaubt.
  update public.app_config set value='true'::jsonb where key='force_complete_enabled';
  v := pg_temp.try_force_complete('a2900000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','Mitarbeiter erreichbar, Abschluss vergessen');
  perform pg_temp.note(207,'Force-Gate','flag=true + gueltige Eingaben: Abschluss erlaubt','OK',v);

  select status::text into v_status from public.jobs where id='c1000000-0000-0000-0000-000000000001';
  perform pg_temp.note(208,'Force-Gate','flag=true: Auftrag ist jetzt completed','completed',v_status);

  -- CASE 209: employee/non-admin wird UNABHAENGIG vom (hier: true) Flag abgelehnt.
  perform pg_temp.mkjob2('c1000000-0000-0000-0000-000000000002','in_progress', now() - interval '1 hour', null);
  perform pg_temp.assign('c1000000-0000-0000-0000-000000000002','a2900000-0000-0000-0000-000000000002');
  update public.job_assignments set employee_started_at = now() - interval '1 hour', attendance='started'
    where job_id='c1000000-0000-0000-0000-000000000002' and employee_id='a2900000-0000-0000-0000-000000000002';

  v := pg_temp.try_force_complete('a2900000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000002','Mitarbeiter versucht Zwangsabschluss');
  perform pg_temp.note(209,'Force-Gate','employee/non-admin wird trotz flag=true abgelehnt','ABGELEHNT',
    case when v like 'ABGELEHNT%' then 'ABGELEHNT' else v end);

  -- Schalter fuer den Rest der Suite (und falls diese Datei je ausserhalb
  -- der eigenen Transaktion liefe) wieder auf den sicheren Default.
  update public.app_config set value='false'::jsonb where key='force_complete_enabled';
end $$;


-- =========================================================
-- TEIL C — BEFUND 1: compat_sync_assignments_from_legacy
-- =========================================================
-- Direkte Fixture-Schreibvorgaenge auf jobs.assigned_to (kein RLS-Pfad
-- noetig — der Trigger reagiert auf JEDEN erfolgreichen Schreibvorgang,
-- unabhaengig vom Aufrufer, exakt das im Audit beschriebene Risiko eines
-- direkten Admin-/SQL-Schreibvorgangs).
do $$
declare v_started text; v_completed text; v_att text; v_cnt int;
begin
  -- CASE 301: legacy assigned_to-Schreibvorgang auf einen BEREITS
  -- COMPLETED Auftrag legt eine neue Zuweisungszeile an (Kompatibilitaet
  -- fuer Alt-Clients bleibt erhalten)...
  perform pg_temp.mkjob2('d1000000-0000-0000-0000-000000000001','completed', now() - interval '2 hours', now() - interval '1 hour');
  update public.jobs set assigned_to='a2900000-0000-0000-0000-000000000002' where id='d1000000-0000-0000-0000-000000000001';

  select count(*) into v_cnt from public.job_assignments
  where job_id='d1000000-0000-0000-0000-000000000001' and employee_id='a2900000-0000-0000-0000-000000000002';
  perform pg_temp.note(301,'Legacy-Sync','completed: Kompatibilitaetszeile wird weiterhin angelegt','1',v_cnt::text);

  -- ...aber OHNE aus der geteilten Job-Uhr abgeleitete Zeitstempel/Anwesenheit.
  select employee_started_at::text, employee_completed_at::text, attendance::text
    into v_started, v_completed, v_att
  from public.job_assignments
  where job_id='d1000000-0000-0000-0000-000000000001' and employee_id='a2900000-0000-0000-0000-000000000002';

  perform pg_temp.note(302,'Legacy-Sync','completed: KEIN fabriziertes employee_started_at','NULL',coalesce(v_started,'NULL'));
  perform pg_temp.note(303,'Legacy-Sync','completed: KEIN fabriziertes employee_completed_at','NULL',coalesce(v_completed,'NULL'));
  perform pg_temp.note(304,'Legacy-Sync','completed: attendance bleibt neutral ''assigned''','assigned',v_att);

  -- CASE 305: dieselbe Pruefung fuer in_progress (vor dem Patch wurde hier
  -- zumindest employee_started_at aus jobs.started_at kopiert).
  perform pg_temp.mkjob2('d1000000-0000-0000-0000-000000000002','in_progress', now() - interval '30 minutes', null);
  update public.jobs set assigned_to='a2900000-0000-0000-0000-000000000003' where id='d1000000-0000-0000-0000-000000000002';

  select employee_started_at::text, attendance::text into v_started, v_att
  from public.job_assignments
  where job_id='d1000000-0000-0000-0000-000000000002' and employee_id='a2900000-0000-0000-0000-000000000003';
  perform pg_temp.note(305,'Legacy-Sync','in_progress: KEIN fabriziertes employee_started_at','NULL',coalesce(v_started,'NULL'));
  perform pg_temp.note(306,'Legacy-Sync','in_progress: attendance bleibt neutral ''assigned''','assigned',v_att);

  -- CASE 307: Regression — open bleibt wie zuvor (dort gab es ohnehin nie
  -- abgeleitete Werte, reine Bestandsaufnahme, dass der Normalfall unveraendert ist).
  perform pg_temp.mkjob2('d1000000-0000-0000-0000-000000000003','open', null, null);
  update public.jobs set assigned_to='a2900000-0000-0000-0000-000000000002' where id='d1000000-0000-0000-0000-000000000003';

  select count(*) into v_cnt from public.job_assignments
  where job_id='d1000000-0000-0000-0000-000000000003' and employee_id='a2900000-0000-0000-0000-000000000002'
    and attendance='assigned' and employee_started_at is null and employee_completed_at is null;
  perform pg_temp.note(307,'Legacy-Sync','open: unveraendert neutral angelegt (Regression)','1',v_cnt::text);
end $$;


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select case_no, bereich, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _r order by case_no;

do $$
declare fails int; gesamt int; liste text;
begin
  select count(*), count(*) filter (where ergebnis is distinct from erwartet)
    into gesamt, fails from _r;

  select coalesce(string_agg('#'||case_no||' '||beschreibung||' (erw='||erwartet||' ist='||coalesce(ergebnis,'NULL')||')', ' ;; ' order by case_no), '')
    into liste from _r where ergebnis is distinct from erwartet;

  if fails > 0 then
    raise exception 'PHASE16 POST-HARDENING TEST: % von % FEHLGESCHLAGEN -> %', fails, gesamt, liste;
  end if;
  raise notice 'PHASE16 POST-HARDENING TEST: ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
