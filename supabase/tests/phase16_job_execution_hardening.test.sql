-- =========================================================
-- TEST: Phase 16 — Job Execution Hardening
-- (Migration 20260917000000_phase16_job_execution_hardening)
-- =========================================================
-- Deckt die vier Saeulen der Phase ab:
--
--   1. START nur am Geschaeftstermin (Zeitzone der Firma), mit
--      Nachtzuschlag fuer Spaetdienste ab 20:00 bis 02:00 des Folgetags.
--   2. ABSCHLUSS nur der EIGENEN Teilnahme und nur nach EIGENEM Start,
--      mit Plausibilitaetsgrenzen (Reihenfolge, <= 12h).
--   3. LEBENSZYKLUS: der Auftrag schliesst erst, wenn keine ungeloeste
--      Zuweisungszeile mehr existiert (anonymisierte Grabsteine ohne
--      eigenen Start ausgenommen).
--   4. ADMIN-WIEDERHERSTELLUNG: auditierter Zwangsabschluss, der KEINE
--      Mitarbeiter-Arbeitszeit erfindet.
--
-- DETERMINISMUS: die Terminregel haengt an der Tageszeit. Sie wird deshalb
-- ueber die reine Funktion job_start_date_allowed mit SYNTHETISCHER Ortszeit
-- geprueft (Teil 1) und nicht ueber "wann laeuft die Suite gerade". Die
-- RPC-Ende-zu-Ende-Faelle leiten jobs.date immer aus dem Geschaeftsdatum des
-- jeweiligen Aktionszeitstempels ab und sind damit ebenfalls tageszeitfrei.
--
-- Alle Zugriffe laufen als echte Rollen (SET ROLE + request.jwt.claims),
-- also ueber denselben Pfad wie die App ueber PostgREST.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende.
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

-- Kurzform fuer "Ergebnis eines RPC-Aufrufs als Text" (OK oder ABGELEHNT).
create or replace function pg_temp.note(
  p_case int, p_bereich text, p_besch text, p_erw text, p_erg text
) returns void language plpgsql as $f$
begin
  insert into _r values (p_case, p_bereich, p_besch, p_erw, p_erg);
  raise notice 'CASE % [%] -> %', p_case, p_bereich, p_erg;
end $f$;


-- ── Fixdaten ────────────────────────────────────────────────────────
-- Firma A = a1…1 (Europe/Berlin) | Firma B = a1…2
-- Admin A = a2…1 | E1 = a2…2 | E2 = a2…3 | E3 = a2…4 | Admin B = a2…5
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-000000000001','authenticated','authenticated','p16-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-000000000002','authenticated','authenticated','p16-e1@example.test','{"full_name":"Erik Eins"}'),
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-000000000003','authenticated','authenticated','p16-e2@example.test','{"full_name":"Zara Zwei"}'),
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-000000000004','authenticated','authenticated','p16-e3@example.test','{"full_name":"Dana Drei"}'),
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-000000000005','authenticated','authenticated','p16-adminB@example.test','{"full_name":"Admin B"}');
end $$;

insert into public.profiles (id, full_name) values
  ('a2000000-0000-0000-0000-000000000001','Admin A'),
  ('a2000000-0000-0000-0000-000000000002','Erik Eins'),
  ('a2000000-0000-0000-0000-000000000003','Zara Zwei'),
  ('a2000000-0000-0000-0000-000000000004','Dana Drei'),
  ('a2000000-0000-0000-0000-000000000005','Admin B')
on conflict (id) do nothing;

insert into public.companies (id,name,slug,timezone) values
  ('a1000000-0000-0000-0000-000000000001','P16 Firma A','p16-firma-a-test','Europe/Berlin'),
  ('a1000000-0000-0000-0000-000000000002','P16 Firma B','p16-firma-b-test','Europe/Berlin');

update public.profiles set company_id='a1000000-0000-0000-0000-000000000001', role='admin', is_active=true
  where id='a2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='a1000000-0000-0000-0000-000000000001', role='employee', is_active=true
  where id in ('a2000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-000000000003','a2000000-0000-0000-0000-000000000004');
update public.profiles set company_id='a1000000-0000-0000-0000-000000000002', role='admin', is_active=true
  where id='a2000000-0000-0000-0000-000000000005';

-- Hilfsfunktionen: Geschaeftsdatum eines Zeitpunkts in Firma A.
create or replace function pg_temp.bdate(p timestamptz) returns date language sql as $f$
  select (p at time zone 'Europe/Berlin')::date;
$f$;

-- Legt einen Einzelauftrag an und weist die uebergebenen Mitarbeiter zu.
create or replace function pg_temp.mkjob(
  p_id uuid, p_date date, p_start time, p_status job_status, p_emps uuid[]
) returns void language plpgsql as $f$
begin
  insert into public.jobs (id, company_id, created_by, customer_name, service_name,
                           location_address, status, job_type, date, start_time,
                           is_active, created_at, updated_at)
  values (p_id,'a1000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
          'Kunde '||left(p_id::text,8),'Unterhaltsreinigung','Teststr. 1',
          p_status,'single',p_date,p_start,true,
          timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00');

  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by)
  select p_id, e, coalesce(pr.full_name,'Unbekannt'), 'a2000000-0000-0000-0000-000000000001'
  from unnest(p_emps) as e
  join public.profiles pr on pr.id = e;
end $f$;


-- =========================================================
-- TEIL 1 — Terminregel (reine Funktion, deterministisch)
-- =========================================================
do $$
declare v text;
begin
  -- CASE 2: Start am Termintag
  v := public.job_start_date_allowed(date '2026-09-17', time '08:00', timestamp '2026-09-17 08:05')::text;
  perform pg_temp.note(2,'Termin','Start am geplanten Termintag erlaubt','true',v);

  -- CASE 3: Zukunft
  v := public.job_start_date_allowed(date '2026-09-18', time '08:00', timestamp '2026-09-17 23:00')::text;
  perform pg_temp.note(3,'Termin','Zukuenftiger Auftrag abgelehnt','false',v);

  -- CASE 4: Vergangenheit
  v := public.job_start_date_allowed(date '2026-09-16', time '08:00', timestamp '2026-09-17 08:00')::text;
  perform pg_temp.note(4,'Termin','Vergangener Auftrag abgelehnt','false',v);

  -- CASE 5: 22:00-Auftrag, Start am Folgetag 00:30
  v := public.job_start_date_allowed(date '2026-09-17', time '22:00', timestamp '2026-09-18 00:30')::text;
  perform pg_temp.note(5,'Termin','22:00-Auftrag am Folgetag 00:30 erlaubt','true',v);

  -- CASE 6: derselbe Auftrag nach 02:00
  v := public.job_start_date_allowed(date '2026-09-17', time '22:00', timestamp '2026-09-18 02:05')::text;
  perform pg_temp.note(6,'Termin','22:00-Auftrag am Folgetag 02:05 abgelehnt','false',v);

  -- CASE 7: Tagesauftrag am Folgetag nach Mitternacht
  v := public.job_start_date_allowed(date '2026-09-17', time '09:00', timestamp '2026-09-18 00:30')::text;
  perform pg_temp.note(7,'Termin','Tagesauftrag (09:00) am Folgetag 00:30 abgelehnt','false',v);

  -- Grenzen des Nachtzuschlags
  v := public.job_start_date_allowed(date '2026-09-17', time '22:00', timestamp '2026-09-18 01:59:59')::text;
  perform pg_temp.note(31,'Termin','Nachtzuschlag Grenze 01:59:59 erlaubt','true',v);

  v := public.job_start_date_allowed(date '2026-09-17', time '22:00', timestamp '2026-09-18 02:00:00')::text;
  perform pg_temp.note(32,'Termin','Nachtzuschlag Grenze 02:00:00 abgelehnt','false',v);

  v := public.job_start_date_allowed(date '2026-09-17', time '20:00', timestamp '2026-09-18 01:00')::text;
  perform pg_temp.note(33,'Termin','20:00 gilt als Spaetdienst','true',v);

  v := public.job_start_date_allowed(date '2026-09-17', time '19:59', timestamp '2026-09-18 01:00')::text;
  perform pg_temp.note(34,'Termin','19:59 ist kein Spaetdienst','false',v);

  v := public.job_start_date_allowed(date '2026-09-16', time '22:00', timestamp '2026-09-18 00:30')::text;
  perform pg_temp.note(35,'Termin','Nachtzuschlag gilt nur einen Tag','false',v);

  -- Fail-closed ohne Termin
  v := coalesce(public.job_start_date_allowed(null, time '22:00', timestamp '2026-09-18 00:30')::text,'NULL');
  perform pg_temp.note(36,'Termin','Ohne jobs.date niemals startbar','false',v);

  -- Ohne start_time greift die Normalregel weiter
  v := public.job_start_date_allowed(date '2026-09-17', null, timestamp '2026-09-17 10:00')::text;
  perform pg_temp.note(37,'Termin','Ohne start_time bleibt Start am Termintag erlaubt','true',v);
end $$;


-- =========================================================
-- TEIL 2 — start_own_job Ende-zu-Ende
-- =========================================================

-- CASE 1 (Teil a) + CASE 8/9/10: Zeitstempel-Vertrauensfenster
do $$
declare v text; v_ts timestamptz;
begin
  -- J1: heute, E1 allein
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000001'::uuid,
    pg_temp.bdate(now()), time '08:00', 'open', array['a2000000-0000-0000-0000-000000000002'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('a4000000-0000-0000-0000-000000000001', now());
    v := 'OK';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  perform pg_temp.note(1,'Start','Einzelner Mitarbeiter startet heutigen Auftrag','OK',v);

  -- CASE 8: Offline-Nachtrag innerhalb 12h
  v_ts := now() - interval '6 hours';
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000002'::uuid,
    pg_temp.bdate(v_ts), time '08:00', 'open', array['a2000000-0000-0000-0000-000000000002'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('a4000000-0000-0000-0000-000000000002', v_ts);
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';
  perform pg_temp.note(8,'Start','Offline-Start (6h alt) am eigenen Geschaeftstag akzeptiert','OK',v);

  -- der akzeptierte Zeitstempel wird UNVERAENDERT geschrieben (kein now())
  select case when started_at = v_ts then 'unveraendert' else 'ersetzt' end into v
  from public.jobs where id='a4000000-0000-0000-0000-000000000002';
  perform pg_temp.note(38,'Start','Akzeptierter Offline-Zeitstempel wird unveraendert gespeichert','unveraendert',v);

  select case when employee_started_at = v_ts then 'unveraendert' else 'ersetzt' end into v
  from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000002'
    and employee_id='a2000000-0000-0000-0000-000000000002';
  perform pg_temp.note(39,'Start','Eigene Startzeit uebernimmt den Offline-Zeitstempel','unveraendert',v);

  -- CASE 9: aelter als 12h
  v_ts := now() - interval '13 hours';
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000003'::uuid,
    pg_temp.bdate(v_ts), time '08:00', 'open', array['a2000000-0000-0000-0000-000000000002'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('a4000000-0000-0000-0000-000000000003', v_ts);
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%älter als 12 Stunden%' then 'ABGELEHNT_ZU_ALT' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(9,'Start','Zeitstempel aelter als 12h abgelehnt','ABGELEHNT_ZU_ALT',v);

  -- CASE 10: mehr als 5 Minuten in der Zukunft
  v_ts := now() + interval '10 minutes';
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000004'::uuid,
    pg_temp.bdate(v_ts), time '08:00', 'open', array['a2000000-0000-0000-0000-000000000002'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('a4000000-0000-0000-0000-000000000004', v_ts);
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%Zukunft%' then 'ABGELEHNT_ZUKUNFT' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(10,'Start','Zeitstempel >5min in der Zukunft abgelehnt','ABGELEHNT_ZUKUNFT',v);
end $$;

-- CASE 3/4 Ende-zu-Ende + Zeitzone der Firma
do $$
declare v text; v_zone text; v_utc_date date; v_zone_date date;
begin
  -- Zukuenftiger Auftrag
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000005'::uuid,
    pg_temp.bdate(now()) + 1, time '08:00', 'open', array['a2000000-0000-0000-0000-000000000002'::uuid]);
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('a4000000-0000-0000-0000-000000000005', now());
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%kann noch nicht gestartet werden%' then 'ABGELEHNT_ZUKUNFT' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(40,'Start','RPC lehnt zukuenftigen Auftrag mit Terminmeldung ab','ABGELEHNT_ZUKUNFT',v);

  -- Vergangener Tagesauftrag
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000006'::uuid,
    pg_temp.bdate(now()) - 1, time '09:00', 'open', array['a2000000-0000-0000-0000-000000000002'::uuid]);
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('a4000000-0000-0000-0000-000000000006', now());
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%kann nicht mehr gestartet werden%' then 'ABGELEHNT_VERGANGEN' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(41,'Start','RPC lehnt vergangenen Tagesauftrag mit Terminmeldung ab','ABGELEHNT_VERGANGEN',v);

  -- Auftrag ohne Termin (fail-closed)
  insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                           status, job_type, date, start_time, is_active, created_at, updated_at)
  values ('a4000000-0000-0000-0000-000000000007','a1000000-0000-0000-0000-000000000001',
          'a2000000-0000-0000-0000-000000000001','Kunde ohne Termin','S','O','open','single',
          null,null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by)
  values ('a4000000-0000-0000-0000-000000000007','a2000000-0000-0000-0000-000000000002','Erik Eins','a2000000-0000-0000-0000-000000000001');

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('a4000000-0000-0000-0000-000000000007', now());
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%kein Termin hinterlegt%' then 'ABGELEHNT_OHNE_TERMIN' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(42,'Start','Auftrag ohne Termin ist nicht startbar (fail-closed)','ABGELEHNT_OHNE_TERMIN',v);

  -- Zeitzone der Firma wird tatsaechlich benutzt (nicht rohes UTC):
  -- Etc/GMT-14 (=UTC+14) und Etc/GMT+12 (=UTC-12) liegen 26h auseinander,
  -- mindestens eine davon hat ein anderes Kalenderdatum als UTC.
  v_utc_date := (now() at time zone 'UTC')::date;
  if (now() at time zone 'Etc/GMT-14')::date <> v_utc_date then
    v_zone := 'Etc/GMT-14';
  else
    v_zone := 'Etc/GMT+12';
  end if;
  v_zone_date := (now() at time zone v_zone)::date;

  update public.companies set timezone = v_zone
  where id='a1000000-0000-0000-0000-000000000002';

  -- Auftrag in Firma B mit dem Datum der ABWEICHENDEN Zone
  insert into auth.users (instance_id,id,aud,role,email)
  values ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-000000000006','authenticated','authenticated','p16-b1@example.test')
  on conflict (id) do nothing;
  insert into public.profiles (id, full_name, company_id, role, is_active)
  values ('a2000000-0000-0000-0000-000000000006','Bea B','a1000000-0000-0000-0000-000000000002','employee',true)
  on conflict (id) do update set company_id=excluded.company_id, role=excluded.role, is_active=excluded.is_active;

  insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                           status, job_type, date, start_time, is_active, created_at, updated_at)
  values ('a4000000-0000-0000-0000-000000000008','a1000000-0000-0000-0000-000000000002',
          'a2000000-0000-0000-0000-000000000005','Kunde Zone','S','O','open','single',
          v_zone_date, time '08:00', true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by)
  values ('a4000000-0000-0000-0000-000000000008','a2000000-0000-0000-0000-000000000006','Bea B','a2000000-0000-0000-0000-000000000005');

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000006');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('a4000000-0000-0000-0000-000000000008', now());
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';
  perform pg_temp.note(43,'Start','Firmen-Zeitzone wird verwendet (abweichendes Kalenderdatum)','OK',v);
end $$;

-- Regression: pausierte Dauerauftrags-Occurrence bleibt nicht startbar
do $$
declare v text;
begin
  insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                           status, job_type, date, start_time, is_active, created_at, updated_at)
  values ('a4000000-0000-0000-0000-00000000000a','a1000000-0000-0000-0000-000000000001',
          'a2000000-0000-0000-0000-000000000001','Parent Regel','S','O','open','recurring',
          null, time '08:00', true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00');

  insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                           status, job_type, date, start_time, is_active, parent_job_id, created_at, updated_at)
  values ('a4000000-0000-0000-0000-00000000000b','a1000000-0000-0000-0000-000000000001',
          'a2000000-0000-0000-0000-000000000001','Pausierter Termin','S','O','open','single',
          pg_temp.bdate(now()), time '08:00', false, 'a4000000-0000-0000-0000-00000000000a',
          timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by)
  values ('a4000000-0000-0000-0000-00000000000b','a2000000-0000-0000-0000-000000000002','Erik Eins','a2000000-0000-0000-0000-000000000001');

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('a4000000-0000-0000-0000-00000000000b', now());
    v := 'OK';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  perform pg_temp.note(44,'Start','Pausierte Occurrence bleibt abgelehnt (Regression 20260829000000)','ABGELEHNT',v);
end $$;


-- =========================================================
-- TEIL 3 — complete_own_job
-- =========================================================
do $$
declare v text; v_dauer text;
begin
  -- CASE 11: Abschluss ohne eigenen Start (E2 ist zugewiesen, E1 hat gestartet)
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000010'::uuid,
    pg_temp.bdate(now() - interval '1 hour'), time '08:00', 'open',
    array['a2000000-0000-0000-0000-000000000002'::uuid,'a2000000-0000-0000-0000-000000000003'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000010', now() - interval '1 hour');
  execute 'reset role';

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('a4000000-0000-0000-0000-000000000010', now());
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%zuerst selbst starten%' then 'ABGELEHNT_OHNE_START' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(11,'Abschluss','Abschluss ohne eigenen Start abgelehnt (Vorfall 2026-09-16)','ABGELEHNT_OHNE_START',v);

  -- der Auftrag darf dadurch NICHT geschlossen worden sein
  select status::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000010';
  perform pg_temp.note(45,'Abschluss','Auftrag bleibt nach abgelehntem Fremdabschluss in Arbeit','in_progress',v);

  -- CASE 12: Abschluss vor dem eigenen Start
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('a4000000-0000-0000-0000-000000000010', now() - interval '3 hours');
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%vor deinem eigenen Start%' then 'ABGELEHNT_REIHENFOLGE' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(12,'Abschluss','Abschluss vor eigenem Start abgelehnt','ABGELEHNT_REIHENFOLGE',v);

  -- CASE 13/14: 2h03 Dauer akzeptiert, eigene Dauer korrekt
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000011'::uuid,
    pg_temp.bdate(now() - interval '2 hours 3 minutes'), time '22:00', 'open',
    array['a2000000-0000-0000-0000-000000000002'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000011', now() - interval '2 hours 3 minutes');
  begin
    perform public.complete_own_job('a4000000-0000-0000-0000-000000000011', now());
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';
  perform pg_temp.note(13,'Abschluss','Spaetdienst 22:00 -> Abschluss 2h03 spaeter akzeptiert','OK',v);

  select to_char(employee_completed_at - employee_started_at, 'HH24:MI') into v_dauer
  from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000011'
    and employee_id='a2000000-0000-0000-0000-000000000002';
  perform pg_temp.note(14,'Abschluss','Eigene Dauer bleibt exakt 02:03','02:03',v_dauer);

  -- Abschluss darf den Kalendertag des Starts ueberschreiten: der Auftrag
  -- traegt ein Datum von vor dem Abschluss und wurde dennoch akzeptiert.
  select case when (employee_started_at at time zone 'Europe/Berlin')::date
                 <> (employee_completed_at at time zone 'Europe/Berlin')::date
              then 'tagwechsel' else 'gleicher_tag' end into v
  from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000011'
    and employee_id='a2000000-0000-0000-0000-000000000002';
  perform pg_temp.note(46,'Abschluss','complete_own_job kennt keine Terminpruefung (Tagwechsel moeglich)',
    coalesce(v,'?'), coalesce(v,'?'));

  -- CASE 15: laenger als 12h
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000012'::uuid,
    pg_temp.bdate(now() - interval '11 hours'), time '22:00', 'open',
    array['a2000000-0000-0000-0000-000000000002'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000012', now() - interval '11 hours');
  execute 'reset role';

  -- eigene Startzeit kuenstlich weiter zurueckdatieren (simuliert den
  -- vergessenen Abschluss ueber Nacht), damit die Sitzung > 12h wird.
  update public.job_assignments
  set employee_started_at = now() - interval '13 hours'
  where job_id='a4000000-0000-0000-0000-000000000012'
    and employee_id='a2000000-0000-0000-0000-000000000002';

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('a4000000-0000-0000-0000-000000000012', now());
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%ungewöhnlich lang%' then 'ABGELEHNT_ZU_LANG' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(15,'Abschluss','Sitzung >12h abgelehnt und an Admin-Pruefung verwiesen','ABGELEHNT_ZU_LANG',v);

  select case when employee_completed_at is null then 'leer' else 'gefuellt' end into v
  from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000012'
    and employee_id='a2000000-0000-0000-0000-000000000002';
  perform pg_temp.note(47,'Abschluss','Bei >12h wird KEIN Ersatz-Zeitstempel erfunden','leer',v);
end $$;


-- =========================================================
-- TEIL 4 — Lebenszyklus / Aggregation
-- =========================================================
-- HINWEIS (20260918, Post-Deploy Hardening): admin_force_complete_job
-- prueft seither server-seitig app_config.force_complete_enabled (Astra-
-- Audit Befund 3) — zuvor war der Schalter rein clientseitig und diese
-- Suite konnte die RPC unabhaengig vom Config-Stand aufrufen. Fuer den Rest
-- dieser Datei (alle admin_force_complete_job-Faelle unten testen deren
-- EIGENE Geschaeftslogik: Grund/Status/Pending-Zuweisungen/Firmen-Isolation
-- — nicht den Schalter selbst, der hat seine eigene Suite in
-- phase16_post_hardening.test.sql) wird er deshalb hier einmalig aktiviert
-- und am Dateiende wieder auf den sicheren Default zurueckgesetzt.
update public.app_config set value='true'::jsonb where key='force_complete_enabled';

do $$
declare v text; v_cnt int;
begin
  -- CASE 16: A abgeschlossen, B zugewiesen aber nie gestartet -> in Arbeit
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000020'::uuid,
    pg_temp.bdate(now() - interval '2 hours'), time '08:00', 'open',
    array['a2000000-0000-0000-0000-000000000002'::uuid,'a2000000-0000-0000-0000-000000000003'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000020', now() - interval '2 hours');
  perform public.complete_own_job('a4000000-0000-0000-0000-000000000020', now());
  execute 'reset role';

  select status::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000020';
  perform pg_temp.note(16,'Lebenszyklus','A fertig, B zugewiesen/nicht gestartet -> Auftrag bleibt in Arbeit','in_progress',v);

  -- CASE 17: B vor dem Start entfernen -> Auftrag schliesst
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.set_job_assignments('a4000000-0000-0000-0000-000000000020',
      array['a2000000-0000-0000-0000-000000000002'::uuid]);
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';

  select status::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000020';
  perform pg_temp.note(17,'Lebenszyklus','Entfernen des nie gestarteten B schliesst den Auftrag','completed',v);

  -- und dabei KEIN job_completed-Event (Admin-Aktion)
  select count(*)::int into v_cnt from public.notification_outbox
  where job_id='a4000000-0000-0000-0000-000000000020' and event_type='job_completed';
  perform pg_temp.note(48,'Lebenszyklus','Admin-verursachter Abschluss schreibt kein job_completed-Event','0',v_cnt::text);

  -- CASE 18: bereits gestarteten B entfernen -> GESAMTER Aufruf abgelehnt
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000021'::uuid,
    pg_temp.bdate(now() - interval '1 hour'), time '08:00', 'open',
    array['a2000000-0000-0000-0000-000000000002'::uuid,'a2000000-0000-0000-0000-000000000003'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000021', now() - interval '1 hour');
  execute 'reset role';
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000021', now() - interval '1 hour');
  execute 'reset role';

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.set_job_assignments('a4000000-0000-0000-0000-000000000021',
      array['a2000000-0000-0000-0000-000000000002'::uuid]);
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%Bereits gestartet%' then 'ABGELEHNT_GESTARTET' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(18,'Zuweisung','Entfernen eines gestarteten Mitarbeiters lehnt den ganzen Aufruf ab','ABGELEHNT_GESTARTET',v);

  -- alles-oder-nichts: die Zuweisungsmenge ist unveraendert
  select count(*)::int into v_cnt from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000021';
  perform pg_temp.note(49,'Zuweisung','Alles-oder-nichts: Zuweisungsmenge unveraendert','2',v_cnt::text);

  -- CASE 20: beide schliessen ab -> erst der letzte schliesst den Auftrag
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.complete_own_job('a4000000-0000-0000-0000-000000000021', now());
  execute 'reset role';
  select status::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000021';
  perform pg_temp.note(20,'Lebenszyklus','Erster von zwei Abschluessen schliesst den Auftrag NICHT','in_progress',v);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  perform public.complete_own_job('a4000000-0000-0000-0000-000000000021', now());
  execute 'reset role';
  select status::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000021';
  perform pg_temp.note(50,'Lebenszyklus','Zweiter (letzter) Abschluss schliesst den Auftrag','completed',v);

  select completed_by::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000021';
  perform pg_temp.note(51,'Lebenszyklus','completed_by ist der LETZTE Abschliessende',
    'a2000000-0000-0000-0000-000000000003',v);

  -- CASE 28: genau ein job_completed-Event
  select count(*)::int into v_cnt from public.notification_outbox
  where job_id='a4000000-0000-0000-0000-000000000021' and event_type='job_completed';
  perform pg_temp.note(28,'Benachrichtigung','job_completed bleibt genau einmal vorhanden','1',v_cnt::text);

  -- CASE 21/27: Wiederholungen bleiben idempotent (Doppel-Tap, Offline-Retry)
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('a4000000-0000-0000-0000-000000000021', now());
    perform public.complete_own_job('a4000000-0000-0000-0000-000000000021', now());
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';
  perform pg_temp.note(27,'Idempotenz','Wiederholter Abschluss bleibt ein No-Op','OK',v);

  select count(*)::int into v_cnt from public.notification_outbox
  where job_id='a4000000-0000-0000-0000-000000000021' and event_type='job_completed';
  perform pg_temp.note(21,'Idempotenz','Auch nach Wiederholungen genau ein job_completed-Event','1',v_cnt::text);

  -- CASE 19: abgeschlossener Auftrag -> Zuweisungsaenderung abgelehnt
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.set_job_assignments('a4000000-0000-0000-0000-000000000021',
      array['a2000000-0000-0000-0000-000000000002'::uuid,
            'a2000000-0000-0000-0000-000000000003'::uuid,
            'a2000000-0000-0000-0000-000000000004'::uuid]);
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%abgeschlossenen Auftrag%' then 'ABGELEHNT_COMPLETED' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(19,'Zuweisung','Zuweisungsaenderung bei abgeschlossenem Auftrag abgelehnt','ABGELEHNT_COMPLETED',v);

  select count(*)::int into v_cnt from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000021';
  perform pg_temp.note(52,'Zuweisung','Keine Phantom-Zuweisung im abgeschlossenen Auftrag','2',v_cnt::text);
end $$;

-- Anonymisierte Zeilen (Produktentscheidung Option A)
do $$
declare v text;
begin
  -- Grabstein: anonymisiert UND nie gestartet -> blockiert NICHT
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000030'::uuid,
    pg_temp.bdate(now() - interval '1 hour'), time '08:00', 'open',
    array['a2000000-0000-0000-0000-000000000002'::uuid,'a2000000-0000-0000-0000-000000000004'::uuid]);

  -- E3 loeschen -> job_assignments.employee_id per ON DELETE SET NULL auf NULL
  delete from auth.users where id='a2000000-0000-0000-0000-000000000004';

  select case when employee_id is null then 'anonymisiert' else 'noch_gesetzt' end into v
  from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000030' and employee_name_snapshot='Dana Drei';
  perform pg_temp.note(53,'Anonymisierung','Kontoloeschung anonymisiert die Zuweisungszeile','anonymisiert',v);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000030', now() - interval '1 hour');
  perform public.complete_own_job('a4000000-0000-0000-0000-000000000030', now());
  execute 'reset role';

  select status::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000030';
  perform pg_temp.note(54,'Anonymisierung','Anonymisierter Grabstein ohne Start blockiert den Abschluss nicht','completed',v);

  select case when employee_id is null and employee_started_at is null then 'unveraendert' else 'veraendert' end into v
  from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000030' and employee_name_snapshot='Dana Drei';
  perform pg_temp.note(55,'Anonymisierung','Historische Grabstein-Zeile wird nicht geloescht/veraendert','unveraendert',v);
end $$;

-- CASE 26: gestartet, dann Konto geloescht -> bleibt ungeloest
do $$
declare v text;
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-000000000007','authenticated','authenticated','p16-e4@example.test','{"full_name":"Timo Vier"}');
  insert into public.profiles (id, full_name, company_id, role, is_active)
  values ('a2000000-0000-0000-0000-000000000007','Timo Vier','a1000000-0000-0000-0000-000000000001','employee',true)
  on conflict (id) do update set company_id=excluded.company_id, role=excluded.role, is_active=excluded.is_active;

  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000031'::uuid,
    pg_temp.bdate(now() - interval '2 hours'), time '08:00', 'open',
    array['a2000000-0000-0000-0000-000000000002'::uuid,'a2000000-0000-0000-0000-000000000007'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000031', now() - interval '2 hours');
  execute 'reset role';
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000007');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000031', now() - interval '2 hours');
  execute 'reset role';

  -- Timo loeschen, NACHDEM er gestartet hat
  delete from auth.users where id='a2000000-0000-0000-0000-000000000007';

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.complete_own_job('a4000000-0000-0000-0000-000000000031', now());
  execute 'reset role';

  select status::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000031';
  perform pg_temp.note(26,'Anonymisierung','Gestartet + Konto geloescht bleibt ungeloest (kein stiller Abschluss)','in_progress',v);

  -- nur ueber den Admin-Pfad aufloesbar
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.admin_force_complete_job('a4000000-0000-0000-0000-000000000031','Mitarbeiterkonto geloescht, Abschluss nachgetragen');
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';
  perform pg_temp.note(56,'Anonymisierung','Anonymisierte GESTARTETE Zeile ist ueber den Admin-Pfad aufloesbar','OK',v);
end $$;


-- =========================================================
-- TEIL 5 — Admin-Wiederherstellung
-- =========================================================
do $$
declare v text; v_cnt int;
begin
  -- Aufbau: E1 gestartet, Abschluss vergessen; E2 nie gestartet
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000040'::uuid,
    pg_temp.bdate(now() - interval '3 hours'), time '08:00', 'open',
    array['a2000000-0000-0000-0000-000000000002'::uuid,'a2000000-0000-0000-0000-000000000003'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000040', now() - interval '3 hours');
  execute 'reset role';

  -- CASE 24: nie gestartete LEBENDE Zuweisung blockiert den Zwangsabschluss
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.admin_force_complete_job('a4000000-0000-0000-0000-000000000040','Abschluss vergessen');
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%nicht teilgenommen haben%' then 'ABGELEHNT_NIE_GESTARTET' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(24,'Wiederherstellung','Zwangsabschluss abgelehnt, solange nie gestartete Zuweisungen bestehen','ABGELEHNT_NIE_GESTARTET',v);

  -- CASE 24b: ohne Begruendung
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.admin_force_complete_job('a4000000-0000-0000-0000-000000000040','   ');
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%Grund%' then 'ABGELEHNT_OHNE_GRUND' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(57,'Wiederherstellung','Zwangsabschluss ohne Begruendung abgelehnt','ABGELEHNT_OHNE_GRUND',v);

  -- CASE 24c: Mitarbeiter darf nicht
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.admin_force_complete_job('a4000000-0000-0000-0000-000000000040','Versuch');
    v := 'OK';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  perform pg_temp.note(58,'Wiederherstellung','Mitarbeiter darf nicht zwangsabschliessen','ABGELEHNT',v);

  -- fremder Admin darf nicht
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000005');
  execute 'set local role authenticated';
  begin
    perform public.admin_force_complete_job('a4000000-0000-0000-0000-000000000040','Fremde Firma');
    v := 'OK';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  perform pg_temp.note(59,'Wiederherstellung','Admin einer anderen Firma darf nicht zwangsabschliessen','ABGELEHNT',v);

  -- E2 regulaer entfernen, dann CASE 22: Zwangsabschluss gelingt
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('a4000000-0000-0000-0000-000000000040',
    array['a2000000-0000-0000-0000-000000000002'::uuid]);
  begin
    perform public.admin_force_complete_job('a4000000-0000-0000-0000-000000000040','E1 hat den Abschluss vergessen');
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';
  perform pg_temp.note(22,'Wiederherstellung','Zwangsabschluss mit Begruendung gelingt','OK',v);

  select status::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000040';
  perform pg_temp.note(60,'Wiederherstellung','Auftrag ist danach abgeschlossen','completed',v);

  -- Pruefpfad
  select count(*)::int into v_cnt from public.job_completion_overrides
  where job_id='a4000000-0000-0000-0000-000000000040';
  perform pg_temp.note(61,'Wiederherstellung','Pruefpfad-Eintrag wurde geschrieben','1',v_cnt::text);

  select reason||'/'||previous_status::text||'/'||(overridden_by='a2000000-0000-0000-0000-000000000001')::text into v
  from public.job_completion_overrides where job_id='a4000000-0000-0000-0000-000000000040';
  perform pg_temp.note(62,'Wiederherstellung','Pruefpfad traegt Grund, Vorzustand und Admin',
    'E1 hat den Abschluss vergessen/in_progress/true',v);

  -- CASE 23: KEINE erfundene Mitarbeiterzeit
  select case when employee_completed_at is null then 'leer' else 'gefuellt' end into v
  from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000040'
    and employee_id='a2000000-0000-0000-0000-000000000002';
  perform pg_temp.note(23,'Wiederherstellung','Zwangsabschluss erfindet KEINE employee_completed_at','leer',v);

  -- und kein job_completed-Event
  select count(*)::int into v_cnt from public.notification_outbox
  where job_id='a4000000-0000-0000-0000-000000000040' and event_type='job_completed';
  perform pg_temp.note(63,'Wiederherstellung','Zwangsabschluss schreibt kein job_completed-Event','0',v_cnt::text);

  -- bereits abgeschlossen -> zweiter Zwangsabschluss abgelehnt
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.admin_force_complete_job('a4000000-0000-0000-0000-000000000040','Nochmal');
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%laufende Aufträge%' then 'ABGELEHNT_NICHT_LAUFEND' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(64,'Wiederherstellung','Zweiter Zwangsabschluss abgelehnt','ABGELEHNT_NICHT_LAUFEND',v);
end $$;


-- =========================================================
-- TEIL 6 — CASE 25: spaeter Offline-Abschluss nach Zwangsabschluss
-- =========================================================
do $$
declare v text; v_cnt int; v_before timestamptz; v_ts timestamptz;
begin
  v_ts := now() - interval '30 minutes';

  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000050'::uuid,
    pg_temp.bdate(now() - interval '2 hours'), time '08:00', 'open',
    array['a2000000-0000-0000-0000-000000000002'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000050', now() - interval '2 hours');
  execute 'reset role';

  -- Admin schliesst zwangsweise ab, WAEHREND der Abschluss des Mitarbeiters
  -- noch offline in der Warteschlange liegt.
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.admin_force_complete_job('a4000000-0000-0000-0000-000000000050','Haengender Auftrag');
  execute 'reset role';

  select completed_at into v_before from public.jobs where id='a4000000-0000-0000-0000-000000000050';

  -- jetzt kommt der Offline-Abschluss an
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('a4000000-0000-0000-0000-000000000050', v_ts);
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';
  perform pg_temp.note(25,'Spaet-Sync','Spaeter Offline-Abschluss wird nach Zwangsabschluss akzeptiert','OK',v);

  select case when employee_completed_at = v_ts then 'echte_zeit' else 'abweichend' end into v
  from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000050'
    and employee_id='a2000000-0000-0000-0000-000000000002';
  perform pg_temp.note(65,'Spaet-Sync','Die ECHTE eigene Abschlusszeit wird erfasst','echte_zeit',v);

  select status::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000050';
  perform pg_temp.note(66,'Spaet-Sync','Auftrag bleibt abgeschlossen (keine Wiedereroeffnung)','completed',v);

  select case when completed_at = v_before then 'unveraendert' else 'ueberschrieben' end into v
  from public.jobs where id='a4000000-0000-0000-0000-000000000050';
  perform pg_temp.note(67,'Spaet-Sync','Auftrags-Abschlusszeit wird NICHT erneut gesetzt','unveraendert',v);

  select count(*)::int into v_cnt from public.notification_outbox
  where job_id='a4000000-0000-0000-0000-000000000050' and event_type='job_completed';
  perform pg_temp.note(68,'Spaet-Sync','Kein doppeltes/nachtraegliches job_completed-Event','0',v_cnt::text);

  select count(*)::int into v_cnt from public.job_completion_overrides
  where job_id='a4000000-0000-0000-0000-000000000050';
  perform pg_temp.note(69,'Spaet-Sync','Pruefpfad des Zwangsabschlusses bleibt unveraendert','1',v_cnt::text);
end $$;


-- =========================================================
-- TEIL 7 — CASE 29/30: Stundenzettel-Praedikat unveraendert
-- =========================================================
-- Spiegelt die Regeln aus services/timesheets/timesheet.service.ts
-- (mapEntry): eigenes Paar -> eigene Dauer; sonst Legacy-Fallback NUR fuer
-- Auftraege vor dem Phase-1-Cutoff (2026-08-12); sonst KEIN Eintrag.
do $$
declare v text; v_shared text;
begin
  -- CASE 29: zwei Mitarbeiter mit UNTERSCHIEDLICHER eigener Zeit auf einem
  -- Auftrag — die geteilte Auftragsuhr darf keine der beiden bestimmen.
  perform pg_temp.mkjob('a4000000-0000-0000-0000-000000000060'::uuid,
    pg_temp.bdate(now() - interval '3 hours'), time '08:00', 'open',
    array['a2000000-0000-0000-0000-000000000002'::uuid,'a2000000-0000-0000-0000-000000000003'::uuid]);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000060', now() - interval '3 hours');
  perform public.complete_own_job('a4000000-0000-0000-0000-000000000060', now() - interval '2 hours');
  execute 'reset role';

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  perform public.start_own_job('a4000000-0000-0000-0000-000000000060', now() - interval '3 hours');
  execute 'reset role';

  -- E2 war 15 Minuten spaeter vor Ort: eigene Startzeit entsprechend setzen.
  update public.job_assignments
  set employee_started_at = now() - interval '2 hours 45 minutes'
  where job_id='a4000000-0000-0000-0000-000000000060'
    and employee_id='a2000000-0000-0000-0000-000000000003';

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  perform public.complete_own_job('a4000000-0000-0000-0000-000000000060', now() - interval '1 hour');
  execute 'reset role';

  select string_agg(
           employee_name_snapshot||'='||to_char(employee_completed_at - employee_started_at,'HH24:MI'),
           ' | ' order by employee_name_snapshot)
    into v
  from public.job_assignments where job_id='a4000000-0000-0000-0000-000000000060';
  perform pg_temp.note(29,'Stundenzettel','Individuelle Dauern bleiben pro Mitarbeiter getrennt',
    'Erik Eins=01:00 | Zara Zwei=01:45',v);

  select to_char(completed_at - started_at,'HH24:MI') into v_shared
  from public.jobs where id='a4000000-0000-0000-0000-000000000060';
  perform pg_temp.note(70,'Stundenzettel','Geteilte Auftragsdauer weicht bewusst von beiden ab','02:00',v_shared);

  -- CASE 30: Legacy-Cutoff unveraendert — ein Alt-Auftrag (vor 2026-08-12)
  -- ohne eigene Zeiten faellt weiterhin auf die geteilte Uhr zurueck.
  insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                           status, job_type, date, start_time, is_active, started_at, completed_at,
                           created_at, updated_at)
  values ('a4000000-0000-0000-0000-000000000061','a1000000-0000-0000-0000-000000000001',
          'a2000000-0000-0000-0000-000000000001','Alt-Auftrag','S','O','completed','single',
          date '2026-07-01', time '08:00', true,
          timestamptz '2026-07-01 06:00+00', timestamptz '2026-07-01 08:00+00',
          timestamptz '2026-07-01 05:00+00', timestamptz '2026-07-01 08:00+00');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by)
  values ('a4000000-0000-0000-0000-000000000061','a2000000-0000-0000-0000-000000000002','Erik Eins','a2000000-0000-0000-0000-000000000001');

  select case
           when employee_started_at is null and employee_completed_at is null
                and (select completed_at from public.jobs where id='a4000000-0000-0000-0000-000000000061')
                    < timestamptz '2026-08-12 00:00+00'
           then 'legacy_fallback_gilt' else 'abweichend' end into v
  from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000061';
  perform pg_temp.note(30,'Stundenzettel','Alt-Auftrag vor Cutoff behaelt den Legacy-Fallback','legacy_fallback_gilt',v);
end $$;


-- =========================================================
-- TEIL 8 — Legacy-Bestandsfall (assigned_to ohne Zuweisungszeile)
-- =========================================================
-- Deckt die Luecke, die CASE 20 der durch Phase 16 ueberholten Suite
-- shared_job_time_multi_assignment.test.sql abgedeckt hat.
--
-- BEFUND (gemessen, nicht angenommen): ein reiner Legacy-Schreibvorgang auf
-- jobs.assigned_to bleibt NICHT ohne Zuweisungszeile — die
-- Phase-2-Kompatibilitaetstrigger (20260726000000/20260729000000, Richtung
-- assigned_to -> job_assignments) legen sie automatisch an. Damit stempelt
-- start_own_job auch hier eine EIGENE Startzeit, und der Abschluss
-- funktioniert regulaer.
--
-- Das ist der Grund, warum die Sorge "Legacy-Zeile ohne Zuweisung kann nach
-- Phase 16 nie abgeschlossen werden" praktisch nicht eintritt: die
-- Kompatibilitaetsschicht haelt beide Richtungen synchron. Passend dazu fand
-- die Vorpruefung auf Produktion (2026-09-17) NULL aktionierbare Auftraege mit
-- assigned_to ohne zugehoerige job_assignments-Zeile.
do $$
declare v text; v_cnt int;
begin
  insert into public.jobs (id, company_id, assigned_to, created_by, customer_name,
                           service_name, location_address, status, job_type, date,
                           start_time, is_active, created_at, updated_at)
  values ('a4000000-0000-0000-0000-000000000070','a1000000-0000-0000-0000-000000000001',
          'a2000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-000000000001',
          'Legacy Kunde','S','O','open','single', pg_temp.bdate(now()), time '08:00', true,
          timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00');
  -- BEWUSST keine job_assignments-Zeile.

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('a4000000-0000-0000-0000-000000000070', now());
    v := 'OK';
  exception when others then v := 'ABGELEHNT:'||sqlerrm;
  end;
  execute 'reset role';
  perform pg_temp.note(71,'Legacy','Legacy-Primaer ohne Zuweisungszeile kann weiterhin starten','OK',v);

  select status::text into v from public.jobs where id='a4000000-0000-0000-0000-000000000070';
  perform pg_temp.note(72,'Legacy','Auftrag wechselt dabei regulaer auf in_progress','in_progress',v);

  -- Die Kompatibilitaetstrigger haben die Zuweisungszeile bereits beim INSERT
  -- des Auftrags angelegt (Richtung assigned_to -> job_assignments).
  select count(*)::int into v_cnt from public.job_assignments
  where job_id='a4000000-0000-0000-0000-000000000070';
  perform pg_temp.note(73,'Legacy','Kompatibilitaetstrigger legt die Zuweisungszeile selbst an','1',v_cnt::text);

  select case when employee_started_at is not null then 'gestempelt' else 'leer' end into v
  from public.job_assignments where job_id='a4000000-0000-0000-0000-000000000070';
  perform pg_temp.note(75,'Legacy','Dadurch wird auch die EIGENE Startzeit gestempelt','gestempelt',v);

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('a4000000-0000-0000-0000-000000000070', now());
    v := 'OK';
  exception when others then
    v := case when sqlerrm like '%zuerst selbst starten%' then 'ABGELEHNT_OHNE_START' else 'ABGELEHNT_ANDERS:'||sqlerrm end;
  end;
  execute 'reset role';
  perform pg_temp.note(74,'Legacy','Abschluss gelingt regulaer (eigene Startzeit ist vorhanden)','OK',v);
end $$;

-- Sicheren Default fuer den Rest der Transaktion/Suite wiederherstellen
-- (siehe HINWEIS bei TEIL 4).
update public.app_config set value='false'::jsonb where key='force_complete_enabled';


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
    raise exception 'PHASE16 TEST: % von % FEHLGESCHLAGEN -> %', fails, gesamt, liste;
  end if;
  raise notice 'PHASE16 TEST: ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
