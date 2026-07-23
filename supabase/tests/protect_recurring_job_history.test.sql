-- =========================================================
-- TEST: protect_recurring_job_history
-- (Migration 20260723000003_protect_recurring_job_history)
-- =========================================================
-- Deckt den BEFORE-DELETE-Guard auf public.jobs ab: das Löschen einer
-- wiederkehrenden Parent-Regel wird blockiert, sobald mindestens eine
-- Occurrence den Status 'in_progress' oder 'completed' hat. Regeln mit
-- ausschließlich offenen Occurrences, Regeln ohne Occurrences, normale
-- Single-Jobs und das Löschen einzelner Occurrences bleiben unverändert
-- erlaubt. Zusätzlich wird nachgewiesen, dass beim blockierten Versuch
-- KEIN Child angefasst wird (Stundenzettel-Zeitstempel, Kommentare,
-- Fotos bleiben vollständig erhalten) — der CASCADE läuft also nicht an.
--
-- Die Löschversuche laufen bewusst als 'authenticated' Admin (nicht als
-- postgres), weil das dem echten Pfad aus services/jobs/jobs.service.ts
-- deleteJob() entspricht und damit zugleich belegt, dass der Guard auch
-- unter RLS greift.
--
-- AUSFÜHREN: im Supabase SQL Editor (läuft als postgres) komplett einfügen
-- und ausführen, oder lokal via
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/protect_recurring_job_history.test.sql
-- Legt Testdaten an und macht am Ende ROLLBACK — es bleiben KEINE
-- Testdaten zurück und es werden KEINE Produktionsdaten verändert.
--
-- Ergebnis: eine Tabelle am Ende (case_no | beschreibung | erwartet |
-- ergebnis | verdikt) sowie NOTICE-Meldungen im Messages-/Log-Panel.
-- Schlägt ein Fall fehl, bricht der Lauf am Ende LAUT ab.
-- =========================================================

begin;

-- Fixe, synthetische IDs (keine Produktions-IDs):
--   Firma            = b1…1
--   Admin            = b2…1   | Mitarbeiter = b2…2
--   Parent-Regeln    = b3…1 (completed child) | b3…2 (in_progress child)
--                      b3…3 (nur offene)      | b3…4 (ohne Children)
--                      b3…6 (für Einzel-Occurrence-Löschung)
--   Single-Job       = b3…5
--   Occurrences      = b4…1 completed | b4…2 in_progress
--                      b4…3/b4…4 offen | b4…5 completed (zu b3…6)
--   Kommentar        = b5…1  | Foto = b6…1

do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000001','authenticated','authenticated','protecthist-admin@example.test','{"full_name":"Admin Historie"}'),
    ('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000002','authenticated','authenticated','protecthist-emp@example.test','{"full_name":"Mitarbeiter Historie"}');
end $$;

-- Absicherung für lokale Baselines ohne den auth.users-Trigger
-- handle_new_user (siehe Projekt-Memory / bestehende Tests): legt die
-- profiles-Zeile nur an, falls der Trigger sie nicht schon erzeugt hat.
insert into public.profiles (id, full_name) values
  ('b2000000-0000-0000-0000-000000000001','Admin Historie'),
  ('b2000000-0000-0000-0000-000000000002','Mitarbeiter Historie')
on conflict (id) do nothing;

insert into public.companies (id, name, slug)
values ('b1000000-0000-0000-0000-000000000001','Protect Historie GmbH','protect-historie-test');

-- Rollen/Firma setzen (läuft als postgres → enforce_profile_field_guard
-- greift bewusst nicht, siehe 20260716000000).
update public.profiles
   set company_id = 'b1000000-0000-0000-0000-000000000001',
       role       = 'admin',
       is_active  = true
 where id = 'b2000000-0000-0000-0000-000000000001';

update public.profiles
   set company_id = 'b1000000-0000-0000-0000-000000000001',
       role       = 'employee',
       is_active  = true
 where id = 'b2000000-0000-0000-0000-000000000002';

-- ── Parent-Regeln (job_type='recurring', parent_job_id IS NULL) ──
insert into public.jobs
  (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
   status, job_type, recurring_days, start_time, is_active)
values
  ('b3000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002',
   'Kunde Completed','Unterhaltsreinigung','Teststr. 1',
   'open','recurring','{mon,thu}','08:00',true),
  ('b3000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002',
   'Kunde InProgress','Unterhaltsreinigung','Teststr. 2',
   'open','recurring','{tue}','09:00',true),
  ('b3000000-0000-0000-0000-000000000003','b1000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002',
   'Kunde NurOffen','Unterhaltsreinigung','Teststr. 3',
   'open','recurring','{wed}','10:00',true),
  ('b3000000-0000-0000-0000-000000000004','b1000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002',
   'Kunde OhneChildren','Unterhaltsreinigung','Teststr. 4',
   'open','recurring','{fri}','11:00',true),
  ('b3000000-0000-0000-0000-000000000006','b1000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002',
   'Kunde EinzelLoeschung','Unterhaltsreinigung','Teststr. 6',
   'open','recurring','{sat}','12:00',true);

-- ── Normaler Single-Job (kein Parent, keine Occurrence) ──
insert into public.jobs
  (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
   status, job_type, date, start_time, is_active)
values
  ('b3000000-0000-0000-0000-000000000005','b1000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002',
   'Kunde Single','Grundreinigung','Teststr. 5',
   'open','single', current_date, '13:00', true);

-- ── Occurrences (job_type='single', parent_job_id gesetzt) ──
-- b4…1: completed inkl. Timesheet-relevanter Zeitstempel.
-- b4…2: in_progress inkl. started_at (CHECK-Constraint verlangt das).
-- b4…3/4: offen.
-- b4…5: completed, hängt an b3…6 (nur für Fall 7).
insert into public.jobs
  (id, company_id, parent_job_id, created_by, assigned_to, customer_name, service_name,
   location_address, status, job_type, date, start_time, is_active, started_at, completed_at)
values
  ('b4000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001',
   'b3000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000002','Kunde Completed','Unterhaltsreinigung','Teststr. 1',
   'completed','single', current_date - 7, '08:00', true,
   timestamptz '2026-07-16 08:02:00+00', timestamptz '2026-07-16 10:31:00+00'),
  ('b4000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001',
   'b3000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000002','Kunde InProgress','Unterhaltsreinigung','Teststr. 2',
   'in_progress','single', current_date, '09:00', true,
   timestamptz '2026-07-23 09:05:00+00', null),
  ('b4000000-0000-0000-0000-000000000003','b1000000-0000-0000-0000-000000000001',
   'b3000000-0000-0000-0000-000000000003','b2000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000002','Kunde NurOffen','Unterhaltsreinigung','Teststr. 3',
   'open','single', current_date + 1, '10:00', true, null, null),
  ('b4000000-0000-0000-0000-000000000004','b1000000-0000-0000-0000-000000000001',
   'b3000000-0000-0000-0000-000000000003','b2000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000002','Kunde NurOffen','Unterhaltsreinigung','Teststr. 3',
   'open','single', current_date + 8, '10:00', true, null, null),
  ('b4000000-0000-0000-0000-000000000005','b1000000-0000-0000-0000-000000000001',
   'b3000000-0000-0000-0000-000000000006','b2000000-0000-0000-0000-000000000001',
   'b2000000-0000-0000-0000-000000000002','Kunde EinzelLoeschung','Unterhaltsreinigung','Teststr. 6',
   'completed','single', current_date - 3, '12:00', true,
   timestamptz '2026-07-20 12:01:00+00', timestamptz '2026-07-20 13:45:00+00');

-- ── Verknüpfte Daten an der completed Occurrence b4…1 ──
insert into public.job_comments (id, company_id, job_id, author_id, message)
values ('b5000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001',
        'b4000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002',
        'Fenster im 2. OG waren verschlossen.');

insert into public.job_photos (id, job_id, company_id, uploaded_by, storage_path, file_name)
values ('b6000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001',
        'b1000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002',
        'b1000000/b4000000/nachweis.jpg','nachweis.jpg');

insert into public.job_comment_reads (job_id, user_id)
values ('b4000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002');

-- Ergebnis-Sammler
create temporary table _protect_results (
  case_no      int,
  beschreibung text,
  erwartet     text,
  ergebnis     text
) on commit drop;

-- Ausgangswerte für den Erhaltungs-Nachweis (Fall 6) festhalten
create temporary table _protect_before as
select
  (select started_at   from public.jobs where id='b4000000-0000-0000-0000-000000000001') as started_at,
  (select completed_at from public.jobs where id='b4000000-0000-0000-0000-000000000001') as completed_at,
  (select count(*) from public.job_comments      where job_id='b4000000-0000-0000-0000-000000000001') as comments,
  (select count(*) from public.job_photos        where job_id='b4000000-0000-0000-0000-000000000001') as photos,
  (select count(*) from public.job_comment_reads where job_id='b4000000-0000-0000-0000-000000000001') as reads;


-- =========================================================
-- CASE 1: Parent mit completed Child → Löschen BLOCKIERT
-- =========================================================
do $$
declare v text; msg text;
begin
  perform set_config('request.jwt.claims','{"sub":"b2000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    delete from public.jobs where id='b3000000-0000-0000-0000-000000000001';
    v := 'DELETED';
  exception
    when others then
      msg := sqlerrm;
      -- Nur als BLOCKED werten, wenn es wirklich unser Guard war.
      if msg like '%Dauerauftrag kann nicht gelöscht werden%' then
        v := 'BLOCKED';
      else
        v := 'OTHER_ERROR('||sqlstate||')';
      end if;
  end;
  execute 'reset role';
  insert into _protect_results values (1,'Parent mit completed Child löschen','BLOCKED',v);
  raise notice 'CASE 1 -> % | msg=%', v, coalesce(msg,'(keine)');
end $$;

-- =========================================================
-- CASE 2: Parent mit in_progress Child → Löschen BLOCKIERT
-- =========================================================
do $$
declare v text; msg text;
begin
  perform set_config('request.jwt.claims','{"sub":"b2000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    delete from public.jobs where id='b3000000-0000-0000-0000-000000000002';
    v := 'DELETED';
  exception
    when others then
      msg := sqlerrm;
      if msg like '%Dauerauftrag kann nicht gelöscht werden%' then
        v := 'BLOCKED';
      else
        v := 'OTHER_ERROR('||sqlstate||')';
      end if;
  end;
  execute 'reset role';
  insert into _protect_results values (2,'Parent mit in_progress Child löschen','BLOCKED',v);
  raise notice 'CASE 2 -> % | msg=%', v, coalesce(msg,'(keine)');
end $$;

-- =========================================================
-- CASE 3: Parent mit ausschließlich offenen Children → ERLAUBT
-- (bestehendes Verhalten bleibt in diesem PR bewusst unverändert;
--  die offenen Children verschwinden weiterhin per CASCADE)
-- =========================================================
do $$
declare v text; parent_rows int; child_rows int;
begin
  perform set_config('request.jwt.claims','{"sub":"b2000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    delete from public.jobs where id='b3000000-0000-0000-0000-000000000003';
    v := 'DELETED';
  exception
    when others then v := 'BLOCKED('||sqlstate||')';
  end;
  execute 'reset role';

  if v = 'DELETED' then
    select count(*) into parent_rows from public.jobs where id='b3000000-0000-0000-0000-000000000003';
    select count(*) into child_rows  from public.jobs where parent_job_id='b3000000-0000-0000-0000-000000000003';
    if parent_rows = 0 and child_rows = 0 then
      v := 'DELETED';
    else
      v := 'NOOP(parent='||parent_rows||',children='||child_rows||')';
    end if;
  end if;

  insert into _protect_results values (3,'Parent mit nur offenen Children löschen','DELETED',v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- =========================================================
-- CASE 4: Parent ohne Children → ERLAUBT
-- Belegt zugleich, dass der Guard NUR eigene Children zählt: die
-- completed Occurrence b4…1 (fremder Parent) existiert weiterhin und
-- darf dieses Löschen nicht blockieren.
-- =========================================================
do $$
declare v text; parent_rows int;
begin
  perform set_config('request.jwt.claims','{"sub":"b2000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    delete from public.jobs where id='b3000000-0000-0000-0000-000000000004';
    v := 'DELETED';
  exception
    when others then v := 'BLOCKED('||sqlstate||')';
  end;
  execute 'reset role';

  if v = 'DELETED' then
    select count(*) into parent_rows from public.jobs where id='b3000000-0000-0000-0000-000000000004';
    if parent_rows <> 0 then v := 'NOOP(parent='||parent_rows||')'; end if;
  end if;

  insert into _protect_results values (4,'Parent ohne Children löschen','DELETED',v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- =========================================================
-- CASE 5: Normaler Single-Job → ERLAUBT
-- =========================================================
do $$
declare v text; rows_left int;
begin
  perform set_config('request.jwt.claims','{"sub":"b2000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    delete from public.jobs where id='b3000000-0000-0000-0000-000000000005';
    v := 'DELETED';
  exception
    when others then v := 'BLOCKED('||sqlstate||')';
  end;
  execute 'reset role';

  if v = 'DELETED' then
    select count(*) into rows_left from public.jobs where id='b3000000-0000-0000-0000-000000000005';
    if rows_left <> 0 then v := 'NOOP(rows='||rows_left||')'; end if;
  end if;

  insert into _protect_results values (5,'Normalen Single-Job löschen','DELETED',v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- =========================================================
-- CASE 6: Nach dem blockierten Versuch aus Fall 1 ist NICHTS angefasst.
-- Prüft Child-Existenz, Status, Timesheet-Zeitstempel, Kommentar, Foto
-- und Lesestatus gegen die vor dem Versuch festgehaltenen Werte.
-- Damit ist zugleich belegt, dass der CASCADE gar nicht erst anlief.
-- =========================================================
do $$
declare
  v            text := 'PRESERVED';
  child_status text;
  b            record;
  now_started  timestamptz;
  now_done     timestamptz;
  now_comments int;
  now_photos   int;
  now_reads    int;
begin
  select * into b from _protect_before;

  select status::text, started_at, completed_at
    into child_status, now_started, now_done
  from public.jobs where id='b4000000-0000-0000-0000-000000000001';

  select count(*) into now_comments from public.job_comments      where job_id='b4000000-0000-0000-0000-000000000001';
  select count(*) into now_photos   from public.job_photos        where job_id='b4000000-0000-0000-0000-000000000001';
  select count(*) into now_reads    from public.job_comment_reads where job_id='b4000000-0000-0000-0000-000000000001';

  if child_status is null then
    v := 'CHILD_GELOESCHT';
  elsif child_status <> 'completed' then
    v := 'STATUS_GEAENDERT('||child_status||')';
  elsif now_started is distinct from b.started_at or now_done is distinct from b.completed_at then
    v := 'ZEITSTEMPEL_GEAENDERT';
  elsif now_comments <> b.comments then
    v := 'KOMMENTARE_WEG('||now_comments||'/'||b.comments||')';
  elsif now_photos <> b.photos then
    v := 'FOTOS_WEG('||now_photos||'/'||b.photos||')';
  elsif now_reads <> b.reads then
    v := 'LESESTATUS_WEG('||now_reads||'/'||b.reads||')';
  end if;

  -- Der Parent selbst muss ebenfalls noch existieren.
  if v = 'PRESERVED'
     and not exists (select 1 from public.jobs where id='b3000000-0000-0000-0000-000000000001') then
    v := 'PARENT_GELOESCHT';
  end if;

  insert into _protect_results values (6,'Blockierter Versuch lässt Child/Timestamps/Kommentar/Foto unberührt','PRESERVED',v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- =========================================================
-- CASE 7: Einzelne Occurrence direkt löschen → weiterhin ERLAUBT
-- Bewusste Scope-Grenze dieses PRs: der Guard schützt nur vor dem
-- Löschen der PARENT-Regel, nicht vor dem gezielten Löschen einer
-- einzelnen Occurrence durch einen Admin.
-- =========================================================
do $$
declare v text; rows_left int;
begin
  perform set_config('request.jwt.claims','{"sub":"b2000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    delete from public.jobs where id='b4000000-0000-0000-0000-000000000005';
    v := 'DELETED';
  exception
    when others then v := 'BLOCKED('||sqlstate||')';
  end;
  execute 'reset role';

  if v = 'DELETED' then
    select count(*) into rows_left from public.jobs where id='b4000000-0000-0000-0000-000000000005';
    if rows_left <> 0 then v := 'NOOP(rows='||rows_left||')'; end if;
  end if;

  insert into _protect_results values (7,'Einzelne completed Occurrence direkt löschen','DELETED',v);
  raise notice 'CASE 7 -> %', v;
end $$;


-- =========================================================
-- Ergebnisübersicht
-- =========================================================
select
  case_no,
  beschreibung,
  erwartet,
  ergebnis,
  case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _protect_results
order by case_no;

-- LAUTER Fehlschlag, falls irgendein Fall nicht PASS ist (nachdem die
-- Tabelle oben ausgegeben wurde). So bricht psql (-v ON_ERROR_STOP=1) / CI ab.
do $$
declare fails int;
begin
  select count(*) into fails from _protect_results where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'PROTECT RECURRING JOB HISTORY TEST: % Fall/Fälle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE 7 FÄLLE PASS';
end $$;

-- Nichts persistieren — reine Prüfung.
rollback;
