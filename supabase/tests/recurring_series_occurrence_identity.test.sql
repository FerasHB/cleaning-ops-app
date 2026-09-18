-- =========================================================
-- TEST: Logische Identität eines generierten Termins (Occurrence-Slot)
-- (Migration 20260916000000_recurring_occurrence_slot_identity)
-- =========================================================
-- Weist nach, dass eine Änderung der REGEL-Uhrzeit den bestehenden Termin
-- VERSCHIEBT statt neben ihm einen zweiten zu erzeugen, dass die Erzeugung
-- idempotent bleibt, dass ein einzeln angepasster Termin (abweichender Termin)
-- erhalten bleibt und nicht nachträglich verdoppelt wird, und dass
-- Vergangenheit sowie laufende/abgeschlossene Arbeit unangetastet bleiben.
--
-- REGRESSION (der eigentliche Fehler):
--   Regel Mo–Fr 19:30 → 20:30. Der Termin des laufenden Tages trug eine Zeile
--   in job_comment_reads (entsteht bereits durch reines Öffnen der
--   Job-Detailansicht, auch ohne einen einzigen Kommentar). Der alte
--   PRUNE-Schritt durfte ihn deshalb nicht löschen, der GENERATE-Schritt legte
--   wegen der anderen start_time trotzdem einen zweiten an — zwei aktive
--   Termine für denselben Tag, der ältere als „Abweichender Termin" markiert.
--   Fall 3 und 4 unten decken genau das ab.
--
-- Aufrufe laufen als 'authenticated' Admin (SET ROLE + request.jwt.claims),
-- also über denselben Pfad wie services/jobs/jobs.service.ts updateJob →
-- rpc('update_job_occurrences').
--
-- AUSFÜHREN lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/recurring_series_occurrence_identity.test.sql
-- Legt Testdaten an, macht am Ende ROLLBACK — KEINE Rückstände, KEINE
-- Produktionsdaten.
--
-- Ergebnis: Tabelle (case_no | beschreibung | erwartet | ergebnis | verdikt).
-- Schlägt ein Fall fehl, bricht der Lauf am Ende LAUT ab (Exit-Code != 0).
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = c1…1 (Haupttests) | Firma B = c1…2 (Isolation)
-- Admin A  = c2…1 | Mitarbeiter A = c2…2 | Admin B = c2…3
-- Regel R1 = c3…1 (alle sieben Wochentage → wochentagsunabhängig reproduzierbar)

do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000001','authenticated','authenticated','slot-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000002','authenticated','authenticated','slot-empA@example.test','{"full_name":"Mitarbeiter A"}'),
    ('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000003','authenticated','authenticated','slot-adminB@example.test','{"full_name":"Admin B"}');
end $$;

-- on conflict: hosted legt die profiles-Zeile per handle_new_user-Trigger
-- bereits an, lokal nicht (siehe admin_status_notifications.test.sql).
insert into public.profiles (id, full_name) values
  ('c2000000-0000-0000-0000-000000000001','Admin A'),
  ('c2000000-0000-0000-0000-000000000002','Mitarbeiter A'),
  ('c2000000-0000-0000-0000-000000000003','Admin B')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('c1000000-0000-0000-0000-000000000001','Slot Firma A','slot-firma-a-test'),
  ('c1000000-0000-0000-0000-000000000002','Slot Firma B','slot-firma-b-test');

update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='c2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id='c2000000-0000-0000-0000-000000000002';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='c2000000-0000-0000-0000-000000000003';

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role','authenticated')::text, true);
end $f$;

-- Regel-Synchronisierung als Admin A auslösen (wie der Client).
create or replace function pg_temp.sync_rule(rule uuid) returns int language plpgsql as $f$
declare r int;
begin
  perform pg_temp.act_as('c2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select public.update_job_occurrences(rule) into r;
  execute 'reset role';
  return r;
end $f$;

create or replace function pg_temp.generate_rule(rule uuid) returns int language plpgsql as $f$
declare r int;
begin
  perform pg_temp.act_as('c2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select public.generate_job_occurrences(rule) into r;
  execute 'reset role';
  return r;
end $f$;

-- Termine eines Tages einer Regel zählen (nach TATSÄCHLICHEM Datum).
create or replace function pg_temp.cnt_on(rule uuid, d date) returns int language sql as $f$
  select count(*)::int from public.jobs where parent_job_id = rule and date = d;
$f$;

create temporary table _slot_results (
  case_no int, beschreibung text, erwartet text, ergebnis text
) on commit drop;


-- =========================================================
-- FIXTURE
--   d_past     = heute-7   completed  (Historie)
--   d_today    = heute     in_progress
--   d_read     = heute+1   offen, MIT Kommentar/Foto/Lesestatus  ← Bug-Auslöser
--   d_plain    = heute+2   offen, unberührt
--   d_override = heute+3   wird einzeln auf 21:00 gelegt
--   d_moved    = heute+4   wird einzeln auf einen ANDEREN Tag verschoben
--   d_prune    = heute+5   dessen Wochentag wird später aus der Regel entfernt
-- Regel R1: alle sieben Wochentage, 19:30, Zeitraum heute-30 … heute+21.
-- =========================================================
do $$
declare
  d_past date := current_date - 7;
begin
  insert into public.jobs
    (id, company_id, created_by, assigned_to, customer_name, service_name, location_address,
     status, job_type, recurring_days, start_time, is_active,
     recurrence_start_date, recurrence_end_date)
  values
    ('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
     'c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002',
     'Kronen Apotheke','Unterhaltsreinigung','Kronenstr. 1',
     'open','recurring', array['mon','tue','wed','thu','fri','sat','sun']::text[], '19:30', true,
     current_date - 30, current_date + 21);

  -- Historie und laufende Arbeit von Hand: generate_job_occurrences erzeugt
  -- grundsätzlich nur ab heute und nur mit status 'open'.
  -- occurrence_date wird BEWUSST NICHT mitgegeben — der Trigger muss den Slot
  -- selbst vergeben (das deckt zugleich Bestandszeilen ab).
  insert into public.jobs
    (id, company_id, parent_job_id, created_by, assigned_to, customer_name, service_name,
     location_address, status, job_type, date, start_time, is_active, started_at, completed_at)
  values
    ('c4000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
     'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
     'c2000000-0000-0000-0000-000000000002','Kronen Apotheke','Unterhaltsreinigung','Kronenstr. 1',
     'completed','single', d_past, '19:30', true,
     timestamptz '2026-09-09 19:33:00+00', timestamptz '2026-09-09 21:05:00+00'),
    ('c4000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001',
     'c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',
     'c2000000-0000-0000-0000-000000000002','Kronen Apotheke','Unterhaltsreinigung','Kronenstr. 1',
     'in_progress','single', current_date, '19:30', true,
     timestamptz '2026-09-16 19:31:00+00', null);

  -- Firma B: eigene Regel + Termin (Isolation)
  insert into public.jobs
    (id, company_id, created_by, customer_name, service_name, location_address,
     status, job_type, recurring_days, start_time, is_active, recurrence_start_date)
  values
    ('c3000000-0000-0000-0000-0000000000B1','c1000000-0000-0000-0000-000000000002',
     'c2000000-0000-0000-0000-000000000003',
     'Fremdkunde','Glasreinigung','Fremdweg 9',
     'open','recurring', array['mon','tue','wed','thu','fri','sat','sun']::text[], '09:00', true,
     current_date);
  insert into public.jobs
    (id, company_id, parent_job_id, created_by, customer_name, service_name,
     location_address, status, job_type, date, start_time, is_active)
  values
    ('c4000000-0000-0000-0000-0000000000B1','c1000000-0000-0000-0000-000000000002',
     'c3000000-0000-0000-0000-0000000000B1','c2000000-0000-0000-0000-000000000003',
     'Fremdkunde','Glasreinigung','Fremdweg 9','open','single', current_date + 1, '09:00', true);
end $$;

-- Termine der Regel erzeugen (heute ist bereits belegt → Slot-Konflikt, wird
-- übersprungen).
do $$ begin perform pg_temp.generate_rule('c3000000-0000-0000-0000-000000000001'); end $$;

-- Der Bug-Auslöser: Admin ÖFFNET den Termin von morgen. JobDetailScreen ruft
-- markJobCommentsAsRead() unabhängig davon auf, ob Kommentare existieren.
-- Zusätzlich ein echter Kommentar und ein Foto — alle drei schützten die Zeile
-- früher vor dem Löschen und lösten damit das Duplikat aus.
do $$
declare v_read uuid;
begin
  select id into v_read from public.jobs
  where parent_job_id='c3000000-0000-0000-0000-000000000001' and date = current_date + 1;

  insert into public.job_comment_reads (job_id, user_id)
  values (v_read, 'c2000000-0000-0000-0000-000000000001');

  insert into public.job_comments (id, company_id, job_id, author_id, message)
  values ('c5000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
          v_read,'c2000000-0000-0000-0000-000000000002','Bitte Schlüssel abholen.');

  insert into public.job_photos (id, job_id, company_id, uploaded_by, storage_path, file_name)
  values ('c6000000-0000-0000-0000-000000000001', v_read,
          'c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002',
          'c1/c4/vorab.jpg','vorab.jpg');
end $$;

-- Ausgangs-ids je Slot festhalten (müssen jede Regeländerung überleben).
create temporary table _ids_before on commit drop as
select occurrence_date, id
from public.jobs
where parent_job_id='c3000000-0000-0000-0000-000000000001';


-- =========================================================
-- TEST 1 — Serie 19:30 → 20:30
--   Erwartung: je Tag GENAU EIN Termin, Uhrzeit 20:30, gleiche id.
-- =========================================================
do $$ begin
  update public.jobs set start_time='20:30' where id='c3000000-0000-0000-0000-000000000001';
  perform pg_temp.sync_rule('c3000000-0000-0000-0000-000000000001');
end $$;

insert into _slot_results
select 1, 'Serie 19:30->20:30: genau EIN Termin fuer heute+2', '1',
  pg_temp.cnt_on('c3000000-0000-0000-0000-000000000001', current_date + 2)::text;

insert into _slot_results
select 2, 'Serie 19:30->20:30: Uhrzeit heute+2 ist 20:30', '20:30:00',
  coalesce((select start_time::text from public.jobs
            where parent_job_id='c3000000-0000-0000-0000-000000000001'
              and date = current_date + 2), 'KEIN TERMIN');

insert into _slot_results
select 3, 'Serie 19:30->20:30: Termin MIT Kommentar/Foto/Lesestatus bleibt EINZELN (Regressionsfall)', '1',
  pg_temp.cnt_on('c3000000-0000-0000-0000-000000000001', current_date + 1)::text;

insert into _slot_results
select 4, 'Regressionsfall: verschoben statt dupliziert — gleiche id, 20:30, Anhaenge intakt', 'OK',
  case when (
    select j.id = b.id and j.start_time = time '20:30'
       and exists (select 1 from public.job_comment_reads x where x.job_id=j.id)
       and exists (select 1 from public.job_comments      x where x.job_id=j.id)
       and exists (select 1 from public.job_photos        x where x.job_id=j.id)
    from public.jobs j
    join _ids_before b on b.occurrence_date = current_date + 1
    where j.parent_job_id='c3000000-0000-0000-0000-000000000001'
      and j.occurrence_date = current_date + 1
  ) then 'OK' else 'DUPLIZIERT_ODER_VERLOREN' end;

insert into _slot_results
select 5, 'Serie 19:30->20:30: scheduled_start mitgezogen', '20:30:00',
  coalesce((select to_char(scheduled_start, 'HH24:MI:SS') from public.jobs
            where parent_job_id='c3000000-0000-0000-0000-000000000001'
              and date = current_date + 2), 'NULL');

insert into _slot_results
select 6, 'Regel-Synchronisierung markiert NICHT als abweichenden Termin', 'false',
  coalesce((select schedule_overridden::text from public.jobs
            where parent_job_id='c3000000-0000-0000-0000-000000000001'
              and occurrence_date = current_date + 2), 'KEIN TERMIN');


-- =========================================================
-- TEST 2 — Serie 20:30 → 21:00
--   Erwartung: weiterhin GENAU EIN Termin, keine Ansammlung 19:30/20:30/21:00.
-- =========================================================
do $$ begin
  update public.jobs set start_time='21:00' where id='c3000000-0000-0000-0000-000000000001';
  perform pg_temp.sync_rule('c3000000-0000-0000-0000-000000000001');
end $$;

insert into _slot_results
select 7, 'Serie 20:30->21:00: weiterhin genau EIN Termin fuer heute+2', '1',
  pg_temp.cnt_on('c3000000-0000-0000-0000-000000000001', current_date + 2)::text;

insert into _slot_results
select 8, 'Keine Ansammlung alter Uhrzeiten (19:30/20:30) in der Zukunft', '0',
  (select count(*)::text from public.jobs
   where parent_job_id='c3000000-0000-0000-0000-000000000001'
     and date > current_date
     and start_time in (time '19:30', time '20:30'));


-- =========================================================
-- TEST 3 — Erzeugung mehrfach laufen lassen
--   Erwartung: keine neuen Zeilen, keine Duplikate.
-- =========================================================
do $$
declare
  before_cnt int;
  after_cnt  int;
  ins        int;
begin
  select count(*) into before_cnt from public.jobs where parent_job_id='c3000000-0000-0000-0000-000000000001';
  ins := pg_temp.generate_rule('c3000000-0000-0000-0000-000000000001')
       + pg_temp.generate_rule('c3000000-0000-0000-0000-000000000001')
       + pg_temp.generate_rule('c3000000-0000-0000-0000-000000000001');
  select count(*) into after_cnt from public.jobs where parent_job_id='c3000000-0000-0000-0000-000000000001';

  insert into _slot_results values
    (9,  'Dreimal generieren fuegt nichts ein', '0', ins::text),
    (10, 'Dreimal generieren aendert die Terminanzahl nicht', before_cnt::text, after_cnt::text);
end $$;

insert into _slot_results
select 11, 'Kein Slot mit mehr als einem Termin (Invariante)', '0',
  (select count(*)::text from (
     select occurrence_date from public.jobs
     where parent_job_id='c3000000-0000-0000-0000-000000000001'
     group by occurrence_date having count(*) > 1) x);


-- =========================================================
-- TEST 4 — EINZELNEN Termin anpassen (echter abweichender Termin)
--   heute+3 wird von 21:00 (Regel) auf 06:00 gelegt — so wie der Admin-Client
--   es tut: direktes UPDATE auf jobs, ohne Regel-RPC.
--   Erwartung: als abweichend markiert; eine spätere Serien-Änderung fasst ihn
--   nicht an; die Erzeugung legt KEINEN zweiten Termin für diesen Tag an.
-- =========================================================
do $$
declare v_id uuid;
begin
  select id into v_id from public.jobs
  where parent_job_id='c3000000-0000-0000-0000-000000000001' and occurrence_date = current_date + 3;

  perform pg_temp.act_as('c2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  update public.jobs
     set start_time = '06:00',
         scheduled_start = ((current_date + 3)::text || ' 06:00')::timestamptz
   where id = v_id;
  execute 'reset role';
end $$;

insert into _slot_results
select 12, 'Einzeln geaenderte Uhrzeit wird als abweichender Termin markiert', 'true',
  coalesce((select schedule_overridden::text from public.jobs
            where parent_job_id='c3000000-0000-0000-0000-000000000001'
              and occurrence_date = current_date + 3), 'KEIN TERMIN');

-- Serie erneut ändern (21:00 → 22:00) und synchronisieren
do $$ begin
  update public.jobs set start_time='22:00' where id='c3000000-0000-0000-0000-000000000001';
  perform pg_temp.sync_rule('c3000000-0000-0000-0000-000000000001');
end $$;

insert into _slot_results
select 13, 'Abweichender Termin behaelt seine Uhrzeit trotz Serien-Aenderung', '06:00:00',
  coalesce((select start_time::text from public.jobs
            where parent_job_id='c3000000-0000-0000-0000-000000000001'
              and occurrence_date = current_date + 3), 'KEIN TERMIN');

insert into _slot_results
select 14, 'Abweichender Termin wird NICHT durch einen regulaeren Termin ergaenzt', '1',
  pg_temp.cnt_on('c3000000-0000-0000-0000-000000000001', current_date + 3)::text;

insert into _slot_results
select 15, 'Regulaerer Termin folgt der Serie weiter (heute+2 = 22:00)', '22:00:00',
  coalesce((select start_time::text from public.jobs
            where parent_job_id='c3000000-0000-0000-0000-000000000001'
              and occurrence_date = current_date + 2), 'KEIN TERMIN');


-- =========================================================
-- TEST 4b — EINZELNEN Termin auf einen ANDEREN TAG verschieben
--   heute+4 wird auf heute+2 gelegt. Der Slot bleibt heute+4, deshalb
--   kollidiert er NICHT mit dem regulären Termin von heute+2 — genau dafür ist
--   die Identität (parent_job_id, occurrence_date) und nicht (…, date) gewählt.
-- =========================================================
do $$
declare v_id uuid;
begin
  select id into v_id from public.jobs
  where parent_job_id='c3000000-0000-0000-0000-000000000001' and occurrence_date = current_date + 4;

  perform pg_temp.act_as('c2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  update public.jobs
     set date = current_date + 2,
         scheduled_start = ((current_date + 2)::text || ' 22:00')::timestamptz
   where id = v_id;
  execute 'reset role';
end $$;

insert into _slot_results
select 16, 'Verschieben auf einen belegten Tag ist erlaubt (Slot bleibt erhalten)', 'OK',
  case when (select count(*) from public.jobs
             where parent_job_id='c3000000-0000-0000-0000-000000000001'
               and date = current_date + 2) = 2
       then 'OK' else 'BLOCKIERT_ODER_VERLOREN' end;

insert into _slot_results
select 17, 'Slot des verschobenen Termins bleibt unveraendert', (current_date + 4)::text,
  coalesce((select occurrence_date::text from public.jobs
            where parent_job_id='c3000000-0000-0000-0000-000000000001'
              and schedule_overridden = true
              and date = current_date + 2), 'KEIN TERMIN');

-- Erneut erzeugen: der Slot heute+4 ist belegt (wenn auch anderswo terminiert)
-- → es darf KEIN Ersatztermin entstehen.
do $$ begin perform pg_temp.generate_rule('c3000000-0000-0000-0000-000000000001'); end $$;

insert into _slot_results
select 18, 'Erzeugung legt fuer den verschobenen Slot keinen Ersatz an', '0',
  pg_temp.cnt_on('c3000000-0000-0000-0000-000000000001', current_date + 4)::text;


-- =========================================================
-- TEST 5 — Abgeschlossene Historie
--   Erwartung: Datum, Uhrzeit, Status und Zeitstempel unverändert.
-- =========================================================
insert into _slot_results
select 19, 'Abgeschlossener Termin der Vergangenheit bleibt unveraendert', 'OK',
  case when exists (
    select 1 from public.jobs
    where id='c4000000-0000-0000-0000-000000000001'
      and status='completed'
      and date = current_date - 7
      and start_time = time '19:30'
      and started_at   = timestamptz '2026-09-09 19:33:00+00'
      and completed_at = timestamptz '2026-09-09 21:05:00+00'
  ) then 'OK' else 'HISTORIE_UEBERSCHRIEBEN' end;

insert into _slot_results
select 20, 'Abgeschlossener Termin wurde nicht als abweichend markiert', 'false',
  coalesce((select schedule_overridden::text from public.jobs
            where id='c4000000-0000-0000-0000-000000000001'), 'WEG');


-- =========================================================
-- TEST 6 — Laufende Arbeit (in_progress)
--   Erwartung: nicht verschoben, nicht gelöscht, started_at intakt; und der
--   belegte Slot verhindert einen zweiten Termin für heute.
-- =========================================================
insert into _slot_results
select 21, 'Laufender Termin (in_progress) bleibt unveraendert', 'OK',
  case when exists (
    select 1 from public.jobs
    where id='c4000000-0000-0000-0000-000000000002'
      and status='in_progress'
      and date = current_date
      and start_time = time '19:30'
      and started_at = timestamptz '2026-09-16 19:31:00+00'
  ) then 'OK' else 'LAUFENDE_ARBEIT_UEBERSCHRIEBEN' end;

insert into _slot_results
select 22, 'Kein zweiter Termin fuer heute neben der laufenden Arbeit', '1',
  pg_temp.cnt_on('c3000000-0000-0000-0000-000000000001', current_date)::text;


-- =========================================================
-- TEST 7 — PRUNE bleibt erhalten: Wochentag aus der Regel entfernen
--   Erwartung: unberührte Termine dieses Wochentags verschwinden; der Termin
--   mit Kommentar/Foto/Lesestatus bleibt als Rest-Historie stehen — und wird
--   NICHT zusätzlich neu erzeugt.
-- =========================================================
do $$
declare
  wd_read text;
begin
  wd_read := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from current_date + 1)::int + 1];
  update public.jobs
     set recurring_days = array(select unnest(recurring_days) except select wd_read)
   where id='c3000000-0000-0000-0000-000000000001';
  perform pg_temp.sync_rule('c3000000-0000-0000-0000-000000000001');
end $$;

insert into _slot_results
select 23, 'Geschuetzter Termin des entfernten Wochentags bleibt erhalten', '1',
  pg_temp.cnt_on('c3000000-0000-0000-0000-000000000001', current_date + 1)::text;

insert into _slot_results
select 24, 'Unberuehrte Termine des entfernten Wochentags werden entfernt', '0',
  pg_temp.cnt_on('c3000000-0000-0000-0000-000000000001', current_date + 8)::text;

insert into _slot_results
select 25, 'Weiterhin kein Slot mit mehr als einem Termin', '0',
  (select count(*)::text from (
     select occurrence_date from public.jobs
     where parent_job_id='c3000000-0000-0000-0000-000000000001'
     group by occurrence_date having count(*) > 1) x);


-- =========================================================
-- TEST 8 — Datenbank-Garantie und Firmen-Isolation
-- =========================================================
do $$
declare
  ok   text := 'ABGELEHNT';
  slot date;
begin
  select occurrence_date into slot from public.jobs
  where parent_job_id='c3000000-0000-0000-0000-000000000001' and date = current_date + 2
  limit 1;

  begin
    insert into public.jobs
      (company_id, parent_job_id, created_by, customer_name, service_name, location_address,
       status, job_type, date, occurrence_date, start_time, is_active)
    values
      ('c1000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001',
       'c2000000-0000-0000-0000-000000000001','Kronen Apotheke','Unterhaltsreinigung','Kronenstr. 1',
       'open','single', current_date + 2, slot, '05:00', true);
    ok := 'DURCHGELASSEN';
  exception when unique_violation then
    ok := 'ABGELEHNT';
  end;

  insert into _slot_results values
    (26, 'Unique Index lehnt einen zweiten Termin im selben Slot ab', 'ABGELEHNT', ok);
end $$;

insert into _slot_results
select 27, 'Fremde Firma bleibt unberuehrt', 'OK',
  case when exists (
    select 1 from public.jobs
    where id='c4000000-0000-0000-0000-0000000000B1'
      and start_time = time '09:00'
      and date = current_date + 1
  ) then 'OK' else 'FREMDDATEN_GEAENDERT' end;

insert into _slot_results
select 28, 'Slot wird auch ohne explizite Angabe vergeben (Bestandszeilen)', 'OK',
  case when not exists (
    select 1 from public.jobs
    where parent_job_id is not null and occurrence_date is null
  ) then 'OK' else 'SLOT_FEHLT' end;


-- =========================================================
-- Ergebnisübersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _slot_results order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _slot_results where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'OCCURRENCE-SLOT TEST: % Fall/Fälle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE FÄLLE PASS';
end $$;

rollback;
