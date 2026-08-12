-- =========================================================
-- TEST: Planned Duration Foundation
-- (Migration 20260813000000_planned_duration_foundation)
-- =========================================================
-- Weist nach:
--   * jobs.planned_duration_minutes ist nullable (Bestand funktioniert
--     unveraendert mit NULL weiter).
--   * chk_jobs_planned_duration_positive lehnt 0/negative Werte ab, laesst
--     NULL und positive Werte zu.
--   * generate_job_occurrences kopiert die Dauer der Parent-Regel auf
--     jede neu erzeugte Occurrence.
--   * update_job_occurrences synct eine geaenderte Dauer auf nicht
--     individuell angepasste, offene Zukunfts-Occurrences (wie
--     customer_name), OHNE sie zu prunen (anders als start_time) und
--     OHNE geschuetzte Occurrences (mit Anhaengen/Historie) anzufassen.
--
-- Aufrufe laufen als 'authenticated' Admin (SET ROLE + request.jwt.claims),
-- also ueber denselben Pfad wie services/jobs/jobs.service.ts.
--
-- AUSFUEHREN lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/planned_duration_foundation.test.sql
-- Legt Testdaten an, macht am Ende ROLLBACK — KEINE Rueckstaende, KEINE
-- Produktionsdaten.
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma C = c1…1 | Admin C = c2…1 | Mitarbeiter C = c2…2

do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000001','authenticated','authenticated','pd-adminC@example.test','{"full_name":"Admin C"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000002','authenticated','authenticated','pd-empC@example.test','{"full_name":"Mitarbeiter C"}');
end $$;

insert into public.profiles (id, full_name) values
  ('c2000000-0000-0000-0000-000000000001','Admin C'),
  ('c2000000-0000-0000-0000-000000000002','Mitarbeiter C')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('c1000000-0000-0000-0000-000000000001','PD Firma C','pd-firma-c-test');

update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='c2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id='c2000000-0000-0000-0000-000000000002';

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role','authenticated')::text, true);
end $f$;

create temporary table _pd_results (
  case_no int, beschreibung text, erwartet text, ergebnis text
) on commit drop;


-- =========================================================
-- CASE 1: Spalte nullable — ein normaler Single-Job ohne Dauer bleibt gueltig.
-- =========================================================
insert into public.jobs
  (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
   status, job_type, date, start_time, is_active)
values
  ('c4000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002',
   'Bestandskunde','Grundreinigung','Bestandsweg 1','open','single', current_date + 1, '10:00', true);

insert into _pd_results
select 1, 'Job ohne planned_duration_minutes bleibt gueltig (NULL)', 'NULL',
  case when (select planned_duration_minutes from public.jobs where id='c4000000-0000-0000-0000-000000000001') is null
       then 'NULL' else 'GESETZT' end;


-- =========================================================
-- CASE 2: CHECK-Constraint lehnt 0/negative Werte ab.
-- =========================================================
do $$
declare
  rejected boolean := false;
begin
  begin
    insert into public.jobs
      (id, company_id, created_by, customer_name, service_name, location_address,
       status, job_type, date, start_time, is_active, planned_duration_minutes)
    values
      ('c4000000-0000-0000-0000-000000000099','c1000000-0000-0000-0000-000000000001',
       'c2000000-0000-0000-0000-000000000001','Ungueltig','Test','Testweg 0',
       'open','single', current_date + 1, '10:00', true, 0);
  exception when check_violation then
    rejected := true;
  end;

  insert into _pd_results values
    (2, 'CHECK-Constraint lehnt planned_duration_minutes=0 ab', 'REJECTED',
     case when rejected then 'REJECTED' else 'AKZEPTIERT' end);
end $$;

-- CASE 3: positiver Wert wird akzeptiert.
insert into public.jobs
  (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
   status, job_type, date, start_time, is_active, planned_duration_minutes)
values
  ('c4000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002',
   'Dauerkunde','Fensterreinigung','Dauerweg 2','open','single', current_date + 1, '11:00', true, 90);

insert into _pd_results
select 3, 'Positiver planned_duration_minutes-Wert wird akzeptiert', '90',
  coalesce((select planned_duration_minutes::text from public.jobs where id='c4000000-0000-0000-0000-000000000002'), 'NULL');


-- =========================================================
-- FIXTURE: Recurring-Regel R (Dauer 60 Min), ein Wochentag = heute+7.
-- =========================================================
do $$
declare
  d_future1 date := current_date + 7;
  d_future2 date := current_date + 14;
  wd_f1 text;
begin
  wd_f1 := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d_future1)::int + 1];

  insert into public.jobs
    (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
     status, job_type, recurring_days, start_time, planned_duration_minutes, is_active,
     recurrence_start_date, recurrence_end_date)
  values
    ('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
     'c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002',
     'Regelkunde','Unterhaltsreinigung','Regelweg 1',
     'open','recurring', array[wd_f1]::text[], '08:00', 60, true,
     current_date - 1, current_date + 60);
end $$;


-- =========================================================
-- CASE 4: generate_job_occurrences kopiert die Dauer der Regel auf jede
-- erzeugte Occurrence.
-- =========================================================
do $$
declare ret int;
begin
  perform pg_temp.act_as('c2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select public.generate_job_occurrences('c3000000-0000-0000-0000-000000000001') into ret;
  execute 'reset role';
end $$;

insert into _pd_results
select 4, 'Neu erzeugte Occurrences erben planned_duration_minutes=60', 'OK',
  case when exists (
    select 1 from public.jobs
    where parent_job_id='c3000000-0000-0000-0000-000000000001'
  ) and not exists (
    select 1 from public.jobs
    where parent_job_id='c3000000-0000-0000-0000-000000000001'
      and planned_duration_minutes is distinct from 60
  ) then 'OK' else 'FALSCH' end;


-- =========================================================
-- FIXTURE: eine zukuenftige, offene, unberuehrte Occurrence (a) und eine
-- geschuetzte (mit Kommentar) Occurrence (b) — beide manuell ergaenzt, um
-- den SYNC-Schritt gezielt zu pruefen (unabhaengig von generate's eigenen
-- Occurrences oben, die denselben Wochentag/Uhrzeit teilen wuerden).
-- =========================================================
do $$
declare
  -- +10/+17 Tage: bewusst KEIN Vielfaches von 7 gegenueber d_future1
  -- (heute+7) versetzt, damit ihr Wochentag nicht mit den bereits von
  -- generate_job_occurrences erzeugten woechentlichen Terminen kollidiert
  -- (sonst verletzt der Insert unten idx_jobs_occurrence_unique).
  d_free      date := current_date + 10;
  d_protected date := current_date + 17;
  wd_free text;
begin
  wd_free := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d_free)::int + 1];
  update public.jobs set recurring_days = array[
    (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from current_date + 7)::int + 1],
    wd_free
  ]::text[]
  where id='c3000000-0000-0000-0000-000000000001';

  -- unberuehrte offene Zukunfts-Occurrence, abweichende Dauer (soll gesynct werden)
  insert into public.jobs
    (id, company_id, parent_job_id, created_by, assigned_to, customer_name, service_name,
     location_address, status, job_type, date, start_time, planned_duration_minutes, is_active)
  values
    ('c4000000-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000001',
     'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
     'c2000000-0000-0000-0000-000000000002','Regelkunde','Unterhaltsreinigung','Regelweg 1',
     'open','single', d_free, '08:00', 45, true);

  -- geschuetzte offene Occurrence (Kommentar), eigener Wochentag NICHT in
  -- recurring_days (bleibt trotzdem geschuetzt, weil sie Anhaenge traegt).
  insert into public.jobs
    (id, company_id, parent_job_id, created_by, assigned_to, customer_name, service_name,
     location_address, status, job_type, date, start_time, planned_duration_minutes, is_active)
  values
    ('c4000000-0000-0000-0000-000000000004','c1000000-0000-0000-0000-000000000001',
     'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
     'c2000000-0000-0000-0000-000000000002','Regelkunde','Unterhaltsreinigung','Regelweg 1',
     'open','single', d_protected, '08:00', 45, true);

  insert into public.job_comments (id, company_id, job_id, author_id, message)
  values ('c5000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
          'c4000000-0000-0000-0000-000000000004','c2000000-0000-0000-0000-000000000002','Geschuetzt.');
end $$;


-- =========================================================
-- EDIT: Regel-Dauer 60 -> 120. update_job_occurrences ausfuehren.
-- =========================================================
do $$
declare ret int;
begin
  update public.jobs set planned_duration_minutes = 120
   where id='c3000000-0000-0000-0000-000000000001';

  perform pg_temp.act_as('c2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select public.update_job_occurrences('c3000000-0000-0000-0000-000000000001') into ret;
  execute 'reset role';
end $$;

-- CASE 5: unberuehrte offene Zukunfts-Occurrence uebernimmt die neue Dauer (SYNC).
insert into _pd_results
select 5, 'Unberuehrte offene Zukunfts-Occurrence uebernimmt neue Dauer (120)', '120',
  coalesce((select planned_duration_minutes::text from public.jobs where id='c4000000-0000-0000-0000-000000000003'), 'WEG/NULL');

-- CASE 6: SYNC prunt NICHT — die Occurrence existiert nach der Dauer-Aenderung weiterhin.
insert into _pd_results
select 6, 'Dauer-Aenderung allein loest KEIN Prunen aus', 'PRESERVED',
  case when exists (select 1 from public.jobs where id='c4000000-0000-0000-0000-000000000003')
       then 'PRESERVED' else 'WEG' end;

-- CASE 7: Kommentar/Foto schuetzen eine Occurrence nur vor PRUNE
-- (Loeschen), NICHT vor SYNC (Inhaltsfelder synct sich weiter — exakt wie
-- customer_name im bestehenden non_destructive_update_job_occurrences-Test,
-- CASE 16). Die geschuetzte Occurrence uebernimmt die neue Dauer also
-- ebenfalls.
insert into _pd_results
select 7, 'Geschuetzte, aber offene/unberuehrte Occurrence synct Dauer trotzdem (120)', '120',
  coalesce((select planned_duration_minutes::text from public.jobs where id='c4000000-0000-0000-0000-000000000004'), 'WEG/NULL');

-- CASE 8: Kommentar der geschuetzten Occurrence weiterhin vorhanden.
insert into _pd_results
select 8, 'Kommentar der geschuetzten Occurrence bleibt erhalten', 'OK',
  case when exists (select 1 from public.job_comments where id='c5000000-0000-0000-0000-000000000001') then 'OK' else 'WEG' end;

-- CASE 9: neu generierte Occurrences (aus GENERATE-Schritt) erhalten ebenfalls 120.
insert into _pd_results
select 9, 'Neu generierte Occurrences nach Dauer-Aenderung tragen 120', 'OK',
  case when not exists (
    select 1 from public.jobs
    where parent_job_id='c3000000-0000-0000-0000-000000000001'
      and status = 'open'
      and started_at is null
      and id not in ('c4000000-0000-0000-0000-000000000004')
      and planned_duration_minutes is distinct from 120
  ) then 'OK' else 'FALSCH' end;


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _pd_results order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _pd_results where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'PLANNED DURATION FOUNDATION TEST: % Fall/Faelle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE FAELLE PASS';
end $$;

rollback;
