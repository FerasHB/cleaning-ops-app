-- Transactional regression for migration 20261015000000_single_job_scheduled_start_consistency.sql
-- (scheduled_start wird serverseitig aus date + start_time + Firmen-Zeitzone abgeleitet).
-- Every fixture write rolls back.
begin;
set local time zone 'UTC';

-- ── Fixtures ──────────────────────────────────────────────────────────
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000000','f5000000-0000-0000-0000-000000000001','authenticated','authenticated','ss-admin@example.test','{"full_name":"SS Admin"}'),
  ('00000000-0000-0000-0000-000000000000','f5000000-0000-0000-0000-00000000000a','authenticated','authenticated','ss-e1@example.test','{"full_name":"SS Eins"}'),
  ('00000000-0000-0000-0000-000000000000','f5000000-0000-0000-0000-00000000000b','authenticated','authenticated','ss-e2@example.test','{"full_name":"SS Zwei"}');

insert into public.profiles (id, full_name) values
  ('f5000000-0000-0000-0000-000000000001','SS Admin'),
  ('f5000000-0000-0000-0000-00000000000a','SS Eins'),
  ('f5000000-0000-0000-0000-00000000000b','SS Zwei')
on conflict (id) do nothing;

insert into public.companies (id, name, slug, timezone) values
  ('f4000000-0000-0000-0000-000000000001','SS Berlin',   'ss-berlin-test',   'Europe/Berlin'),
  ('f4000000-0000-0000-0000-000000000002','SS Istanbul', 'ss-istanbul-test', 'Europe/Istanbul'),
  ('f4000000-0000-0000-0000-000000000003','SS Kaputt',   'ss-kaputt-test',   'Not/AZone');

update public.profiles set company_id='f4000000-0000-0000-0000-000000000001', role='admin', is_active=true
where id='f5000000-0000-0000-0000-000000000001';
update public.profiles set company_id='f4000000-0000-0000-0000-000000000001', role='employee', is_active=true
where id in ('f5000000-0000-0000-0000-00000000000a','f5000000-0000-0000-0000-00000000000b');

create temporary table _ss (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.as_admin() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub','f5000000-0000-0000-0000-000000000001','role','authenticated')::text, true);
end $f$;

-- Einzel-Job anlegen (als postgres, wie der Service-Insert, nur ohne RLS).
create or replace function pg_temp.single(p_id uuid, p_company uuid, p_date date, p_time time, p_ss timestamptz)
returns void language sql as $f$
  insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                           job_type, date, start_time, scheduled_start)
  values (p_id, p_company, 'f5000000-0000-0000-0000-000000000001', 'SS Kunde', 'SS Service', 'SS Ort',
          'single', p_date, p_time, p_ss);
$f$;

create or replace function pg_temp.ss(p_id uuid) returns text language sql as $f$
  select coalesce(to_char(scheduled_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'NULL')
  from public.jobs where id = p_id;
$f$;

-- CASE 1: Insert, gelieferter Wert absichtlich falsch (Gerät in UTC, mit Picker-Sekunden)
select pg_temp.single('f6000000-0000-0000-0000-000000000001','f4000000-0000-0000-0000-000000000001',
                      '2026-07-15','14:30','2026-07-15 14:30:37.481+00');
insert into _ss values (1,'Insert: falscher Wert wird kanonisch','2026-07-15T12:30:00.000Z',
                        pg_temp.ss('f6000000-0000-0000-0000-000000000001'));

-- CASE 2: Sommerzeit (MESZ, +2)
select pg_temp.single('f6000000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-000000000001',
                      '2026-08-03','09:00',null);
insert into _ss values (2,'Sommerzeit Berlin','2026-08-03T07:00:00.000Z',
                        pg_temp.ss('f6000000-0000-0000-0000-000000000002'));

-- CASE 3: Winterzeit (MEZ, +1)
select pg_temp.single('f6000000-0000-0000-0000-000000000003','f4000000-0000-0000-0000-000000000001',
                      '2026-12-22','09:00','2026-12-22 09:00+00');
insert into _ss values (3,'Winterzeit Berlin','2026-12-22T08:00:00.000Z',
                        pg_temp.ss('f6000000-0000-0000-0000-000000000003'));

-- CASE 4: kurz nach Mitternacht — UTC-Datum ist der Vortag
select pg_temp.single('f6000000-0000-0000-0000-000000000004','f4000000-0000-0000-0000-000000000001',
                      '2026-07-01','00:30','2026-07-01 00:30+00');
insert into _ss values (4,'00:30 Berlin = Vortag 22:30Z','2026-06-30T22:30:00.000Z',
                        pg_temp.ss('f6000000-0000-0000-0000-000000000004'));

-- CASE 5: nur date ändern (Sommer → Winter, Offset wechselt mit)
update public.jobs set date = '2026-11-10' where id = 'f6000000-0000-0000-0000-000000000001';
insert into _ss values (5,'Update nur date','2026-11-10T13:30:00.000Z',
                        pg_temp.ss('f6000000-0000-0000-0000-000000000001'));

-- CASE 6: nur start_time ändern
update public.jobs set start_time = '18:15' where id = 'f6000000-0000-0000-0000-000000000001';
insert into _ss values (6,'Update nur start_time','2026-11-10T17:15:00.000Z',
                        pg_temp.ss('f6000000-0000-0000-0000-000000000001'));

-- CASE 7: scheduled_start direkt überschreiben → kanonischer Wert bleibt
update public.jobs set scheduled_start = '2030-01-01 00:00+00' where id = 'f6000000-0000-0000-0000-000000000001';
insert into _ss values (7,'Direktes Update scheduled_start wird korrigiert','2026-11-10T17:15:00.000Z',
                        pg_temp.ss('f6000000-0000-0000-0000-000000000001'));

-- CASE 8: company_id wechseln → neue Firmen-Zeitzone (Istanbul, ganzjährig +3)
update public.jobs set company_id = 'f4000000-0000-0000-0000-000000000002' where id = 'f6000000-0000-0000-0000-000000000002';
insert into _ss values (8,'company_id-Wechsel nutzt neue Zeitzone','2026-08-03T06:00:00.000Z',
                        pg_temp.ss('f6000000-0000-0000-0000-000000000002'));

-- CASE 9: ungültige Firmen-Zeitzone → Fallback Europe/Berlin (wie Generator)
select pg_temp.single('f6000000-0000-0000-0000-000000000009','f4000000-0000-0000-0000-000000000003',
                      '2026-08-03','09:00',null);
insert into _ss values (9,'Ungültige Zeitzone ⇒ Europe/Berlin','2026-08-03T07:00:00.000Z',
                        pg_temp.ss('f6000000-0000-0000-0000-000000000009'));

-- CASE 10: Legacy-Zeile (vor dem Trigger geschrieben) wird von themenfremden
-- Updates NICHT umgeschrieben: Status, Zuweisung, created_by/SET NULL über
-- echte Profil-Löschung, updated_at-Touch.
alter table public.jobs disable trigger trg_jobs_sync_scheduled_start;
select pg_temp.single('f6000000-0000-0000-0000-00000000000a','f4000000-0000-0000-0000-000000000001',
                      '2026-05-14','19:12:41','2026-05-14 19:12:41+00');
update public.jobs set created_by = 'f5000000-0000-0000-0000-00000000000b'
where id = 'f6000000-0000-0000-0000-00000000000a';
alter table public.jobs enable trigger trg_jobs_sync_scheduled_start;
do $$
declare v text := '';
begin
  update public.jobs set status = 'in_progress', started_at = '2026-05-14 19:13+00'
  where id = 'f6000000-0000-0000-0000-00000000000a';
  v := v || 'status=' || pg_temp.ss('f6000000-0000-0000-0000-00000000000a');
  update public.jobs set assigned_to = 'f5000000-0000-0000-0000-00000000000a'
  where id = 'f6000000-0000-0000-0000-00000000000a';
  v := v || '/assigned=' || pg_temp.ss('f6000000-0000-0000-0000-00000000000a');
  update public.jobs set updated_at = now(), notes = 'touch', customer_name = 'SS Kunde 2'
  where id = 'f6000000-0000-0000-0000-00000000000a';
  v := v || '/touch=' || pg_temp.ss('f6000000-0000-0000-0000-00000000000a');
  -- echtes ON DELETE SET NULL (jobs_created_by_fkey) über Profil-Löschung
  delete from public.profiles where id = 'f5000000-0000-0000-0000-00000000000b';
  v := v || '/set_null=' || pg_temp.ss('f6000000-0000-0000-0000-00000000000a')
         || '/created_by=' || coalesce((select created_by::text from public.jobs where id='f6000000-0000-0000-0000-00000000000a'),'NULL');
  insert into _ss values (10,'Themenfremde Updates lassen Legacy-Wert stehen',
    'status=2026-05-14T19:12:41.000Z/assigned=2026-05-14T19:12:41.000Z/touch=2026-05-14T19:12:41.000Z/set_null=2026-05-14T19:12:41.000Z/created_by=NULL', v);
end $$;

-- CASE 11: Legacy-Zeile ohne date bzw. ohne start_time bleibt unangetastet
do $$
declare v text := '';
begin
  insert into public.jobs (id, company_id, customer_name, service_name, location_address, job_type, date, start_time, scheduled_start)
  values ('f6000000-0000-0000-0000-00000000000b','f4000000-0000-0000-0000-000000000001','SS','SS','SS','single', null, null, '2026-04-07 20:49:13+00'),
         ('f6000000-0000-0000-0000-00000000000c','f4000000-0000-0000-0000-000000000001','SS','SS','SS','single', '2026-08-23', null, null),
         ('f6000000-0000-0000-0000-00000000000d','f4000000-0000-0000-0000-000000000001','SS','SS','SS','single', null, '09:00', '2026-04-08 21:38+00');
  v := 'no_date_no_time=' || pg_temp.ss('f6000000-0000-0000-0000-00000000000b')
    || '/date_only=' || pg_temp.ss('f6000000-0000-0000-0000-00000000000c')
    || '/time_only=' || pg_temp.ss('f6000000-0000-0000-0000-00000000000d');
  update public.jobs set scheduled_start = '2026-04-07 21:00+00' where id = 'f6000000-0000-0000-0000-00000000000b';
  update public.jobs set start_time = '10:00' where id = 'f6000000-0000-0000-0000-00000000000d';
  v := v || '/upd_no_date=' || pg_temp.ss('f6000000-0000-0000-0000-00000000000b')
         || '/upd_time_only=' || pg_temp.ss('f6000000-0000-0000-0000-00000000000d');
  insert into _ss values (11,'Fehlendes date/start_time ⇒ keine Rekonstruktion',
    'no_date_no_time=2026-04-07T20:49:13.000Z/date_only=NULL/time_only=2026-04-08T21:38:00.000Z/upd_no_date=2026-04-07T21:00:00.000Z/upd_time_only=2026-04-08T21:38:00.000Z', v);
end $$;

-- CASE 12: Recurring-Generator unverändert korrekt; Parent-Regel (date null) bleibt null
insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address, status,
                         job_type, recurring_days, start_time, is_active, recurrence_start_date, recurrence_end_date)
values ('f7000000-0000-0000-0000-000000000001','f4000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000001',
        'SS Regel','SS Service','SS Ort','open','recurring', array['mon','thu'], '14:30', true,
        current_date, current_date + 60);
select public._materialize_recurring_occurrences('f7000000-0000-0000-0000-000000000001', current_date + 60);
do $$
declare v text;
begin
  select 'occ=' || (count(*) > 0)::text
      || '/alle_kanonisch=' || bool_and(scheduled_start = (date + start_time) at time zone 'Europe/Berlin')::text
      || '/overridden=' || bool_or(schedule_overridden)::text
      || '/parent_ss=' || pg_temp.ss('f7000000-0000-0000-0000-000000000001')
  into v from public.jobs where parent_job_id = 'f7000000-0000-0000-0000-000000000001';
  insert into _ss values (12,'Generator: Werte kanonisch, Parent null','occ=true/alle_kanonisch=true/overridden=false/parent_ss=NULL', v);
end $$;

-- CASE 13: Regel-Uhrzeit ändern → update_job_occurrences (RESCHEDULE) bleibt
-- kanonisch und markiert nichts als einzeln angepasst
do $$
declare v text;
begin
  update public.jobs set start_time = '07:45' where id = 'f7000000-0000-0000-0000-000000000001';
  perform pg_temp.as_admin();
  perform public.update_job_occurrences('f7000000-0000-0000-0000-000000000001');
  perform set_config('request.jwt.claims', '', true);
  select 'alle_0745=' || bool_and(start_time = '07:45')::text
      || '/alle_kanonisch=' || bool_and(scheduled_start = (date + start_time) at time zone 'Europe/Berlin')::text
      || '/overridden=' || bool_or(schedule_overridden)::text
  into v from public.jobs where parent_job_id = 'f7000000-0000-0000-0000-000000000001' and date >= current_date;
  insert into _ss values (13,'Regel-Reschedule kanonisch, kein Override','alle_0745=true/alle_kanonisch=true/overridden=false', v);
end $$;

-- CASE 14: schedule_overridden unverändert: Edit-Maske verschiebt einen Termin
-- (Gerät UTC+3, falscher ISO-Wert) ⇒ Override=true wie bisher, Wert kanonisch;
-- ein anderer Termin bekommt nur scheduled_start ⇒ Override bleibt false.
do $$
declare v text; o1 uuid; o2 uuid;
begin
  select id into o1 from public.jobs where parent_job_id = 'f7000000-0000-0000-0000-000000000001' and date >= current_date order by date limit 1;
  select id into o2 from public.jobs where parent_job_id = 'f7000000-0000-0000-0000-000000000001' and date >= current_date order by date offset 1 limit 1;
  update public.jobs
  set date = date + 1, start_time = '16:00', scheduled_start = ((date + 1) + time '16:00') at time zone 'Europe/Istanbul'
  where id = o1;
  update public.jobs set scheduled_start = '2030-01-01 00:00+00' where id = o2;
  select 'o1_overridden=' || (select schedule_overridden from public.jobs where id = o1)::text
      || '/o1_kanonisch=' || (select scheduled_start = (date + start_time) at time zone 'Europe/Berlin' from public.jobs where id = o1)::text
      || '/o2_overridden=' || (select schedule_overridden from public.jobs where id = o2)::text
      || '/o2_kanonisch=' || (select scheduled_start = (date + start_time) at time zone 'Europe/Berlin' from public.jobs where id = o2)::text
  into v;
  insert into _ss values (14,'schedule_overridden-Verhalten unverändert','o1_overridden=true/o1_kanonisch=true/o2_overridden=false/o2_kanonisch=true', v);
end $$;

-- CASE 15: Geräte-Zeitzonen-Unabhängigkeit — gleiche Wanduhr, drei Geräte
do $$
declare v text;
begin
  perform pg_temp.single('f6000000-0000-0000-0000-000000000011','f4000000-0000-0000-0000-000000000001','2026-09-24','15:15','2026-09-24 15:15:18+00');            -- Gerät UTC
  perform pg_temp.single('f6000000-0000-0000-0000-000000000012','f4000000-0000-0000-0000-000000000001','2026-09-24','15:15','2026-09-24 13:15:00+00');            -- Gerät Berlin
  perform pg_temp.single('f6000000-0000-0000-0000-000000000013','f4000000-0000-0000-0000-000000000001','2026-09-24','15:15','2026-09-24 12:15:18+00');            -- Gerät UTC+3
  select pg_temp.ss('f6000000-0000-0000-0000-000000000011') || '|' || pg_temp.ss('f6000000-0000-0000-0000-000000000012') || '|' || pg_temp.ss('f6000000-0000-0000-0000-000000000013')
  into v;
  insert into _ss values (15,'UTC/Berlin/UTC+3-Gerät ⇒ identischer Wert',
    '2026-09-24T13:15:00.000Z|2026-09-24T13:15:00.000Z|2026-09-24T13:15:00.000Z', v);
end $$;

-- CASE 16: Trigger-Definition eng geschnitten (nur INSERT + UPDATE OF 4 Spalten)
do $$
declare v text;
begin
  select pg_get_triggerdef(oid) into v from pg_trigger where tgname = 'trg_jobs_sync_scheduled_start';
  insert into _ss values (16,'Trigger-Definition',
    'CREATE TRIGGER trg_jobs_sync_scheduled_start BEFORE INSERT OR UPDATE OF date, start_time, scheduled_start, company_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION sync_job_scheduled_start()', v);
end $$;

-- ── Auswertung ───────────────────────────────────────────────────────
select case_no, beschreibung, erwartet, ergebnis,
       case when erwartet = ergebnis then 'ok' else 'FAIL' end as verdict
from _ss order by case_no;

do $$
declare n_fail int; n_all int;
begin
  select count(*) filter (where erwartet is distinct from ergebnis), count(*) into n_fail, n_all from _ss;
  if n_all <> 16 then
    raise exception 'SCHEDULED_START TEST: nur % von 16 Fällen gelaufen', n_all;
  end if;
  if n_fail > 0 then
    raise exception 'SCHEDULED_START TEST: % Fall/Fälle FEHLGESCHLAGEN', n_fail;
  end if;
  raise notice 'SCHEDULED_START TEST: alle % Fälle ok', n_all;
end $$;

rollback;
