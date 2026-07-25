-- =========================================================
-- TEST: Vererbung und Anpassung von Zuweisungen auf Occurrences
-- (Migration 20260728000000_occurrence_assignment_inheritance)
-- =========================================================
-- Prueft Generierung, Regel-Synchronisierung, individuelle Anpassung,
-- Zuruecksetzen, Nachweis-Bewahrung, Legacy-Kompatibilitaet,
-- Duplikatfreiheit und die Sperrreihenfolge.
--
-- Alle Admin-Aufrufe laufen mit gesetzten JWT-Claims, also ueber
-- denselben Autorisierungspfad wie die App.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende.
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/occurrence_assignment_inheritance.test.sql
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = c9…1 | Firma B = c9…2
-- Admin A = ca…1 | A=ca…a | B=ca…b | C=ca…c | P=ca…p(0d) | inaktiv=ca…e
-- Admin B = ca…f
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','ca000000-0000-0000-0000-000000000001','authenticated','authenticated','oi-adm@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','ca000000-0000-0000-0000-00000000000a','authenticated','authenticated','oi-a@example.test','{"full_name":"Anna"}'),
    ('00000000-0000-0000-0000-000000000000','ca000000-0000-0000-0000-00000000000b','authenticated','authenticated','oi-b@example.test','{"full_name":"Bert"}'),
    ('00000000-0000-0000-0000-000000000000','ca000000-0000-0000-0000-00000000000c','authenticated','authenticated','oi-c@example.test','{"full_name":"Cora"}'),
    ('00000000-0000-0000-0000-000000000000','ca000000-0000-0000-0000-00000000000d','authenticated','authenticated','oi-p@example.test','{"full_name":"Paul"}'),
    ('00000000-0000-0000-0000-000000000000','ca000000-0000-0000-0000-00000000000e','authenticated','authenticated','oi-inakt@example.test','{"full_name":"Ida"}'),
    ('00000000-0000-0000-0000-000000000000','ca000000-0000-0000-0000-00000000000f','authenticated','authenticated','oi-admb@example.test','{"full_name":"Admin B"}');
end $$;

insert into public.profiles (id, full_name) values
  ('ca000000-0000-0000-0000-000000000001','Admin A'),
  ('ca000000-0000-0000-0000-00000000000a','Anna'),
  ('ca000000-0000-0000-0000-00000000000b','Bert'),
  ('ca000000-0000-0000-0000-00000000000c','Cora'),
  ('ca000000-0000-0000-0000-00000000000d','Paul'),
  ('ca000000-0000-0000-0000-00000000000e','Ida'),
  ('ca000000-0000-0000-0000-00000000000f','Admin B')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('c9000000-0000-0000-0000-000000000001','OI Firma A','oi-firma-a-test'),
  ('c9000000-0000-0000-0000-000000000002','OI Firma B','oi-firma-b-test');

update public.profiles set company_id='c9000000-0000-0000-0000-000000000001', role='admin',    is_active=true  where id='ca000000-0000-0000-0000-000000000001';
update public.profiles set company_id='c9000000-0000-0000-0000-000000000001', role='employee', is_active=true  where id in
  ('ca000000-0000-0000-0000-00000000000a','ca000000-0000-0000-0000-00000000000b','ca000000-0000-0000-0000-00000000000c','ca000000-0000-0000-0000-00000000000d');
update public.profiles set company_id='c9000000-0000-0000-0000-000000000001', role='employee', is_active=false where id='ca000000-0000-0000-0000-00000000000e';
update public.profiles set company_id='c9000000-0000-0000-0000-000000000002', role='admin',    is_active=true  where id='ca000000-0000-0000-0000-00000000000f';

create temporary table _oi (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;

-- Kurzname eines Mitarbeiters fuer lesbare Erwartungswerte
create or replace function pg_temp.kurz(p uuid) returns text language sql as $f$
  select case p::text
    when 'ca000000-0000-0000-0000-00000000000a' then 'A'
    when 'ca000000-0000-0000-0000-00000000000b' then 'B'
    when 'ca000000-0000-0000-0000-00000000000c' then 'C'
    when 'ca000000-0000-0000-0000-00000000000d' then 'P'
    when 'ca000000-0000-0000-0000-00000000000e' then 'I'
    else coalesce(p::text,'ANON') end;
$f$;

-- Zuweisungsmenge eines Auftrags, deterministisch sortiert
create or replace function pg_temp.menge(p_job uuid) returns text language sql as $f$
  select coalesce(string_agg(pg_temp.kurz(ja.employee_id), ',' order by pg_temp.kurz(ja.employee_id)),'LEER')
  from public.job_assignments ja where ja.job_id = p_job;
$f$;

create or replace function pg_temp.legacy(p_job uuid) returns text language sql as $f$
  select case when (select assigned_to from public.jobs where id=p_job) is null
              then 'NULL'
              else pg_temp.kurz((select assigned_to from public.jobs where id=p_job)) end;
$f$;

-- Erster (frühester) Termin einer Regel
create or replace function pg_temp.erster(p_parent uuid) returns uuid language sql as $f$
  select id from public.jobs where parent_job_id=p_parent order by date, start_time limit 1;
$f$;

create or replace function pg_temp.angepasst(p_job uuid) returns boolean language sql as $f$
  select exists(select 1 from public.job_occurrence_assignment_overrides where job_id=p_job);
$f$;

-- Regel R1: Wochentags-Regel, zunaechst Paul zugewiesen
insert into public.jobs (id,company_id,assigned_to,created_by,customer_name,service_name,location_address,
                         status,job_type,recurring_days,start_time,recurrence_start_date,is_active,created_at,updated_at)
values ('cb000000-0000-0000-0000-000000000001','c9000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-00000000000d',
        'ca000000-0000-0000-0000-000000000001','Kunde R1','Service R1','Ort R1','open','recurring',
        array['mon','tue','wed','thu','fri','sat','sun'],'08:00',current_date,true,
        timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00');


-- =========================================================
-- A. Generierung und Vererbung
-- =========================================================

-- CASE 1: Regel hat MEHRERE Mitarbeiter -> neue Termine erben die MENGE
do $$
declare v text; occ uuid;
begin
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  -- Regel auf {P, A} setzen (Regel selbst ist kein Termin -> keine Markierung)
  perform public.set_job_assignments('cb000000-0000-0000-0000-000000000001',
    array['ca000000-0000-0000-0000-00000000000d','ca000000-0000-0000-0000-00000000000a']::uuid[]);
  perform public.generate_job_occurrences('cb000000-0000-0000-0000-000000000001');
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  v := 'menge='||pg_temp.menge(occ)||'/angepasst='||pg_temp.angepasst(occ)::text;
  insert into _oi values (1,'Neuer Termin erbt die vollstaendige Zuweisungsmenge der Regel','menge=A,P/angepasst=false',v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2: Legacy assigned_to ist nach der Vererbung gedeckt
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  v := 'gedeckt='||(select (j.assigned_to is null or exists(
         select 1 from public.job_assignments ja where ja.job_id=j.id and ja.employee_id=j.assigned_to))::text
       from public.jobs j where j.id=occ);
  insert into _oi values (2,'Legacy assigned_to bleibt durch eine Zuweisung gedeckt','gedeckt=true',v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3: Regel-Aenderung wirkt auf NICHT angepasste Termine
do $$
declare v text; occ uuid;
begin
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments('cb000000-0000-0000-0000-000000000001',
    array['ca000000-0000-0000-0000-00000000000b','ca000000-0000-0000-0000-00000000000c']::uuid[]);
  perform public.update_job_occurrences('cb000000-0000-0000-0000-000000000001');
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  v := 'menge='||pg_temp.menge(occ);
  insert into _oi values (3,'Nicht angepasster Termin folgt der geaenderten Regelmenge','menge=B,C',v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4: keine doppelten Zuweisungszeilen nach mehrfacher Synchronisierung
do $$
declare v text;
begin
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.update_job_occurrences('cb000000-0000-0000-0000-000000000001');
  perform public.update_job_occurrences('cb000000-0000-0000-0000-000000000001');
  select 'duplikate='||count(*)::text into v from (
    select job_id, employee_id from public.job_assignments
    where employee_id is not null group by 1,2 having count(*)>1) d;
  insert into _oi values (4,'Mehrfache Synchronisierung erzeugt keine Duplikate','duplikate=0',v);
  raise notice 'CASE 4 -> %', v;
end $$;


-- =========================================================
-- B. Individuelle Anpassung (Kern von Phase 4)
-- =========================================================

-- CASE 5: Anpassung markiert den Termin
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments(occ, array['ca000000-0000-0000-0000-00000000000a']::uuid[]);
  v := 'menge='||pg_temp.menge(occ)||'/angepasst='||pg_temp.angepasst(occ)::text
     ||'/by='||(select pg_temp.kurz(customized_by) from public.job_occurrence_assignment_overrides where job_id=occ);
  insert into _oi values (5,'Anpassung setzt Menge und markiert den Termin',
    'menge=A/angepasst=true/by=ca000000-0000-0000-0000-000000000001',v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6: URSACHEN-FALL — Regel-Edit an einem UNBETEILIGTEN Feld
--   darf die angepasste Menge nicht mehr veraendern.
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  update public.jobs set customer_name='Kunde R1 neu' where id='cb000000-0000-0000-0000-000000000001';
  perform public.update_job_occurrences('cb000000-0000-0000-0000-000000000001');
  v := 'menge='||pg_temp.menge(occ)
     ||'/kunde_gesynct='||(select (customer_name='Kunde R1 neu')::text from public.jobs where id=occ);
  insert into _oi values (6,'Angepasster Termin behaelt die Menge; andere Felder werden weiter gesynct',
    'menge=A/kunde_gesynct=true',v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: Regel-Zuweisung aendern beruehrt den angepassten Termin nicht
do $$
declare v text; occ uuid; occ2 uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments('cb000000-0000-0000-0000-000000000001',
    array['ca000000-0000-0000-0000-00000000000d']::uuid[]);
  perform public.update_job_occurrences('cb000000-0000-0000-0000-000000000001');
  select id into occ2 from public.jobs
   where parent_job_id='cb000000-0000-0000-0000-000000000001' and id <> occ order by date limit 1;
  v := 'angepasst='||pg_temp.menge(occ)||'/geerbt='||pg_temp.menge(occ2);
  insert into _oi values (7,'Regelmengen-Aenderung: angepasster Termin unveraendert, geerbter folgt',
    'angepasst=A/geerbt=P',v);
  raise notice 'CASE 7 -> %', v;
end $$;

-- CASE 8: LEERE angepasste Menge bleibt leer
--   Genau dieser Fall waere mit einer Markierung je Zuweisungszeile
--   nicht abbildbar (keine Zeile -> keine Markierung).
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments(occ, '{}'::uuid[]);
  perform public.update_job_occurrences('cb000000-0000-0000-0000-000000000001');
  v := 'menge='||pg_temp.menge(occ)||'/angepasst='||pg_temp.angepasst(occ)::text
     ||'/legacy='||pg_temp.legacy(occ);
  insert into _oi values (8,'Leere angepasste Menge bleibt nach Regel-Sync leer',
    'menge=LEER/angepasst=true/legacy=NULL',v);
  raise notice 'CASE 8 -> %', v;
end $$;


-- =========================================================
-- C. Zuruecksetzen auf "folgt der Regel"
-- =========================================================

-- CASE 9: Zuruecksetzen uebernimmt die Regelmenge sofort
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.reset_job_occurrence_assignments(occ);
  v := 'menge='||pg_temp.menge(occ)||'/angepasst='||pg_temp.angepasst(occ)::text
     ||'/legacy_gedeckt='||(select (j.assigned_to is null or exists(
          select 1 from public.job_assignments ja where ja.job_id=j.id and ja.employee_id=j.assigned_to))::text
        from public.jobs j where j.id=occ);
  insert into _oi values (9,'Zuruecksetzen stellt die Regelmenge sofort wieder her',
    'menge=P/angepasst=false/legacy_gedeckt=true',v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: nach dem Zuruecksetzen folgt der Termin wieder der Regel
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments('cb000000-0000-0000-0000-000000000001',
    array['ca000000-0000-0000-0000-00000000000b']::uuid[]);
  perform public.update_job_occurrences('cb000000-0000-0000-0000-000000000001');
  v := 'menge='||pg_temp.menge(occ);
  insert into _oi values (10,'Zurueckgesetzter Termin folgt wieder der Regel','menge=B',v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- CASE 11: Zuruecksetzen auf einem Nicht-Termin wird abgelehnt
do $$
declare v text;
begin
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  begin
    perform public.reset_job_occurrence_assignments('cb000000-0000-0000-0000-000000000001');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT'; end;
  insert into _oi values (11,'Zuruecksetzen auf der Regel selbst abgelehnt','ABGELEHNT',v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- CASE 12: Zuruecksetzen durch Employee abgelehnt
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  perform pg_temp.act_as('ca000000-0000-0000-0000-00000000000a');
  begin
    perform public.reset_job_occurrence_assignments(occ);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT'; end;
  insert into _oi values (12,'Employee darf nicht zuruecksetzen','ABGELEHNT',v);
  raise notice 'CASE 12 -> %', v;
end $$;

-- CASE 13: Zuruecksetzen durch Admin einer FREMDEN Firma abgelehnt
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  perform pg_temp.act_as('ca000000-0000-0000-0000-00000000000f');
  begin
    perform public.reset_job_occurrence_assignments(occ);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT'; end;
  insert into _oi values (13,'Fremder Admin darf nicht zuruecksetzen','ABGELEHNT',v);
  raise notice 'CASE 13 -> %', v;
end $$;


-- =========================================================
-- D. Nachweis-Bewahrung
-- =========================================================

-- CASE 14: Zuweisung MIT Anwesenheit ueberlebt die Regel-Synchronisierung
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  -- B hat auf dem geerbten Termin bereits gestartet
  update public.job_assignments set attendance='started', employee_started_at=now()
   where job_id=occ and employee_id='ca000000-0000-0000-0000-00000000000b';

  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments('cb000000-0000-0000-0000-000000000001',
    array['ca000000-0000-0000-0000-00000000000c']::uuid[]);
  perform public.update_job_occurrences('cb000000-0000-0000-0000-000000000001');

  select coalesce(string_agg(pg_temp.kurz(ja.employee_id)||':'||ja.attendance::text
         ||'/'||ja.counts_for_timesheet::text, ',' order by pg_temp.kurz(ja.employee_id)),'LEER')
    into v from public.job_assignments ja where ja.job_id=occ;
  insert into _oi values (14,'Nachweis-Zuweisung (started) ueberlebt den Mengenabgleich',
    'B:started/true,C:assigned/false',v);
  raise notice 'CASE 14 -> %', v;
end $$;

-- CASE 15: Nachweis ueberlebt auch das Zuruecksetzen
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments(occ, array['ca000000-0000-0000-0000-00000000000a']::uuid[]);
  perform public.reset_job_occurrence_assignments(occ);
  select coalesce(string_agg(pg_temp.kurz(ja.employee_id)||':'||ja.attendance::text, ',' order by pg_temp.kurz(ja.employee_id)),'LEER')
    into v from public.job_assignments ja where ja.job_id=occ;
  insert into _oi values (15,'Nachweis-Zuweisung ueberlebt Anpassung und Zuruecksetzen',
    'B:started,C:assigned',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16: gestarteter Termin wird vom Mengenabgleich gar nicht angefasst
do $$
declare v text; occ uuid;
begin
  select id into occ from public.jobs
   where parent_job_id='cb000000-0000-0000-0000-000000000001'
     and id <> pg_temp.erster('cb000000-0000-0000-0000-000000000001')
   order by date limit 1;

  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments(occ, array['ca000000-0000-0000-0000-00000000000a']::uuid[]);
  update public.jobs set status='in_progress', started_at=now() where id=occ;
  delete from public.job_occurrence_assignment_overrides where job_id=occ; -- als "geerbt" markieren

  perform public.set_job_assignments('cb000000-0000-0000-0000-000000000001',
    array['ca000000-0000-0000-0000-00000000000d']::uuid[]);
  perform public.update_job_occurrences('cb000000-0000-0000-0000-000000000001');

  v := 'menge='||pg_temp.menge(occ);
  insert into _oi values (16,'Gestarteter Termin bleibt vom Mengenabgleich ausgenommen','menge=A',v);
  raise notice 'CASE 16 -> %', v;
end $$;

-- CASE 17: anonymisierte Zeile (geloeschtes Konto) ueberlebt den Abgleich
do $$
declare v text; occ uuid;
begin
  occ := pg_temp.erster('cb000000-0000-0000-0000-000000000001');
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments(occ, array['ca000000-0000-0000-0000-00000000000d']::uuid[]);
  delete from auth.users where id='ca000000-0000-0000-0000-00000000000d';
  perform public.reset_job_occurrence_assignments(occ);

  select coalesce(string_agg(coalesce(pg_temp.kurz(ja.employee_id),'ANON')||':'||ja.employee_name_snapshot,
         ',' order by ja.employee_name_snapshot),'LEER')
    into v from public.job_assignments ja where ja.job_id=occ and ja.employee_id is null;
  insert into _oi values (17,'Anonymisierte Zeile ueberlebt Zuruecksetzen und Abgleich','ANON:Paul',v);
  raise notice 'CASE 17 -> %', v;
end $$;


-- =========================================================
-- E. Struktur, Rechte und Sperrreihenfolge
-- =========================================================

-- CASE 18: Markierung verschwindet mit dem Termin (ON DELETE CASCADE)
do $$
declare v text; occ uuid; n_vor int; n_nach int;
begin
  select id into occ from public.jobs
   where parent_job_id='cb000000-0000-0000-0000-000000000001'
   order by date desc limit 1;
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments(occ, array['ca000000-0000-0000-0000-00000000000a']::uuid[]);
  select count(*) into n_vor from public.job_occurrence_assignment_overrides where job_id=occ;
  delete from public.jobs where id=occ;
  select count(*) into n_nach from public.job_occurrence_assignment_overrides where job_id=occ;
  v := 'vor='||n_vor::text||'/nach='||n_nach::text;
  insert into _oi values (18,'Markierung kaskadiert mit dem geloeschten Termin','vor=1/nach=0',v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- CASE 19: Rechte auf der Markierungstabelle
do $$
declare v text;
begin
  v := 'anon='||coalesce((select string_agg(distinct privilege_type,'+') from information_schema.role_table_grants
        where table_schema='public' and table_name='job_occurrence_assignment_overrides' and grantee='anon'),'KEINE')
     ||'/auth='||coalesce((select string_agg(distinct privilege_type,'+' order by privilege_type) from information_schema.role_table_grants
        where table_schema='public' and table_name='job_occurrence_assignment_overrides' and grantee='authenticated'),'KEINE')
     ||'/schreib_policies='||(select count(*)::text from pg_policies
        where schemaname='public' and tablename='job_occurrence_assignment_overrides' and cmd <> 'SELECT')
     ||'/rls='||(select relrowsecurity::text from pg_class where oid='public.job_occurrence_assignment_overrides'::regclass);
  insert into _oi values (19,'Markierungstabelle: anon rechtelos, authenticated nur SELECT, keine Schreib-Policy',
    'anon=KEINE/auth=SELECT/schreib_policies=0/rls=true',v);
  raise notice 'CASE 19 -> %', v;
end $$;

-- CASE 20: interne Hilfsfunktion ist fuer Clients nicht aufrufbar
do $$
declare v text;
begin
  v := 'inherit_auth='||has_function_privilege('authenticated','public.inherit_occurrence_assignments(uuid,uuid)','EXECUTE')::text
     ||'/inherit_anon='||has_function_privilege('anon','public.inherit_occurrence_assignments(uuid,uuid)','EXECUTE')::text
     ||'/reset_auth='||has_function_privilege('authenticated','public.reset_job_occurrence_assignments(uuid)','EXECUTE')::text
     ||'/reset_anon='||has_function_privilege('anon','public.reset_job_occurrence_assignments(uuid)','EXECUTE')::text;
  insert into _oi values (20,'EXECUTE: Hilfsfunktion gesperrt, Reset-RPC nur fuer authenticated',
    'inherit_auth=false/inherit_anon=false/reset_auth=true/reset_anon=false',v);
  raise notice 'CASE 20 -> %', v;
end $$;

-- CASE 21: Sperrreihenfolge Regel -> Termin ist im Code verankert
--   (strukturelle Zusicherung gegen Deadlocks; echte Nebenlaeufigkeit
--    laesst sich in einer Transaktion nicht darstellen)
do $$
declare v text; src text; pos_parent int; pos_child int;
begin
  select pg_get_functiondef('public.set_job_assignments(uuid,uuid[])'::regprocedure) into src;
  pos_parent := position('where id = v_parent for update' in src);
  pos_child  := position('and j.company_id = public.current_user_company_id()' in src);
  v := 'parent_lock_vorhanden='||(pos_parent > 0)::text
     ||'/parent_vor_child='||(pos_parent > 0 and pos_parent < pos_child)::text;
  insert into _oi values (21,'set_job_assignments sperrt die Regel VOR dem Termin',
    'parent_lock_vorhanden=true/parent_vor_child=true',v);
  raise notice 'CASE 21 -> %', v;
end $$;

-- CASE 22: inaktiver Mitarbeiter wird nicht vererbt
--   Geprueft wird gezielt die Abwesenheit des inaktiven Mitarbeiters.
--   Bereits vorhandene anonymisierte Nachweiszeilen duerfen bleiben.
do $$
declare v text; occ uuid;
begin
  perform pg_temp.act_as('ca000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments('cb000000-0000-0000-0000-000000000001',
    array['ca000000-0000-0000-0000-00000000000c']::uuid[]);
  update public.profiles set is_active=false where id='ca000000-0000-0000-0000-00000000000c';

  select id into occ from public.jobs
   where parent_job_id='cb000000-0000-0000-0000-000000000001' and status='open'
     and not exists (select 1 from public.job_occurrence_assignment_overrides o where o.job_id=jobs.id)
   order by date desc limit 1;

  perform public.update_job_occurrences('cb000000-0000-0000-0000-000000000001');

  v := 'inaktiver_vererbt='||(exists(
         select 1 from public.job_assignments ja
         where ja.job_id=occ and ja.employee_id='ca000000-0000-0000-0000-00000000000c'))::text;
  update public.profiles set is_active=true where id='ca000000-0000-0000-0000-00000000000c';
  insert into _oi values (22,'Inaktiver Mitarbeiter wird nicht auf Termine vererbt','inaktiver_vererbt=false',v);
  raise notice 'CASE 22 -> %', v;
end $$;

-- CASE 23: Invariante ueber ALLE Auftraege des Tests
do $$
declare v text;
begin
  select 'verletzungen='||count(*)::text into v
  from public.jobs j
  where j.assigned_to is not null
    and not exists (select 1 from public.job_assignments ja
                    where ja.job_id=j.id and ja.employee_id=j.assigned_to);
  insert into _oi values (23,'Invariante: assigned_to IS NULL ODER durch Zuweisung gedeckt','verletzungen=0',v);
  raise notice 'CASE 23 -> %', v;
end $$;

-- CASE 24: keine doppelten Zuweisungen ueber den gesamten Testlauf
do $$
declare v text;
begin
  select 'duplikate='||count(*)::text into v from (
    select job_id, employee_id from public.job_assignments
    where employee_id is not null group by 1,2 having count(*)>1) d;
  insert into _oi values (24,'Keine doppelten (job_id, employee_id) nach allen Operationen','duplikate=0',v);
  raise notice 'CASE 24 -> %', v;
end $$;


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _oi order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _oi where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'OCCURRENCE ASSIGNMENT INHERITANCE TEST: % Fall/Faelle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE 24 FAELLE PASS';
end $$;

rollback;
