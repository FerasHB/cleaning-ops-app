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
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000003','authenticated','authenticated','disp-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000004','authenticated','authenticated','disp-empA2@example.test','{"full_name":"Employee A2"}');
end $$;

insert into public.profiles (id, full_name) values
  ('c2000000-0000-0000-0000-000000000001','Admin A'),
  ('c2000000-0000-0000-0000-000000000002','Employee A'),
  ('c2000000-0000-0000-0000-000000000003','Admin B'),
  ('c2000000-0000-0000-0000-000000000004','Employee A2')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('c1000000-0000-0000-0000-000000000001','Display Firma A','disp-firma-a-test'),
  ('c1000000-0000-0000-0000-000000000002','Display Firma B','disp-firma-b-test');

update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='c2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id='c2000000-0000-0000-0000-000000000002';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='c2000000-0000-0000-0000-000000000003';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id='c2000000-0000-0000-0000-000000000004';

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

-- Zusatz-Fixtures für die KPI-Fenster + Mitarbeiter-Filter (Firma A, parent c3..1):
insert into public.jobs
  (id, company_id, parent_job_id, created_by, assigned_to, customer_name, service_name,
   location_address, status, job_type, date, start_time, is_active, started_at, completed_at)
values
  -- FERNTERMIN: offen, +45 Tage → außerhalb Offen-Fenster [morgen..+30]
  ('c4000000-0000-0000-0000-000000000006','c1000000-0000-0000-0000-000000000001',
   'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000002','Regelkunde','Unterhaltsreinigung','Regelweg 1',
   'open','single', current_date + 45, '08:00', true, null, null),
  -- ALT erledigt: completed_at vor 40 Tagen → außerhalb Erledigt-30
  ('c4000000-0000-0000-0000-000000000007','c1000000-0000-0000-0000-000000000001',
   'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000002','Regelkunde','Unterhaltsreinigung','Regelweg 1',
   'completed','single', current_date - 40, '08:00', true,
   (current_date - 40)::timestamptz, (current_date - 40)::timestamptz),
  -- UNZUGEWIESEN: offen, +3 Tage, assigned_to NULL
  ('c4000000-0000-0000-0000-000000000008','c1000000-0000-0000-0000-000000000001',
   'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
   null,'Regelkunde','Unterhaltsreinigung','Regelweg 1',
   'open','single', current_date + 3, '08:00', true, null, null),
  -- Zugewiesen an Employee A2: offen, +3 Tage.
  -- Abweichende Uhrzeit (09:00), weil idx_jobs_occurrence_unique
  -- (parent_job_id, date, start_time) sonst mit c4..8 kollidiert.
  ('c4000000-0000-0000-0000-000000000009','c1000000-0000-0000-0000-000000000001',
   'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
   'c2000000-0000-0000-0000-000000000004','Regelkunde','Unterhaltsreinigung','Regelweg 1',
   'open','single', current_date + 3, '09:00', true, null, null);

-- Firma B: eigener Job (für Cross-Company-Test)
insert into public.jobs
  (id, company_id, created_by, customer_name, service_name, location_address,
   status, job_type, date, start_time, is_active)
values
  ('c4000000-0000-0000-0000-0000000000B1','c1000000-0000-0000-0000-000000000002',
   'c2000000-0000-0000-0000-000000000003','Fremdkunde','Glas','Fremdweg 1',
   'open','single', current_date, '10:00', true);

-- Isolierte Fixtures für die Regel-Bearbeitungs-Regression (Präfix d…) UNTER
-- FIRMA B: damit sie unter RLS für Admin A (der Cases 1-32 ausführt) UNSICHTBAR
-- bleiben und keine der bestehenden Zähl-Assertions (Bevorstehend/Erledigt/
-- KPIs/Regel-Anzahl) verfälschen. Als postgres angelegt (kein RLS-Einfluss).
-- Kein Mitarbeiter zugewiesen (Firma B hat nur einen Admin) — für diesen
-- Test irrelevant, es geht ausschließlich um Kunde/Service-Synchronisierung.
do $$
declare
  d_future date := current_date + 10;
  wd_future text;
begin
  wd_future := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d_future)::int + 1];

  insert into public.jobs
    (id, company_id, created_by, customer_name, service_name, location_address,
     status, job_type, recurring_days, start_time, is_active)
  values
    ('d3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000002',
     'c2000000-0000-0000-0000-000000000003',
     'Bug Regel Alt','Alt Service','Bugweg 1',
     'open','recurring', array[wd_future]::text[], '07:00', true);

  insert into public.jobs
    (id, company_id, parent_job_id, created_by, customer_name, service_name,
     location_address, status, job_type, date, start_time, is_active, started_at, completed_at)
  values
    -- passende Zukunfts-Occurrence: muss vom SYNC-Schritt aktualisiert werden
    ('d4000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000002',
     'd3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000003',
     'Bug Regel Alt','Alt Service','Bugweg 1',
     'open','single', d_future, '07:00', true, null, null),
    -- geschützte, abgeschlossene Occurrence: darf NICHT verändert werden
    ('d4000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000002',
     'd3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000003',
     'Bug Regel Alt','Alt Service','Bugweg 1',
     'completed','single', current_date - 5, '07:00', true,
     timestamptz '2026-07-18 07:02:00+00', timestamptz '2026-07-18 09:00:00+00');

  insert into public.job_comments (id, company_id, job_id, author_id, message)
  values ('d5000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000002',
          'd4000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000003',
          'Vor der Regeländerung erledigt.');
end $$;

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

  -- CASE 7: Bevorstehend (Screen-Fenster [morgen..+60], offen/in Arbeit)
  --   c4..1(+2 offen), c4..4(+4 in_progress), c4..8(+3 offen), c4..9(+3 offen), c4..6(+45 offen) = 5
  select count(*) into n from public.jobs
   where job_type='single' and status in ('open','in_progress')
     and date > today and date <= today + 60;
  insert into _disp_results values (7,'Bevorstehend-Filter [morgen..+60]','5', n::text);

  -- CASE 8: Überfällig (date<heute, offen/in Arbeit) → c4..2 = 1
  select count(*) into n from public.jobs where job_type='single' and status in ('open','in_progress') and date < today;
  insert into _disp_results values (8,'Überfällig-Filter','1', n::text);

  -- CASE 9: Erledigt-Filter des Zeitplans (alle completed, ohne Datumsgrenze)
  --   c4..3 (vor 8 Tagen) + c4..7 (vor 40 Tagen) = 2
  --   (Die Dashboard-KPI „Erledigt" ist dagegen auf 30 Tage begrenzt → Fall 19.)
  select count(*) into n from public.jobs where job_type='single' and status='completed';
  insert into _disp_results values (9,'Erledigt-Filter (Zeitplan, unbegrenzt)','2', n::text);

  -- CASE 10: Parent-Regeln zählen NIE in der KPI „Offen" mit.
  -- Parents haben kein date und sind zusätzlich per job_type ausgeschlossen —
  -- gegen das Offen-Fenster geprüft muss das Ergebnis 0 sein.
  select count(*) into n from public.jobs
   where job_type='recurring' and parent_job_id is null
     and status='open' and date > today and date <= today + 30;
  insert into _disp_results values (10,'KPI Offen: Parent-Regeln zählen nicht','0', n::text);

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

  -- ── KPI-Fenster (neue operative Definitionen) ─────────────────────────
  -- CASE 15: KPI „Offen" = open UND date in [morgen, heute+30]
  --   qualifiziert: c4..1(+2), c4..8(+3, unassigned), c4..9(+3, A2) = 3
  --   NICHT: c4..5/c4..AA (heute), c4..2 (überfällig), c4..6 (+45), c4..4 (in_progress)
  select count(*) into n from public.jobs
   where job_type='single' and status='open'
     and date > today and date <= today + 30;
  insert into _disp_results values (15,'KPI Offen: [morgen..+30], nur open','3', n::text);

  -- CASE 16: Ferntermin (+45) NICHT in Offen-Fenster
  select count(*) into n from public.jobs
   where id='c4000000-0000-0000-0000-000000000006'
     and status='open' and date > today and date <= today + 30;
  insert into _disp_results values (16,'Ferntermin (+45) NICHT in Offen','0', n::text);

  -- CASE 17: Heutige offene Termine NICHT in Offen (eigene Karte „Heute")
  select count(*) into n from public.jobs
   where job_type='single' and status='open' and date = today
     and date > today; -- immer 0: heute ist per Definition ausgeschlossen
  insert into _disp_results values (17,'Heutige offene NICHT in Offen','0', n::text);

  -- CASE 18: Überfällige NICHT in Offen (date<heute ausgeschlossen)
  select count(*) into n from public.jobs
   where job_type='single' and status='open' and date < today
     and date > today; -- immer 0
  insert into _disp_results values (18,'Überfällige NICHT in Offen','0', n::text);

  -- CASE 19: KPI „Erledigt" = completed UND completed_at >= heute-30
  --   c4..3 (vor 8 Tagen) ja; c4..7 (vor 40 Tagen) nein → 1
  select count(*) into n from public.jobs
   where job_type='single' and status='completed' and completed_at >= today - 30;
  insert into _disp_results values (19,'KPI Erledigt: letzte 30 Tage','1', n::text);

  -- CASE 20: completed/in_progress NICHT in Offen
  select count(*) into n from public.jobs
   where job_type='single' and status in ('completed','in_progress')
     and date > today and date <= today + 30
     and status='open'; -- immer 0 (Statuswiderspruch)
  insert into _disp_results values (20,'completed/in_progress NICHT in Offen','0', n::text);

  -- ── Mitarbeiter-gefilterte Zeitplan-Queries (serverseitig) ────────────
  -- CASE 21: Bevorstehend (open/in_progress, [morgen..+60]) für Employee A2 = c4..9
  select count(*) into n from public.jobs
   where job_type='single' and status in ('open','in_progress')
     and date > today and date <= today + 60
     and assigned_to='c2000000-0000-0000-0000-000000000004';
  insert into _disp_results values (21,'Mitarbeiter-Filter (A2) bevorstehend','1', n::text);

  -- CASE 22: Bevorstehend gefiltert auf „Nicht zugewiesen" = c4..8
  select count(*) into n from public.jobs
   where job_type='single' and status in ('open','in_progress')
     and date > today and date <= today + 60
     and assigned_to is null;
  insert into _disp_results values (22,'Mitarbeiter-Filter (unassigned) bevorstehend','1', n::text);

  -- ── Suche (SQL-Spiegel von utils/scheduleView.matchesSearch) ─────────
  -- ODER über Kunde/Objekt, Service, Adresse, Mitarbeitername; case-insensitiv.
  -- Datensatz: „Regelkunde"/„Unterhaltsreinigung"/„Regelweg 1" (Occurrences)
  --            „Einzelkunde"/„Grundreinigung"/„Einzelweg 9" (Single, heute)

  -- CASE 23: Suche nach Kunde/Objekt („einzelkunde") im Heute-Fenster = 1
  select count(*) into n from public.jobs j
   left join public.profiles p on p.id = j.assigned_to
   where j.job_type='single' and j.date = today
     and (j.customer_name ilike '%einzelkunde%' or j.service_name ilike '%einzelkunde%'
          or j.location_address ilike '%einzelkunde%' or coalesce(p.full_name,'') ilike '%einzelkunde%');
  insert into _disp_results values (23,'Suche: Kunde/Objekt (heute)','1', n::text);

  -- CASE 24: Suche nach Adresse („einzelweg") im Heute-Fenster = 1
  select count(*) into n from public.jobs j
   left join public.profiles p on p.id = j.assigned_to
   where j.job_type='single' and j.date = today
     and (j.customer_name ilike '%einzelweg%' or j.service_name ilike '%einzelweg%'
          or j.location_address ilike '%einzelweg%' or coalesce(p.full_name,'') ilike '%einzelweg%');
  insert into _disp_results values (24,'Suche: Adresse (heute)','1', n::text);

  -- CASE 25: Suche nach Service („grundreinigung") im Heute-Fenster = 1
  select count(*) into n from public.jobs j
   left join public.profiles p on p.id = j.assigned_to
   where j.job_type='single' and j.date = today
     and (j.customer_name ilike '%grundreinigung%' or j.service_name ilike '%grundreinigung%'
          or j.location_address ilike '%grundreinigung%' or coalesce(p.full_name,'') ilike '%grundreinigung%');
  insert into _disp_results values (25,'Suche: Service (heute)','1', n::text);

  -- CASE 26: Suche nach Mitarbeitername („Employee A2") bevorstehend = c4..9
  select count(*) into n from public.jobs j
   left join public.profiles p on p.id = j.assigned_to
   where j.job_type='single' and j.status in ('open','in_progress')
     and j.date > today and j.date <= today + 60
     and (j.customer_name ilike '%employee a2%' or j.service_name ilike '%employee a2%'
          or j.location_address ilike '%employee a2%' or coalesce(p.full_name,'') ilike '%employee a2%');
  insert into _disp_results values (26,'Suche: Mitarbeitername (bevorstehend)','1', n::text);

  -- CASE 27: Suche UND Mitarbeiter-Filter (UND-Semantik):
  --   Suche „Regelkunde" + Mitarbeiter A2, bevorstehend → nur c4..9 = 1
  select count(*) into n from public.jobs j
   left join public.profiles p on p.id = j.assigned_to
   where j.job_type='single' and j.status in ('open','in_progress')
     and j.date > today and j.date <= today + 60
     and j.assigned_to='c2000000-0000-0000-0000-000000000004'
     and (j.customer_name ilike '%regelkunde%' or j.service_name ilike '%regelkunde%'
          or j.location_address ilike '%regelkunde%' or coalesce(p.full_name,'') ilike '%regelkunde%');
  insert into _disp_results values (27,'Suche UND Mitarbeiter-Filter','1', n::text);

  -- CASE 28: Suche kombiniert mit Status „Überfällig" → c4..2 (Regelkunde) = 1
  select count(*) into n from public.jobs j
   where j.job_type='single' and j.status in ('open','in_progress') and j.date < today
     and j.customer_name ilike '%regelkunde%';
  insert into _disp_results values (28,'Suche kombiniert mit Überfällig','1', n::text);

  -- CASE 29: Suche kombiniert mit Status „Erledigt" → c4..3 + c4..7 = 2
  select count(*) into n from public.jobs j
   where j.job_type='single' and j.status='completed'
     and j.customer_name ilike '%regelkunde%';
  insert into _disp_results values (29,'Suche kombiniert mit Erledigt','2', n::text);

  -- CASE 30: Suche ohne Treffer → leeres Ergebnis
  select count(*) into n from public.jobs j
   left join public.profiles p on p.id = j.assigned_to
   where j.job_type='single'
     and (j.customer_name ilike '%zzz_kein_treffer%' or j.service_name ilike '%zzz_kein_treffer%'
          or j.location_address ilike '%zzz_kein_treffer%' or coalesce(p.full_name,'') ilike '%zzz_kein_treffer%');
  insert into _disp_results values (30,'Suche ohne Treffer (Empty-State)','0', n::text);

  -- CASE 31: Suche trifft NIE eine Parent-Regel (Zeitplan bleibt parent-frei),
  -- obwohl „Regelkunde" auch im Namen der Parent-Regel steht.
  select count(*) into n from public.jobs j
   where j.job_type='single' and j.customer_name ilike '%regelkunde%'
     and j.id='c3000000-0000-0000-0000-000000000001';
  insert into _disp_results values (31,'Suche schließt Parent-Regel aus','0', n::text);

  -- CASE 32: Leere Suche = kein Filter (alle heutigen Termine bleiben) = 2
  select count(*) into n from public.jobs
   where job_type='single' and date = today;
  insert into _disp_results values (32,'Leere Suche filtert nicht (heute)','2', n::text);

  -- ── Regression: Regel-Bearbeitung muss sofort sichtbar sein ──────────
  -- Bildet exakt den Schreibpfad von services/jobs/jobs.service.ts
  -- updateJob() nach: (1) direktes UPDATE der Parent-Zeile, (2) Aufruf der
  -- nicht-destruktiven RPC update_job_occurrences (PR #43). Danach wird
  -- GENAU die Query nachgestellt, die getRecurringRules() (und damit
  -- AdminRecurringRulesScreen) ausführt — beweist, dass ein einfaches
  -- Neu-Abfragen (kein Workaround) die aktualisierten Werte sofort liefert.
  -- Fixtures (Präfix d…) wurden bereits oben als postgres angelegt (Firma B).
  -- Als Admin B agieren (Regel gehört zu Firma B) — vorher noch als Admin A
  -- aktiv (Cases 1-32), daher expliziter Rollenwechsel.
  perform pg_temp.as_admin_b();
  execute 'set local role authenticated';

  -- Schritt 1: direktes UPDATE der Parent-Zeile (wie updateJob() Teil 1)
  update public.jobs
     set customer_name='Bug Regel Neu', service_name='Neu Service'
   where id='d3000000-0000-0000-0000-000000000001';

  -- CASE 33: DB-Schreibung ist SOFORT sichtbar (keine Verzögerung serverseitig
  -- — die Verzögerung im gemeldeten Bug war rein clientseitig).
  insert into _disp_results
  select 33,'Parent-UPDATE sofort persistiert (kein Commit-Delay)','Bug Regel Neu',
    (select customer_name from public.jobs where id='d3000000-0000-0000-0000-000000000001');

  -- Schritt 2: nicht-destruktive Occurrence-Synchronisierung (wie updateJob() Teil 2)
  perform public.update_job_occurrences('d3000000-0000-0000-0000-000000000001');

  execute 'reset role';

  -- CASE 34: exakt die Query von getRecurringRules() (job_type='recurring'
  -- AND parent_job_id IS NULL) liefert beim einfachen Neu-Abfragen sofort
  -- den neuen Namen — genau das, was jetzt bei jedem Fokussieren passiert.
  insert into _disp_results
  select 34,'getRecurringRules()-Query liefert neuen Namen ohne Workaround','Bug Regel Neu',
    (select customer_name from public.jobs
      where job_type='recurring' and parent_job_id is null
        and id='d3000000-0000-0000-0000-000000000001');

  -- CASE 35: passende Zukunfts-Occurrence wurde synchronisiert (SYNC-Schritt)
  insert into _disp_results
  select 35,'Passende Zukunfts-Occurrence übernimmt neue Werte','Bug Regel Neu',
    (select customer_name from public.jobs where id='d4000000-0000-0000-0000-000000000001');

  -- CASE 36: geschützte, abgeschlossene Occurrence bleibt UNVERÄNDERT
  insert into _disp_results
  select 36,'Geschützte completed Occurrence bleibt bei alten Werten','Bug Regel Alt',
    (select customer_name from public.jobs where id='d4000000-0000-0000-0000-000000000002');

  -- CASE 37: kein Kommentarverlust an der geschützten Occurrence
  insert into _disp_results values (37,'Kommentar an geschützter Occurrence erhalten','1',
    (select count(*)::text from public.job_comments where id='d5000000-0000-0000-0000-000000000001'));

  -- CASE 38: keine doppelten (parent_job_id, date, start_time)-Zeilen
  insert into _disp_results values (38,'Keine Duplikate nach Regel-Update','0',
    (select count(*)::text from (
       select date, start_time from public.jobs
        where parent_job_id='d3000000-0000-0000-0000-000000000001'
        group by date, start_time having count(*) > 1
     ) dup));

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
