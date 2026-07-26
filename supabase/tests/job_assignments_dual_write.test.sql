-- =========================================================
-- TEST: Kompatibilitäts-Dual-Write jobs.assigned_to <-> job_assignments
-- (Migration 20260726000000_job_assignments_dual_write)
-- =========================================================
-- Prüft beide Synchronisierungsrichtungen, die Primär-Regel, den
-- Schleifen- und Sturmschutz, die Bewahrung von Nachweisen sowie das
-- Verhalten auf wiederkehrenden Aufträgen.
--
-- Läuft transaktional (BEGIN … ROLLBACK): keine Rückstände, keine
-- Produktionsdaten. Ausführen lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/job_assignments_dual_write.test.sql
--
-- Ergebnis: Tabelle (case_no | beschreibung | erwartet | ergebnis |
-- verdikt). Schlägt ein Fall fehl, bricht der Lauf am Ende LAUT ab.
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = e1…1 | Firma B = e1…2
-- Admin A = e2…1 | A1 = e2…2 | A2 = e2…3 | A3 = e2…4 | inaktiv = e2…5
-- B1 (Firma B) = e2…6 | löschbar = e2…7

do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000001','authenticated','authenticated','dw-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000002','authenticated','authenticated','dw-a1@example.test','{"full_name":"Anna Eins"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000003','authenticated','authenticated','dw-a2@example.test','{"full_name":"Bert Zwei"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000004','authenticated','authenticated','dw-a3@example.test','{"full_name":"Cora Drei"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000005','authenticated','authenticated','dw-inaktiv@example.test','{"full_name":"Ida Inaktiv"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000006','authenticated','authenticated','dw-b1@example.test','{"full_name":"Bea Fremd"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000007','authenticated','authenticated','dw-del@example.test','{"full_name":"Lars Loeschbar"}');
end $$;

insert into public.profiles (id, full_name) values
  ('e2000000-0000-0000-0000-000000000001','Admin A'),
  ('e2000000-0000-0000-0000-000000000002','Anna Eins'),
  ('e2000000-0000-0000-0000-000000000003','Bert Zwei'),
  ('e2000000-0000-0000-0000-000000000004','Cora Drei'),
  ('e2000000-0000-0000-0000-000000000005','Ida Inaktiv'),
  ('e2000000-0000-0000-0000-000000000006','Bea Fremd'),
  ('e2000000-0000-0000-0000-000000000007','Lars Loeschbar')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('e1000000-0000-0000-0000-000000000001','DW Firma A','dw-firma-a-test'),
  ('e1000000-0000-0000-0000-000000000002','DW Firma B','dw-firma-b-test');

update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='admin',    is_active=true  where id='e2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=true  where id='e2000000-0000-0000-0000-000000000002';
update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=true  where id='e2000000-0000-0000-0000-000000000003';
update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=true  where id='e2000000-0000-0000-0000-000000000004';
update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=false where id='e2000000-0000-0000-0000-000000000005';
update public.profiles set company_id='e1000000-0000-0000-0000-000000000002', role='employee', is_active=true  where id='e2000000-0000-0000-0000-000000000006';
update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=true  where id='e2000000-0000-0000-0000-000000000007';

create temporary table _dw (
  case_no int, beschreibung text, erwartet text, ergebnis text
) on commit drop;

-- Legt einen frischen Auftrag mit altem updated_at an (INSERT feuert
-- trg_jobs_updated_at nicht -> Touch/Änderungen bleiben beobachtbar).
create or replace function pg_temp.mk_job(
  p_id uuid, p_assigned uuid default null, p_status public.job_status default 'open',
  p_started timestamptz default null, p_completed timestamptz default null,
  p_company uuid default 'e1000000-0000-0000-0000-000000000001',
  p_type public.job_type default 'single', p_parent uuid default null
) returns void language plpgsql as $f$
begin
  insert into public.jobs (
    id, company_id, assigned_to, created_by, customer_name, service_name,
    location_address, status, started_at, completed_at, job_type, date,
    start_time, recurring_days, is_active, created_at, updated_at, parent_job_id
  ) values (
    p_id, p_company, p_assigned, 'e2000000-0000-0000-0000-000000000001',
    'Kunde','Service','Ort', p_status, p_started, p_completed, p_type,
    case when p_type='single' then current_date else null end, '08:00',
    case when p_type='recurring' then array['mon'] else null end,
    true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00', p_parent
  );
end;
$f$;

create or replace function pg_temp.legacy(p_job uuid) returns text
language sql as $f$ select coalesce((select assigned_to::text from public.jobs where id=p_job),'NULL'); $f$;

-- Sortiert bewusst nach employee_id und NICHT nach (assigned_at, id):
-- now() ist transaktionsfix, alle in einer Transaktion erzeugten Zeilen
-- teilen sich daher denselben assigned_at, und der id-Tiebreaker waere
-- eine zufaellige UUID -> nicht reproduzierbare Testausgabe.
create or replace function pg_temp.zuw(p_job uuid) returns text
language sql as $f$
  select coalesce(string_agg(
           coalesce(ja.employee_id::text,'ANON')||':'||ja.attendance::text||
           case when ja.review is null then '' else '/'||ja.review::text end,
           ',' order by ja.employee_id nulls last), 'KEINE')
  from public.job_assignments ja where ja.job_id = p_job;
$f$;

-- Zaehlt Tupel-Updates auf public.jobs INNERHALB der laufenden
-- Transaktion. Das ist die einzige verlaessliche Messung fuer
-- "hat ein Trigger ein Folge-Update ausgeloest?" — xmin/xmax taugen dafuer
-- nicht, weil alle Zeilenversionen derselben Transaktion dieselbe xmin
-- tragen.
create or replace function pg_temp.jobs_updates() returns bigint
language sql as $f$
  select coalesce((select n_tup_upd from pg_stat_xact_user_tables
                   where schemaname='public' and relname='jobs'), 0);
$f$;

create or replace function pg_temp.updated(p_job uuid) returns timestamptz
language sql as $f$ select updated_at from public.jobs where id=p_job; $f$;

-- Setzt die JWT-Claims des Aufrufers (fuer die Admin-RPCs ab Phase 3).
create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;


-- =========================================================
-- A. Richtung Legacy -> job_assignments
-- =========================================================

-- CASE 1: NULL -> Mitarbeiter legt Zuweisung an
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000001');
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000002' where id='e4000000-0000-0000-0000-000000000001';
  select 'zuw='||pg_temp.zuw('e4000000-0000-0000-0000-000000000001')
         ||'/snapshot='||coalesce((select employee_name_snapshot from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000001'),'-')
         ||'/by='||coalesce((select assigned_by::text from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000001'),'-')
    into v;
  insert into _dw values (1,'NULL -> Mitarbeiter legt Zuweisung an',
    'zuw=e2000000-0000-0000-0000-000000000002:assigned/snapshot=Anna Eins/by=e2000000-0000-0000-0000-000000000001', v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2: derselbe Mitarbeiter zweimal geschrieben -> idempotent
do $$
declare v text; n int;
begin
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000002' where id='e4000000-0000-0000-0000-000000000001';
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000002' where id='e4000000-0000-0000-0000-000000000001';
  select count(*) into n from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000001';
  v := 'zeilen='||n::text;
  insert into _dw values (2,'Derselbe Mitarbeiter mehrfach geschrieben bleibt idempotent','zeilen=1',v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3+4: A -> B legt B an und entfernt das SAUBERE A
do $$
declare v text;
begin
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003' where id='e4000000-0000-0000-0000-000000000001';
  v := pg_temp.zuw('e4000000-0000-0000-0000-000000000001');
  insert into _dw values (3,'A -> B legt Zuweisung fuer B an','e2000000-0000-0000-0000-000000000003:assigned',v);
  insert into _dw values (4,'Saubere Zuweisung von A wird nach Umzuweisung entfernt','e2000000-0000-0000-0000-000000000003:assigned',v);
  raise notice 'CASE 3+4 -> %', v;
end $$;

-- CASE 5: A mit attendance='started' bleibt nach Umzuweisung erhalten
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000002');
  update public.job_assignments set attendance='started', employee_started_at=now()
   where job_id='e4000000-0000-0000-0000-000000000002';
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003' where id='e4000000-0000-0000-0000-000000000002';
  v := pg_temp.zuw('e4000000-0000-0000-0000-000000000002');
  insert into _dw values (5,'A mit attendance=started bleibt nach Umzuweisung erhalten',
    'e2000000-0000-0000-0000-000000000002:started,e2000000-0000-0000-0000-000000000003:assigned', v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6: A mit attendance='completed' bleibt erhalten
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000002');
  update public.job_assignments set attendance='completed', employee_started_at=now(), employee_completed_at=now()
   where job_id='e4000000-0000-0000-0000-000000000003';
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003' where id='e4000000-0000-0000-0000-000000000003';
  v := pg_temp.zuw('e4000000-0000-0000-0000-000000000003');
  insert into _dw values (6,'A mit attendance=completed bleibt erhalten',
    'e2000000-0000-0000-0000-000000000002:completed,e2000000-0000-0000-0000-000000000003:assigned', v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: A mit review='present' bleibt erhalten (Anwesenheit unveraendert)
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000004','e2000000-0000-0000-0000-000000000002');
  update public.job_assignments set review='present', reviewed_at=now(), reviewed_by='e2000000-0000-0000-0000-000000000001'
   where job_id='e4000000-0000-0000-0000-000000000004';
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003' where id='e4000000-0000-0000-0000-000000000004';
  v := pg_temp.zuw('e4000000-0000-0000-0000-000000000004');
  insert into _dw values (7,'A mit review=present bleibt erhalten',
    'e2000000-0000-0000-0000-000000000002:assigned/present,e2000000-0000-0000-0000-000000000003:assigned', v);
  raise notice 'CASE 7 -> %', v;
end $$;

-- CASE 8: A mit review='absent' bleibt erhalten
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000005','e2000000-0000-0000-0000-000000000002');
  update public.job_assignments set review='absent', reviewed_at=now(), reviewed_by='e2000000-0000-0000-0000-000000000001'
   where job_id='e4000000-0000-0000-0000-000000000005';
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003' where id='e4000000-0000-0000-0000-000000000005';
  v := pg_temp.zuw('e4000000-0000-0000-0000-000000000005');
  insert into _dw values (8,'A mit review=absent bleibt erhalten',
    'e2000000-0000-0000-0000-000000000002:assigned/absent,e2000000-0000-0000-0000-000000000003:assigned', v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9: Mitarbeiter -> NULL entfernt NUR die saubere Zuweisung
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000006','e2000000-0000-0000-0000-000000000002');
  update public.jobs set assigned_to=null where id='e4000000-0000-0000-0000-000000000006';
  v := 'zuw='||pg_temp.zuw('e4000000-0000-0000-0000-000000000006')||'/legacy='||pg_temp.legacy('e4000000-0000-0000-0000-000000000006');
  insert into _dw values (9,'Mitarbeiter -> NULL entfernt saubere Zuweisung','zuw=KEINE/legacy=NULL',v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: Mitarbeiter -> NULL bewahrt Nachweis-Zuweisung
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000007','e2000000-0000-0000-0000-000000000002');
  update public.job_assignments set attendance='started', employee_started_at=now()
   where job_id='e4000000-0000-0000-0000-000000000007';
  update public.jobs set assigned_to=null where id='e4000000-0000-0000-0000-000000000007';
  v := 'zuw='||pg_temp.zuw('e4000000-0000-0000-0000-000000000007')||'/legacy='||pg_temp.legacy('e4000000-0000-0000-0000-000000000007');
  insert into _dw values (10,'Mitarbeiter -> NULL bewahrt Nachweis-Zuweisung',
    'zuw=e2000000-0000-0000-0000-000000000002:started/legacy=NULL',v);
  raise notice 'CASE 10 -> %', v;
end $$;


-- =========================================================
-- B. Richtung job_assignments -> Legacy (Primaer-Regel)
-- =========================================================

-- CASE 11: Zuweisungs-INSERT fuellt leeres assigned_to
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000010');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_at)
  values ('e4000000-0000-0000-0000-000000000010','e2000000-0000-0000-0000-000000000002','Anna Eins', now() - interval '3 min');
  v := pg_temp.legacy('e4000000-0000-0000-0000-000000000010');
  insert into _dw values (11,'Zuweisungs-INSERT fuellt leeres jobs.assigned_to','e2000000-0000-0000-0000-000000000002',v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- CASE 12: zweite Zuweisung ersetzt einen gueltigen Primaer NICHT
do $$
declare v text;
begin
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_at)
  values ('e4000000-0000-0000-0000-000000000010','e2000000-0000-0000-0000-000000000003','Bert Zwei', now() - interval '2 min');
  v := pg_temp.legacy('e4000000-0000-0000-0000-000000000010');
  insert into _dw values (12,'Zweite Zuweisung ersetzt gueltigen Primaer nicht','e2000000-0000-0000-0000-000000000002',v);
  raise notice 'CASE 12 -> %', v;
end $$;

-- CASE 13: Entfernen des Primaers waehlt die naechste geeignete Zuweisung
do $$
declare v text;
begin
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_at)
  values ('e4000000-0000-0000-0000-000000000010','e2000000-0000-0000-0000-000000000004','Cora Drei', now() - interval '1 min');
  delete from public.job_assignments
   where job_id='e4000000-0000-0000-0000-000000000010' and employee_id='e2000000-0000-0000-0000-000000000002';
  v := pg_temp.legacy('e4000000-0000-0000-0000-000000000010');
  insert into _dw values (13,'Entfernen des Primaers waehlt aeltesten verbleibenden (assigned_at, id)',
    'e2000000-0000-0000-0000-000000000003',v);
  raise notice 'CASE 13 -> %', v;
end $$;

-- CASE 14: Entfernen der LETZTEN lebenden Zuweisung setzt assigned_to auf NULL
do $$
declare v text;
begin
  delete from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000010';
  v := pg_temp.legacy('e4000000-0000-0000-0000-000000000010');
  insert into _dw values (14,'Entfernen der letzten Zuweisung setzt assigned_to auf NULL','NULL',v);
  raise notice 'CASE 14 -> %', v;
end $$;

-- CASE 15: anonyme (employee_id IS NULL) Zeilen werden nie primaer
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000011');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
  values ('e4000000-0000-0000-0000-000000000011','e2000000-0000-0000-0000-000000000007','Lars Loeschbar');
  -- anonymisieren ueber den echten FK-Pfad
  delete from auth.users where id='e2000000-0000-0000-0000-000000000007';
  v := 'legacy='||pg_temp.legacy('e4000000-0000-0000-0000-000000000011')
       ||'/zuw='||pg_temp.zuw('e4000000-0000-0000-0000-000000000011')
       ||'/snapshot='||coalesce((select employee_name_snapshot from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000011'),'-');
  insert into _dw values (15,'Anonyme Zeile wird nie primaer; Snapshot bleibt erhalten',
    'legacy=NULL/zuw=ANON:assigned/snapshot=Lars Loeschbar',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16: Konto-Loeschung waehlt einen anderen Primaer, wenn vorhanden
do $$
declare v text;
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000008','authenticated','authenticated','dw-del2@example.test','{"full_name":"Mia Weg"}');
  insert into public.profiles (id, full_name) values ('e2000000-0000-0000-0000-000000000008','Mia Weg') on conflict (id) do nothing;
  update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=true
   where id='e2000000-0000-0000-0000-000000000008';

  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000012');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_at)
  values ('e4000000-0000-0000-0000-000000000012','e2000000-0000-0000-0000-000000000008','Mia Weg', now() - interval '5 min');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_at)
  values ('e4000000-0000-0000-0000-000000000012','e2000000-0000-0000-0000-000000000003','Bert Zwei', now() - interval '1 min');

  delete from auth.users where id='e2000000-0000-0000-0000-000000000008';

  v := 'legacy='||pg_temp.legacy('e4000000-0000-0000-0000-000000000012')
       ||'/snapshot_bleibt='||(select count(*) from public.job_assignments
            where job_id='e4000000-0000-0000-0000-000000000012' and employee_name_snapshot='Mia Weg')::text;
  insert into _dw values (16,'Konto-Loeschung: Snapshot bleibt, anderer Primaer wird gewaehlt',
    'legacy=e2000000-0000-0000-0000-000000000003/snapshot_bleibt=1',v);
  raise notice 'CASE 16 -> %', v;
end $$;


-- =========================================================
-- C. Schleifen-, Sturm- und Konsistenzschutz
-- =========================================================

-- CASE 17: keine Trigger-Rekursion (Flag ist nach dem Schreiben sauber)
do $$
declare v text; flag text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000020');
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000002' where id='e4000000-0000-0000-0000-000000000020';
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003' where id='e4000000-0000-0000-0000-000000000020';
  update public.jobs set assigned_to=null where id='e4000000-0000-0000-0000-000000000020';
  flag := coalesce(current_setting('app.jobs_assignment_sync', true),'');
  -- Nach Abschluss aller Sync-Vorgaenge muss das Flag wieder leer sein,
  -- sonst waeren nachfolgende Trigger in derselben Transaktion stumm.
  v := 'zuw=' || pg_temp.zuw('e4000000-0000-0000-0000-000000000020')
       || '/legacy=' || pg_temp.legacy('e4000000-0000-0000-0000-000000000020')
       || '/flag=[' || flag || ']';
  insert into _dw values (17,'Keine Rekursion; Sync-Flag nach Abschluss zurueckgesetzt',
    'zuw=KEINE/legacy=NULL/flag=[]', v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- CASE 18: keine doppelten Zuweisungszeilen ueber alle Testauftraege
do $$
declare v text;
begin
  select 'duplikate='||count(*)::text into v from (
    select job_id, employee_id from public.job_assignments
    where employee_id is not null group by 1,2 having count(*)>1
  ) d;
  insert into _dw values (18,'Keine doppelten (job_id, employee_id)-Zuweisungen','duplikate=0',v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- CASE 19: jobs.updated_at aendert sich NUR bei echter Kompatibilitaets-Aenderung
do $$
declare v text; t0 timestamptz; t1 timestamptz; t2 timestamptz;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000021');
  t0 := pg_temp.updated('e4000000-0000-0000-0000-000000000021');

  -- (a) echte Zuweisungsaenderung -> updated_at MUSS steigen
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
  values ('e4000000-0000-0000-0000-000000000021','e2000000-0000-0000-0000-000000000002','Anna Eins');
  t1 := pg_temp.updated('e4000000-0000-0000-0000-000000000021');

  -- (b) reine Anwesenheitsaenderung: Richtung B feuert nicht (UPDATE OF
  --     employee_id), der Touch schon -> updated_at darf steigen, aber es
  --     darf KEIN assigned_to-Schreibvorgang stattfinden.
  update public.job_assignments set attendance='started', employee_started_at=now()
   where job_id='e4000000-0000-0000-0000-000000000021';
  t2 := pg_temp.updated('e4000000-0000-0000-0000-000000000021');

  v := 'a_gestiegen='||(t1 > t0)::text||'/legacy='||pg_temp.legacy('e4000000-0000-0000-0000-000000000021')
       ||'/b_kein_rueckschritt='||(t2 >= t1)::text;
  insert into _dw values (19,'updated_at steigt bei echter Aenderung; Primaer bleibt bei Anwesenheitsaenderung stabil',
    'a_gestiegen=true/legacy=e2000000-0000-0000-0000-000000000002/b_kein_rueckschritt=true', v);
  raise notice 'CASE 19 -> %', v;
end $$;

-- CASE 20: identische Wiederholung erzeugt KEINE weiteren Schreibvorgaenge
--   xmin der jobs-Zeile aendert sich nur bei echtem Row-Update.
do $$
declare v text; id0 text; id1 text; n0 int; n1 int; u0 bigint; u1 bigint;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000022','e2000000-0000-0000-0000-000000000002');
  select count(*), min(id::text) into n0, id0 from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000022';
  u0 := pg_temp.jobs_updates();

  -- Identischer Wert erneut geschrieben: die WHEN-Klausel unterdrueckt den
  -- Trigger vollstaendig, die Funktion laeuft gar nicht erst an.
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000002' where id='e4000000-0000-0000-0000-000000000022';

  u1 := pg_temp.jobs_updates();
  select count(*), min(id::text) into n1, id1 from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000022';

  -- Genau EIN Tupel-Update (das eigene) und dieselbe, unveraenderte
  -- Zuweisungszeile -> kein Delete+Insert, kein Trigger-Folgeupdate.
  v := 'zuweisungen='||n0::text||'->'||n1::text
       ||'/zeile_identisch='||(id0 = id1)::text
       ||'/jobs_updates='||(u1 - u0)::text;
  insert into _dw values (20,'Identische Wiederholung: keine zusaetzliche Zuweisung, genau ein Tupel-Update',
    'zuweisungen=1->1/zeile_identisch=true/jobs_updates=1', v);
  raise notice 'CASE 20 -> %', v;
end $$;


-- =========================================================
-- D. Bestandsdaten und historische Ausnahmen
-- =========================================================

-- CASE 21: produktionsaehnlicher Bestand bleibt stabil
--   30 Zeilen im Verhaeltnis der Produktion (completed/started/assigned),
--   danach eine unbeteiligte Schreiboperation auf einem anderen Auftrag.
do $$
declare v text; i int; n_vor int; n_nach int; c_vor int; c_nach int;
begin
  for i in 1..30 loop
    perform pg_temp.mk_job(
      ('e5000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,
      'e2000000-0000-0000-0000-000000000002',
      case when i <= 3 then 'completed'::public.job_status
           when i <= 6 then 'in_progress'::public.job_status
           else 'open'::public.job_status end,
      case when i <= 6 then timestamptz '2026-06-01 08:00+00' end,
      case when i <= 3 then timestamptz '2026-06-01 10:00+00' end
    );
  end loop;

  select count(*), count(*) filter (where counts_for_timesheet)
    into n_vor, c_vor
  from public.job_assignments where job_id::text like 'e5000000%';

  -- unbeteiligte Operation
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000030','e2000000-0000-0000-0000-000000000003');
  update public.jobs set assigned_to=null where id='e4000000-0000-0000-0000-000000000030';

  select count(*), count(*) filter (where counts_for_timesheet)
    into n_nach, c_nach
  from public.job_assignments where job_id::text like 'e5000000%';

  v := 'zeilen='||n_vor::text||'->'||n_nach::text||'/counts='||c_vor::text||'->'||c_nach::text;
  insert into _dw values (21,'Produktionsaehnlicher Bestand (30 Zeilen) bleibt durch unbeteiligte Schreibvorgaenge stabil',
    'zeilen=30->30/counts=6->6', v);
  raise notice 'CASE 21 -> %', v;
end $$;

-- CASE 22: historische Guard-Ausnahme wird nicht geloescht/revalidiert
--   Nachbildung der Produktion: Zuweisung an einen INAKTIVEN Mitarbeiter
--   (angelegt wie im Phase-1-Backfill, also am Guard vorbei), danach eine
--   unbeteiligte Aenderung am selben Auftrag.
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000040', null, 'in_progress', timestamptz '2026-06-01 08:00+00');

  alter table public.job_assignments disable trigger enforce_active_assignment_on_job_assignments;
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, attendance, employee_started_at)
  values ('e4000000-0000-0000-0000-000000000040','e2000000-0000-0000-0000-000000000005','Ida Inaktiv','started', timestamptz '2026-06-01 08:00+00');
  alter table public.job_assignments enable trigger enforce_active_assignment_on_job_assignments;

  -- unbeteiligte Aenderung am selben Auftrag (kein assigned_to)
  update public.jobs set notes='unbeteiligt' where id='e4000000-0000-0000-0000-000000000040';
  -- und eine Zuweisung eines anderen Mitarbeiters
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003' where id='e4000000-0000-0000-0000-000000000040';

  v := 'ausnahme_bleibt='||(select count(*) from public.job_assignments
         where job_id='e4000000-0000-0000-0000-000000000040' and employee_id='e2000000-0000-0000-0000-000000000005')::text
       ||'/attendance='||coalesce((select attendance::text from public.job_assignments
         where job_id='e4000000-0000-0000-0000-000000000040' and employee_id='e2000000-0000-0000-0000-000000000005'),'-')
       ||'/counts='||coalesce((select counts_for_timesheet::text from public.job_assignments
         where job_id='e4000000-0000-0000-0000-000000000040' and employee_id='e2000000-0000-0000-0000-000000000005'),'-');
  insert into _dw values (22,'Historische Guard-Ausnahme wird nicht geloescht oder revalidiert',
    'ausnahme_bleibt=1/attendance=started/counts=true', v);
  raise notice 'CASE 22 -> %', v;
end $$;


-- =========================================================
-- E. Wiederkehrende Auftraege
-- =========================================================

-- CASE 23: Parent-Regel erhaelt eine Vorlagen-Zuweisung
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000050', null, 'open', null, null,
                         'e1000000-0000-0000-0000-000000000001','recurring', null);
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000002' where id='e4000000-0000-0000-0000-000000000050';
  v := 'zuw='||pg_temp.zuw('e4000000-0000-0000-0000-000000000050')||'/legacy='||pg_temp.legacy('e4000000-0000-0000-0000-000000000050');
  insert into _dw values (23,'Parent-Regel: Vorlagen-Zuweisung wird gespiegelt',
    'zuw=e2000000-0000-0000-0000-000000000002:assigned/legacy=e2000000-0000-0000-0000-000000000002', v);
  raise notice 'CASE 23 -> %', v;
end $$;

-- CASE 24: Occurrence spiegelt den Legacy-Wert; Loeschen kaskadiert sauber
do $$
declare v text; rest int;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000051','e2000000-0000-0000-0000-000000000002','open',
                         null, null, 'e1000000-0000-0000-0000-000000000001','single','e4000000-0000-0000-0000-000000000050');
  v := 'zuw='||pg_temp.zuw('e4000000-0000-0000-0000-000000000051');

  -- Occurrence loeschen -> Kaskade, Richtung B darf nicht stolpern
  begin
    delete from public.jobs where id='e4000000-0000-0000-0000-000000000051';
    select count(*) into rest from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000051';
    v := v || '/geloescht=ok/rest='||rest::text;
  exception when others then v := v || '/geloescht=FEHLER('||sqlstate||')';
  end;

  insert into _dw values (24,'Occurrence spiegelt Legacy-Wert; Loeschung kaskadiert ohne Fehler',
    'zuw=e2000000-0000-0000-0000-000000000002:assigned/geloescht=ok/rest=0', v);
  raise notice 'CASE 24 -> %', v;
end $$;

-- CASE 25: Bulk-UPDATE wie im SYNC-Block von update_job_occurrences
--   erzeugt genau EINE Zeilenversion je Auftrag (kein Realtime-Sturm).
do $$
declare v text; i int; u0 bigint; u1 bigint;
begin
  for i in 1..10 loop
    perform pg_temp.mk_job(('e6000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,
                           'e2000000-0000-0000-0000-000000000002');
  end loop;

  u0 := pg_temp.jobs_updates();

  -- Mengenoperation wie im SYNC-Block von update_job_occurrences()
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003'
   where id::text like 'e6000000%';

  u1 := pg_temp.jobs_updates();

  -- ENTSCHEIDEND: genau 10 Tupel-Updates auf jobs — eines je Auftrag.
  -- Ohne die Touch-Unterdrueckung waeren es 20 (und in Produktion bei
  -- einem Regel-Edit bis zu 1248 statt 624), samt doppelter
  -- Realtime-Events.
  v := 'zuweisungen='||(select count(*) from public.job_assignments where job_id::text like 'e6000000%')::text
       ||'/jobs_updates='||(u1 - u0)::text;
  insert into _dw values (25,'Bulk-Umzuweisung (10 Auftraege): genau 10 Tupel-Updates, kein Touch-Folgeupdate',
    'zuweisungen=10/jobs_updates=10', v);
  raise notice 'CASE 25 -> %', v;
end $$;



-- =========================================================
-- F. Legacy-Schreibvorgang ersetzt die MENGE
--    (Migration 20260729000000 — Mischmengen-Befund aus den Reviews
--     zu PR #52 / PR #53)
-- =========================================================

-- CASE 26: Alt-Client setzt assigned_to auf einer Mehrfachzuweisung
--   Frueher entstand eine Mischmenge, deren ueberlebender Mitarbeiter vom
--   zufaelligen Primaer-Tiebreaker abhing ({A,C} bzw. {B,C}).
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000060');
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments('e4000000-0000-0000-0000-000000000060',
    array['e2000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000003']::uuid[]);
  -- Alt-Client: updateJob setzt genau einen Mitarbeiter
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000004'
   where id='e4000000-0000-0000-0000-000000000060';
  v := 'menge='||pg_temp.zuw('e4000000-0000-0000-0000-000000000060')
     ||'/legacy='||pg_temp.legacy('e4000000-0000-0000-0000-000000000060');
  insert into _dw values (26,'Legacy-Schreibvorgang ersetzt die gesamte Menge',
    'menge=e2000000-0000-0000-0000-000000000004:assigned/legacy=e2000000-0000-0000-0000-000000000004', v);
  raise notice 'CASE 26 -> %', v;
end $$;

-- CASE 27: UNVERAENDERT mitgesendeter Wert laesst die Mehrfachzuweisung intakt
--   Das ist die tragende Sicherung: alte Clients senden assigned_to bei
--   JEDEM updateJob mit. Ohne diese Eigenschaft wuerde jede beliebige
--   Feldaenderung die Mehrfachzuweisung platt machen.
do $$
declare v text; primaer uuid;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000061');
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments('e4000000-0000-0000-0000-000000000061',
    array['e2000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000003']::uuid[]);
  select assigned_to into primaer from public.jobs where id='e4000000-0000-0000-0000-000000000061';
  -- Alt-Client aendert nur den Kundennamen und sendet assigned_to unveraendert mit
  update public.jobs set customer_name='Alt-Client Edit', assigned_to=primaer
   where id='e4000000-0000-0000-0000-000000000061';
  v := 'zeilen='||(select count(*)::text from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000061')
     ||'/primaer_unveraendert='||(primaer = (select assigned_to from public.jobs where id='e4000000-0000-0000-0000-000000000061'))::text;
  insert into _dw values (27,'Unveraendert mitgesendeter Wert laesst Mehrfachzuweisung unangetastet',
    'zeilen=2/primaer_unveraendert=true', v);
  raise notice 'CASE 27 -> %', v;
end $$;

-- CASE 28: Nachweis-Zeilen ueberleben die Mengenersetzung
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000062');
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments('e4000000-0000-0000-0000-000000000062',
    array['e2000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000003']::uuid[]);
  update public.job_assignments set attendance='started', employee_started_at=now()
   where job_id='e4000000-0000-0000-0000-000000000062' and employee_id='e2000000-0000-0000-0000-000000000002';
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000004'
   where id='e4000000-0000-0000-0000-000000000062';
  v := pg_temp.zuw('e4000000-0000-0000-0000-000000000062');
  insert into _dw values (28,'Nachweis-Zeile ueberlebt die Legacy-Mengenersetzung',
    'e2000000-0000-0000-0000-000000000002:started,e2000000-0000-0000-0000-000000000004:assigned', v);
  raise notice 'CASE 28 -> %', v;
end $$;

-- CASE 29: anonymisierte Zeile (geloeschtes Konto) ueberlebt
do $$
declare v text;
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000009','authenticated','authenticated','dw-del9@example.test','{"full_name":"Nina Weg"}');
  insert into public.profiles (id,full_name) values ('e2000000-0000-0000-0000-000000000009','Nina Weg') on conflict (id) do nothing;
  update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=true
   where id='e2000000-0000-0000-0000-000000000009';

  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000063');
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments('e4000000-0000-0000-0000-000000000063',
    array['e2000000-0000-0000-0000-000000000009','e2000000-0000-0000-0000-000000000002']::uuid[]);
  delete from auth.users where id='e2000000-0000-0000-0000-000000000009';

  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000004'
   where id='e4000000-0000-0000-0000-000000000063';

  v := 'anon_erhalten='||(select count(*)::text from public.job_assignments
         where job_id='e4000000-0000-0000-0000-000000000063' and employee_id is null)
     ||'/snapshot='||coalesce((select employee_name_snapshot from public.job_assignments
         where job_id='e4000000-0000-0000-0000-000000000063' and employee_id is null),'-')
     ||'/neuer_da='||exists(select 1 from public.job_assignments
         where job_id='e4000000-0000-0000-0000-000000000063' and employee_id='e2000000-0000-0000-0000-000000000004')::text;
  insert into _dw values (29,'Anonymisierte Zeile ueberlebt die Legacy-Mengenersetzung',
    'anon_erhalten=1/snapshot=Nina Weg/neuer_da=true', v);
  raise notice 'CASE 29 -> %', v;
end $$;

-- CASE 30: Legacy-Schreibvorgang auf NULL entfernt alle sauberen Zuweisungen
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000064');
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  perform public.set_job_assignments('e4000000-0000-0000-0000-000000000064',
    array['e2000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000003']::uuid[]);
  update public.jobs set assigned_to=null where id='e4000000-0000-0000-0000-000000000064';
  v := 'menge='||pg_temp.zuw('e4000000-0000-0000-0000-000000000064')
     ||'/legacy='||pg_temp.legacy('e4000000-0000-0000-0000-000000000064');
  insert into _dw values (30,'Legacy-Schreibvorgang auf NULL leert die Menge','menge=KEINE/legacy=NULL',v);
  raise notice 'CASE 30 -> %', v;
end $$;

-- CASE 31: drei Mitarbeiter -> alle ausser dem neuen werden entfernt
--   DETERMINISTISCH: die Zuweisungen werden mit EXPLIZITEN assigned_at
--   angelegt, damit der Primaer eindeutig der aelteste (A1) ist. Wuerde
--   man hier set_job_assignments verwenden, teilten sich alle Zeilen
--   denselben now()-Wert und der zufaellige id-Tiebreaker entschiede,
--   ob der anschliessende Legacy-Schreibvorgang ueberhaupt eine
--   Aenderung ist — der Fall waere dann nicht reproduzierbar.
--
--   Geprueft wird zugleich, dass die Zeile des NEUEN Werts nicht
--   geloescht-und-neu-angelegt wird: ihr urspruengliches assigned_at
--   bleibt erhalten.
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000065');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_at) values
    ('e4000000-0000-0000-0000-000000000065','e2000000-0000-0000-0000-000000000002','Anna Eins', now() - interval '3 min'),
    ('e4000000-0000-0000-0000-000000000065','e2000000-0000-0000-0000-000000000003','Bert Zwei', now() - interval '2 min'),
    ('e4000000-0000-0000-0000-000000000065','e2000000-0000-0000-0000-000000000004','Cora Drei', now() - interval '1 min');

  -- Primaer ist jetzt eindeutig A1 (aeltester assigned_at).
  -- Alt-Client schreibt A2 -> echte Aenderung -> Menge wird ersetzt.
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003'
   where id='e4000000-0000-0000-0000-000000000065';

  v := pg_temp.zuw('e4000000-0000-0000-0000-000000000065')
     ||'/zeile_erhalten='||(select (min(assigned_at) < now() - interval '90 seconds')::text
          from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000065');
  insert into _dw values (31,'Dreier-Menge wird auf den neuen Wert reduziert; dessen Zeile bleibt bestehen',
    'e2000000-0000-0000-0000-000000000003:assigned/zeile_erhalten=true', v);
  raise notice 'CASE 31 -> %', v;
end $$;

-- CASE 32: Einzelzuweisung -> Wechsel bleibt unveraendert (Regression)
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000066','e2000000-0000-0000-0000-000000000002');
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003'
   where id='e4000000-0000-0000-0000-000000000066';
  v := 'menge='||pg_temp.zuw('e4000000-0000-0000-0000-000000000066')
     ||'/legacy='||pg_temp.legacy('e4000000-0000-0000-0000-000000000066');
  insert into _dw values (32,'Einzelzuweisung: Wechsel verhaelt sich unveraendert',
    'menge=e2000000-0000-0000-0000-000000000003:assigned/legacy=e2000000-0000-0000-0000-000000000003', v);
  raise notice 'CASE 32 -> %', v;
end $$;

-- CASE 33: Phase-4-Semantik bleibt: ein Legacy-Schreibvorgang markiert
--   einen Termin NICHT als individuell angepasst.
do $$
declare v text; occ uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000067', null, 'open', null, null,
                         'e1000000-0000-0000-0000-000000000001','recurring', null);
  update public.jobs set recurrence_start_date=current_date where id='e4000000-0000-0000-0000-000000000067';
  perform public.set_job_assignments('e4000000-0000-0000-0000-000000000067',
    array['e2000000-0000-0000-0000-000000000002']::uuid[]);
  perform public.generate_job_occurrences('e4000000-0000-0000-0000-000000000067');
  select id into occ from public.jobs where parent_job_id='e4000000-0000-0000-0000-000000000067' order by date limit 1;

  -- Alt-Client bearbeitet den TERMIN direkt
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000003' where id=occ;

  v := 'menge='||pg_temp.zuw(occ)
     ||'/angepasst='||exists(select 1 from public.job_occurrence_assignment_overrides where job_id=occ)::text;
  insert into _dw values (33,'Legacy-Schreibvorgang markiert einen Termin NICHT als angepasst',
    'menge=e2000000-0000-0000-0000-000000000003:assigned/angepasst=false', v);
  raise notice 'CASE 33 -> %', v;
end $$;



-- CASE 34: Konto-Loeschung darf die Zuweisungen der UEBRIGEN Mitarbeiter
--   nicht mit entfernen.
--   Regressionsschutz fuer den Anonymisierungspfad: der Fremdschluessel
--   setzt jobs.assigned_to auf NULL, was auf Trigger-Ebene wie ein
--   bewusstes "niemandem mehr zuweisen" aussieht. Ohne die Ausnahme in
--   Richtung A wuerde die Mengenersetzung hier unbeteiligte Mitarbeiter
--   loeschen.
do $$
declare v text;
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-00000000000a','authenticated','authenticated','dw-del10@example.test','{"full_name":"Ola Weg"}');
  insert into public.profiles (id,full_name) values ('e2000000-0000-0000-0000-00000000000a','Ola Weg') on conflict (id) do nothing;
  update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=true
   where id='e2000000-0000-0000-0000-00000000000a';

  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000068');
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  -- Mehrfachzuweisung ueber die RPC: zu loeschendes Konto + zwei weitere
  perform public.set_job_assignments('e4000000-0000-0000-0000-000000000068',
    array['e2000000-0000-0000-0000-00000000000a','e2000000-0000-0000-0000-000000000003',
          'e2000000-0000-0000-0000-000000000004']::uuid[]);

  delete from auth.users where id='e2000000-0000-0000-0000-00000000000a';

  v := 'lebende_zuweisungen='||(select count(*)::text from public.job_assignments
         where job_id='e4000000-0000-0000-0000-000000000068' and employee_id is not null)
     ||'/anonym='||(select count(*)::text from public.job_assignments
         where job_id='e4000000-0000-0000-0000-000000000068' and employee_id is null)
     ||'/legacy_gedeckt='||(select (j.assigned_to is null or exists(select 1 from public.job_assignments ja
          where ja.job_id=j.id and ja.employee_id=j.assigned_to))::text
        from public.jobs j where j.id='e4000000-0000-0000-0000-000000000068');
  insert into _dw values (34,'Konto-Loeschung entfernt keine Zuweisungen unbeteiligter Mitarbeiter',
    'lebende_zuweisungen=2/anonym=1/legacy_gedeckt=true', v);
  raise notice 'CASE 34 -> %', v;
end $$;



-- CASE 35: BEKANNTE GRENZE — Zielwert ist bereits der Primaer
--   Die WHEN-Klausel feuert nur bei einer echten Wertaenderung. Schreibt
--   ein alter Client genau den Wert, der ohnehin schon Primaer ist,
--   passiert NICHTS — die Mehrfachzuweisung bleibt vollstaendig bestehen.
--
--   Das ist ausdruecklich gewollt: auf Datenbankebene ist dieser Fall
--   nicht davon zu unterscheiden, dass ein alter Client ein unbeteiligtes
--   Feld aendert und assigned_to unveraendert mitsendet — was er bei
--   JEDEM updateJob tut. Wuerde man die WHEN-Klausel lockern, wuerde jede
--   beliebige Feldaenderung eines alten Clients die gesamte
--   Mehrfachzuweisung platt machen.
--
--   Deterministisch durch explizite assigned_at (Primaer = A1).
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000069');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_at) values
    ('e4000000-0000-0000-0000-000000000069','e2000000-0000-0000-0000-000000000002','Anna Eins', now() - interval '3 min'),
    ('e4000000-0000-0000-0000-000000000069','e2000000-0000-0000-0000-000000000003','Bert Zwei', now() - interval '2 min');

  -- Alt-Client aendert ein unbeteiligtes Feld und sendet den bereits
  -- primaeren Mitarbeiter unveraendert mit.
  update public.jobs
     set customer_name='Alt-Client Speichern',
         assigned_to='e2000000-0000-0000-0000-000000000002'
   where id='e4000000-0000-0000-0000-000000000069';

  v := 'menge='||pg_temp.zuw('e4000000-0000-0000-0000-000000000069')
     ||'/feld_gesynct='||(select (customer_name='Alt-Client Speichern')::text
          from public.jobs where id='e4000000-0000-0000-0000-000000000069');
  insert into _dw values (35,'Bekannte Grenze: Zielwert == Primaer laesst die Menge unveraendert',
    'menge=e2000000-0000-0000-0000-000000000002:assigned,e2000000-0000-0000-0000-000000000003:assigned/feld_gesynct=true', v);
  raise notice 'CASE 35 -> %', v;
end $$;

-- CASE 36: Fotos/Kommentare schuetzen KEINE Zuweisungszeile
--   Bewusste Entscheidung (siehe Migrations-Header): das Evidenzmodell aus
--   Phase 3 ist ein Modell je ZUWEISUNG (attendance/review/Zeitstempel).
--   Fotos und Kommentare bleiben beim Entfernen einer Zuweisung
--   vollstaendig erhalten — es geht also kein Nachweis verloren. Dieser
--   Fall haelt die Entscheidung fest, damit sie nicht unbemerkt kippt.
do $$
declare v text;
begin
  perform pg_temp.mk_job('e4000000-0000-0000-0000-000000000070');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_at) values
    ('e4000000-0000-0000-0000-000000000070','e2000000-0000-0000-0000-000000000002','Anna Eins', now() - interval '3 min'),
    ('e4000000-0000-0000-0000-000000000070','e2000000-0000-0000-0000-000000000003','Bert Zwei', now() - interval '2 min');

  -- A2 laedt ein Foto hoch und schreibt einen Kommentar, ohne zu starten.
  insert into public.job_photos (job_id, company_id, uploaded_by, storage_path, file_name)
  values ('e4000000-0000-0000-0000-000000000070','e1000000-0000-0000-0000-000000000001',
          'e2000000-0000-0000-0000-000000000003','pfad/f.jpg','f.jpg');
  insert into public.job_comments (job_id, company_id, author_id, message)
  values ('e4000000-0000-0000-0000-000000000070','e1000000-0000-0000-0000-000000000001',
          'e2000000-0000-0000-0000-000000000003','Notiz');

  -- Alt-Client weist einem Dritten zu.
  update public.jobs set assigned_to='e2000000-0000-0000-0000-000000000004'
   where id='e4000000-0000-0000-0000-000000000070';

  v := 'menge='||pg_temp.zuw('e4000000-0000-0000-0000-000000000070')
     ||'/foto_bleibt='||(select count(*)::text from public.job_photos
          where job_id='e4000000-0000-0000-0000-000000000070' and uploaded_by='e2000000-0000-0000-0000-000000000003')
     ||'/kommentar_bleibt='||(select count(*)::text from public.job_comments
          where job_id='e4000000-0000-0000-0000-000000000070' and author_id='e2000000-0000-0000-0000-000000000003');
  insert into _dw values (36,'Fotos/Kommentare schuetzen keine Zuweisung, bleiben aber vollstaendig erhalten',
    'menge=e2000000-0000-0000-0000-000000000004:assigned/foto_bleibt=1/kommentar_bleibt=1', v);
  raise notice 'CASE 36 -> %', v;
end $$;


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select
  case_no, beschreibung, erwartet, ergebnis,
  case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _dw
order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _dw where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'DUAL WRITE TEST: % Fall/Faelle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE 36 FAELLE PASS';
end $$;

rollback;
