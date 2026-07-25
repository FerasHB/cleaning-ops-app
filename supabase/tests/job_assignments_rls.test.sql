-- =========================================================
-- TEST: RLS und Zugriffsmodell für job_assignments
-- (Migration 20260727000000_job_assignments_rls)
-- =========================================================
-- Prüft Lese-Policies (Admin/Employee/anon), die Schreib-RPC
-- set_job_assignments(), die Bewahrung von Nachweisen, das Zusammenspiel
-- mit den LIVE-Triggern aus Phase 2 sowie die Rekursionsfreiheit der
-- Employee-Policy.
--
-- Alle Zugriffe laufen als echte Rollen (SET ROLE + request.jwt.claims),
-- also über denselben Pfad wie die App über PostgREST.
--
-- Läuft transaktional (BEGIN … ROLLBACK): keine Rückstände, keine
-- Produktionsdaten. Ausführen lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/job_assignments_rls.test.sql
-- =========================================================

begin;

-- =========================================================
-- HINWEIS ZU „VERWEIGERT"-PFADEN
-- =========================================================
-- Der lokale Supabase-Container (PostgreSQL 17.6, aarch64) stuerzt bei
-- JEDEM permission-denied-Fehler ab (signal 11) statt eine saubere
-- Fehlermeldung zu liefern. Reproduzierbar auch mit voellig unbeteiligten
-- Funktionen (pg_read_file) und mit seit Monaten produktiv laufenden
-- Funktionen (fanout_notification_events) — es ist also ein Defekt der
-- Umgebung, nicht dieses Schemas.
--
-- Faelle, deren Verweigerung ueber ein FEHLENDES PRIVILEG laeuft, koennen
-- hier deshalb nicht durch einen echten Aufruf geprueft werden, ohne die
-- Test-Datenbank abzuschiessen. Sie werden stattdessen ueber die
-- Rechtevergabe selbst nachgewiesen (has_function_privilege /
-- role_table_grants / pg_policies). Das ist fuer genau dieses Design auch
-- die richtige Zusicherung: die Verweigerung IST hier die fehlende
-- Rechtevergabe (Defense-in-Depth vor jeder Policy-Auswertung).
--
-- Verweigerungen, die ueber RLS-Policies statt ueber Privilegien laufen
-- (z. B. Zeilen, die ein Nutzer nicht sieht), werden weiterhin durch
-- echte Zugriffe geprueft — sie loesen keinen permission-denied-Fehler aus.
-- =========================================================

-- ── Fixdaten ──
-- Firma A = d1…1 | Firma B = d1…2
-- Admin A = d2…1 | A1 = d2…2 | A2 = d2…3 | A3 = d2…4 | inaktiv = d2…5
-- Admin B = d2…6 | B1 = d2…7 | loeschbar = d2…8
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','d2000000-0000-0000-0000-000000000001','authenticated','authenticated','r-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','d2000000-0000-0000-0000-000000000002','authenticated','authenticated','r-a1@example.test','{"full_name":"Anna Eins"}'),
    ('00000000-0000-0000-0000-000000000000','d2000000-0000-0000-0000-000000000003','authenticated','authenticated','r-a2@example.test','{"full_name":"Bert Zwei"}'),
    ('00000000-0000-0000-0000-000000000000','d2000000-0000-0000-0000-000000000004','authenticated','authenticated','r-a3@example.test','{"full_name":"Cora Drei"}'),
    ('00000000-0000-0000-0000-000000000000','d2000000-0000-0000-0000-000000000005','authenticated','authenticated','r-inaktiv@example.test','{"full_name":"Ida Inaktiv"}'),
    ('00000000-0000-0000-0000-000000000000','d2000000-0000-0000-0000-000000000006','authenticated','authenticated','r-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','d2000000-0000-0000-0000-000000000007','authenticated','authenticated','r-b1@example.test','{"full_name":"Bea Fremd"}'),
    ('00000000-0000-0000-0000-000000000000','d2000000-0000-0000-0000-000000000008','authenticated','authenticated','r-del@example.test','{"full_name":"Lars Loeschbar"}');
end $$;

insert into public.profiles (id, full_name) values
  ('d2000000-0000-0000-0000-000000000001','Admin A'),
  ('d2000000-0000-0000-0000-000000000002','Anna Eins'),
  ('d2000000-0000-0000-0000-000000000003','Bert Zwei'),
  ('d2000000-0000-0000-0000-000000000004','Cora Drei'),
  ('d2000000-0000-0000-0000-000000000005','Ida Inaktiv'),
  ('d2000000-0000-0000-0000-000000000006','Admin B'),
  ('d2000000-0000-0000-0000-000000000007','Bea Fremd'),
  ('d2000000-0000-0000-0000-000000000008','Lars Loeschbar')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('d1000000-0000-0000-0000-000000000001','RLS Firma A','rls-firma-a-test'),
  ('d1000000-0000-0000-0000-000000000002','RLS Firma B','rls-firma-b-test');

update public.profiles set company_id='d1000000-0000-0000-0000-000000000001', role='admin',    is_active=true  where id='d2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='d1000000-0000-0000-0000-000000000001', role='employee', is_active=true  where id in
  ('d2000000-0000-0000-0000-000000000002','d2000000-0000-0000-0000-000000000003','d2000000-0000-0000-0000-000000000004','d2000000-0000-0000-0000-000000000008');
update public.profiles set company_id='d1000000-0000-0000-0000-000000000001', role='employee', is_active=false where id='d2000000-0000-0000-0000-000000000005';
update public.profiles set company_id='d1000000-0000-0000-0000-000000000002', role='admin',    is_active=true  where id='d2000000-0000-0000-0000-000000000006';
update public.profiles set company_id='d1000000-0000-0000-0000-000000000002', role='employee', is_active=true  where id='d2000000-0000-0000-0000-000000000007';

-- Aufträge: J1/J2 Firma A, J3 Firma B, J4 Recurring-Parent A, J5 Occurrence A
insert into public.jobs (id, company_id, assigned_to, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time, recurring_days,
                         is_active, created_at, updated_at, parent_job_id) values
  ('d4000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001',null,'d2000000-0000-0000-0000-000000000001','K1','S1','O1','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('d4000000-0000-0000-0000-000000000002','d1000000-0000-0000-0000-000000000001',null,'d2000000-0000-0000-0000-000000000001','K2','S2','O2','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('d4000000-0000-0000-0000-000000000003','d1000000-0000-0000-0000-000000000002',null,'d2000000-0000-0000-0000-000000000006','K3','S3','O3','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('d4000000-0000-0000-0000-000000000004','d1000000-0000-0000-0000-000000000001',null,'d2000000-0000-0000-0000-000000000001','K4','S4','O4','open','recurring',null,'08:00',array['mon'],true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('d4000000-0000-0000-0000-000000000005','d1000000-0000-0000-0000-000000000001',null,'d2000000-0000-0000-0000-000000000001','K5','S5','O5','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00','d4000000-0000-0000-0000-000000000004');

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;
-- Merkt sich Zwischenstaende, die spaetere Faelle vergleichen muessen.
create temporary table _state (k text primary key, v text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;

create or replace function pg_temp.zuw(p_job uuid) returns text language sql as $f$
  select coalesce(string_agg(coalesce(ja.employee_id::text,'ANON')||':'||ja.attendance::text
         || case when ja.review is null then '' else '/'||ja.review::text end,
         ',' order by ja.employee_id nulls last),'KEINE')
  from public.job_assignments ja where ja.job_id = p_job;
$f$;

create or replace function pg_temp.legacy(p_job uuid) returns text language sql as $f$
  select coalesce((select assigned_to::text from public.jobs where id=p_job),'NULL');
$f$;

create or replace function pg_temp.jobs_updates() returns bigint language sql as $f$
  select coalesce((select n_tup_upd from pg_stat_xact_user_tables where schemaname='public' and relname='jobs'),0);
$f$;


-- =========================================================
-- A. Schreib-RPC — Grundverhalten
-- =========================================================

-- CASE 1: Admin setzt eine Zuweisungsmenge (2 Mitarbeiter)
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('d4000000-0000-0000-0000-000000000001',
    array['d2000000-0000-0000-0000-000000000002','d2000000-0000-0000-0000-000000000003']::uuid[]);
  execute 'reset role';
  -- WICHTIG: der konkrete Primaer ist hier NICHT vorhersagbar. Beide
  -- Zuweisungen entstehen in derselben Transaktion, teilen sich also
  -- denselben assigned_at; den Ausschlag gibt dann der id-Tiebreaker, also
  -- eine zufaellige UUID (so in Phase 2 dokumentiert). Geprueft wird
  -- deshalb die DETERMINISTISCHE Eigenschaft: der Primaer ist gesetzt,
  -- gehoert zur Zielmenge und ist durch eine Zuweisung gedeckt.
  insert into _state values ('case1_legacy', pg_temp.legacy('d4000000-0000-0000-0000-000000000001'));
  v := 'zuw='||pg_temp.zuw('d4000000-0000-0000-0000-000000000001')
     ||'/primaer_aus_menge='||(pg_temp.legacy('d4000000-0000-0000-0000-000000000001') in
          ('d2000000-0000-0000-0000-000000000002','d2000000-0000-0000-0000-000000000003'))::text
     ||'/gedeckt='||(select (j.assigned_to is null or exists(select 1 from public.job_assignments ja
          where ja.job_id=j.id and ja.employee_id=j.assigned_to))::text
        from public.jobs j where j.id='d4000000-0000-0000-0000-000000000001');
  insert into _r values (1,'Admin setzt Menge; Phase 2 waehlt einen gedeckten Primaer aus der Menge',
    'zuw=d2000000-0000-0000-0000-000000000002:assigned,d2000000-0000-0000-0000-000000000003:assigned/primaer_aus_menge=true/gedeckt=true', v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2: Doppelte IDs in der Eingabe -> harmlos entdupliziert
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.set_job_assignments('d4000000-0000-0000-0000-000000000002',
      array['d2000000-0000-0000-0000-000000000002','d2000000-0000-0000-0000-000000000002',null]::uuid[]);
    v := 'OK/'||(select count(*)::text from public.job_assignments where job_id='d4000000-0000-0000-0000-000000000002');
  exception when others then v := 'FEHLER('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (2,'Doppelte und NULL-IDs in der Eingabe werden entdupliziert','OK/1',v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3: leere Menge entfernt alle sauberen Zuweisungen
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('d4000000-0000-0000-0000-000000000002', '{}'::uuid[]);
  execute 'reset role';
  v := 'zuw='||pg_temp.zuw('d4000000-0000-0000-0000-000000000002')||'/legacy='||pg_temp.legacy('d4000000-0000-0000-0000-000000000002');
  insert into _r values (3,'Leere Zielmenge entfernt saubere Zuweisungen','zuw=KEINE/legacy=NULL',v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4: fremde Firma -> abgelehnt, KEINE Teiländerung
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.set_job_assignments('d4000000-0000-0000-0000-000000000001',
      array['d2000000-0000-0000-0000-000000000002','d2000000-0000-0000-0000-000000000007']::uuid[]);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  v := v||'/zuw_unveraendert='||(pg_temp.zuw('d4000000-0000-0000-0000-000000000001') =
        'd2000000-0000-0000-0000-000000000002:assigned,d2000000-0000-0000-0000-000000000003:assigned')::text;
  insert into _r values (4,'Mitarbeiter fremder Firma -> abgelehnt, keine Teilaenderung','ABGELEHNT/zuw_unveraendert=true',v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- CASE 5: inaktiver Mitarbeiter -> abgelehnt
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.set_job_assignments('d4000000-0000-0000-0000-000000000001',
      array['d2000000-0000-0000-0000-000000000005']::uuid[]);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (5,'Inaktiver Mitarbeiter -> abgelehnt','ABGELEHNT',v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6: Admin-Profil als Feldmitarbeiter -> abgelehnt
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.set_job_assignments('d4000000-0000-0000-0000-000000000001',
      array['d2000000-0000-0000-0000-000000000001']::uuid[]);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (6,'Admin-Profil als Mitarbeiter -> abgelehnt','ABGELEHNT',v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: Auftrag fremder Firma -> abgelehnt
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.set_job_assignments('d4000000-0000-0000-0000-000000000003',
      array['d2000000-0000-0000-0000-000000000002']::uuid[]);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (7,'Auftrag einer fremden Firma -> abgelehnt','ABGELEHNT',v);
  raise notice 'CASE 7 -> %', v;
end $$;

-- CASE 8: Employee darf die RPC nicht nutzen
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.set_job_assignments('d4000000-0000-0000-0000-000000000001',
      array['d2000000-0000-0000-0000-000000000002']::uuid[]);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (8,'Employee ruft set_job_assignments -> abgelehnt','ABGELEHNT',v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9: anon darf die RPC nicht ausfuehren (ueber die Rechtevergabe geprueft)
do $$
declare v text;
begin
  v := 'anon_execute='||has_function_privilege('anon','public.set_job_assignments(uuid,uuid[])','EXECUTE')::text
     ||'/public_execute='||has_function_privilege('public','public.set_job_assignments(uuid,uuid[])','EXECUTE')::text;
  insert into _r values (9,'anon/PUBLIC ohne EXECUTE auf set_job_assignments','anon_execute=false/public_execute=false',v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- =========================================================
-- B. Nachweis-Bewahrung
-- =========================================================

-- CASE 10: Nachweis-behaftete Zeile wird beim Mengenwechsel BEWAHRT
do $$
declare v text;
begin
  update public.job_assignments set attendance='started', employee_started_at=now()
   where job_id='d4000000-0000-0000-0000-000000000001' and employee_id='d2000000-0000-0000-0000-000000000002';
  update public.job_assignments set review='absent', reviewed_at=now(), reviewed_by='d2000000-0000-0000-0000-000000000001'
   where job_id='d4000000-0000-0000-0000-000000000001' and employee_id='d2000000-0000-0000-0000-000000000003';

  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  -- beide bisherigen ersetzen durch einen dritten Mitarbeiter
  perform public.set_job_assignments('d4000000-0000-0000-0000-000000000001',
    array['d2000000-0000-0000-0000-000000000004']::uuid[]);
  execute 'reset role';

  v := pg_temp.zuw('d4000000-0000-0000-0000-000000000001');
  insert into _r values (10,'Nachweis-Zeilen (Anwesenheit/Review) ueberleben den Mengenwechsel',
    'd2000000-0000-0000-0000-000000000002:started,d2000000-0000-0000-0000-000000000003:assigned/absent,d2000000-0000-0000-0000-000000000004:assigned', v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- CASE 11: Primaer bleibt gedeckt; Nachweis-Zeile wird nicht automatisch primaer
do $$
declare v text;
begin
  -- Deterministische Aussage: Regel 1 der Phase-2-Primaerregel behaelt den
  -- BESTEHENDEN Zeiger, solange ihn eine Zuweisungszeile deckt. Der Zeiger
  -- darf also weder wechseln noch auf die neu hinzugekommene, saubere
  -- Zuweisung (…004) springen.
  v := 'unveraendert='||(pg_temp.legacy('d4000000-0000-0000-0000-000000000001') =
          (select st.v from _state st where st.k='case1_legacy'))::text
     ||'/nicht_der_neue='||(pg_temp.legacy('d4000000-0000-0000-0000-000000000001')
          <> 'd2000000-0000-0000-0000-000000000004')::text
     ||'/gedeckt='||(select (exists(select 1 from public.job_assignments ja
          where ja.job_id=j.id and ja.employee_id=j.assigned_to))::text
        from public.jobs j where j.id='d4000000-0000-0000-0000-000000000001');
  insert into _r values (11,'Bestehender Primaer bleibt erhalten und springt nicht auf die neue Zuweisung',
    'unveraendert=true/nicht_der_neue=true/gedeckt=true', v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- CASE 12: anonymisierte Zeile (Konto geloescht) ueberlebt den Mengenwechsel
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('d4000000-0000-0000-0000-000000000005',
    array['d2000000-0000-0000-0000-000000000008']::uuid[]);
  execute 'reset role';

  delete from auth.users where id='d2000000-0000-0000-0000-000000000008';

  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('d4000000-0000-0000-0000-000000000005',
    array['d2000000-0000-0000-0000-000000000003']::uuid[]);
  execute 'reset role';

  v := 'zuw='||pg_temp.zuw('d4000000-0000-0000-0000-000000000005')
       ||'/snapshot_erhalten='||(select count(*) from public.job_assignments
            where job_id='d4000000-0000-0000-0000-000000000005' and employee_name_snapshot='Lars Loeschbar')::text;
  insert into _r values (12,'Anonymisierte Zeile ueberlebt den Mengenwechsel',
    'zuw=d2000000-0000-0000-0000-000000000003:assigned,ANON:assigned/snapshot_erhalten=1', v);
  raise notice 'CASE 12 -> %', v;
end $$;


-- =========================================================
-- C. Lese-Policies
-- =========================================================

-- CASE 13: Admin liest Zuweisungen der EIGENEN Firma
do $$
declare v text; n int;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select count(*) into n from public.job_assignments where job_id='d4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  v := 'sichtbar='||n::text;
  insert into _r values (13,'Admin liest Zuweisungen der eigenen Firma','sichtbar=3',v);
  raise notice 'CASE 13 -> %', v;
end $$;

-- CASE 14: Admin sieht KEINE Zuweisungen einer fremden Firma
do $$
declare v text; n int;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub','d2000000-0000-0000-0000-000000000006','role','authenticated')::text, true);
  select count(*) into n from public.job_assignments where job_id='d4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  v := 'sichtbar='||n::text;
  insert into _r values (14,'Admin der Firma B sieht Zuweisungen der Firma A nicht','sichtbar=0',v);
  raise notice 'CASE 14 -> %', v;
end $$;

-- CASE 15: Employee sieht ALLE Zuweisungen SEINES Auftrags (Variante B)
do $$
declare v text; n int;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  select count(*) into n from public.job_assignments where job_id='d4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  v := 'sichtbar='||n::text;
  insert into _r values (15,'Employee sieht alle Zuweisungen seines eigenen Auftrags (Variante B)','sichtbar=3',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16: Employee sieht Kollegennamen OHNE profiles-Zugriff
do $$
declare v text; namen text; profil_sichtbar int;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  select string_agg(employee_name_snapshot, ',' order by employee_name_snapshot) into namen
    from public.job_assignments where job_id='d4000000-0000-0000-0000-000000000001';
  -- profiles bleibt fuer Mitarbeiter auf die EIGENE Zeile beschraenkt
  select count(*) into profil_sichtbar from public.profiles where id='d2000000-0000-0000-0000-000000000002';
  execute 'reset role';
  v := 'namen='||coalesce(namen,'-')||'/fremdes_profil_sichtbar='||profil_sichtbar::text;
  insert into _r values (16,'Kollegennamen kommen aus dem Snapshot; profiles bleibt zu',
    'namen=Anna Eins,Bert Zwei,Cora Drei/fremdes_profil_sichtbar=0', v);
  raise notice 'CASE 16 -> %', v;
end $$;

-- CASE 17: Employee sieht KEINE Zuweisungen fremder Auftraege
do $$
declare v text; n int;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  select count(*) into n from public.job_assignments where job_id='d4000000-0000-0000-0000-000000000005';
  execute 'reset role';
  v := 'sichtbar='||n::text;
  insert into _r values (17,'Employee sieht Zuweisungen fremder Auftraege nicht','sichtbar=0',v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- CASE 18: Employee einer FREMDEN Firma sieht nichts
do $$
declare v text; n int;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000007');
  execute 'set local role authenticated';
  select count(*) into n from public.job_assignments;
  execute 'reset role';
  v := 'sichtbar='||n::text;
  insert into _r values (18,'Employee der Firma B sieht keine Zuweisungen der Firma A','sichtbar=0',v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- CASE 19: DEAKTIVIERTER Mitarbeiter verliert den Lesezugriff
do $$
declare v text; n int;
begin
  update public.profiles set is_active=false where id='d2000000-0000-0000-0000-000000000004';
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  select count(*) into n from public.job_assignments;
  execute 'reset role';
  update public.profiles set is_active=true where id='d2000000-0000-0000-0000-000000000004';
  v := 'sichtbar='||n::text;
  insert into _r values (19,'Deaktivierter Mitarbeiter sieht keine Zuweisungen mehr','sichtbar=0',v);
  raise notice 'CASE 19 -> %', v;
end $$;

-- CASE 20: anon hat keinerlei Tabellenrechte (ueber die Rechtevergabe geprueft)
do $$
declare v text;
begin
  v := 'anon_tabellenrechte='||coalesce((select string_agg(distinct privilege_type,'+')
        from information_schema.role_table_grants
        where table_schema='public' and table_name='job_assignments' and grantee='anon'),'KEINE');
  insert into _r values (20,'anon: keine Tabellenrechte auf job_assignments','anon_tabellenrechte=KEINE',v);
  raise notice 'CASE 20 -> %', v;
end $$;

-- CASE 21: Employee-Policy ist REKURSIONSFREI
--   Eine Policy AUF job_assignments, die job_assignments abfragt, waere
--   ohne SECURITY-DEFINER-Helfer unendlich rekursiv (SQLSTATE 42P17).
do $$
declare v text; n int;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    select count(*) into n from public.job_assignments;
    v := 'OK/sichtbar='||n::text;
  exception when others then v := 'FEHLER('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (21,'Employee-Policy ohne RLS-Rekursion','OK/sichtbar=3',v);
  raise notice 'CASE 21 -> %', v;
end $$;


-- =========================================================
-- D. Schreibsperren fuer nicht-privilegierte Rollen
-- =========================================================

-- CASE 22: KEINE Schreibrechte fuer authenticated (weder Employee noch Admin)
--   Die Verweigerung laeuft hier ueber das fehlende Privileg, greift also
--   VOR jeder Policy-Auswertung und gilt fuer beide Rollen gleichermassen.
do $$
declare v text;
begin
  v := 'schreibrechte='||coalesce((select string_agg(distinct privilege_type,'+' order by privilege_type)
        from information_schema.role_table_grants
        where table_schema='public' and table_name='job_assignments'
          and grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')),'KEINE');
  insert into _r values (22,'authenticated hat weder INSERT noch UPDATE noch DELETE','schreibrechte=KEINE',v);
  raise notice 'CASE 22 -> %', v;
end $$;

-- CASE 23: es existiert AUCH KEINE Schreib-Policy (zweite Verriegelung)
do $$
declare v text;
begin
  v := 'schreib_policies='||(select count(*)::text from pg_policies
        where schemaname='public' and tablename='job_assignments' and cmd <> 'SELECT')
     ||'/select_policies='||(select count(*)::text from pg_policies
        where schemaname='public' and tablename='job_assignments' and cmd = 'SELECT');
  insert into _r values (23,'Keine INSERT/UPDATE/DELETE-Policy; genau zwei SELECT-Policies',
    'schreib_policies=0/select_policies=2', v);
  raise notice 'CASE 23 -> %', v;
end $$;

-- CASE 24: Policy-Helfer sind fuer Clients nicht aufrufbar
do $$
declare v text := '';
begin
  -- Policy-Helfer MUESSEN fuer authenticated ausfuehrbar sein (sonst ist die
  -- Policy nicht auswertbar), duerfen anon aber nicht offenstehen.
  v := 'helfer_auth='||(has_function_privilege('authenticated','public.is_assigned_to_job(uuid)','EXECUTE')
                    and has_function_privilege('authenticated','public.job_in_current_company(uuid)','EXECUTE'))::text
     ||'/helfer_anon='||(has_function_privilege('anon','public.is_assigned_to_job(uuid)','EXECUTE')
                      or has_function_privilege('anon','public.job_in_current_company(uuid)','EXECUTE'))::text
     ||'/rpc_auth='||has_function_privilege('authenticated','public.set_job_assignments(uuid,uuid[])','EXECUTE')::text
     ||'/rpc_anon='||has_function_privilege('anon','public.set_job_assignments(uuid,uuid[])','EXECUTE')::text;
  insert into _r values (24,'EXECUTE: Helfer fuer authenticated noetig, fuer anon gesperrt; RPC nur authenticated',
    'helfer_auth=true/helfer_anon=false/rpc_auth=true/rpc_anon=false', v);
  raise notice 'CASE 24 -> %', v;
end $$;

-- CASE 25: Tabellen-Grants — nur SELECT fuer authenticated, nichts fuer anon
do $$
declare v text;
begin
  select 'auth='||coalesce(string_agg(distinct privilege_type,'+' order by privilege_type),'KEINE')
    into v
  from information_schema.role_table_grants
  where table_schema='public' and table_name='job_assignments' and grantee='authenticated';
  v := v || '/anon='||coalesce((select string_agg(distinct privilege_type,'+') from information_schema.role_table_grants
        where table_schema='public' and table_name='job_assignments' and grantee='anon'),'KEINE');
  insert into _r values (25,'Grants: authenticated nur SELECT, anon keine','auth=SELECT/anon=KEINE',v);
  raise notice 'CASE 25 -> %', v;
end $$;


-- =========================================================
-- E. Zusammenspiel mit den Phase-2-Triggern
-- =========================================================

-- CASE 26: Primaer-Neuberechnung und keine doppelten Zeilen
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('d4000000-0000-0000-0000-000000000002',
    array['d2000000-0000-0000-0000-000000000003','d2000000-0000-0000-0000-000000000004']::uuid[]);
  execute 'reset role';

  v := 'legacy_gedeckt='||(select (j.assigned_to is null or exists(
          select 1 from public.job_assignments ja where ja.job_id=j.id and ja.employee_id=j.assigned_to))::text
        from public.jobs j where j.id='d4000000-0000-0000-0000-000000000002')
     ||'/duplikate='||(select count(*)::text from (
          select job_id, employee_id from public.job_assignments
          where employee_id is not null group by 1,2 having count(*)>1) d);
  insert into _r values (26,'Phase-2-Primaer gedeckt, keine doppelten Zuweisungen','legacy_gedeckt=true/duplikate=0',v);
  raise notice 'CASE 26 -> %', v;
end $$;

-- CASE 27: Schreibverstaerkung ist durch die Mengengroesse begrenzt
do $$
declare v text; u0 bigint; u1 bigint;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  u0 := pg_temp.jobs_updates();
  -- 2 vorhandene ersetzen durch 1 neuen => 2 DELETE + 1 INSERT = 3 Zeilen
  perform public.set_job_assignments('d4000000-0000-0000-0000-000000000002',
    array['d2000000-0000-0000-0000-000000000002']::uuid[]);
  u1 := pg_temp.jobs_updates();
  execute 'reset role';
  v := 'jobs_updates_hoechstens_6='||((u1-u0) <= 6)::text||'/gemessen='||(u1-u0)::text;
  insert into _r values (27,'Schreibverstaerkung durch Mengengroesse begrenzt (nicht mengenbasiert)',
    'jobs_updates_hoechstens_6=true/gemessen=' || (u1-u0)::text, v);
  raise notice 'CASE 27 -> %', v;
end $$;

-- CASE 28: alter Client-Pfad (createJob/updateJob ueber assigned_to) bleibt intakt
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  insert into public.jobs (id, company_id, assigned_to, created_by, customer_name, service_name,
                           location_address, status, job_type, date, start_time, is_active)
  values ('d4000000-0000-0000-0000-000000000009','d1000000-0000-0000-0000-000000000001',
          'd2000000-0000-0000-0000-000000000002','d2000000-0000-0000-0000-000000000001',
          'K9','S9','O9','open','single',current_date,'08:00',true);
  update public.jobs set assigned_to='d2000000-0000-0000-0000-000000000003'
   where id='d4000000-0000-0000-0000-000000000009';
  execute 'reset role';
  v := 'zuw='||pg_temp.zuw('d4000000-0000-0000-0000-000000000009')||'/legacy='||pg_temp.legacy('d4000000-0000-0000-0000-000000000009');
  insert into _r values (28,'Alter Client-Pfad (createJob/updateJob) unveraendert funktionsfaehig',
    'zuw=d2000000-0000-0000-0000-000000000003:assigned/legacy=d2000000-0000-0000-0000-000000000003', v);
  raise notice 'CASE 28 -> %', v;
end $$;

-- CASE 29: Recurring-Parent und Occurrence verhalten sich unveraendert
do $$
declare v text;
begin
  perform pg_temp.act_as('d2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('d4000000-0000-0000-0000-000000000004',
    array['d2000000-0000-0000-0000-000000000002']::uuid[]);
  execute 'reset role';
  v := 'parent_zuw='||pg_temp.zuw('d4000000-0000-0000-0000-000000000004')
     ||'/parent_legacy='||pg_temp.legacy('d4000000-0000-0000-0000-000000000004')
     ||'/occurrence_unveraendert='||(pg_temp.zuw('d4000000-0000-0000-0000-000000000005') =
        'd2000000-0000-0000-0000-000000000003:assigned,ANON:assigned')::text;
  insert into _r values (29,'Recurring-Parent erhaelt Vorlage; Occurrence bleibt unveraendert (Phase 4 offen)',
    'parent_zuw=d2000000-0000-0000-0000-000000000002:assigned/parent_legacy=d2000000-0000-0000-0000-000000000002/occurrence_unveraendert=true', v);
  raise notice 'CASE 29 -> %', v;
end $$;

-- CASE 30: Invariante ueber alle Testauftraege
do $$
declare v text;
begin
  select 'verletzungen='||count(*)::text into v
  from public.jobs j
  where j.assigned_to is not null
    and not exists (select 1 from public.job_assignments ja
                    where ja.job_id=j.id and ja.employee_id=j.assigned_to);
  insert into _r values (30,'Invariante: assigned_to IS NULL ODER durch Zuweisung gedeckt','verletzungen=0',v);
  raise notice 'CASE 30 -> %', v;
end $$;


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _r order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _r where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'JOB ASSIGNMENTS RLS TEST: % Fall/Faelle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE 30 FAELLE PASS';
end $$;

rollback;
