-- =========================================================
-- TEST: pausierte Dauerauftrags-Occurrence ist nicht startbar
-- (Migration 20260829000000_block_start_of_paused_recurring_occurrence)
-- =========================================================
-- Weist nach:
--   A) aktive Occurrence          → zugewiesener Mitarbeiter kann starten
--   B) pausierte offene Occurrence → start_own_job wird ABGELEHNT
--      (sowohl vorab-pausiert als auch via Parent-Deaktivierung + SYNC)
--   C) nicht zugewiesener Mitarbeiter bleibt abgelehnt (unverändert)
--   D) GESTARTETE Occurrence: Historie überlebt Parent-Deaktivierung,
--      bleibt abschließbar
--   E) ABGESCHLOSSENE Occurrence: Historie überlebt Parent-Deaktivierung
--   F) Reaktivierung stellt die Startbarkeit sauberer Zukunftstermine
--      wieder her (update_job_occurrences / SYNC)
--   G) gewöhnlicher aktiver Einzelauftrag: Start unverändert erlaubt
--   H) Firmen-Isolation: fremder Admin/Mitarbeiter unberührt
--
-- Aufrufe laufen als 'authenticated' (SET ROLE + request.jwt.claims), also
-- über denselben Pfad wie services/jobs/jobs.service.ts.
--
-- AUSFÜHREN lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/paused_recurring_occurrence_start_guard.test.sql
-- Legt Testdaten an, macht am Ende ROLLBACK — KEINE Rückstände.
--
-- Ergebnis: Tabelle (case_no | beschreibung | erwartet | ergebnis | verdikt)
-- + LAUTER Abbruch am Ende, falls ein Fall nicht PASS ist.
-- =========================================================

begin;

-- ── Fixdaten ──
--   Firma A = f1…1 (Haupttests) | Firma B = f1…2 (Isolation)
--   Admin A = f2…1 | Mitarbeiter A1 (zugewiesen) = f2…2
--   Mitarbeiter A2 (nicht zugewiesen) = f2…3
--   Admin B = f2…4 | Mitarbeiter B1 = f2…5

do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000001','authenticated','authenticated','pauseocc-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000002','authenticated','authenticated','pauseocc-empA1@example.test','{"full_name":"Mitarbeiter A1"}'),
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000003','authenticated','authenticated','pauseocc-empA2@example.test','{"full_name":"Mitarbeiter A2"}'),
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000004','authenticated','authenticated','pauseocc-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000005','authenticated','authenticated','pauseocc-empB1@example.test','{"full_name":"Mitarbeiter B1"}');
end $$;

insert into public.profiles (id, full_name) values
  ('f2000000-0000-0000-0000-000000000001','Admin A'),
  ('f2000000-0000-0000-0000-000000000002','Mitarbeiter A1'),
  ('f2000000-0000-0000-0000-000000000003','Mitarbeiter A2'),
  ('f2000000-0000-0000-0000-000000000004','Admin B'),
  ('f2000000-0000-0000-0000-000000000005','Mitarbeiter B1')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('f1000000-0000-0000-0000-000000000001','Pause Firma A','pause-firma-a-test'),
  ('f1000000-0000-0000-0000-000000000002','Pause Firma B','pause-firma-b-test');

update public.profiles set company_id='f1000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='f2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='f1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id='f2000000-0000-0000-0000-000000000002';
update public.profiles set company_id='f1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id='f2000000-0000-0000-0000-000000000003';
update public.profiles set company_id='f1000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='f2000000-0000-0000-0000-000000000004';
update public.profiles set company_id='f1000000-0000-0000-0000-000000000002', role='employee', is_active=true where id='f2000000-0000-0000-0000-000000000005';

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role','authenticated')::text, true);
end $f$;

-- Startet einen Job als Mitarbeiter, fängt jede Ausnahme ab.
create or replace function pg_temp.try_start(uid uuid, job_id uuid)
returns text language plpgsql as $f$
declare v text;
begin
  perform pg_temp.act_as(uid);
  execute 'set local role authenticated';
  begin
    perform public.start_own_job(job_id, now());
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  return v;
end $f$;

create or replace function pg_temp.try_complete(uid uuid, job_id uuid)
returns text language plpgsql as $f$
declare v text;
begin
  perform pg_temp.act_as(uid);
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job(job_id, now());
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  return v;
end $f$;

create temporary table _r (
  case_no int, beschreibung text, erwartet text, ergebnis text
) on commit drop;

-- =========================================================
-- FIXTURE
--   Parent-Regel R (Firma A), recurring an den Wochentagen der beiden
--   sauberen offenen Zukunftstermine, start_time 08:00, aktiv.
--   Occurrences (alle parent_job_id = R, job_type 'single', 08:00):
--     o_active   : heute+7  , open , is_active=true   (CASE A / B via Deaktivierung / F)
--     o_paused   : heute+10 , open , is_active=false  (CASE B direkt)
--     o_started  : heute+3  , in_progress (started_at gesetzt), is_active=true (CASE D)
--     o_completed: heute+2  , completed (start+complete gesetzt), is_active=true (CASE E)
--   Plus:
--     s_single   : gewöhnlicher Einzelauftrag, parent_job_id NULL, open (CASE G)
--     o_other    : Occurrence einer Regel der Firma B (CASE H)
--   Zuweisung Mitarbeiter A1 auf o_active, o_paused, o_started, o_completed,
--   s_single. Mitarbeiter A2 bleibt überall unzugewiesen.
-- =========================================================
do $$
declare
  d_a  date := current_date + 7;
  d_p  date := current_date + 10;
  d_s  date := current_date + 3;
  d_c  date := current_date + 2;
  wd_a text := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from current_date + 7)::int + 1];
  wd_p text := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from current_date + 10)::int + 1];
begin
  -- Parent-Regel R (Firma A)
  insert into public.jobs
    (id, company_id, created_by, customer_name, service_name, location_address,
     status, job_type, recurring_days, start_time, is_active,
     recurrence_start_date, recurrence_end_date)
  values
    ('f3000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000001','Regelkunde A','Unterhaltsreinigung','Regelweg 1',
     'open','recurring', array[wd_a, wd_p]::text[], '08:00', true,
     current_date, current_date + 21);

  -- Parent-Regel R_B (Firma B) — nur als Aufhänger für o_other
  insert into public.jobs
    (id, company_id, created_by, customer_name, service_name, location_address,
     status, job_type, recurring_days, start_time, is_active,
     recurrence_start_date, recurrence_end_date)
  values
    ('f3000000-0000-0000-0000-000000000002','f1000000-0000-0000-0000-000000000002',
     'f2000000-0000-0000-0000-000000000004','Regelkunde B','Glas','Fremdweg 1',
     'open','recurring', array[wd_a]::text[], '08:00', true,
     current_date, current_date + 21);

  -- Occurrences von R
  insert into public.jobs
    (id, company_id, parent_job_id, created_by, customer_name, service_name, location_address,
     status, job_type, date, start_time, is_active, started_at, completed_at)
  values
    ('f4000000-0000-0000-0000-0000000000a1','f1000000-0000-0000-0000-000000000001','f3000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000001','Regelkunde A','Unterhaltsreinigung','Regelweg 1',
     'open','single', d_a, '08:00', true, null, null),
    ('f4000000-0000-0000-0000-0000000000b1','f1000000-0000-0000-0000-000000000001','f3000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000001','Regelkunde A','Unterhaltsreinigung','Regelweg 1',
     'open','single', d_p, '08:00', false, null, null),
    ('f4000000-0000-0000-0000-0000000000c1','f1000000-0000-0000-0000-000000000001','f3000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000001','Regelkunde A','Unterhaltsreinigung','Regelweg 1',
     'in_progress','single', d_s, '08:00', true, (current_date + 3)::timestamptz, null),
    ('f4000000-0000-0000-0000-0000000000d1','f1000000-0000-0000-0000-000000000001','f3000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000001','Regelkunde A','Unterhaltsreinigung','Regelweg 1',
     'completed','single', d_c, '08:00', true, (current_date + 2)::timestamptz, (current_date + 2)::timestamptz);

  -- gewöhnlicher Einzelauftrag (Firma A)
  insert into public.jobs
    (id, company_id, created_by, customer_name, service_name, location_address,
     status, job_type, date, start_time, is_active)
  values
    ('f4000000-0000-0000-0000-0000000000e1','f1000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000001','Einzelkunde A','Grundreinigung','Einzelweg 9',
     'open','single', d_a, '13:00', true);

  -- Occurrence der Firma B
  insert into public.jobs
    (id, company_id, parent_job_id, created_by, customer_name, service_name, location_address,
     status, job_type, date, start_time, is_active)
  values
    ('f4000000-0000-0000-0000-0000000000f1','f1000000-0000-0000-0000-000000000002','f3000000-0000-0000-0000-000000000002',
     'f2000000-0000-0000-0000-000000000004','Regelkunde B','Glas','Fremdweg 1',
     'open','single', d_a, '08:00', true);
end $$;

-- Zuweisung Mitarbeiter A1 auf die REGEL R — sonst würde
-- inherit_occurrence_assignments (Teil von update_job_occurrences) die
-- Occurrence-Zuweisungen als „nicht in der Regelmenge" wieder entfernen.
insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by) values
  ('f3000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000002','Mitarbeiter A1','f2000000-0000-0000-0000-000000000001');

-- Zuweisungen Mitarbeiter A1 auf die Occurrences
insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by) values
  ('f4000000-0000-0000-0000-0000000000a1','f2000000-0000-0000-0000-000000000002','Mitarbeiter A1','f2000000-0000-0000-0000-000000000001'),
  ('f4000000-0000-0000-0000-0000000000b1','f2000000-0000-0000-0000-000000000002','Mitarbeiter A1','f2000000-0000-0000-0000-000000000001'),
  ('f4000000-0000-0000-0000-0000000000c1','f2000000-0000-0000-0000-000000000002','Mitarbeiter A1','f2000000-0000-0000-0000-000000000001'),
  ('f4000000-0000-0000-0000-0000000000d1','f2000000-0000-0000-0000-000000000002','Mitarbeiter A1','f2000000-0000-0000-0000-000000000001'),
  ('f4000000-0000-0000-0000-0000000000e1','f2000000-0000-0000-0000-000000000002','Mitarbeiter A1','f2000000-0000-0000-0000-000000000001');
-- Zuweisung Mitarbeiter B1 auf die Fremd-Occurrence
insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by) values
  ('f4000000-0000-0000-0000-0000000000f1','f2000000-0000-0000-0000-000000000005','Mitarbeiter B1','f2000000-0000-0000-0000-000000000004');


-- =========================================================
-- CASE A — aktive Occurrence: zugewiesener Mitarbeiter kann starten
-- =========================================================
do $$
begin
  insert into _r values (1, 'CASE A: aktive Occurrence → A1 kann starten',
    'AKZEPTIERT',
    pg_temp.try_start('f2000000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-0000000000a1'));
end $$;

-- o_active für die weiteren Fälle wieder auf 'open' zurücksetzen
update public.jobs
   set status='open', started_at=null, started_by=null, completed_at=null, completed_by=null
 where id='f4000000-0000-0000-0000-0000000000a1';
update public.job_assignments
   set employee_started_at=null, employee_completed_at=null, attendance='assigned'
 where job_id='f4000000-0000-0000-0000-0000000000a1';

-- =========================================================
-- CASE B1 — vorab pausierte offene Occurrence → ABGELEHNT
-- =========================================================
do $$
begin
  insert into _r values (2, 'CASE B1: vorab pausierte offene Occurrence → start abgelehnt',
    'ABGELEHNT',
    pg_temp.try_start('f2000000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-0000000000b1'));
end $$;

-- =========================================================
-- CASE B2 — Parent deaktivieren → SYNC pausiert o_active → ABGELEHNT
-- =========================================================
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  update public.jobs set is_active=false where id='f3000000-0000-0000-0000-000000000001';
  perform public.update_job_occurrences('f3000000-0000-0000-0000-000000000001');
  execute 'reset role';

  select case when j.is_active is false and j.status='open' then 'PAUSED' else 'NICHT_PAUSED' end
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-0000000000a1';

  insert into _r values (3, 'CASE B2a: Deaktivierung setzt o_active via SYNC auf is_active=false',
    'PAUSED', coalesce(v,'FEHLT'));

  insert into _r values (4, 'CASE B2b: pausierte o_active → start abgelehnt',
    'ABGELEHNT',
    pg_temp.try_start('f2000000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-0000000000a1'));
end $$;

-- =========================================================
-- CASE C — nicht zugewiesener Mitarbeiter bleibt abgelehnt (aktive Occ)
--   Parent kurz reaktivieren, damit o_active wieder aktiv ist, dann A2 testen.
-- =========================================================
do $$
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  update public.jobs set is_active=true where id='f3000000-0000-0000-0000-000000000001';
  perform public.update_job_occurrences('f3000000-0000-0000-0000-000000000001');
  execute 'reset role';

  insert into _r values (5, 'CASE C: nicht zugewiesener Mitarbeiter A2 → start abgelehnt',
    'ABGELEHNT',
    pg_temp.try_start('f2000000-0000-0000-0000-000000000003','f4000000-0000-0000-0000-0000000000a1'));
end $$;

-- =========================================================
-- CASE D — gestartete Occurrence: Historie überlebt Deaktivierung,
--          bleibt abschließbar
-- =========================================================
do $$
declare v_status text; v_started timestamptz; v_stamps text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  update public.jobs set is_active=false where id='f3000000-0000-0000-0000-000000000001';
  perform public.update_job_occurrences('f3000000-0000-0000-0000-000000000001');
  execute 'reset role';

  select j.status, j.started_at into v_status, v_started
  from public.jobs j where j.id='f4000000-0000-0000-0000-0000000000c1';

  insert into _r values (6, 'CASE D1: gestartete Occurrence bleibt in_progress + started_at erhalten',
    'in_progress|'||(current_date + 3)::text,
    coalesce(v_status,'FEHLT')||'|'||coalesce(v_started::date::text,'FEHLT'));

  insert into _r values (7, 'CASE D2: gestartete Occurrence bleibt abschließbar (trotz pausierter Regel)',
    'AKZEPTIERT',
    pg_temp.try_complete('f2000000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-0000000000c1'));
end $$;

-- =========================================================
-- CASE E — abgeschlossene Occurrence: Historie überlebt Deaktivierung
-- =========================================================
do $$
declare v text;
begin
  select j.status||'|'||coalesce(j.started_at::date::text,'-')||'|'||coalesce(j.completed_at::date::text,'-')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-0000000000d1';
  insert into _r values (8, 'CASE E: abgeschlossene Occurrence unverändert nach Deaktivierung',
    'completed|'||(current_date + 2)::text||'|'||(current_date + 2)::text,
    coalesce(v,'FEHLT'));
end $$;

-- =========================================================
-- CASE F — Reaktivierung stellt Startbarkeit sauberer Zukunftstermine her
-- =========================================================
do $$
declare v_active boolean; v_start text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  update public.jobs set is_active=true where id='f3000000-0000-0000-0000-000000000001';
  perform public.update_job_occurrences('f3000000-0000-0000-0000-000000000001');
  execute 'reset role';

  select j.is_active into v_active
  from public.jobs j where j.id='f4000000-0000-0000-0000-0000000000b1';

  insert into _r values (9, 'CASE F1: Reaktivierung → o_paused via SYNC wieder is_active=true',
    'true', coalesce(v_active::text,'FEHLT'));

  insert into _r values (10, 'CASE F2: reaktivierte saubere Zukunfts-Occurrence → start wieder erlaubt',
    'AKZEPTIERT',
    pg_temp.try_start('f2000000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-0000000000b1'));
end $$;

-- =========================================================
-- CASE G — gewöhnlicher aktiver Einzelauftrag: Start unverändert erlaubt
-- =========================================================
do $$
begin
  insert into _r values (11, 'CASE G: gewöhnlicher Einzelauftrag (parent_job_id NULL) → start erlaubt',
    'AKZEPTIERT',
    pg_temp.try_start('f2000000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-0000000000e1'));
end $$;

-- =========================================================
-- CASE H — Firmen-Isolation: fremder Mitarbeiter kann Fremd-Occurrence nicht
--          starten; unser Mitarbeiter kann Fremd-Occurrence nicht starten
-- =========================================================
do $$
declare v text;
begin
  insert into _r values (12, 'CASE H1: Firma-A-Mitarbeiter → Fremd-Occurrence (Firma B) start abgelehnt',
    'ABGELEHNT',
    pg_temp.try_start('f2000000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-0000000000f1'));

  -- Fremder Admin darf die Regel der anderen Firma nicht updaten
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    perform public.update_job_occurrences('f3000000-0000-0000-0000-000000000001');
    v := 'OK';
  exception when others then v := 'FEHLER';
  end;
  execute 'reset role';
  insert into _r values (13, 'CASE H2: Fremd-Admin update_job_occurrences auf Regel R (Firma A) → Fehler',
    'FEHLER', v);
end $$;


-- =========================================================
-- Ergebnisübersicht + LAUTER Abbruch bei Fehlschlag
-- =========================================================
select
  case_no, beschreibung, erwartet, ergebnis,
  case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _r
order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _r where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'PAUSED RECURRING OCCURRENCE START GUARD TEST: % Fall/Faelle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE % FAELLE PASS', (select count(*) from _r);
end $$;

rollback;
