-- Transactional regression for migration 20261012000000_recurring_horizon_extension.sql
-- (rolling 90-day horizon, tombstones, paused rules, cron worker without JWT).
-- Local-only: every fixture write rolls back. Concurrency lives in
-- recurring_horizon_extension_concurrency.test.sh (needs two connections).
begin;
set local time zone 'UTC';

-- ── Fixtures ──────────────────────────────────────────────────────────
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000001','authenticated','authenticated','rh-admin@example.test','{"full_name":"RH Admin"}'),
  ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-00000000000a','authenticated','authenticated','rh-e1@example.test','{"full_name":"RH Eins"}'),
  ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-00000000000b','authenticated','authenticated','rh-e2@example.test','{"full_name":"RH Zwei"}');

insert into public.profiles (id, full_name) values
  ('f2000000-0000-0000-0000-000000000001','RH Admin'),
  ('f2000000-0000-0000-0000-00000000000a','RH Eins'),
  ('f2000000-0000-0000-0000-00000000000b','RH Zwei')
on conflict (id) do nothing;

insert into public.companies (id, name, slug, timezone) values
  ('f1000000-0000-0000-0000-000000000001','RH Firma','rh-firma-test','Europe/Berlin');

update public.profiles set company_id='f1000000-0000-0000-0000-000000000001', role='admin', is_active=true
where id='f2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='f1000000-0000-0000-0000-000000000001', role='employee', is_active=true
where id in ('f2000000-0000-0000-0000-00000000000a','f2000000-0000-0000-0000-00000000000b');

create temporary table _rh (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;
create temporary table _t on commit drop as
  select current_date as utc_today,
         (now() at time zone 'Europe/Berlin')::date as today;

create or replace function pg_temp.as_admin() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub','f2000000-0000-0000-0000-000000000001','role','authenticated')::text, true);
end $f$;

-- Cron-Kontext: kein JWT, Rolle postgres.
create or replace function pg_temp.as_cron() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', '', true);
end $f$;

-- Erwartete Slot-Daten einer Regel im Fenster [von, bis].
create or replace function pg_temp.slots(p_days text[], p_from date, p_to date)
returns setof date language sql as $f$
  select g::date from generate_series(p_from, p_to, interval '1 day') g
  where p_days @> array[(array['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from g)::int]];
$f$;

-- Regeln (alle als postgres eingefügt):
--   R1 offen, aktiv, Mo/Mi/Fr 09:15, Legacy-Zeiger E1 + Menge {E1,E2}
--   R2 offen, aktiv, Di 10:00 — wird vorab bis heute+90 gefüllt (ok)
--   R3 endet heute+40, aktiv, täglich
--   R4 offen, PAUSIERT, täglich
--   R5 offen, aktiv, Sa, KEINE Zuweisung
insert into public.jobs
  (id, company_id, created_by, customer_name, service_name, location_address, status,
   job_type, recurring_days, start_time, is_active, recurrence_start_date, recurrence_end_date, assigned_to)
select v.id::uuid, 'f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001',
       v.name, 'Reinigung', 'Teststraße 1', 'open', 'recurring', v.days, v.t::time, v.active,
       null, v.ende, v.legacy::uuid
from _t, (values
  ('f3000000-0000-0000-0000-000000000001','R1',array['mon','wed','fri'],'09:15',true, null::date,'f2000000-0000-0000-0000-00000000000a'),
  ('f3000000-0000-0000-0000-000000000002','R2',array['tue'],            '10:00',true, null::date,null),
  ('f3000000-0000-0000-0000-000000000003','R3',array['mon','tue','wed','thu','fri','sat','sun'],'07:00',true,null::date,null),
  ('f3000000-0000-0000-0000-000000000004','R4',array['mon','tue','wed','thu','fri','sat','sun'],'08:00',false,null::date,null),
  ('f3000000-0000-0000-0000-000000000005','R5',array['sat'],            '12:00',true, null::date,null)
) v(id, name, days, t, active, ende, legacy);
update public.jobs set recurrence_end_date = (select today + 40 from _t)
where id = 'f3000000-0000-0000-0000-000000000003';

insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
values ('f3000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-00000000000b','RH Zwei')
on conflict do nothing;  -- E1 entsteht bereits über den Legacy-Zeiger (compat-Trigger)
insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
values ('f3000000-0000-0000-0000-000000000002','f2000000-0000-0000-0000-00000000000a','RH Eins'),
       ('f3000000-0000-0000-0000-000000000003','f2000000-0000-0000-0000-00000000000a','RH Eins'),
       ('f3000000-0000-0000-0000-000000000004','f2000000-0000-0000-0000-00000000000a','RH Eins')
on conflict do nothing;

-- Kurzer Horizont (Simulation "Regel lange nicht angefasst"): R1/R3/R5 bis
-- utc_today+10 bzw. +5, R2 bereits voll.
select public._materialize_recurring_occurrences('f3000000-0000-0000-0000-000000000001', (select utc_today + 10 from _t));
select public._materialize_recurring_occurrences('f3000000-0000-0000-0000-000000000003', (select utc_today + 5  from _t));
select public._materialize_recurring_occurrences('f3000000-0000-0000-0000-000000000005', (select utc_today + 10 from _t));
select public._materialize_recurring_occurrences('f3000000-0000-0000-0000-000000000002', (select today + 90 from _t));

-- Historie an R1: vergangener abgeschlossener + vergangener offener Termin.
insert into public.jobs
  (id, company_id, parent_job_id, created_by, customer_name, service_name, location_address,
   status, job_type, date, occurrence_date, start_time, scheduled_start, started_at, completed_at, is_active)
select 'f4000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001',
       'f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001',
       'R1','Reinigung','Teststraße 1','completed','single', utc_today - 7, utc_today - 7, '09:15',
       (utc_today - 7) + time '09:15', now() - interval '7 days', now() - interval '7 days' + interval '1 hour', true
from _t;
insert into public.jobs
  (id, company_id, parent_job_id, created_by, customer_name, service_name, location_address,
   status, job_type, date, occurrence_date, start_time, scheduled_start, is_active)
select 'f4000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001',
       'f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001',
       'R1','Reinigung','Teststraße 1','open','single', utc_today - 3, utc_today - 3, '09:15',
       (utc_today - 3) + time '09:15', true
from _t;

create temporary table _hist on commit drop as
  select id, md5(row(j.*)::text) as h from public.jobs j
  where j.id in ('f4000000-0000-0000-0000-000000000001','f4000000-0000-0000-0000-000000000002');

-- ── CASE 1: Health vor dem Lauf ───────────────────────────────────────
do $$
declare v text;
begin
  select string_agg(left(parent_job_id::text,8)||'='||status, ',' order by parent_job_id) into v
  from public.recurring_horizon_health
  where company_id = 'f1000000-0000-0000-0000-000000000001';
  insert into _rh values (1,'Health vor Lauf',
    'f3000000=needs_extension,f3000000=ok,f3000000=needs_extension,f3000000=paused,f3000000=needs_extension', v);
end $$;

create temporary table _outbox_before on commit drop as
  select (select count(*) from public.notification_outbox) n;
create temporary table _r2_before on commit drop as
  select last_extended_at from public.recurring_rule_horizons
  where parent_job_id = 'f3000000-0000-0000-0000-000000000002';

-- ── Worker-Lauf 1 (Cron-Kontext) ──────────────────────────────────────
select pg_temp.as_cron();
create temporary table _run1 on commit drop as select public.extend_recurring_horizons() r;

-- CASE 2: R1 bis heute+90, richtige Wochentage/Daten, keine Lücke
do $$
declare v text; exp_dates date[]; got_dates date[];
begin
  select array_agg(d order by d) into exp_dates
  from _t, pg_temp.slots(array['mon','wed','fri'], utc_today, today + 90) d;
  select array_agg(occurrence_date order by occurrence_date) into got_dates
  from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000001'
    and occurrence_date >= (select utc_today from _t);
  v := 'gleich='||(exp_dates = got_dates)::text
    ||'/max_le_heute90='||((select max(d) from unnest(got_dates) d) <= (select today+90 from _t))::text
    ||'/max_ge_heute84='||((select max(d) from unnest(got_dates) d) >= (select today+84 from _t))::text;
  insert into _rh values (2,'R1 rollierend bis heute+90','gleich=true/max_le_heute90=true/max_ge_heute84=true', v);
end $$;

-- CASE 3: start_time + scheduled_start (Firmen-Zeitzone) auf ALLEN neuen R1-Terminen
do $$
declare v text;
begin
  select 'falsch='||count(*) filter (where start_time <> '09:15'
           or scheduled_start <> (occurrence_date + time '09:15') at time zone 'Europe/Berlin'
           or date <> occurrence_date or job_type <> 'single' or status <> 'open')
  into v
  from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000001'
    and occurrence_date >= (select utc_today from _t);
  insert into _rh values (3,'R1 start_time/scheduled_start/date korrekt','falsch=0', v);
end $$;

-- CASE 4: Mehrfachzuweisung genau einmal je Termin, assigned_by NULL für Worker-Termine
do $$
declare v text;
begin
  select 'ohne_genau_E1E2='||count(*) filter (where s <> 'a,b')
       ||'/worker_assigned_by_nicht_null='||sum(nn)
  into v
  from (
    select j.id,
           string_agg(case ja.employee_id when 'f2000000-0000-0000-0000-00000000000a' then 'a'
                                          when 'f2000000-0000-0000-0000-00000000000b' then 'b' end, ',' order by ja.employee_id) s,
           count(*) filter (where ja.assigned_by is not null and j.occurrence_date > (select utc_today + 10 from _t)) nn
    from public.jobs j
    join public.job_assignments ja on ja.job_id = j.id
    where j.parent_job_id='f3000000-0000-0000-0000-000000000001'
      and j.occurrence_date >= (select utc_today from _t)
    group by j.id
  ) x;
  insert into _rh values (4,'R1 {E1,E2} je Termin genau einmal, Worker ohne Akteur',
    'ohne_genau_E1E2=0/worker_assigned_by_nicht_null=0', v);
end $$;

-- CASE 5: R2 (bereits voll) wurde nicht angefasst
do $$
declare v text;
begin
  v := 'unveraendert='||((select last_extended_at from public.recurring_rule_horizons
         where parent_job_id='f3000000-0000-0000-0000-000000000002')
        = (select last_extended_at from _r2_before))::text;
  insert into _rh values (5,'R2 (voll) nicht erneut verarbeitet','unveraendert=true', v);
end $$;

-- CASE 6: R3 endet am echten Regel-Ende, nicht 90 Tage danach
do $$
declare v text; exp_n int; got_n int; got_max date;
begin
  select count(*) into exp_n from _t, pg_temp.slots(array['mon','tue','wed','thu','fri','sat','sun'], utc_today, today + 40);
  select count(*), max(occurrence_date) into got_n, got_max from public.jobs
  where parent_job_id='f3000000-0000-0000-0000-000000000003' and occurrence_date >= (select utc_today from _t);
  v := 'anzahl_ok='||(exp_n = got_n)::text||'/max_eq_ende='||(got_max = (select today+40 from _t))::text;
  insert into _rh values (6,'R3 stoppt am recurrence_end_date','anzahl_ok=true/max_eq_ende=true', v);
end $$;

-- CASE 7: R4 pausiert ⇒ nichts erzeugt
do $$
declare v text;
begin
  v := 'termine='||(select count(*) from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000004');
  insert into _rh values (7,'R4 pausiert: Worker erzeugt nichts','termine=0', v);
end $$;

-- CASE 8: R5 ohne Zuweisung: Termine ja, Zuweisungen nein
do $$
declare v text; exp_n int;
begin
  select count(*) into exp_n from _t, pg_temp.slots(array['sat'], utc_today, today + 90);
  v := 'anzahl_ok='||((select count(*) from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000005') = exp_n)::text
    ||'/zuweisungen='||(select count(*) from public.job_assignments ja join public.jobs j on j.id=ja.job_id
                        where j.parent_job_id='f3000000-0000-0000-0000-000000000005');
  insert into _rh values (8,'R5 ohne Mitarbeiter','anzahl_ok=true/zuweisungen=0', v);
end $$;

-- CASE 9: keine Benachrichtigungen durch den Worker
do $$
declare v text;
begin
  v := 'neu_im_outbox='||((select count(*) from public.notification_outbox) - (select n from _outbox_before));
  insert into _rh values (9,'Worker erzeugt keine Benachrichtigungen','neu_im_outbox=0', v);
end $$;

-- CASE 10: Lauf-Protokoll + Health danach
do $$
declare v text;
begin
  -- rules_due kann Regeln anderer (lokaler) Firmen enthalten ⇒ nur >= 3 prüfen.
  select 'due_ge_3='||((r->>'rules_due')::int >= 3)::text
       ||'/due_eq_extended='||((r->>'rules_due') = (r->>'rules_extended'))::text
       ||'/errors='||(r->>'errors')
       ||'/protokolliert='||(select count(*) from public.recurring_horizon_runs where not skipped_concurrent)::text
       ||'/health_needs_ext='||(select count(*) from public.recurring_horizon_health
                                where company_id='f1000000-0000-0000-0000-000000000001' and needs_extension)
       ||'/health_critical='||(select count(*) from public.recurring_horizon_health
                                where company_id='f1000000-0000-0000-0000-000000000001' and critical)
  into v from _run1;
  insert into _rh values (10,'Lauf protokolliert, Health danach gesund',
    'due_ge_3=true/due_eq_extended=true/errors=0/protokolliert=1/health_needs_ext=0/health_critical=0', v);
end $$;

-- ── Idempotenz: zweiter Lauf ──────────────────────────────────────────
create temporary table _snap on commit drop as
  select (select count(*) from public.jobs where company_id='f1000000-0000-0000-0000-000000000001') jobs_n,
         (select count(*) from public.job_assignments ja join public.jobs j on j.id=ja.job_id
           where j.company_id='f1000000-0000-0000-0000-000000000001') ass_n;
create temporary table _run2 on commit drop as select public.extend_recurring_horizons() r;

do $$
declare v text;
begin
  v := 'inserted='||(select r->>'occurrences_inserted' from _run2)
    ||'/jobs_gleich='||((select count(*) from public.jobs where company_id='f1000000-0000-0000-0000-000000000001') = (select jobs_n from _snap))::text
    ||'/zuweisungen_gleich='||((select count(*) from public.job_assignments ja join public.jobs j on j.id=ja.job_id
           where j.company_id='f1000000-0000-0000-0000-000000000001') = (select ass_n from _snap))::text
    ||'/kern_zweimal='||public._materialize_recurring_occurrences('f3000000-0000-0000-0000-000000000001', (select today+90 from _t))
    ||'/doppelte_slots='||(select count(*) from (select parent_job_id, occurrence_date from public.jobs
           where company_id='f1000000-0000-0000-0000-000000000001' and parent_job_id is not null
           group by 1,2 having count(*)>1) d)
    ||'/doppelte_zuweisungen='||(select count(*) from (select job_id, employee_id from public.job_assignments
           group by 1,2 having count(*)>1) d);
  insert into _rh values (11,'Zweiter Lauf idempotent',
    'inserted=0/jobs_gleich=true/zuweisungen_gleich=true/kern_zweimal=0/doppelte_slots=0/doppelte_zuweisungen=0', v);
end $$;

-- ── Tombstone: Admin löscht einen zukünftigen Termin ──────────────────
create temporary table _del on commit drop as
  select id, occurrence_date from public.jobs
  where parent_job_id='f3000000-0000-0000-0000-000000000001'
    and occurrence_date > (select utc_today + 20 from _t)
  order by occurrence_date limit 1;
grant select on _del to authenticated;

select pg_temp.as_admin();
set local role authenticated;
delete from public.jobs where id = (select id from _del);
reset role;
select pg_temp.as_cron();

-- Horizont künstlich zurücksetzen, damit der Worker R1 erneut voll verarbeitet.
update public.recurring_rule_horizons set generated_through = (select utc_today + 5 from _t)
where parent_job_id = 'f3000000-0000-0000-0000-000000000001';
create temporary table _run3 on commit drop as select public.extend_recurring_horizons() r;

do $$
declare v text;
begin
  v := 'skip='||(select count(*) from public.job_occurrence_skips s
                 where s.parent_job_id='f3000000-0000-0000-0000-000000000001'
                   and s.occurrence_date=(select occurrence_date from _del)
                   and s.skipped_by='f2000000-0000-0000-0000-000000000001'
                   and s.source_job_id=(select id from _del))
    ||'/wiedererzeugt='||(select count(*) from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000001'
                           and occurrence_date=(select occurrence_date from _del))
    ||'/nachbarn_vollstaendig='||(
         (select count(*) from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000001'
            and occurrence_date >= (select utc_today from _t))
         = (select count(*) - 1 from _t, pg_temp.slots(array['mon','wed','fri'], utc_today, today + 90)))::text
    ||'/r1_verarbeitet='||(select (r->>'rules_extended')::int >= 1 from _run3)::text;
  insert into _rh values (12,'Gelöschter Termin bleibt gelöscht, Nachbarn vollständig',
    'skip=1/wiedererzeugt=0/nachbarn_vollstaendig=true/r1_verarbeitet=true', v);
end $$;

-- CASE 13: auch der Admin-Pfad (update_job_occurrences) erzeugt den Slot nicht wieder
select pg_temp.as_admin();
set local role authenticated;
select public.update_job_occurrences('f3000000-0000-0000-0000-000000000001');
reset role;
select pg_temp.as_cron();
do $$
declare v text;
begin
  v := 'wiedererzeugt='||(select count(*) from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000001'
                           and occurrence_date=(select occurrence_date from _del));
  insert into _rh values (13,'Admin-Edit erzeugt Tombstone-Slot nicht wieder','wiedererzeugt=0', v);
end $$;

-- ── Abweichender Termin (schedule_overridden) bleibt erhalten ─────────
create temporary table _ovr on commit drop as
  select id, occurrence_date from public.jobs
  where parent_job_id='f3000000-0000-0000-0000-000000000001'
    and occurrence_date > (select utc_today + 30 from _t)
  order by occurrence_date limit 1;
grant select on _ovr to authenticated;
select pg_temp.as_admin();
set local role authenticated;
update public.jobs set start_time = '15:45' where id = (select id from _ovr);
reset role;
select pg_temp.as_cron();
update public.recurring_rule_horizons set generated_through = (select utc_today + 5 from _t)
where parent_job_id = 'f3000000-0000-0000-0000-000000000001';
select public.extend_recurring_horizons();
do $$
declare v text;
begin
  select 'overridden='||schedule_overridden::text||'/zeit='||start_time::text
       ||'/slot_zeilen='||(select count(*) from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000001'
                            and occurrence_date=(select occurrence_date from _ovr))
  into v from public.jobs where id=(select id from _ovr);
  insert into _rh values (14,'Abweichender Termin unverändert, kein Zweittermin',
    'overridden=true/zeit=15:45:00/slot_zeilen=1', v);
end $$;

-- ── PRUNE (Wochentag entfernt) erzeugt KEINE Tombstones ───────────────
select pg_temp.as_admin();
set local role authenticated;
update public.jobs set recurring_days = array['mon','wed'] where id='f3000000-0000-0000-0000-000000000001';
select public.update_job_occurrences('f3000000-0000-0000-0000-000000000001');
reset role;
select pg_temp.as_cron();
do $$
declare v text;
begin
  v := 'fr_termine_zukunft='||(select count(*) from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000001'
         and occurrence_date >= (select utc_today from _t) and extract(isodow from occurrence_date)=5
         and not schedule_overridden)
    ||'/skips='||(select count(*) from public.job_occurrence_skips where parent_job_id='f3000000-0000-0000-0000-000000000001');
  insert into _rh values (15,'PRUNE durch Regel-Edit legt keine Tombstones an','fr_termine_zukunft=0/skips=1', v);
end $$;

-- ── Pausiert ⇒ Reaktivieren über den normalen App-Pfad füllt sofort ──
select pg_temp.as_admin();
set local role authenticated;
update public.jobs set is_active = true where id='f3000000-0000-0000-0000-000000000004';
select public.update_job_occurrences('f3000000-0000-0000-0000-000000000004');
reset role;
select pg_temp.as_cron();
do $$
declare v text; exp_n int;
begin
  select count(*) into exp_n from _t,
    pg_temp.slots(array['mon','tue','wed','thu','fri','sat','sun'], utc_today, (utc_today + interval '3 months')::date);
  v := 'sofort_gefuellt='||((select count(*) from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000004') = exp_n)::text
    ||'/zugewiesen='||((select count(*) from public.job_assignments ja join public.jobs j on j.id=ja.job_id
                        where j.parent_job_id='f3000000-0000-0000-0000-000000000004') = exp_n)::text;
  insert into _rh values (16,'Reaktivierung füllt Horizont sofort (Admin-Pfad, +3 Monate)','sofort_gefuellt=true/zugewiesen=true', v);
end $$;

-- CASE 17: Pausieren über den App-Pfad erzeugt nichts Neues (Admin-Pfad ebenfalls)
create temporary table _r5_before on commit drop as
  select count(*) n from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000005';
select pg_temp.as_admin();
set local role authenticated;
update public.jobs set is_active = false where id='f3000000-0000-0000-0000-000000000005';
select public.update_job_occurrences('f3000000-0000-0000-0000-000000000005');
select public.generate_job_occurrences('f3000000-0000-0000-0000-000000000005');
reset role;
select pg_temp.as_cron();
update public.recurring_rule_horizons set generated_through = (select utc_today + 1 from _t)
where parent_job_id = 'f3000000-0000-0000-0000-000000000005';
select public.extend_recurring_horizons();
do $$
declare v text;
begin
  v := 'neu='||((select count(*) from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000005') - (select n from _r5_before))
    ||'/status='||(select status from public.recurring_horizon_health where parent_job_id='f3000000-0000-0000-0000-000000000005');
  insert into _rh values (17,'Pausierte Regel: weder Admin-Pfad noch Worker erzeugen','neu=0/status=paused', v);
end $$;

-- ── Historie unverändert ──────────────────────────────────────────────
do $$
declare v text;
begin
  v := 'geaendert='||(select count(*) from _hist h join public.jobs j on j.id=h.id
                      where md5(row(j.*)::text) <> h.h)
     ||'/vorhanden='||(select count(*) from _hist h join public.jobs j on j.id=h.id);
  insert into _rh values (18,'Vergangene/abgeschlossene Termine unverändert','geaendert=0/vorhanden=2', v);
end $$;

-- ── Keine Tombstones für Einzel-Jobs, vergangene Slots und Regel-Löschung ──
insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                         status, job_type, date, start_time, is_active)
select 'f5000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000001',
       'f2000000-0000-0000-0000-000000000001','Einzel','Reinigung','Teststraße 1','open','single',
       utc_today + 3, '09:00', true from _t;
select pg_temp.as_admin();
set local role authenticated;
delete from public.jobs where id='f5000000-0000-0000-0000-000000000001';
delete from public.jobs where id='f4000000-0000-0000-0000-000000000002';           -- vergangener offener Termin
delete from public.jobs where id='f3000000-0000-0000-0000-000000000002';           -- ganze Regel R2 (CASCADE)
reset role;
select pg_temp.as_cron();
do $$
declare v text;
begin
  v := 'skips_gesamt='||(select count(*) from public.job_occurrence_skips s
                         join public.jobs p on p.id = s.parent_job_id
                         where p.company_id='f1000000-0000-0000-0000-000000000001')
    ||'/r2_rest='||(select count(*) from public.jobs where parent_job_id='f3000000-0000-0000-0000-000000000002')
    ||'/r2_skips='||(select count(*) from public.job_occurrence_skips where parent_job_id='f3000000-0000-0000-0000-000000000002')
    ||'/r2_horizont='||(select count(*) from public.recurring_rule_horizons where parent_job_id='f3000000-0000-0000-0000-000000000002');
  insert into _rh values (19,'Keine Tombstones für Einzel-Job/Vergangenheit/Regel-Löschung',
    'skips_gesamt=1/r2_rest=0/r2_skips=0/r2_horizont=0', v);
end $$;

-- ── Zugriffsschutz ────────────────────────────────────────────────────
do $$
declare v text;
begin
  v := 'worker='||has_function_privilege('authenticated','public.extend_recurring_horizons()','execute')::text
    ||'/kern='||has_function_privilege('authenticated','public._materialize_recurring_occurrences(uuid,date)','execute')::text
    ||'/kern_anon='||has_function_privilege('anon','public._materialize_recurring_occurrences(uuid,date)','execute')::text
    ||'/trigger_fn='||has_function_privilege('authenticated','public.record_occurrence_skip()','execute')::text
    ||'/view='||has_table_privilege('authenticated','public.recurring_horizon_health','select')::text
    ||'/skips='||has_table_privilege('authenticated','public.job_occurrence_skips','select')::text
    ||'/horizons='||has_table_privilege('authenticated','public.recurring_rule_horizons','select')::text
    ||'/runs='||has_table_privilege('anon','public.recurring_horizon_runs','select')::text
    ||'/admin_rpc='||has_function_privilege('authenticated','public.generate_job_occurrences(uuid)','execute')::text;
  insert into _rh values (20,'Nur Server darf Worker/Kern/Health',
    'worker=false/kern=false/kern_anon=false/trigger_fn=false/view=false/skips=false/horizons=false/runs=false/admin_rpc=true', v);
end $$;

-- CASE 21: Admin-RPC prüft weiterhin Rolle + Firma
do $$
declare v text := '';
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub','f2000000-0000-0000-0000-00000000000a','role','authenticated')::text, true);
  begin
    set local role authenticated;
    perform public.generate_job_occurrences('f3000000-0000-0000-0000-000000000001');
    v := 'mitarbeiter=ERLAUBT';
  exception when others then
    v := 'mitarbeiter=abgelehnt';
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.generate_job_occurrences('f3000000-0000-0000-0000-000000000001');
    v := v || '/ohne_jwt=ERLAUBT';
  exception when others then
    v := v || '/ohne_jwt=abgelehnt';
  end;
  insert into _rh values (21,'generate_job_occurrences weiter nur für Admins','mitarbeiter=abgelehnt/ohne_jwt=abgelehnt', v);
end $$;

-- CASE 22: Cron-Job vorhanden, genau einmal
do $$
declare v text;
begin
  select 'jobs='||count(*)||'/schedule='||string_agg(schedule, ',')||'/cmd_ok='||bool_and(command ilike '%public.extend_recurring_horizons()%')::text
  into v from cron.job where jobname='recurring-horizon-extension';
  insert into _rh values (22,'pg_cron recurring-horizon-extension','jobs=1/schedule=17 2 * * */cmd_ok=true', v);
end $$;

-- ── Auswertung ───────────────────────────────────────────────────────
select case_no, beschreibung, erwartet, ergebnis,
       case when erwartet = ergebnis then 'ok' else 'FAIL' end as verdict
from _rh order by case_no;

do $$
declare n_fail int; n_all int;
begin
  select count(*) filter (where erwartet is distinct from ergebnis), count(*) into n_fail, n_all from _rh;
  if n_all <> 22 then
    raise exception 'RECURRING HORIZON TEST: nur % von 22 Fällen gelaufen', n_all;
  end if;
  if n_fail > 0 then
    raise exception 'RECURRING HORIZON TEST: % Fall/Fälle FEHLGESCHLAGEN', n_fail;
  end if;
  raise notice 'RECURRING HORIZON TEST: alle % Fälle ok', n_all;
end $$;

rollback;
