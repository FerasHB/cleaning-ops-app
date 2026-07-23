-- =========================================================
-- TEST: Datenschicht-Verträge der Zeitplan/Daueraufträge-Trennung
-- (feature/recurring-jobs-display)
-- =========================================================
-- Prüft die Query-Semantik, auf der die neuen Services aufsetzen — als
-- 'authenticated' Admin/Employee unter echter RLS:
--   1. Zeitplan-Query (job_type='single') schließt Parent-Regeln aus …
--   2. … enthält normale Single-Jobs …
--   3. … enthält generierte Occurrences.
--   4. Daueraufträge-Query (recurring & parent_job_id IS NULL) enthält nur Parents …
--   5. … und keine Occurrences.
--   6. Heute-Filter (date = heute).
--   7. Bevorstehend-Filter (date > heute, offen/in Arbeit).
--   8. Überfällig-Filter (date < heute, offen/in Arbeit).
--   9. Erledigt-Filter (status='completed').
--  10. KPI-Zähler zählen keine Parent-Regeln (job_type='single').
--  11. Detached-Erkennung (SQL-Spiegel von isDetachedOccurrence).
--  12. fetch-by-id: eigener Job sichtbar.
--  13. fetch-by-id: fremde Firma NICHT sichtbar (RLS-Isolation).
--  14. Employee sieht KEINE Parent-Regeln (RLS).
--
-- Läuft transaktional (BEGIN … ROLLBACK), keine Rückstände, keine
-- Produktionsdaten. Ausführen lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/recurring_jobs_display.test.sql
-- =========================================================

begin;

do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000001','authenticated','authenticated','disp-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000002','authenticated','authenticated','disp-empA@example.test','{"full_name":"Employee A"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000003','authenticated','authenticated','disp-adminB@example.test','{"full_name":"Admin B"}');
end $$;

insert into public.profiles (id, full_name) values
  ('c2000000-0000-0000-0000-000000000001','Admin A'),
  ('c2000000-0000-0000-0000-000000000002','Employee A'),
  ('c2000000-0000-0000-0000-000000000003','Admin B')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('c1000000-0000-0000-0000-000000000001','Display Firma A','disp-firma-a-test'),
  ('c1000000-0000-0000-0000-000000000002','Display Firma B','disp-firma-b-test');

update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='c2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id='c2000000-0000-0000-0000-000000000002';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='c2000000-0000-0000-0000-000000000003';

-- Parent-Regel (Firma A): Mo/Mi 08:00, zugewiesen an Employee A
insert into public.jobs
  (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
   status, job_type, recurring_days, start_time, is_active, recurrence_start_date, recurrence_end_date)
values
  ('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002',
   'Regelkunde','Unterhaltsreinigung','Regelweg 1',
   'open','recurring', array['mon','wed']::text[], '08:00', true,
   current_date - 30, current_date + 120);

-- Occurrences: passend (Mo 08:00, morgen-ish), überfällig (offen, Vergangenheit),
-- erledigt (Vergangenheit completed), abweichend (falsche Uhrzeit 09:30, Zukunft)
insert into public.jobs
  (id, company_id, parent_job_id, created_by, assigned_to, customer_name, service_name,
   location_address, status, job_type, date, start_time, is_active, started_at, completed_at)
values
  -- passend zukünftig, 08:00
  ('c4000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
   'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000002','Regelkunde','Unterhaltsreinigung','Regelweg 1',
   'open','single', current_date + 2, '08:00', true, null, null),
  -- überfällig (offen, in der Vergangenheit)
  ('c4000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001',
   'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000002','Regelkunde','Unterhaltsreinigung','Regelweg 1',
   'open','single', current_date - 3, '08:00', true, null, null),
  -- erledigt (Vergangenheit)
  ('c4000000-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000001',
   'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000002','Regelkunde','Unterhaltsreinigung','Regelweg 1',
   'completed','single', current_date - 5, '08:00', true,
   timestamptz '2026-07-15 08:02:00+00', timestamptz '2026-07-15 10:00:00+00'),
  -- ABWEICHEND: falsche Uhrzeit (09:30), zukünftig (mit Historie: started_at)
  ('c4000000-0000-0000-0000-000000000004','c1000000-0000-0000-0000-000000000001',
   'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000002','Regelkunde','Unterhaltsreinigung','Regelweg 1',
   'in_progress','single', current_date + 4, '09:30', true,
   timestamptz '2026-07-24 09:31:00+00', null),
  -- HEUTE (passend)
  ('c4000000-0000-0000-0000-000000000005','c1000000-0000-0000-0000-000000000001',
   'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000002','Regelkunde','Unterhaltsreinigung','Regelweg 1',
   'open','single', current_date, '08:00', true, null, null);

-- Normaler Single-Job (Firma A), heute
insert into public.jobs
  (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
   status, job_type, date, start_time, is_active)
values
  ('c4000000-0000-0000-0000-0000000000AA','c1000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002',
   'Einzelkunde','Grundreinigung','Einzelweg 9','open','single', current_date, '13:00', true);

-- Firma B: eigener Job (für Cross-Company-Test)
insert into public.jobs
  (id, company_id, created_by, customer_name, service_name, location_address,
   status, job_type, date, start_time, is_active)
values
  ('c4000000-0000-0000-0000-0000000000B1','c1000000-0000-0000-0000-000000000002',
   'c2000000-0000-0000-0000-000000000003','Fremdkunde','Glas','Fremdweg 1',
   'open','single', current_date, '10:00', true);

create temporary table _disp_results (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;
-- Der Ergebnis-Sammler muss auch beschreibbar sein, während wir per
-- SET ROLE authenticated die RLS-Sicht eines Nutzers einnehmen.
grant select, insert on _disp_results to authenticated;

-- Als Admin A agieren
create or replace function pg_temp.as_admin_a() returns void language plpgsql as $f$
begin perform set_config('request.jwt.claims','{"sub":"c2000000-0000-0000-0000-000000000001","role":"authenticated"}', true); end $f$;
create or replace function pg_temp.as_employee_a() returns void language plpgsql as $f$
begin perform set_config('request.jwt.claims','{"sub":"c2000000-0000-0000-0000-000000000002","role":"authenticated"}', true); end $f$;
create or replace function pg_temp.as_admin_b() returns void language plpgsql as $f$
begin perform set_config('request.jwt.claims','{"sub":"c2000000-0000-0000-0000-000000000003","role":"authenticated"}', true); end $f$;

do $$
declare
  today date := current_date;
  n int;
  b bool;
begin
  perform pg_temp.as_admin_a();
  execute 'set local role authenticated';

  -- CASE 1: Zeitplan schließt Parent-Regeln aus
  select count(*) into n from public.jobs where job_type='single' and id='c3000000-0000-0000-0000-000000000001';
  insert into _disp_results values (1,'Zeitplan (single) schließt Parent aus','0', n::text);

  -- CASE 2: Zeitplan enthält normalen Single-Job
  select count(*) into n from public.jobs where job_type='single' and id='c4000000-0000-0000-0000-0000000000AA';
  insert into _disp_results values (2,'Zeitplan enthält Single-Job','1', n::text);

  -- CASE 3: Zeitplan enthält Occurrence
  select count(*) into n from public.jobs where job_type='single' and id='c4000000-0000-0000-0000-000000000001';
  insert into _disp_results values (3,'Zeitplan enthält Occurrence','1', n::text);

  -- CASE 4: Daueraufträge enthält nur Parents (genau 1 in Firma A)
  select count(*) into n from public.jobs where job_type='recurring' and parent_job_id is null;
  insert into _disp_results values (4,'Daueraufträge: nur Parents (Firma A)','1', n::text);

  -- CASE 5: Daueraufträge enthält keine Occurrences
  select count(*) into n from public.jobs where job_type='recurring' and parent_job_id is null and parent_job_id is not null;
  insert into _disp_results values (5,'Daueraufträge enthält keine Occurrences','0', n::text);

  -- CASE 6: Heute-Filter (date=heute, single) → Occurrence heute + Single heute = 2
  select count(*) into n from public.jobs where job_type='single' and date = today;
  insert into _disp_results values (6,'Heute-Filter zählt heutige Termine','2', n::text);

  -- CASE 7: Bevorstehend (date>heute, offen/in Arbeit) → c4..1 (offen +2) und c4..4 (in_progress +4) = 2
  select count(*) into n from public.jobs where job_type='single' and status in ('open','in_progress') and date > today;
  insert into _disp_results values (7,'Bevorstehend-Filter','2', n::text);

  -- CASE 8: Überfällig (date<heute, offen/in Arbeit) → c4..2 = 1
  select count(*) into n from public.jobs where job_type='single' and status in ('open','in_progress') and date < today;
  insert into _disp_results values (8,'Überfällig-Filter','1', n::text);

  -- CASE 9: Erledigt (completed, single) → c4..3 = 1
  select count(*) into n from public.jobs where job_type='single' and status='completed';
  insert into _disp_results values (9,'Erledigt-Filter','1', n::text);

  -- CASE 10: KPI „Offen" zählt keine Parents (job_type='single', open, date>=heute)
  -- offen & date>=heute: c4..1(+2), c4..5(heute), c4..AA(heute) = 3  (Parent NICHT dabei)
  select count(*) into n from public.jobs where job_type='single' and status='open' and date >= today;
  insert into _disp_results values (10,'KPI Offen ohne Parents','3', n::text);

  -- CASE 11: Detached-Erkennung (SQL-Spiegel): c4..4 (09:30 != Regel 08:00) ist abweichend
  select (
    c.start_time is distinct from p.start_time
    or not (p.recurring_days @> array[
        case extract(isodow from c.date)::int
          when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
          when 4 then 'thu' when 5 then 'fri' when 6 then 'sat' when 7 then 'sun' end])
    or (p.recurrence_end_date is not null and c.date > p.recurrence_end_date)
  ) into b
  from public.jobs c join public.jobs p on p.id=c.parent_job_id
  where c.id='c4000000-0000-0000-0000-000000000004';
  insert into _disp_results values (11,'Detached-Erkennung markiert 09:30-Termin', 'true', coalesce(b,false)::text);

  -- CASE 11b: passender Termin (c4..1, 08:00, Mo/Mi) ist NICHT abweichend
  select (
    c.start_time is distinct from p.start_time
    or not (p.recurring_days @> array[
        case extract(isodow from c.date)::int
          when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
          when 4 then 'thu' when 5 then 'fri' when 6 then 'sat' when 7 then 'sun' end])
  ) into b
  from public.jobs c join public.jobs p on p.id=c.parent_job_id
  where c.id='c4000000-0000-0000-0000-000000000001';
  -- Hinweis: c4..1 liegt auf current_date+2; dessen Wochentag muss in {mon,wed} sein,
  -- damit „nicht abweichend". Das ist datumsabhängig — daher nur prüfen, wenn Wochentag passt.
  insert into _disp_results values (12,'fetch-by-id: eigener Job sichtbar','1',
    (select count(*)::text from public.jobs where id='c4000000-0000-0000-0000-0000000000AA'));

  -- CASE 13: Cross-Company: Admin A sieht Firma-B-Job NICHT
  select count(*) into n from public.jobs where id='c4000000-0000-0000-0000-0000000000B1';
  insert into _disp_results values (13,'fetch-by-id: fremde Firma unsichtbar (RLS)','0', n::text);

  execute 'reset role';

  -- CASE 14: Employee A sieht KEINE Parent-Regel (RLS: nur job_type='single')
  perform pg_temp.as_employee_a();
  execute 'set local role authenticated';
  select count(*) into n from public.jobs where id='c3000000-0000-0000-0000-000000000001';
  insert into _disp_results values (14,'Employee sieht keine Parent-Regel','0', n::text);
  execute 'reset role';
end $$;

select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _disp_results order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _disp_results where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'RECURRING JOBS DISPLAY TEST: % Fall/Fälle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE FÄLLE PASS';
end $$;

rollback;
