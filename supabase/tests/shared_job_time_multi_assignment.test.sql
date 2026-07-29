-- =========================================================
-- TEST: Shared Job Time — Start/Abschluss fuer JEDEN Zugewiesenen
-- (Migration 20260731000000_shared_job_time_multi_assignment)
-- =========================================================
-- Prueft die drei Aussagen, auf denen die Phase steht:
--
--   1. JEDER ueber job_assignments Zugewiesene darf starten und
--      abschliessen — auch der, der den jeweils anderen Uebergang nicht
--      ausgeloest hat (geteilte Job-Uhr).
--   2. Die Uhr gehoert dem AUFTRAG: startet Ahmed und schliesst Mohammed
--      ab, ist die offizielle Dauer 08:00–10:00 und BEIDE erscheinen mit
--      genau dieser Zeit im Stundenzettel-Praedikat.
--   3. Es geht dabei KEINE Grenze auf: nicht Zugewiesene, fremde Firmen,
--      deaktivierte Konten, Admins und Recurring-Parent-Regeln bleiben
--      abgewiesen; ein zweiter Start/Abschluss aendert nichts.
--
-- Alle Zugriffe laufen als echte Rollen (SET ROLE + request.jwt.claims),
-- also ueber denselben Pfad wie die App ueber PostgREST.
--
-- HINWEIS ZU „VERWEIGERT"-PFADEN: wie in job_assignments_rls.test.sql
-- begruendet, stuerzt der lokale Supabase-Container bei einem
-- permission-denied-Fehler ab. Dieser Test loest keine solchen Fehler aus —
-- alle Ablehnungen kommen aus dem FUNKTIONSKOERPER der beiden RPCs
-- (RAISE EXCEPTION) bzw. aus RLS, nicht aus fehlenden Privilegien.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende, keine
-- Produktionsdaten. Ausfuehren lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/shared_job_time_multi_assignment.test.sql
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = f1…1 | Firma B = f1…2
-- Admin A   = f2…1
-- AHMED     = f2…2  (Legacy-Primaer von J1)
-- MOHAMMED  = f2…3  (nur ueber job_assignments an J1)
-- FREMD A   = f2…4  (Firma A, J1 NICHT zugewiesen)
-- Admin B   = f2…5 | Employee B = f2…6 (andere Firma)
-- INAKTIV   = f2…7  (Firma A, zugewiesen, aber is_active = false)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000001','authenticated','authenticated','s-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000002','authenticated','authenticated','s-ahmed@example.test','{"full_name":"Ahmed Start"}'),
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000003','authenticated','authenticated','s-mohammed@example.test','{"full_name":"Mohammed Ende"}'),
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000004','authenticated','authenticated','s-fremd@example.test','{"full_name":"Frida Fremd"}'),
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000005','authenticated','authenticated','s-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000006','authenticated','authenticated','s-b1@example.test','{"full_name":"Bea Fremdfirma"}'),
    ('00000000-0000-0000-0000-000000000000','f2000000-0000-0000-0000-000000000007','authenticated','authenticated','s-inaktiv@example.test','{"full_name":"Ines Inaktiv"}');
end $$;

-- Der auth-Trigger handle_new_user ist in der lokalen Baseline nicht
-- enthalten — Profile werden deshalb explizit angelegt.
insert into public.profiles (id, full_name) values
  ('f2000000-0000-0000-0000-000000000001','Admin A'),
  ('f2000000-0000-0000-0000-000000000002','Ahmed Start'),
  ('f2000000-0000-0000-0000-000000000003','Mohammed Ende'),
  ('f2000000-0000-0000-0000-000000000004','Frida Fremd'),
  ('f2000000-0000-0000-0000-000000000005','Admin B'),
  ('f2000000-0000-0000-0000-000000000006','Bea Fremdfirma'),
  ('f2000000-0000-0000-0000-000000000007','Ines Inaktiv')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('f1000000-0000-0000-0000-000000000001','Shared Firma A','shared-firma-a-test'),
  ('f1000000-0000-0000-0000-000000000002','Shared Firma B','shared-firma-b-test');

update public.profiles set company_id='f1000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='f2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='f1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id in
  ('f2000000-0000-0000-0000-000000000002','f2000000-0000-0000-0000-000000000003','f2000000-0000-0000-0000-000000000004','f2000000-0000-0000-0000-000000000007');
update public.profiles set company_id='f1000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='f2000000-0000-0000-0000-000000000005';
update public.profiles set company_id='f1000000-0000-0000-0000-000000000002', role='employee', is_active=true where id='f2000000-0000-0000-0000-000000000006';

-- Auftraege (alle Firma A, ausser J5):
--   J1 = single, {AHMED, MOHAMMED}      -> Hauptszenario (A startet, B schliesst ab)
--   J2 = single, {MOHAMMED, AHMED}      -> Gegenrichtung (Szenario 2)
--   J3 = RECURRING-PARENT, {MOHAMMED}   -> darf NIE startbar sein
--   J4 = single, NUR Legacy-Zeiger      -> Bestandsfall ohne Zuweisungszeile
--   J5 = single, Firma B, {Employee B}  -> Firmengrenze
--   J6 = single, {INAKTIV}              -> deaktiviertes Konto
insert into public.jobs (id, company_id, assigned_to, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time, recurring_days,
                         is_active, created_at, updated_at, parent_job_id) values
  ('f4000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000001',null,'f2000000-0000-0000-0000-000000000001','K1','S1','O1','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('f4000000-0000-0000-0000-000000000002','f1000000-0000-0000-0000-000000000001',null,'f2000000-0000-0000-0000-000000000001','K2','S2','O2','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('f4000000-0000-0000-0000-000000000003','f1000000-0000-0000-0000-000000000001',null,'f2000000-0000-0000-0000-000000000001','K3','S3','O3','open','recurring',null,'08:00',array['mon'],true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('f4000000-0000-0000-0000-000000000004','f1000000-0000-0000-0000-000000000001',null,'f2000000-0000-0000-0000-000000000001','K4','S4','O4','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('f4000000-0000-0000-0000-000000000005','f1000000-0000-0000-0000-000000000002',null,'f2000000-0000-0000-0000-000000000005','K5','S5','O5','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('f4000000-0000-0000-0000-000000000006','f1000000-0000-0000-0000-000000000001',null,'f2000000-0000-0000-0000-000000000001','K6','S6','O6','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null);

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;


-- =========================================================
-- Ausgangslage herstellen
-- =========================================================
-- Der Legacy-Zeiger muss DETERMINISTISCH stehen, sonst ist "sekundaer"
-- nicht nachweisbar. Phase 2 behaelt einen gedeckten Zeiger bei (Regel 1
-- von compat_primary_assignee) — also erst den gewuenschten Primaer allein
-- setzen, dann den Zweiten ergaenzen.
--   J1: Primaer AHMED,    dann MOHAMMED  -> MOHAMMED ist der sekundaere
--   J2: Primaer MOHAMMED, dann AHMED     -> AHMED    ist der sekundaere
do $$
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';

  perform public.set_job_assignments('f4000000-0000-0000-0000-000000000001',
    array['f2000000-0000-0000-0000-000000000002']::uuid[]);
  perform public.set_job_assignments('f4000000-0000-0000-0000-000000000001',
    array['f2000000-0000-0000-0000-000000000002','f2000000-0000-0000-0000-000000000003']::uuid[]);

  perform public.set_job_assignments('f4000000-0000-0000-0000-000000000002',
    array['f2000000-0000-0000-0000-000000000003']::uuid[]);
  perform public.set_job_assignments('f4000000-0000-0000-0000-000000000002',
    array['f2000000-0000-0000-0000-000000000003','f2000000-0000-0000-0000-000000000002']::uuid[]);

  -- Recurring-PARENT traegt eine Zuweisung als Vorlage (Phase 4).
  perform public.set_job_assignments('f4000000-0000-0000-0000-000000000003',
    array['f2000000-0000-0000-0000-000000000003']::uuid[]);

  -- Noch AKTIVES Konto zuweisen — der Guard enforce_active_assignment
  -- laesst keine Zuweisung an ein inaktives Profil zu. Deaktiviert wird
  -- erst danach (unten), was fachlich exakt dem Realfall entspricht.
  perform public.set_job_assignments('f4000000-0000-0000-0000-000000000006',
    array['f2000000-0000-0000-0000-000000000007']::uuid[]);

  execute 'reset role';
end $$;

-- Fremdfirmen-Auftrag J5 direkt verdrahten (ein zweiter Rollenwechsel als
-- Admin B braechte keinen Erkenntnisgewinn).
insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
values ('f4000000-0000-0000-0000-000000000005','f2000000-0000-0000-0000-000000000006','Bea Fremdfirma');

-- J4: BESTANDSFALL "nur Legacy-Zeiger, keine Zuweisungszeile".
-- Genau diese Konstellation existiert in Produktion (der Phase-1-Backfill
-- hat nicht-konforme Zeilen bewusst erhalten) und ist der Grund, warum der
-- ODER-Zweig "assigned_to = auth.uid()" in beiden RPCs stehen bleibt.
--
-- Sie laesst sich NICHT durch ein normales UPDATE herstellen: die
-- Kompatibilitaets-Trigger aus Phase 2/4.1 spiegeln jeden Legacy-Schreib-
-- vorgang sofort in job_assignments (Richtung A) und leiten umgekehrt den
-- Zeiger aus der Menge ab (Richtung B). Fuer die Dauer des Fixtures werden
-- beide Richtungen deshalb stillgelegt und danach wieder aktiviert.
alter table public.jobs            disable trigger compat_sync_assignments_from_legacy_upd;
alter table public.job_assignments disable trigger compat_sync_legacy_from_assignments_trg;

update public.jobs set assigned_to='f2000000-0000-0000-0000-000000000002'
where id='f4000000-0000-0000-0000-000000000004';

alter table public.jobs            enable trigger compat_sync_assignments_from_legacy_upd;
alter table public.job_assignments enable trigger compat_sync_legacy_from_assignments_trg;

-- INAKTIV wird jetzt deaktiviert — Zuweisung bleibt bestehen.
update public.profiles set is_active=false where id='f2000000-0000-0000-0000-000000000007';


-- CASE 0: Ausgangslage — Zeiger und Mengen sitzen wie beabsichtigt
do $$
declare v text;
begin
  select 'j1_legacy='||coalesce((select assigned_to::text from public.jobs where id='f4000000-0000-0000-0000-000000000001'),'NULL')
       ||'/j1_anzahl='||(select count(*)::text from public.job_assignments where job_id='f4000000-0000-0000-0000-000000000001')
       ||'/j4_legacy='||coalesce((select assigned_to::text from public.jobs where id='f4000000-0000-0000-0000-000000000004'),'NULL')
       ||'/j4_anzahl='||(select count(*)::text from public.job_assignments where job_id='f4000000-0000-0000-0000-000000000004')
    into v;
  insert into _r values (0,'Ausgangslage: J1 Primaer=AHMED mit 2 Zuweisungen, J4 nur Legacy-Zeiger ohne Zuweisung',
    'j1_legacy=f2000000-0000-0000-0000-000000000002/j1_anzahl=2/j4_legacy=f2000000-0000-0000-0000-000000000002/j4_anzahl=0', v);
  raise notice 'CASE 0 -> %', v;
end $$;


-- =========================================================
-- A. SZENARIO 1 — Ahmed startet 08:00, Mohammed schliesst 10:00 ab
-- =========================================================

-- CASE 1: AHMED (Legacy-Primaer) startet. Setzt started_at UND started_by.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000001',
                                 timestamptz '2026-07-31 08:00+00');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status
       ||'/start='||coalesce(to_char(j.started_at at time zone 'UTC','HH24:MI'),'NULL')
       ||'/start_by='||coalesce(j.started_by::text,'NULL')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000001';

  insert into _r values (1,'AHMED startet J1 -> in_progress, started_at + started_by gesetzt',
    'OK/status=in_progress/start=08:00/start_by=f2000000-0000-0000-0000-000000000002', v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2: MOHAMMED sieht den laufenden Auftrag und dieselbe Startzeit.
-- (Die Anforderung "jeder Zugewiesene sieht sofort: Job in Arbeit".)
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'status='||status||'/start='||to_char(started_at at time zone 'UTC','HH24:MI') into v
  from public.jobs where id='f4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (2,'MOHAMMED sieht J1 als laufend mit AHMEDs Startzeit',
    'status=in_progress/start=08:00', v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3: KERN DER PHASE — MOHAMMED (sekundaer, hat NICHT gestartet)
-- schliesst ab. Vor der Migration: "Job not found or not allowed".
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000001',
                                    timestamptz '2026-07-31 10:00+00');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status
       ||'/ende='||coalesce(to_char(j.completed_at at time zone 'UTC','HH24:MI'),'NULL')
       ||'/ende_by='||coalesce(j.completed_by::text,'NULL')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000001';

  insert into _r values (3,'MOHAMMED (sekundaer) schliesst J1 ab -> completed_at + completed_by gesetzt',
    'OK/status=completed/ende=10:00/ende_by=f2000000-0000-0000-0000-000000000003', v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4: DIE GETEILTE UHR — genau EINE Dauer, und beide Akteure stehen
-- unterschiedlich in der Zeile. Kein Pro-Mitarbeiter-Timer entstanden.
do $$
declare v text;
begin
  select 'dauer_min='||(extract(epoch from (j.completed_at - j.started_at))/60)::int::text
       ||'/verschiedene_akteure='||(j.started_by is distinct from j.completed_by)::text
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000001';
  insert into _r values (4,'J1 hat GENAU EINE offizielle Dauer (120 Min) mit zwei verschiedenen Akteuren',
    'dauer_min=120/verschiedene_akteure=true', v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- CASE 5: STUNDENZETTEL-PRAEDIKAT — beide Mitarbeiter erhalten 08:00–10:00.
-- Exakt die Abfrage aus services/timesheets/timesheet.service.ts
-- (job_assignments-Inner-Join, status=completed, job_type=single).
-- Nachweis, dass PR #58 unveraendert weiterarbeitet: der Mitarbeiter, der
-- Start NIE gedrueckt hat, bekommt dieselbe Zeit wie der Starter.
do $$
declare v text;
begin
  select string_agg(x.eintrag, ' | ' order by x.eintrag) into v
  from (
    select p.full_name||'='
           ||to_char(j.started_at   at time zone 'UTC','HH24:MI')||'-'
           ||to_char(j.completed_at at time zone 'UTC','HH24:MI') as eintrag
    from public.jobs j
    join public.job_assignments ja on ja.job_id = j.id
    join public.profiles p         on p.id      = ja.employee_id
    where j.id = 'f4000000-0000-0000-0000-000000000001'
      and j.status   = 'completed'
      and j.job_type = 'single'
      and j.started_at   is not null
      and j.completed_at is not null
  ) x;
  insert into _r values (5,'Stundenzettel: BEIDE Zugewiesenen erhalten die geteilte Zeit 08:00-10:00',
    'Ahmed Start=08:00-10:00 | Mohammed Ende=08:00-10:00', v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6: NIEMAND KANN ZWEIMAL ABSCHLIESSEN. AHMED versucht es nach
-- MOHAMMED: idempotenter No-Op, MOHAMMEDs Endzeit und Akteur bleiben.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000001',
                                    timestamptz '2026-07-31 23:00+00');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/ende='||to_char(j.completed_at at time zone 'UTC','HH24:MI')
       ||'/ende_by='||coalesce(j.completed_by::text,'NULL')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000001';

  insert into _r values (6,'Zweiter Abschluss ist No-Op: Endzeit und Akteur bleiben bei MOHAMMED/10:00',
    'OK/ende=10:00/ende_by=f2000000-0000-0000-0000-000000000003', v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: Genau EIN job_completed-Outbox-Event (keine Doppel-
-- Benachrichtigung durch den zweiten Versuch).
do $$
declare v text;
begin
  select 'gestartet='||count(*) filter (where event_type='job_started')::text
       ||'/abgeschlossen='||count(*) filter (where event_type='job_completed')::text
       -- ORDER BY explizit: DISTINCT sortiert in der Praxis, garantiert ist
       -- das aber nicht — ein Test darf nicht von Implementierungsdetails
       -- der Aggregation abhaengen.
       ||'/akteure='||coalesce(string_agg(distinct employee_name, ',' order by employee_name),'-')
    into v
  from public.notification_outbox
  where job_id='f4000000-0000-0000-0000-000000000001';
  insert into _r values (7,'Je Uebergang genau EIN Outbox-Event, jeweils mit dem tatsaechlichen Akteur',
    'gestartet=1/abgeschlossen=1/akteure=Ahmed Start,Mohammed Ende', v);
  raise notice 'CASE 7 -> %', v;
end $$;


-- =========================================================
-- B. SZENARIO 2 — Gegenrichtung: der sekundaere startet
-- =========================================================

-- CASE 8: An J2 ist MOHAMMED der Legacy-Primaer. AHMED (sekundaer) startet.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000002',
                                 timestamptz '2026-07-31 09:00+00');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status||'/start_by='||coalesce(j.started_by::text,'NULL')
       ||'/legacy='||coalesce(j.assigned_to::text,'NULL')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000002';

  insert into _r values (8,'Sekundaerer AHMED startet J2; der Legacy-Zeiger bleibt unveraendert bei MOHAMMED',
    'OK/status=in_progress/start_by=f2000000-0000-0000-0000-000000000002/legacy=f2000000-0000-0000-0000-000000000003', v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9: NIEMAND KANN ZWEIMAL STARTEN. MOHAMMED versucht es danach:
-- No-Op, er erhaelt AHMEDs geteilte Startzeit zurueck (nicht die eigene).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    select 'rueckgabe='||to_char(
             public.start_own_job('f4000000-0000-0000-0000-000000000002',
                                  timestamptz '2026-07-31 11:30+00') at time zone 'UTC','HH24:MI')
      into v;
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/start='||to_char(j.started_at at time zone 'UTC','HH24:MI')
       ||'/start_by='||coalesce(j.started_by::text,'NULL')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000002';

  insert into _r values (9,'Zweiter Start ist No-Op und liefert die GETEILTE Startzeit des Ersten zurueck',
    'rueckgabe=09:00/start=09:00/start_by=f2000000-0000-0000-0000-000000000002', v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: Abschluss durch den Primaer MOHAMMED funktioniert weiterhin
-- (keine Regression fuer den bisher einzig Berechtigten).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000002',
                                    timestamptz '2026-07-31 12:00+00');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status||'/dauer_min='||(extract(epoch from (j.completed_at - j.started_at))/60)::int::text
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000002';

  insert into _r values (10,'Primaerer MOHAMMED schliesst J2 ab (geteilte Dauer 180 Min)',
    'OK/status=completed/dauer_min=180', v);
  raise notice 'CASE 10 -> %', v;
end $$;


-- =========================================================
-- C. SZENARIO 3 — nicht Zugewiesene bleiben aussen
-- =========================================================

-- CASE 11: FREMD A (Firma A, aber J6 nicht zugewiesen) kann nicht starten.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000006');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (11,'Nicht zugewiesener Mitarbeiter derselben Firma kann NICHT starten','ABGELEHNT',v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- CASE 12: und auch nicht abschliessen (J2 laeuft/ist fertig, er ist nicht
-- zugewiesen -> Ablehnung schon an der Berechtigung, nicht am Status).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000002');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (12,'Nicht zugewiesener Mitarbeiter kann NICHT abschliessen','ABGELEHNT',v);
  raise notice 'CASE 12 -> %', v;
end $$;

-- CASE 13: Mitarbeiter der FREMDEN Firma kann den Firma-A-Auftrag nicht
-- starten (Firmengrenze, doppelt gesichert: RPC + is_assigned_to_job).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000006');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000006');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (13,'Mitarbeiter einer FREMDEN Firma kann nicht starten','ABGELEHNT',v);
  raise notice 'CASE 13 -> %', v;
end $$;

-- CASE 14: DEAKTIVIERTES Konto kann seinen zugewiesenen Auftrag nicht
-- starten (current_user_role()/company_id sind NULL, is_assigned_to_job
-- liefert false).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000007');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000006');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (14,'Deaktivierter Mitarbeiter kann seinen zugewiesenen Auftrag NICHT starten','ABGELEHNT',v);
  raise notice 'CASE 14 -> %', v;
end $$;

-- CASE 15: der ADMIN der eigenen Firma kann ebenfalls nicht ueber die RPC
-- starten (role='employee' bleibt Bedingung — Admins aendern den Status
-- nie hierueber).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000006');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (15,'Admin kann nicht ueber start_own_job starten','ABGELEHNT',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16: J6 ist nach allen Fehlversuchen unveraendert offen.
do $$
declare v text;
begin
  select 'status='||status
       ||'/start='||coalesce(started_at::text,'NULL')
       ||'/start_by='||coalesce(started_by::text,'NULL')
    into v
  from public.jobs where id='f4000000-0000-0000-0000-000000000006';
  insert into _r values (16,'J6 bleibt nach allen abgelehnten Versuchen unberuehrt offen',
    'status=open/start=NULL/start_by=NULL', v);
  raise notice 'CASE 16 -> %', v;
end $$;


-- =========================================================
-- D. SZENARIO 4 — Recurring-Parent bleibt nicht ausfuehrbar
-- =========================================================

-- CASE 17: MOHAMMED ist der Parent-REGEL J3 zugewiesen (Vorlage, Phase 4).
-- is_assigned_to_job() liefert dafuer true — job_type='single' steht
-- deshalb bewusst AUSSERHALB der ODER-Klammer. Ohne das waere eine
-- Regel ab jetzt startbar.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000003');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (17,'Zugewiesener kann eine RECURRING-PARENT-Regel NICHT starten','ABGELEHNT',v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- CASE 18: Gegenprobe, dass CASE 17 nicht an der Zuweisung scheiterte:
-- is_assigned_to_job() bestaetigt fuer MOHAMMED die Parent-Regel.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'zugewiesen='||public.is_assigned_to_job('f4000000-0000-0000-0000-000000000003')::text into v;
  execute 'reset role';
  insert into _r values (18,'Gegenprobe: MOHAMMED IST der Parent-Regel zugewiesen (Ablehnung kam von job_type)',
    'zugewiesen=true', v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- CASE 19: die Parent-Regel ist unveraendert offen geblieben.
do $$
declare v text;
begin
  select 'status='||status||'/start='||coalesce(started_at::text,'NULL') into v
  from public.jobs where id='f4000000-0000-0000-0000-000000000003';
  insert into _r values (19,'Parent-Regel J3 bleibt unberuehrt offen','status=open/start=NULL',v);
  raise notice 'CASE 19 -> %', v;
end $$;


-- =========================================================
-- E. Bestandsfall: nur Legacy-Zeiger, keine Zuweisungszeile
-- =========================================================

-- CASE 20: AHMED darf J4 starten, obwohl KEINE job_assignments-Zeile
-- existiert. Genau dafuer bleibt der Legacy-Zweig in der ODER-Klammer —
-- ein Ersetzen statt Erweitern haette diesen Mitarbeitern den Start
-- entzogen.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000004',
                                 timestamptz '2026-07-31 07:00+00');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status||'/start_by='||coalesce(j.started_by::text,'NULL')
       ||'/anzahl_zuweisungen='||(select count(*)::text from public.job_assignments where job_id=j.id)
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000004';

  insert into _r values (20,'Legacy-Primaer ohne Zuweisungszeile kann weiterhin starten (Bestandsschutz)',
    'OK/status=in_progress/start_by=f2000000-0000-0000-0000-000000000002/anzahl_zuweisungen=0', v);
  raise notice 'CASE 20 -> %', v;
end $$;

-- CASE 21: MOHAMMED darf J4 NICHT abschliessen — an diesem Auftrag ist er
-- weder Primaer noch zugewiesen. Beide Zweige der Klammer sind falsch.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000004');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (21,'An einem Auftrag ohne eigene Zuweisung bleibt MOHAMMED abgewiesen','ABGELEHNT',v);
  raise notice 'CASE 21 -> %', v;
end $$;


-- =========================================================
-- F. Zustandsuebergaenge: kein Abschluss ohne Start
-- =========================================================

-- CASE 22: J6 ist offen. Ein zugewiesener Mitarbeiter darf NICHT
-- abschliessen, ohne dass gestartet wurde — ohne Startzeit gaebe es keine
-- Dauer, und ein stiller Erfolg wuerde einen Auftrag ohne Arbeitszeit als
-- abgeschlossen fuehren. (Bewusst unveraendertes Bestandsverhalten.)
-- Zuweisung dafuer auf den aktiven AHMED umstellen.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('f4000000-0000-0000-0000-000000000006',
    array['f2000000-0000-0000-0000-000000000002']::uuid[]);
  execute 'reset role';

  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000006');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';

  select v||'/status='||status||'/ende_by='||coalesce(completed_by::text,'NULL') into v
  from public.jobs where id='f4000000-0000-0000-0000-000000000006';

  insert into _r values (22,'Abschluss eines NICHT gestarteten Auftrags wird abgelehnt (kein completed_by)',
    'ABGELEHNT/status=open/ende_by=NULL', v);
  raise notice 'CASE 22 -> %', v;
end $$;

-- CASE 23: Neustart eines abgeschlossenen Auftrags aendert nichts (J1 ist
-- completed). Wichtig, weil der Start-Zweig completed_at/completed_by
-- nullen WUERDE, wenn er greifen koennte — die Statusbedingung 'open'
-- verhindert genau das.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000001',
                                 timestamptz '2026-08-01 06:00+00');
    v := 'OK(No-Op)';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status
       ||'/start='||to_char(j.started_at   at time zone 'UTC','HH24:MI')
       ||'/ende='||to_char(j.completed_at at time zone 'UTC','HH24:MI')
       ||'/ende_by='||coalesce(j.completed_by::text,'NULL')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000001';

  insert into _r values (23,'Start auf einem abgeschlossenen Auftrag ist No-Op und nullt den Abschluss NICHT',
    'OK(No-Op)/status=completed/start=08:00/ende=10:00/ende_by=f2000000-0000-0000-0000-000000000003', v);
  raise notice 'CASE 23 -> %', v;
end $$;


-- =========================================================
-- G. Was diese Phase ausdruecklich NICHT anfasst
-- =========================================================

-- CASE 24: job_assignments ist unberuehrt — keine Anwesenheitserfassung.
-- attendance bleibt 'assigned', die Audit-Zeitstempel bleiben NULL, und
-- counts_for_timesheet (generiert daraus) bleibt false. Der Stundenzettel
-- filtert bewusst NICHT darauf (siehe PR #58 und CASE 5).
do $$
declare v text;
begin
  select 'attendance='||string_agg(distinct ja.attendance::text,',' order by ja.attendance::text)
       ||'/emp_start_gesetzt='||count(*) filter (where ja.employee_started_at is not null)::text
       ||'/emp_ende_gesetzt='||count(*) filter (where ja.employee_completed_at is not null)::text
       ||'/counts='||string_agg(distinct ja.counts_for_timesheet::text,',' order by ja.counts_for_timesheet::text)
    into v
  from public.job_assignments ja
  where ja.job_id in ('f4000000-0000-0000-0000-000000000001','f4000000-0000-0000-0000-000000000002');
  insert into _r values (24,'KEINE Anwesenheitserfassung: attendance/Audit-Stempel/counts_for_timesheet unveraendert',
    'attendance=assigned/emp_start_gesetzt=0/emp_ende_gesetzt=0/counts=false', v);
  raise notice 'CASE 24 -> %', v;
end $$;

-- CASE 25: der Kommentar-Schreibpfad bleibt am Legacy-Primaer. MOHAMMED
-- darf J1 abschliessen (CASE 3), aber weiterhin keinen Kommentar anlegen —
-- diese INSERT-Policy ist NICHT Teil dieser Phase. Der Client gated das
-- Eingabefeld entsprechend (isPrimaryAssignee), es entsteht also kein
-- Button, der fehlschlaegt.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    insert into public.job_comments (company_id, job_id, author_id, message)
    values ('f1000000-0000-0000-0000-000000000001','f4000000-0000-0000-0000-000000000001',
            'f2000000-0000-0000-0000-000000000003','Test');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (25,'Kommentar-INSERT bleibt fuer den Sekundaeren abgelehnt (bewusste Asymmetrie)','ABGELEHNT',v);
  raise notice 'CASE 25 -> %', v;
end $$;

-- CASE 26: Mitarbeiter haben weiterhin KEIN direktes UPDATE auf jobs — der
-- Statuswechsel bleibt auf die zwei RPC-Uebergaenge beschraenkt. Geprueft
-- ueber die Zeilenwirkung (die Employee-Policy erlaubt nur SELECT, ein
-- UPDATE trifft daher 0 Zeilen).
do $$
declare betroffen int; v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    update public.jobs set customer_name='Gekapert'
    where id='f4000000-0000-0000-0000-000000000001';
    get diagnostics betroffen = row_count;
    v := 'zeilen='||betroffen::text;
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';

  select v||'/kunde='||customer_name into v
  from public.jobs where id='f4000000-0000-0000-0000-000000000001';

  insert into _r values (26,'Mitarbeiter kann jobs nicht direkt aendern (kein neues UPDATE-Recht)',
    'zeilen=0/kunde=K1', v);
  raise notice 'CASE 26 -> %', v;
end $$;


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _r order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _r where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'SHARED JOB TIME TEST: % Fall/Faelle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE 27 FAELLE PASS';
end $$;

rollback;
