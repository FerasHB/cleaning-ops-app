-- =========================================================
-- TEST: job_assignments (Phase 1 — Datenschicht Mehrfachzuweisung)
-- (Migration 20260725000000_job_assignments)
-- =========================================================
-- Prüft Tabelle, Constraints, Guard-Trigger, Touch-Trigger, Backfill und
-- die Wahrheitstabelle von counts_for_timesheet.
--
-- Kernaussagen, die dieser Test absichert:
--   * Zuweisung nur an aktive Mitarbeiter derselben Firma.
--   * Anwesenheits-/Review-Änderungen bleiben für INZWISCHEN DEAKTIVIERTE
--     Mitarbeiter möglich (der Guard darf hier nicht greifen).
--   * Eine Konto-Löschung anonymisiert die Zuweisung (employee_id -> NULL),
--     LÖSCHT sie aber nicht — und wird vom Guard nicht blockiert.
--   * Der Nachweis bleibt über employee_name_snapshot nutzbar.
--   * counts_for_timesheet ist die einzige Berechtigungsquelle und folgt
--     exakt der vereinbarten Regel.
--   * In job_assignments existiert KEINE Dauer-Spalte.
--
-- Hinweis zur lokalen Basis-DB: der auth-Trigger handle_new_user ist im
-- Baseline-Dump nicht enthalten. Profile werden deshalb — wie in den
-- bestehenden Tests dieses Repos — explizit angelegt.
--
-- Läuft transaktional (BEGIN … ROLLBACK): keine Rückstände, keine
-- Produktionsdaten. Ausführen lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/job_assignments.test.sql
--
-- Ergebnis: Tabelle (case_no | beschreibung | erwartet | ergebnis |
-- verdikt). Schlägt ein Fall fehl, bricht der Lauf am Ende LAUT ab.
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = c1…1 | Firma B = c1…2
-- Admin A = c2…1 | Mitarbeiter A1 = c2…2 | Mitarbeiter A2 = c2…3
-- Admin B = c2…4 | Mitarbeiter B1 = c2…5 | Mitarbeiter A3 (inaktiv) = c2…6
-- Mitarbeiter A4 (wird gelöscht) = c2…7

do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000001','authenticated','authenticated','ja-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000002','authenticated','authenticated','ja-empA1@example.test','{"full_name":"Anna Mueller"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000003','authenticated','authenticated','ja-empA2@example.test','{"full_name":"Tom Schmidt"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000004','authenticated','authenticated','ja-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000005','authenticated','authenticated','ja-empB1@example.test','{"full_name":"Bea Berg"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000006','authenticated','authenticated','ja-empA3@example.test','{"full_name":"Ina Inaktiv"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000007','authenticated','authenticated','ja-empA4@example.test','{"full_name":"Lena Wagner"}');
end $$;

insert into public.profiles (id, full_name) values
  ('c2000000-0000-0000-0000-000000000001','Admin A'),
  ('c2000000-0000-0000-0000-000000000002','Anna Mueller'),
  ('c2000000-0000-0000-0000-000000000003','Tom Schmidt'),
  ('c2000000-0000-0000-0000-000000000004','Admin B'),
  ('c2000000-0000-0000-0000-000000000005','Bea Berg'),
  ('c2000000-0000-0000-0000-000000000006','Ina Inaktiv'),
  ('c2000000-0000-0000-0000-000000000007','Lena Wagner')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('c1000000-0000-0000-0000-000000000001','JA Firma A','ja-firma-a-test'),
  ('c1000000-0000-0000-0000-000000000002','JA Firma B','ja-firma-b-test');

update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='admin',    is_active=true  where id='c2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='employee', is_active=true  where id='c2000000-0000-0000-0000-000000000002';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='employee', is_active=true  where id='c2000000-0000-0000-0000-000000000003';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000002', role='admin',    is_active=true  where id='c2000000-0000-0000-0000-000000000004';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000002', role='employee', is_active=true  where id='c2000000-0000-0000-0000-000000000005';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='employee', is_active=false where id='c2000000-0000-0000-0000-000000000006';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='employee', is_active=true  where id='c2000000-0000-0000-0000-000000000007';

-- ── Aufträge ──
-- Alle mit BEWUSST ALTEM updated_at angelegt, damit der Touch-Trigger
-- beobachtbar ist (der BEFORE-UPDATE-Trigger trg_jobs_updated_at feuert
-- bei INSERT nicht).
insert into public.jobs (
  id, company_id, assigned_to, created_by, customer_name, service_name,
  location_address, status, started_at, completed_at, job_type, date,
  start_time, is_active, created_at, updated_at
) values
  -- J1: offen, zugewiesen A1              -> Backfill: attendance 'assigned'
  ('c4000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001','Kunde 1','Service 1','Ort 1','open',   null,                          null,                          'single', current_date, '08:00', true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00'),
  -- J2: in Arbeit, zugewiesen A1          -> Backfill: attendance 'started'
  ('c4000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001','Kunde 2','Service 2','Ort 2','in_progress', timestamptz '2026-06-01 08:00+00', null,                     'single', current_date, '08:00', true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00'),
  -- J3: abgeschlossen, zugewiesen A2      -> Backfill: attendance 'completed'
  ('c4000000-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000003','c2000000-0000-0000-0000-000000000001','Kunde 3','Service 3','Ort 3','completed',   timestamptz '2026-06-01 08:00+00', timestamptz '2026-06-01 10:00+00','single', current_date, '08:00', true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00'),
  -- J4: offen, NICHT zugewiesen           -> Backfill: keine Zeile
  ('c4000000-0000-0000-0000-000000000004','c1000000-0000-0000-0000-000000000001',null,                                  'c2000000-0000-0000-0000-000000000001','Kunde 4','Service 4','Ort 4','open',   null,                          null,                          'single', current_date, '08:00', true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00'),
  -- J5: Arbeitsauftrag für Guard-/Touch-Fälle
  ('c4000000-0000-0000-0000-000000000005','c1000000-0000-0000-0000-000000000001',null,                                  'c2000000-0000-0000-0000-000000000001','Kunde 5','Service 5','Ort 5','open',   null,                          null,                          'single', current_date, '08:00', true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00'),
  -- J6: Auftrag der Firma B (Isolation)
  ('c4000000-0000-0000-0000-000000000006','c1000000-0000-0000-0000-000000000002',null,                                  'c2000000-0000-0000-0000-000000000004','Kunde 6','Service 6','Ort 6','open',   null,                          null,                          'single', current_date, '08:00', true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00'),
  -- J7: abgeschlossen, zugewiesen A4 (Konto wird später gelöscht)
  ('c4000000-0000-0000-0000-000000000007','c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000007','c2000000-0000-0000-0000-000000000001','Kunde 7','Service 7','Ort 7','completed',   timestamptz '2026-06-02 08:00+00', timestamptz '2026-06-02 10:00+00','single', current_date, '08:00', true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00'),
  -- J8: Auftrag zum Löschen (Cascade-Fall)
  ('c4000000-0000-0000-0000-000000000008','c1000000-0000-0000-0000-000000000001',null,                                  'c2000000-0000-0000-0000-000000000001','Kunde 8','Service 8','Ort 8','open',   null,                          null,                          'single', current_date, '08:00', true, timestamptz '2020-01-01 10:00+00', timestamptz '2020-01-01 10:00+00');

create temporary table _ja_results (
  case_no      int,
  beschreibung text,
  erwartet     text,
  ergebnis     text
) on commit drop;

-- Hilfsfunktion: Auftrag auf ein altes updated_at zurücksetzen, OHNE dass
-- trg_jobs_updated_at es sofort wieder auf now() hebt. Nur so ist der
-- Touch-Trigger innerhalb EINER Transaktion beobachtbar (now() ist
-- transaktionsfix, ein zweites now() wäre identisch).
create or replace function pg_temp.reset_touch(p_job uuid) returns void
language plpgsql as $f$
begin
  alter table public.jobs disable trigger trg_jobs_updated_at;
  update public.jobs set updated_at = timestamptz '2020-01-01 10:00+00' where id = p_job;
  alter table public.jobs enable trigger trg_jobs_updated_at;
end;
$f$;

create or replace function pg_temp.touched(p_job uuid) returns boolean
language sql as $f$
  select updated_at > timestamptz '2020-01-01 10:00+00' from public.jobs where id = p_job;
$f$;


-- =========================================================
-- CASE 1: Gültige Zuweisung (aktiver Mitarbeiter, gleiche Firma)
-- =========================================================
do $$
declare v text;
begin
  begin
    insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by)
    values ('c4000000-0000-0000-0000-000000000005','c2000000-0000-0000-0000-000000000002','Anna Mueller','c2000000-0000-0000-0000-000000000001');
    v := 'ACCEPTED';
  exception when others then v := 'REJECTED('||sqlstate||')';
  end;
  insert into _ja_results values (1,'Gueltige Zuweisung an aktiven Mitarbeiter derselben Firma','ACCEPTED',v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- =========================================================
-- CASE 2: Inaktiver Mitarbeiter -> abgelehnt
-- =========================================================
do $$
declare v text;
begin
  begin
    insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
    values ('c4000000-0000-0000-0000-000000000005','c2000000-0000-0000-0000-000000000006','Ina Inaktiv');
    v := 'ACCEPTED';
  exception when others then v := 'REJECTED';
  end;
  insert into _ja_results values (2,'Zuweisung an INAKTIVEN Mitarbeiter','REJECTED',v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- =========================================================
-- CASE 3: Admin-Profil -> abgelehnt (role muss 'employee' sein)
-- =========================================================
do $$
declare v text;
begin
  begin
    insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
    values ('c4000000-0000-0000-0000-000000000005','c2000000-0000-0000-0000-000000000001','Admin A');
    v := 'ACCEPTED';
  exception when others then v := 'REJECTED';
  end;
  insert into _ja_results values (3,'Zuweisung an ADMIN-Profil','REJECTED',v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- =========================================================
-- CASE 4: Fremde Firma -> abgelehnt
-- =========================================================
do $$
declare v text;
begin
  begin
    insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
    values ('c4000000-0000-0000-0000-000000000005','c2000000-0000-0000-0000-000000000005','Bea Berg');
    v := 'ACCEPTED';
  exception when others then v := 'REJECTED';
  end;
  insert into _ja_results values (4,'Zuweisung an Mitarbeiter FREMDER Firma','REJECTED',v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- =========================================================
-- CASE 5: Doppelte lebende Zuweisung -> abgelehnt (UNIQUE)
-- =========================================================
do $$
declare v text;
begin
  begin
    insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
    values ('c4000000-0000-0000-0000-000000000005','c2000000-0000-0000-0000-000000000002','Anna Mueller');
    v := 'ACCEPTED';
  exception when unique_violation then v := 'REJECTED';
            when others          then v := 'OTHER('||sqlstate||')';
  end;
  insert into _ja_results values (5,'Doppelte lebende Zuweisung (job_id, employee_id)','REJECTED',v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- =========================================================
-- CASE 6: Leerer Namens-Schnappschuss -> abgelehnt
-- =========================================================
do $$
declare v text;
begin
  begin
    insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
    values ('c4000000-0000-0000-0000-000000000005','c2000000-0000-0000-0000-000000000003','   ');
    v := 'ACCEPTED';
  exception when check_violation then v := 'REJECTED';
            when others          then v := 'OTHER('||sqlstate||')';
  end;
  insert into _ja_results values (6,'Leerer employee_name_snapshot','REJECTED',v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- =========================================================
-- CASE 7: review ohne reviewed_at -> abgelehnt (Biconditional)
-- =========================================================
do $$
declare v text;
begin
  begin
    update public.job_assignments
       set review = 'present'
     where job_id = 'c4000000-0000-0000-0000-000000000005'
       and employee_id = 'c2000000-0000-0000-0000-000000000002';
    v := 'ACCEPTED';
  exception when check_violation then v := 'REJECTED';
            when others          then v := 'OTHER('||sqlstate||')';
  end;
  insert into _ja_results values (7,'review gesetzt ohne reviewed_at','REJECTED',v);
  raise notice 'CASE 7 -> %', v;
end $$;

-- =========================================================
-- CASE 8: Anwesenheits-/Review-Aenderung fuer INZWISCHEN DEAKTIVIERTEN
--         Mitarbeiter -> ERLAUBT (Guard darf hier nicht greifen)
-- =========================================================
do $$
declare v text;
begin
  -- Mitarbeiter A1 nachtraeglich deaktivieren (Zuweisung besteht bereits).
  update public.profiles set is_active = false where id='c2000000-0000-0000-0000-000000000002';

  begin
    update public.job_assignments
       set attendance = 'started', employee_started_at = now(),
           review = 'present', reviewed_at = now(),
           reviewed_by = 'c2000000-0000-0000-0000-000000000001'
     where job_id = 'c4000000-0000-0000-0000-000000000005'
       and employee_id = 'c2000000-0000-0000-0000-000000000002';
    v := 'ACCEPTED';
  exception when others then v := 'REJECTED('||sqlstate||')';
  end;

  update public.profiles set is_active = true where id='c2000000-0000-0000-0000-000000000002';

  insert into _ja_results values (8,'Anwesenheit/Review fuer deaktivierten Mitarbeiter aendern','ACCEPTED',v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- =========================================================
-- CASE 9: counts_for_timesheet — vollstaendige Wahrheitstabelle
--   review='absent'                       -> false  (auch bei completed)
--   review='present'                      -> true   (auch bei assigned)
--   attendance in (started, completed)    -> true
--   sonst (assigned, ungeprueft)          -> false
-- =========================================================
do $$
declare v text; ist text; c record; got boolean;
begin
  create temporary table _ct (label text, att public.attendance_state, rev public.attendance_review, erwartet boolean) on commit drop;
  insert into _ct values
    ('assigned/null',   'assigned',  null,      false),
    ('started/null',    'started',   null,      true ),
    ('completed/null',  'completed', null,      true ),
    ('assigned/present','assigned', 'present',  true ),
    ('started/present', 'started',  'present',  true ),
    ('completed/present','completed','present', true ),
    ('assigned/absent', 'assigned',  'absent',  false),
    ('started/absent',  'started',   'absent',  false),
    ('completed/absent','completed', 'absent',  false);

  create temporary table _ct_ist (label text, ergebnis boolean) on commit drop;

  -- Eine Trägerzeile, die alle Kombinationen nacheinander durchläuft.
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
  values ('c4000000-0000-0000-0000-000000000005','c2000000-0000-0000-0000-000000000003','Tom Schmidt');

  for c in select * from _ct loop
    update public.job_assignments
       set attendance  = c.att,
           review      = c.rev,
           reviewed_at = case when c.rev is null then null else now() end
     where job_id = 'c4000000-0000-0000-0000-000000000005'
       and employee_id = 'c2000000-0000-0000-0000-000000000003'
    returning counts_for_timesheet into got;

    insert into _ct_ist values (c.label, got);
  end loop;

  select string_agg(label || '=' || ergebnis::text, ', ' order by label) into ist from _ct_ist;
  select string_agg(label || '=' || erwartet::text, ', ' order by label) into v   from _ct;

  insert into _ja_results values (9,'counts_for_timesheet Wahrheitstabelle (9 Kombinationen)', v, ist);
  raise notice 'CASE 9 -> %', ist;
end $$;

-- =========================================================
-- CASE 10: completed OHNE employee_started_at bleibt erlaubt
-- =========================================================
do $$
declare v text;
begin
  begin
    insert into public.job_assignments (
      job_id, employee_id, employee_name_snapshot,
      attendance, employee_started_at, employee_completed_at
    )
    values (
      'c4000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000003','Tom Schmidt',
      'completed', null, now()
    );
    v := 'ACCEPTED';
  exception when others then v := 'REJECTED('||sqlstate||')';
  end;
  insert into _ja_results values (10,'attendance=completed ohne employee_started_at','ACCEPTED',v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- =========================================================
-- CASE 11: Touch-Trigger bei INSERT
-- =========================================================
do $$
declare v text;
begin
  perform pg_temp.reset_touch('c4000000-0000-0000-0000-000000000002');
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
  values ('c4000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000002','Anna Mueller');
  v := case when pg_temp.touched('c4000000-0000-0000-0000-000000000002') then 'TOUCHED' else 'NOT_TOUCHED' end;
  insert into _ja_results values (11,'jobs.updated_at angehoben bei Zuweisungs-INSERT','TOUCHED',v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- =========================================================
-- CASE 12: Touch-Trigger bei UPDATE
-- =========================================================
do $$
declare v text;
begin
  perform pg_temp.reset_touch('c4000000-0000-0000-0000-000000000002');
  update public.job_assignments
     set attendance = 'started', employee_started_at = now()
   where job_id = 'c4000000-0000-0000-0000-000000000002';
  v := case when pg_temp.touched('c4000000-0000-0000-0000-000000000002') then 'TOUCHED' else 'NOT_TOUCHED' end;
  insert into _ja_results values (12,'jobs.updated_at angehoben bei Zuweisungs-UPDATE','TOUCHED',v);
  raise notice 'CASE 12 -> %', v;
end $$;

-- =========================================================
-- CASE 13: Touch-Trigger bei DELETE
-- =========================================================
do $$
declare v text;
begin
  perform pg_temp.reset_touch('c4000000-0000-0000-0000-000000000002');
  delete from public.job_assignments where job_id = 'c4000000-0000-0000-0000-000000000002';
  v := case when pg_temp.touched('c4000000-0000-0000-0000-000000000002') then 'TOUCHED' else 'NOT_TOUCHED' end;
  insert into _ja_results values (13,'jobs.updated_at angehoben bei Zuweisungs-DELETE','TOUCHED',v);
  raise notice 'CASE 13 -> %', v;
end $$;

-- =========================================================
-- CASE 14: Backfill-Korrektheit (Status -> attendance, Zeitstempel, Name)
--   Der Guard wird fuer die Dauer des Backfills deaktiviert — exakt die
--   Reihenfolge der Migration (Backfill VOR Trigger-Anlage), damit auch
--   historische Zuweisungen an inaktive Mitarbeiter uebernommen werden.
-- =========================================================
do $$
declare v text;
begin
  alter table public.job_assignments disable trigger enforce_active_assignment_on_job_assignments;

  insert into public.job_assignments (
    job_id, employee_id, employee_name_snapshot, assigned_at, assigned_by,
    attendance, employee_started_at, employee_completed_at
  )
  select
    j.id, j.assigned_to,
    coalesce(nullif(btrim(p.full_name), ''), 'Unbekannt'),
    j.created_at, j.created_by,
    case j.status
      when 'completed'   then 'completed'
      when 'in_progress' then 'started'
      else                    'assigned'
    end::public.attendance_state,
    j.started_at, j.completed_at
  from public.jobs j
  join public.profiles p on p.id = j.assigned_to
  where j.assigned_to is not null
    and not exists (
      select 1 from public.job_assignments ja
      where ja.job_id = j.id and ja.employee_id = j.assigned_to
    )
  on conflict (job_id, employee_id) do nothing;

  alter table public.job_assignments enable trigger enforce_active_assignment_on_job_assignments;

  select string_agg(t.txt, ' | ' order by t.ord) into v from (
    -- J1 offen -> assigned, nicht abrechenbar
    select 1 as ord, 'J1='||ja.attendance::text||'/'||ja.counts_for_timesheet::text as txt
      from public.job_assignments ja
     where ja.job_id='c4000000-0000-0000-0000-000000000001' and ja.employee_id='c2000000-0000-0000-0000-000000000002'
    union all
    -- J3 abgeschlossen -> completed, abrechenbar, Zeitstempel uebernommen
    select 3, 'J3='||ja.attendance::text||'/'||ja.counts_for_timesheet::text
             ||'/start='||coalesce(ja.employee_started_at::text,'-')
             ||'/end='||coalesce(ja.employee_completed_at::text,'-')
             ||'/name='||ja.employee_name_snapshot
             ||'/by='||coalesce(ja.assigned_by::text,'-')
      from public.job_assignments ja
     where ja.job_id='c4000000-0000-0000-0000-000000000003'
    union all
    -- J4 ohne assigned_to -> gar keine Zeile
    select 4, 'J4rows='||(select count(*) from public.job_assignments ja2 where ja2.job_id='c4000000-0000-0000-0000-000000000004')::text
  ) t;

  insert into _ja_results values (
    14,'Backfill: Status-Abbildung, Zeitstempel, Name, assigned_by, keine Zeile ohne assigned_to',
    'J1=assigned/false | J3=completed/true/start=2026-06-01 08:00:00+00/end=2026-06-01 10:00:00+00/name=Tom Schmidt/by=c2000000-0000-0000-0000-000000000001 | J4rows=0',
    v);
  raise notice 'CASE 14 -> %', v;
end $$;

-- =========================================================
-- CASE 15: Backfill ist idempotent (zweiter Lauf fuegt nichts ein)
-- =========================================================
do $$
declare vorher int; nachher int; v text;
begin
  select count(*) into vorher from public.job_assignments;

  insert into public.job_assignments (
    job_id, employee_id, employee_name_snapshot, assigned_at, assigned_by,
    attendance, employee_started_at, employee_completed_at
  )
  select
    j.id, j.assigned_to,
    coalesce(nullif(btrim(p.full_name), ''), 'Unbekannt'),
    j.created_at, j.created_by,
    case j.status
      when 'completed'   then 'completed'
      when 'in_progress' then 'started'
      else                    'assigned'
    end::public.attendance_state,
    j.started_at, j.completed_at
  from public.jobs j
  join public.profiles p on p.id = j.assigned_to
  where j.assigned_to is not null
    and not exists (
      select 1 from public.job_assignments ja
      where ja.job_id = j.id and ja.employee_id = j.assigned_to
    )
  on conflict (job_id, employee_id) do nothing;

  select count(*) into nachher from public.job_assignments;
  v := 'delta='||(nachher - vorher)::text;
  insert into _ja_results values (15,'Backfill zweiter Lauf fuegt keine Zeile ein','delta=0',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- =========================================================
-- CASE 16: Historische Stundenzettel-Berechtigung bleibt erhalten
--   Alter Pfad (jobs.assigned_to) und neuer Pfad (counts_for_timesheet)
--   liefern fuer abgeschlossene Jobs identische Minuten je Mitarbeiter.
-- =========================================================
do $$
declare abweichungen int; v text;
begin
  select count(*) into abweichungen from (
    with alt as (
      select j.assigned_to as employee_id,
             sum(extract(epoch from (j.completed_at - j.started_at))/60)::int as minuten
      from public.jobs j
      where j.status='completed' and j.job_type='single'
        and j.started_at is not null and j.completed_at is not null
        and j.assigned_to is not null
      group by 1
    ),
    neu as (
      select ja.employee_id,
             sum(extract(epoch from (j.completed_at - j.started_at))/60)::int as minuten
      from public.jobs j
      join public.job_assignments ja on ja.job_id = j.id and ja.counts_for_timesheet
      where j.status='completed' and j.job_type='single'
        and j.started_at is not null and j.completed_at is not null
        and ja.employee_id is not null
      group by 1
    )
    select 1 from alt full outer join neu using (employee_id)
    where alt.minuten is distinct from neu.minuten
  ) d;

  v := 'abweichungen='||abweichungen::text;
  insert into _ja_results values (16,'Historische Stundenzettel-Minuten alt vs. neu identisch','abweichungen=0',v);
  raise notice 'CASE 16 -> %', v;
end $$;

-- =========================================================
-- CASE 17: Konto-Loeschung -> employee_id NULL, Zeile bleibt erhalten,
--          Loeschung wird NICHT blockiert
-- =========================================================
do $$
declare v text;
begin
  begin
    delete from auth.users where id='c2000000-0000-0000-0000-000000000007';
    v := 'DELETED';
  exception when others then v := 'BLOCKED('||sqlstate||')';
  end;

  if v = 'DELETED' then
    select 'rows='||count(*)::text
           ||'/emp='||coalesce(max(ja.employee_id::text),'NULL')
           ||'/name='||max(ja.employee_name_snapshot)
           ||'/counts='||max(ja.counts_for_timesheet::text)
      into v
    from public.job_assignments ja
    where ja.job_id='c4000000-0000-0000-0000-000000000007';
  end if;

  insert into _ja_results values (
    17,'Konto-Loeschung anonymisiert die Zuweisung statt sie zu loeschen',
    'rows=1/emp=NULL/name=Lena Wagner/counts=true', v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- =========================================================
-- CASE 18: Historie eines geloeschten Mitarbeiters bleibt auswertbar
--   Reports nutzen den lebenden Profilnamen und fallen auf den
--   Schnappschuss zurueck (LEFT JOIN + coalesce).
-- =========================================================
do $$
declare v text;
begin
  select 'name='||coalesce(p.full_name, ja.employee_name_snapshot)
         ||'/minuten='||(extract(epoch from (j.completed_at - j.started_at))/60)::int::text
    into v
  from public.job_assignments ja
  join public.jobs j on j.id = ja.job_id
  left join public.profiles p on p.id = ja.employee_id
  where ja.job_id='c4000000-0000-0000-0000-000000000007'
    and ja.counts_for_timesheet;

  insert into _ja_results values (
    18,'Nachweis eines geloeschten Kontos bleibt ueber den Namens-Schnappschuss nutzbar',
    'name=Lena Wagner/minuten=120', v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- =========================================================
-- CASE 19: Mehrere anonymisierte Zeilen am selben Auftrag sind moeglich
--   (NULLS DISTINCT ist erforderlich — NULLS NOT DISTINCT wuerde die
--    zweite Konto-Loeschung blockieren)
-- =========================================================
do $$
declare v text;
begin
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
  values ('c4000000-0000-0000-0000-000000000006','c2000000-0000-0000-0000-000000000005','Bea Berg');

  update public.profiles set company_id='c1000000-0000-0000-0000-000000000002', role='employee', is_active=true
   where id='c2000000-0000-0000-0000-000000000004';
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
  values ('c4000000-0000-0000-0000-000000000006','c2000000-0000-0000-0000-000000000004','Admin B');

  begin
    delete from auth.users where id in (
      'c2000000-0000-0000-0000-000000000005','c2000000-0000-0000-0000-000000000004'
    );
    select 'rows='||count(*)::text||'/null='||count(*) filter (where employee_id is null)::text
      into v
    from public.job_assignments where job_id='c4000000-0000-0000-0000-000000000006';
  exception when others then v := 'BLOCKED('||sqlstate||')';
  end;

  insert into _ja_results values (
    19,'Zwei geloeschte Mitarbeiter am selben Auftrag: beide Nachweiszeilen bleiben',
    'rows=2/null=2', v);
  raise notice 'CASE 19 -> %', v;
end $$;

-- =========================================================
-- CASE 20: Auftrag loeschen -> Zuweisungen kaskadieren, kein Fehler
-- =========================================================
do $$
declare v text; rest int;
begin
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
  values ('c4000000-0000-0000-0000-000000000008','c2000000-0000-0000-0000-000000000003','Tom Schmidt');

  begin
    delete from public.jobs where id='c4000000-0000-0000-0000-000000000008';
    select count(*) into rest from public.job_assignments where job_id='c4000000-0000-0000-0000-000000000008';
    v := 'DELETED/rest='||rest::text;
  exception when others then v := 'ERROR('||sqlstate||')';
  end;

  insert into _ja_results values (20,'Auftragsloeschung kaskadiert auf Zuweisungen (Touch-Trigger kein No-Op-Fehler)','DELETED/rest=0',v);
  raise notice 'CASE 20 -> %', v;
end $$;

-- =========================================================
-- CASE 21: KEINE Dauer-Spalte in job_assignments
--   Strukturzusicherung gegen kuenftiges Abdriften: die offizielle Dauer
--   lebt ausschliesslich auf jobs.
-- =========================================================
do $$
declare treffer text; v text;
begin
  select coalesce(string_agg(column_name || ':' || data_type, ', ' order by column_name), 'keine')
    into treffer
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'job_assignments'
    and (
      column_name ~* '(duration|dauer|minute|minuten|hour|stunde|worked|arbeitszeit|payroll)'
      or data_type = 'interval'
    );

  v := 'dauerspalten='||treffer;
  insert into _ja_results values (21,'Keine Dauer-/Intervall-Spalte in job_assignments','dauerspalten=keine',v);
  raise notice 'CASE 21 -> %', v;
end $$;

-- =========================================================
-- CASE 22: jobs bleibt strukturell unveraendert (assigned_to intakt)
-- =========================================================
do $$
declare v text;
begin
  select 'assigned_to='||data_type||'/nullable='||is_nullable into v
  from information_schema.columns
  where table_schema='public' and table_name='jobs' and column_name='assigned_to';

  insert into _ja_results values (22,'jobs.assigned_to unveraendert vorhanden','assigned_to=uuid/nullable=YES',coalesce(v,'FEHLT'));
  raise notice 'CASE 22 -> %', v;
end $$;

-- =========================================================
-- CASE 23: Neue Tabelle ist fail-closed (RLS an, keine Grants)
-- =========================================================
do $$
declare v text; rls boolean; grants int;
begin
  select relrowsecurity into rls from pg_class where oid = 'public.job_assignments'::regclass;
  select count(*) into grants
  from information_schema.role_table_grants
  where table_schema='public' and table_name='job_assignments'
    and grantee in ('anon','authenticated');

  v := 'rls='||rls::text||'/grants='||grants::text;
  insert into _ja_results values (23,'job_assignments fail-closed: RLS aktiv, keine anon/authenticated-Grants','rls=true/grants=0',v);
  raise notice 'CASE 23 -> %', v;
end $$;


-- =========================================================
-- CASE 24: DIREKTER INSERT mit employee_id = NULL -> abgelehnt
--   Anonyme Zeilen duerfen ausschliesslich NACHTRAEGLICH aus einer echten
--   Zuweisung entstehen (ON DELETE SET NULL). Ohne diese Ablehnung liesse
--   sich eine beliebige Zahl namenloser Geisterzeilen an einem Auftrag
--   anlegen — und damit die Invariante aushebeln, auf der die Begruendung
--   fuer NULLS DISTINCT beruht (jede NULL-Zeile = genau ein geloeschter
--   Mitarbeiter). Regressionsschutz fuer den Security-Review zu PR #50.
-- =========================================================
do $$
declare v text;
begin
  begin
    insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
    values ('c4000000-0000-0000-0000-000000000001', null, 'Geisterzeile');
    v := 'ACCEPTED';
  exception when others then v := 'REJECTED';
  end;
  insert into _ja_results values (24,'Direkter INSERT mit employee_id = NULL','REJECTED',v);
  raise notice 'CASE 24 -> %', v;
end $$;

-- =========================================================
-- CASE 25: Anonymisierungspfad bleibt trotz CASE-24-Ablehnung offen
--   Der Guard darf NUR den INSERT treffen. Das UPDATE auf NULL, das
--   PostgreSQL bei ON DELETE SET NULL ausfuehrt, muss weiterhin
--   durchlaufen — sonst waeren Konto-Loeschungen blockiert.
-- =========================================================
do $$
declare v text;
begin
  begin
    update public.job_assignments
       set employee_id = null
     where job_id = 'c4000000-0000-0000-0000-000000000001'
       and employee_id = 'c2000000-0000-0000-0000-000000000003';
    v := 'ACCEPTED';
  exception when others then v := 'REJECTED('||sqlstate||')';
  end;
  insert into _ja_results values (25,'UPDATE auf employee_id = NULL (Anonymisierung) bleibt erlaubt','ACCEPTED',v);
  raise notice 'CASE 25 -> %', v;
end $$;


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select
  case_no,
  beschreibung,
  erwartet,
  ergebnis,
  case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _ja_results
order by case_no;

-- LAUTER Fehlschlag, falls irgendein Fall nicht PASS ist (nachdem die
-- Tabelle oben ausgegeben wurde). So bricht psql (-v ON_ERROR_STOP=1) / CI ab.
do $$
declare fails int;
begin
  select count(*) into fails from _ja_results where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'JOB ASSIGNMENTS TEST: % Fall/Faelle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE 25 FAELLE PASS';
end $$;

-- Nichts persistieren — reine Pruefung.
rollback;
