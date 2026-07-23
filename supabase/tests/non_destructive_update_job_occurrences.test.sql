-- =========================================================
-- TEST: update_job_occurrences (nicht-destruktiv)
-- (Migration 20260723000004_non_destructive_update_job_occurrences)
-- =========================================================
-- Weist nach, dass eine Regeländerung Historie bewahrt (completed/
-- in_progress/Zeitstempel/Kommentare/Fotos/Lesestatus), Nicht-Termin-
-- Felder auf noch nicht gestartete Zukunfts-Occurrences synct, nur
-- unberührte, nicht mehr passende Zukunfts-Occurrences entfernt, fehlende
-- Termine einfügt, idempotent bleibt und Firmen isoliert.
--
-- Aufrufe laufen als 'authenticated' Admin (SET ROLE + request.jwt.claims),
-- also über denselben Pfad wie services/jobs/jobs.service.ts updateJob →
-- rpc('update_job_occurrences').
--
-- AUSFÜHREN lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/non_destructive_update_job_occurrences.test.sql
-- Legt Testdaten an, macht am Ende ROLLBACK — KEINE Rückstände, KEINE
-- Produktionsdaten.
--
-- Ergebnis: Tabelle (case_no | beschreibung | erwartet | ergebnis |
-- verdikt) + NOTICE-Meldungen. Schlägt ein Fall fehl, bricht der Lauf
-- am Ende LAUT ab (Exit-Code != 0).
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = a1…1 (Haupttests) | Firma B = a1…2 (Isolation)
-- Admin A  = a2…1 | Mitarbeiter A = a2…2 | Admin B = a2…3
-- Heute ist Referenz; recurring_days werden dynamisch aus konkreten Daten
-- abgeleitet, damit der Test wochentagsunabhängig reproduzierbar ist.

do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-000000000001','authenticated','authenticated','ndupd-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-000000000002','authenticated','authenticated','ndupd-empA@example.test','{"full_name":"Mitarbeiter A"}'),
    ('00000000-0000-0000-0000-000000000000','a2000000-0000-0000-0000-000000000003','authenticated','authenticated','ndupd-adminB@example.test','{"full_name":"Admin B"}');
end $$;

insert into public.profiles (id, full_name) values
  ('a2000000-0000-0000-0000-000000000001','Admin A'),
  ('a2000000-0000-0000-0000-000000000002','Mitarbeiter A'),
  ('a2000000-0000-0000-0000-000000000003','Admin B')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('a1000000-0000-0000-0000-000000000001','ND Firma A','nd-firma-a-test'),
  ('a1000000-0000-0000-0000-000000000002','ND Firma B','nd-firma-b-test');

update public.profiles set company_id='a1000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='a2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='a1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id='a2000000-0000-0000-0000-000000000002';
update public.profiles set company_id='a1000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='a2000000-0000-0000-0000-000000000003';

-- Helfer: JWT-Claims für einen Aufrufer setzen
create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role','authenticated')::text, true);
end $f$;

-- Ergebnis-Sammler
create temporary table _nd_results (
  case_no int, beschreibung text, erwartet text, ergebnis text
) on commit drop;


-- =========================================================
-- FIXTURE: Regel R1 (Firma A), Wochentage = die der beiden Zukunftstage
--   d_future1 = heute+7  (Occurrence mit Historie/Anhängen, „geschützt")
--   d_future2 = heute+14 (unberührte, passende Occurrence)
-- Zusätzlich:
--   d_past    = heute-7  (completed, Vergangenheit)
--   d_today_ip= heute    (in_progress)
-- Start-/Endzeitraum großzügig, Uhrzeit 08:00.
-- =========================================================
do $$
declare
  d_past    date := current_date - 7;
  d_today   date := current_date;
  d_future1 date := current_date + 7;
  d_future2 date := current_date + 14;
  wd_f1 text;
  wd_f2 text;
  wd_today text;
begin
  wd_f1    := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d_future1)::int + 1];
  wd_f2    := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d_future2)::int + 1];
  wd_today := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d_today)::int + 1];

  -- Parent-Regel R1 (deckt zunächst die Wochentage von f1, f2 und heute ab)
  insert into public.jobs
    (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
     status, job_type, recurring_days, start_time, is_active,
     recurrence_start_date, recurrence_end_date)
  values
    ('a3000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',
     'a2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
     'Kunde Alt','Unterhaltsreinigung','Altweg 1',
     'open','recurring', array[wd_f1, wd_f2, wd_today]::text[], '08:00', true,
     current_date - 30, current_date + 365);

  -- Occurrences an R1
  insert into public.jobs
    (id, company_id, parent_job_id, created_by, assigned_to, customer_name, service_name,
     location_address, status, job_type, date, start_time, is_active, started_at, completed_at)
  values
    -- completed (Vergangenheit) + Timesheet-Zeitstempel
    ('a4000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',
     'a3000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
     'a2000000-0000-0000-0000-000000000002','Kunde Alt','Unterhaltsreinigung','Altweg 1',
     'completed','single', d_past, '08:00', true,
     timestamptz '2026-07-10 08:03:00+00', timestamptz '2026-07-10 10:12:00+00'),
    -- in_progress (heute) + started_at
    ('a4000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000001',
     'a3000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
     'a2000000-0000-0000-0000-000000000002','Kunde Alt','Unterhaltsreinigung','Altweg 1',
     'in_progress','single', d_today, '08:00', true,
     timestamptz '2026-07-23 08:05:00+00', null),
    -- zukünftig, unberührt, PASSEND (bleibt erhalten, kein Churn)
    ('a4000000-0000-0000-0000-000000000003','a1000000-0000-0000-0000-000000000001',
     'a3000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
     'a2000000-0000-0000-0000-000000000002','Kunde Alt','Unterhaltsreinigung','Altweg 1',
     'open','single', d_future2, '08:00', true, null, null),
    -- zukünftig, OFFEN aber mit Anhängen (Kommentar+Foto+Lesestatus) → geschützt
    ('a4000000-0000-0000-0000-000000000004','a1000000-0000-0000-0000-000000000001',
     'a3000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
     'a2000000-0000-0000-0000-000000000002','Kunde Alt','Unterhaltsreinigung','Altweg 1',
     'open','single', d_future1, '08:00', true, null, null);

  -- Anhänge an die geschützte offene Zukunfts-Occurrence a4…4
  insert into public.job_comments (id, company_id, job_id, author_id, message)
  values ('a5000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',
          'a4000000-0000-0000-0000-000000000004','a2000000-0000-0000-0000-000000000002','Bitte Schlüssel abholen.');
  insert into public.job_photos (id, job_id, company_id, uploaded_by, storage_path, file_name)
  values ('a6000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000004',
          'a1000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002','a1/a4/vorab.jpg','vorab.jpg');
  insert into public.job_comment_reads (job_id, user_id)
  values ('a4000000-0000-0000-0000-000000000004','a2000000-0000-0000-0000-000000000002');

  -- Firma B: eigene Regel + Occurrence (Isolation)
  insert into public.jobs
    (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
     status, job_type, recurring_days, start_time, is_active, recurrence_start_date)
  values
    ('a3000000-0000-0000-0000-0000000000B1','a1000000-0000-0000-0000-000000000002',
     'a2000000-0000-0000-0000-000000000003', null,
     'Fremdkunde','Glasreinigung','Fremdweg 9',
     'open','recurring', array[wd_f1]::text[], '09:00', true, current_date - 10);
  insert into public.jobs
    (id, company_id, parent_job_id, created_by, customer_name, service_name,
     location_address, status, job_type, date, start_time, is_active)
  values
    ('a4000000-0000-0000-0000-0000000000B1','a1000000-0000-0000-0000-000000000002',
     'a3000000-0000-0000-0000-0000000000B1','a2000000-0000-0000-0000-000000000003',
     'Fremdkunde','Glasreinigung','Fremdweg 9','open','single', d_future1, '09:00', true);

  -- Normaler Single-Job Firma A (kein Parent) — darf nie berührt werden
  insert into public.jobs
    (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
     status, job_type, date, start_time, is_active)
  values
    ('a4000000-0000-0000-0000-0000000000AA','a1000000-0000-0000-0000-000000000001',
     'a2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002',
     'Einzelkunde','Grundreinigung','Einzelweg 3','open','single', d_future1, '15:00', true);
end $$;


-- =========================================================
-- EDIT 1: Nicht-Termin-Änderung (Kunde/Service/Ort) + Enddatum unverändert.
-- Regel R1: Kunde Alt -> Kunde Neu, Service -> Fensterreinigung.
-- Erwartung nach update_job_occurrences:
--   * completed/in_progress/past: Felder UNVERÄNDERT (Historie)
--   * offene Zukunft (a4…3, a4…4): Kunde/Service SYNCED
--   * a4…4 behält Kommentar/Foto/Lesestatus (nicht gelöscht)
--   * kein Churn: a4…3 und a4…4 behalten ihre id
-- =========================================================
do $$
declare
  ret int;
begin
  update public.jobs set customer_name='Kunde Neu', service_name='Fensterreinigung'
   where id='a3000000-0000-0000-0000-000000000001';

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select public.update_job_occurrences('a3000000-0000-0000-0000-000000000001') into ret;
  execute 'reset role';
end $$;

-- CASE 1: completed Occurrence erhalten
insert into _nd_results
select 1, 'completed Occurrence bleibt erhalten', 'PRESERVED',
  case when exists (select 1 from public.jobs where id='a4000000-0000-0000-0000-000000000001' and status='completed')
       then 'PRESERVED' else 'WEG' end;

-- CASE 2: in_progress Occurrence erhalten
insert into _nd_results
select 2, 'in_progress Occurrence bleibt erhalten', 'PRESERVED',
  case when exists (select 1 from public.jobs where id='a4000000-0000-0000-0000-000000000002' and status='in_progress')
       then 'PRESERVED' else 'WEG' end;

-- CASE 3: started_at/completed_at unverändert
insert into _nd_results
select 3, 'Zeitstempel started_at/completed_at unverändert', 'OK',
  case when exists (
    select 1 from public.jobs
    where id='a4000000-0000-0000-0000-000000000001'
      and started_at = timestamptz '2026-07-10 08:03:00+00'
      and completed_at = timestamptz '2026-07-10 10:12:00+00'
  ) and exists (
    select 1 from public.jobs
    where id='a4000000-0000-0000-0000-000000000002'
      and started_at = timestamptz '2026-07-23 08:05:00+00'
  ) then 'OK' else 'GEAENDERT' end;

-- CASE 4: Kommentar erhalten
insert into _nd_results
select 4, 'Kommentar der offenen Zukunfts-Occurrence erhalten', 'OK',
  case when exists (select 1 from public.job_comments where id='a5000000-0000-0000-0000-000000000001') then 'OK' else 'WEG' end;

-- CASE 5: Foto erhalten
insert into _nd_results
select 5, 'Foto der offenen Zukunfts-Occurrence erhalten', 'OK',
  case when exists (select 1 from public.job_photos where id='a6000000-0000-0000-0000-000000000001') then 'OK' else 'WEG' end;

-- CASE 6: Lesestatus erhalten
insert into _nd_results
select 6, 'Lesestatus der offenen Zukunfts-Occurrence erhalten', 'OK',
  case when exists (select 1 from public.job_comment_reads where job_id='a4000000-0000-0000-0000-000000000004') then 'OK' else 'WEG' end;

-- CASE 7: Timesheet-relevante Daten (completed + beide Zeitstempel) intakt
insert into _nd_results
select 7, 'Timesheet-Datensatz (completed + Zeitstempel) intakt', 'OK',
  case when exists (
    select 1 from public.jobs
    where id='a4000000-0000-0000-0000-000000000001'
      and status='completed' and started_at is not null and completed_at is not null
  ) then 'OK' else 'DEFEKT' end;

-- CASE 8: offene Zukunfts-Occurrence MIT Kommentar bleibt erhalten (a4…4)
insert into _nd_results
select 8, 'Offene Zukunfts-Occurrence mit Kommentar bleibt erhalten', 'PRESERVED',
  case when exists (select 1 from public.jobs where id='a4000000-0000-0000-0000-000000000004') then 'PRESERVED' else 'WEG' end;

-- CASE 9: offene Zukunfts-Occurrence MIT Foto bleibt erhalten (dieselbe Zeile a4…4)
insert into _nd_results
select 9, 'Offene Zukunfts-Occurrence mit Foto bleibt erhalten', 'PRESERVED',
  case when exists (select 1 from public.jobs where id='a4000000-0000-0000-0000-000000000004') then 'PRESERVED' else 'WEG' end;

-- CASE 16 (hier prüfbar): Sync ändert Anzeige der offenen Zukunft, nicht der Historie
insert into _nd_results
select 16, 'Sync: offene Zukunft = Kunde Neu, Historie = Kunde Alt', 'OK',
  case when (select customer_name from public.jobs where id='a4000000-0000-0000-0000-000000000003') = 'Kunde Neu'
        and (select customer_name from public.jobs where id='a4000000-0000-0000-0000-000000000004') = 'Kunde Neu'
        and (select customer_name from public.jobs where id='a4000000-0000-0000-0000-000000000001') = 'Kunde Alt'
        and (select customer_name from public.jobs where id='a4000000-0000-0000-0000-000000000002') = 'Kunde Alt'
       then 'OK' else 'FALSCH' end;

-- CASE 17: normaler Single-Job unberührt
insert into _nd_results
select 17, 'Normaler Single-Job unberührt', 'OK',
  case when exists (
    select 1 from public.jobs
    where id='a4000000-0000-0000-0000-0000000000AA' and customer_name='Einzelkunde' and service_name='Grundreinigung'
  ) then 'OK' else 'GEAENDERT' end;

-- CASE 18: Firma B unberührt (Isolation)
insert into _nd_results
select 18, 'Firma B Occurrence unberührt (Isolation)', 'OK',
  case when exists (
    select 1 from public.jobs
    where id='a4000000-0000-0000-0000-0000000000B1' and customer_name='Fremdkunde'
  ) then 'OK' else 'BEEINFLUSST' end;


-- =========================================================
-- EDIT 2: Uhrzeit ändern 08:00 -> 09:30. Danach:
--   * a4…3 (unberührt, passend zur alten Zeit) → jetzt nicht passend →
--     PRUNE entfernt sie
--   * a4…4 (mit Anhängen, alte Zeit) → nicht passend ABER geschützt → bleibt
--   * neue 09:30-Occurrences werden erzeugt (CASE 14)
-- =========================================================
do $$
declare ret int;
begin
  update public.jobs set start_time='09:30' where id='a3000000-0000-0000-0000-000000000001';
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select public.update_job_occurrences('a3000000-0000-0000-0000-000000000001') into ret;
  execute 'reset role';
end $$;

-- CASE 10: unberührte, nicht mehr passende Zukunfts-Occurrence entfernt (a4…3, alte Zeit 08:00)
insert into _nd_results
select 10, 'Unberührte, nicht passende Zukunfts-Occurrence entfernt', 'REMOVED',
  case when not exists (select 1 from public.jobs where id='a4000000-0000-0000-0000-000000000003')
       then 'REMOVED' else 'NOCH_DA' end;

-- CASE 8b: geschützte a4…4 (alte Zeit, aber mit Anhängen) NICHT entfernt
insert into _nd_results
select 21, 'Nicht passende ABER geschützte Occurrence bleibt (abgekoppelt)', 'PRESERVED',
  case when exists (select 1 from public.jobs where id='a4000000-0000-0000-0000-000000000004' and start_time='08:00')
       then 'PRESERVED' else 'WEG' end;

-- CASE 14: nach Zeitänderung existieren neue 09:30-Occurrences
insert into _nd_results
select 14, 'Zeitänderung erzeugt neue 09:30-Occurrences', 'OK',
  case when exists (
    select 1 from public.jobs
    where parent_job_id='a3000000-0000-0000-0000-000000000001'
      and start_time='09:30' and date >= current_date
  ) then 'OK' else 'FEHLT' end;

-- CASE 11: neu benötigte Occurrence eingefügt (mind. eine 09:30 an einem Regeltag)
insert into _nd_results
select 11, 'Neu benötigte Occurrence eingefügt', 'OK',
  case when (select count(*) from public.jobs
             where parent_job_id='a3000000-0000-0000-0000-000000000001'
               and start_time='09:30') > 0
       then 'OK' else 'FEHLT' end;


-- =========================================================
-- EDIT 3: Idempotenz — identischer Aufruf ohne Regeländerung darf keine
-- Duplikate erzeugen und die Zeilenzahl nicht verändern.
-- =========================================================
do $$
declare
  before_cnt int; after_cnt int; ret int;
begin
  select count(*) into before_cnt from public.jobs where parent_job_id='a3000000-0000-0000-0000-000000000001';
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select public.update_job_occurrences('a3000000-0000-0000-0000-000000000001') into ret;
  execute 'reset role';
  select count(*) into after_cnt from public.jobs where parent_job_id='a3000000-0000-0000-0000-000000000001';

  insert into _nd_results values
    (12, 'Erneuter Aufruf erzeugt keine Duplikate (Zeilenzahl stabil)', 'STABLE',
     case when before_cnt = after_cnt then 'STABLE' else 'CHANGED('||before_cnt||'->'||after_cnt||')' end);

  -- keine doppelten (date,start_time) an derselben Regel
  insert into _nd_results
  select 22, 'Keine doppelten (date,start_time) an der Regel', 'OK',
    case when not exists (
      select 1 from public.jobs
      where parent_job_id='a3000000-0000-0000-0000-000000000001'
      group by date, start_time having count(*) > 1
    ) then 'OK' else 'DUPLIKAT' end;
end $$;


-- =========================================================
-- EDIT 4: Wochentage ändern — nur noch der Wochentag von d_future2.
-- Prüft "korrekte Zukunftsplanung": es entstehen nur Occurrences an diesem
-- Wochentag, und unberührte an anderen Wochentagen verschwinden.
-- =========================================================
do $$
declare
  wd_keep text; ret int; wrong_day int;
  d_future2 date := current_date + 14;
begin
  wd_keep := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d_future2)::int + 1];
  update public.jobs set recurring_days = array[wd_keep]::text[]
   where id='a3000000-0000-0000-0000-000000000001';

  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select public.update_job_occurrences('a3000000-0000-0000-0000-000000000001') into ret;
  execute 'reset role';

  -- Zukunfts-Occurrences OHNE Historie dürfen nur noch am erlaubten Wochentag liegen
  select count(*) into wrong_day
  from public.jobs c
  where c.parent_job_id='a3000000-0000-0000-0000-000000000001'
    and c.date >= current_date
    and c.started_at is null and c.completed_at is null
    and not exists (select 1 from public.job_comments x where x.job_id=c.id)
    and not exists (select 1 from public.job_photos x where x.job_id=c.id)
    and not exists (select 1 from public.job_comment_reads x where x.job_id=c.id)
    and (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from c.date)::int + 1] <> wd_keep;

  insert into _nd_results values
    (13, 'Wochentagsänderung: unberührte Zukunft nur am erlaubten Tag', 'OK',
     case when wrong_day = 0 then 'OK' else 'FALSCHER_TAG('||wrong_day||')' end);
end $$;


-- =========================================================
-- EDIT 5: recurrence_end_date verkürzen — darf geschützte Historie nicht
-- anfassen. completed/in_progress bleiben, auch wenn sie (theoretisch)
-- außerhalb lägen. Hier bereits in Vergangenheit/heute → immer geschützt.
-- =========================================================
do $$
declare ret int;
begin
  update public.jobs set recurrence_end_date = current_date + 3
   where id='a3000000-0000-0000-0000-000000000001';
  perform pg_temp.act_as('a2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select public.update_job_occurrences('a3000000-0000-0000-0000-000000000001') into ret;
  execute 'reset role';
end $$;

insert into _nd_results
select 15, 'Enddatum-Verkürzung lässt geschützte Historie unberührt', 'OK',
  case when exists (select 1 from public.jobs where id='a4000000-0000-0000-0000-000000000001' and status='completed')
        and exists (select 1 from public.jobs where id='a4000000-0000-0000-0000-000000000002' and status='in_progress')
        and exists (select 1 from public.jobs where id='a4000000-0000-0000-0000-000000000004')
       then 'OK' else 'HISTORIE_BESCHAEDIGT' end;

-- CASE 19/20 (Negativ-Kontrolle) wird separat außerhalb dieses Files gefahren
-- (siehe Report / Runner): dort wird die alte destruktive Funktion
-- eingespielt und CASE 4/5/6/8 schlagen fehl. Hier als Platzhalter der
-- positive Nachweis, dass die aktuelle Implementierung greift.


-- =========================================================
-- Ergebnisübersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _nd_results order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _nd_results where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'NON-DESTRUCTIVE UPDATE TEST: % Fall/Fälle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE FÄLLE PASS';
end $$;

rollback;
