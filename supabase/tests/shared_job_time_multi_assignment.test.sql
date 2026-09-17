-- =========================================================
-- TEST: Shared Job Time — Start/Abschluss fuer JEDEN Zugewiesenen
-- (Migration 20260731000000_shared_job_time_multi_assignment)
-- =========================================================
-- ÜBERARBEITET 2026-09-17 fuer Phase 16 (Migration 20260917000000).
--
-- Was sich aendert und warum — die urspruengliche Kernaussage dieser Suite
-- war: "JEDER Zugewiesene darf abschliessen, auch ohne selbst gestartet zu
-- haben" (geteilte Job-Uhr, ein einzelner Akteur schliesst den GANZEN
-- Auftrag ab). GENAU DAS hat Phase 16 bewusst abgeschafft — es war die
-- nachgewiesene Ursache des Vorfalls vom 2026-09-16 (Employee A startet,
-- Employee B schliesst ab, ohne je selbst gestartet zu haben).
--
-- Diese Fassung testet deshalb die AKTUALISIERTE, aber gleichwertige
-- Kernaussage:
--   1. JEDER Zugewiesene darf starten UND abschliessen — aber Abschliessen
--      verlangt seit Phase 16 den EIGENEN Start (Rolle 4). Ein Sekundaerer
--      OHNE eigenen Start wird jetzt explizit abgewiesen (neuer Fall).
--   2. Die geteilte Job-Uhr existiert weiterhin genau EINMAL pro Auftrag
--      (jobs.started_at/completed_at) — aber sie wird jetzt erst gesetzt,
--      wenn ALLE aktuellen Zuweisungen ihre EIGENE Teilnahme abgeschlossen
--      haben (Phase-16-Aggregation). Start bleibt "der Erste gewinnt";
--      Abschluss ist jetzt "der LETZTE schliesst den Auftrag".
--   3. Es geht dabei KEINE der urspruenglichen Grenzen auf: nicht
--      Zugewiesene, fremde Firmen, deaktivierte Konten, Admins und
--      Recurring-Parent-Regeln bleiben abgewiesen; ein zweiter eigener
--      Abschluss aendert nichts (Idempotenz bleibt erhalten, jetzt pro
--      Mitarbeiter statt pro Auftrag).
--
-- Zeitstempel sind jetzt RELATIV zu now() (statt fixer 2026-07-31-Literale),
-- damit sie innerhalb von Phase 16s 12-Stunden-Vertrauensfenster bleiben.
-- Mehrere Start-Aufrufe auf DEMSELBEN Auftrag verwenden bewusst denselben
-- Anker-Zeitstempel (nicht nur "nah beieinander") — das macht das Ergebnis
-- unabhaengig davon, ob die Suite kurz vor oder nach Mitternacht (Europe/
-- Berlin) laeuft: derselbe Ausdruck kann innerhalb einer Transaktion nicht
-- auf zwei verschiedene Kalendertage fallen, da now() transaktionsweit
-- konstant ist.
--
-- Alle Zugriffe laufen als echte Rollen (SET ROLE + request.jwt.claims),
-- also ueber denselben Pfad wie die App ueber PostgREST.
--
-- HINWEIS ZU „VERWEIGERT"-PFADEN: wie in job_assignments_rls.test.sql
-- begruendet, stuerzt der lokale Supabase-Container bei einem
-- permission-denied-Fehler ab. Dieser Test loest keine solchen Fehler aus —
-- alle Ablehnungen kommen aus dem FUNKTIONSKOERPER der RPCs (RAISE
-- EXCEPTION) bzw. aus RLS, nicht aus fehlenden Privilegien.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende, keine
-- Produktionsdaten.
-- =========================================================

begin;

-- ── Fixdaten (unveraendert gegenueber der Vorfassung) ──
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

-- companies.timezone bekommt keinen expliziten Wert — der Spalten-Default
-- 'Europe/Berlin' greift, exakt die Zeitzone, gegen die Phase 16 rechnet.
insert into public.companies (id,name,slug) values
  ('f1000000-0000-0000-0000-000000000001','Shared Firma A','shared-firma-a-test'),
  ('f1000000-0000-0000-0000-000000000002','Shared Firma B','shared-firma-b-test');

update public.profiles set company_id='f1000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='f2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='f1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id in
  ('f2000000-0000-0000-0000-000000000002','f2000000-0000-0000-0000-000000000003','f2000000-0000-0000-0000-000000000004','f2000000-0000-0000-0000-000000000007');
update public.profiles set company_id='f1000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='f2000000-0000-0000-0000-000000000005';
update public.profiles set company_id='f1000000-0000-0000-0000-000000000002', role='employee', is_active=true where id='f2000000-0000-0000-0000-000000000006';

-- Geschaeftsdatum eines Zeitpunkts in Europe/Berlin — fuer jobs.date, damit
-- Start-Aufrufe die Phase-16-Terminpruefung bestehen.
create or replace function pg_temp.bdate(p timestamptz) returns date language sql as $f$
  select (p at time zone 'Europe/Berlin')::date;
$f$;

-- Anker fuer J1 ("Szenario 1"): Ahmeds Start. J1.date wird DIREKT hieraus
-- abgeleitet (siehe unten) — Mohammeds spaeterer eigener Start verwendet
-- denselben Anker, nicht einen zeitlich versetzten, damit beide garantiert
-- denselben Kalendertag treffen.
-- Anker fuer J2 ("Szenario 2", Gegenrichtung): Ahmeds Start dort.
do $$ begin
  -- true = transaktionslokal (wie act_as() unten) — darf auf einer gepoolten
  -- Verbindung niemals ueber das abschliessende ROLLBACK hinaus bestehen.
  perform set_config('phase16_test.anchor_j1', (now() - interval '4 hours')::text, true);
  perform set_config('phase16_test.anchor_j2', (now() - interval '5 hours')::text, true);
end $$;

-- Auftraege (alle Firma A, ausser J5):
--   J1 = single, {AHMED, MOHAMMED}      -> Hauptszenario (A startet, beide schliessen eigenen Teil ab)
--   J2 = single, {MOHAMMED, AHMED}      -> Gegenrichtung (Szenario 2)
--   J3 = RECURRING-PARENT, {MOHAMMED}   -> darf NIE startbar sein
--   J4 = single, NUR Legacy-Zeiger      -> Bestandsfall ohne Zuweisungszeile
--   J5 = single, Firma B, {Employee B}  -> Firmengrenze
--   J6 = single, {INAKTIV}              -> deaktiviertes Konto
insert into public.jobs (id, company_id, assigned_to, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time, recurring_days,
                         is_active, created_at, updated_at, parent_job_id) values
  ('f4000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000001',null,'f2000000-0000-0000-0000-000000000001','K1','S1','O1','open','single',pg_temp.bdate(current_setting('phase16_test.anchor_j1')::timestamptz),'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('f4000000-0000-0000-0000-000000000002','f1000000-0000-0000-0000-000000000001',null,'f2000000-0000-0000-0000-000000000001','K2','S2','O2','open','single',pg_temp.bdate(current_setting('phase16_test.anchor_j2')::timestamptz),'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
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
-- A. SZENARIO 1 — Ahmed startet, BEIDE schliessen ihre eigene Teilnahme ab
-- =========================================================
-- Reihenfolge bewusst so gewaehlt, dass Ahmed startet aber Mohammed als
-- LETZTER abschliesst (schliesst den Auftrag) — das erhaelt die
-- urspruengliche Aussage "verschiedene Akteure fuer Start und Abschluss"
-- unter der neuen Regel, die fuer JEDEN Akteur einen eigenen Start verlangt.

-- CASE 1: AHMED (Legacy-Primaer) startet. Setzt started_at UND started_by.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000001',
                                 current_setting('phase16_test.anchor_j1')::timestamptz);
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status
       ||'/start_by='||coalesce(j.started_by::text,'NULL')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000001';

  insert into _r values (1,'AHMED startet J1 -> in_progress, started_by gesetzt',
    'OK/status=in_progress/start_by=f2000000-0000-0000-0000-000000000002', v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2: MOHAMMED sieht den laufenden Auftrag mit Ahmeds Startzeit.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'status='||status||'/start_gleich_anker='||(started_at = current_setting('phase16_test.anchor_j1')::timestamptz)::text
    into v
  from public.jobs where id='f4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (2,'MOHAMMED sieht J1 als laufend mit AHMEDs Startzeit',
    'status=in_progress/start_gleich_anker=true', v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3 — KERN VON PHASE 16: MOHAMMED (hat NICHT selbst gestartet) versucht
-- abzuschliessen. Das MUSS jetzt abgelehnt werden — die alte Erwartung
-- ("Sekundaerer darf ohne eigenen Start abschliessen") ist genau die Regel,
-- die Phase 16 wegen des Vorfalls vom 2026-09-16 abgeschafft hat.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000001',
                                    current_setting('phase16_test.anchor_j1')::timestamptz + interval '2 hours');
    v := 'AKZEPTIERT';
  exception when others then
    v := case when sqlerrm like '%zuerst selbst starten%' then 'ABGELEHNT_OHNE_START' else 'ABGELEHNT_ANDERS: '||sqlerrm end;
  end;
  execute 'reset role';
  insert into _r values (3,'PHASE 16: MOHAMMED kann OHNE eigenen Start nicht mehr abschliessen',
    'ABGELEHNT_OHNE_START', v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4: MOHAMMED startet jetzt seine EIGENE Teilnahme (Auftrag laeuft
-- bereits -> idempotenter Nachzuegler-Zweig, stempelt trotzdem seine eigene
-- Startzeit). Derselbe Anker wie Ahmeds Start — siehe Kopf-Kommentar.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000001',
                                 current_setting('phase16_test.anchor_j1')::timestamptz);
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/eigener_start_gesetzt='||(employee_started_at is not null)::text into v
  from public.job_assignments
  where job_id='f4000000-0000-0000-0000-000000000001' and employee_id='f2000000-0000-0000-0000-000000000003';

  insert into _r values (4,'MOHAMMED startet danach seine EIGENE Teilnahme (Nachzuegler-Zweig)',
    'OK/eigener_start_gesetzt=true', v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- CASE 5: AHMED schliesst seine EIGENE Teilnahme zuerst ab — der AUFTRAG
-- bleibt trotzdem in_progress, weil MOHAMMEDs Teilnahme noch ungeloest ist
-- (Phase-16-Aggregation: der Auftrag schliesst erst, wenn ALLE abgeschlossen
-- haben).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000001',
                                    current_setting('phase16_test.anchor_j1')::timestamptz + interval '2 hours');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status||'/eigener_ende_ahmed='||(ja.employee_completed_at is not null)::text
    into v
  from public.jobs j
  join public.job_assignments ja on ja.job_id=j.id and ja.employee_id='f2000000-0000-0000-0000-000000000002'
  where j.id='f4000000-0000-0000-0000-000000000001';

  insert into _r values (5,'AHMED schliesst eigene Teilnahme ab -> AUFTRAG bleibt in_progress (MOHAMMED noch offen)',
    'OK/status=in_progress/eigener_ende_ahmed=true', v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6: MOHAMMED schliesst als LETZTER seine eigene Teilnahme ab -> JETZT
-- schliesst der AUFTRAG, mit MOHAMMED als completed_by (anderer Akteur als
-- started_by=AHMED — die urspruengliche Aussage bleibt damit erhalten).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000001',
                                    current_setting('phase16_test.anchor_j1')::timestamptz + interval '2 hours');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status
       ||'/ende_by='||coalesce(j.completed_by::text,'NULL')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000001';

  insert into _r values (6,'MOHAMMED schliesst als LETZTER ab -> AUFTRAG completed, completed_by=MOHAMMED',
    'OK/status=completed/ende_by=f2000000-0000-0000-0000-000000000003', v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: DIE GETEILTE UHR — genau EINE Dauer (120 Min), zwei verschiedene
-- Akteure fuer Start (AHMED) und Auftragsabschluss (MOHAMMED).
do $$
declare v text;
begin
  select 'dauer_min='||(extract(epoch from (j.completed_at - j.started_at))/60)::int::text
       ||'/verschiedene_akteure='||(j.started_by is distinct from j.completed_by)::text
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000001';
  insert into _r values (7,'J1 hat GENAU EINE offizielle Dauer (120 Min) mit zwei verschiedenen Akteuren',
    'dauer_min=120/verschiedene_akteure=true', v);
  raise notice 'CASE 7 -> %', v;
end $$;

-- CASE 8: Stundenzettel-Praedikat (geteilte Uhr) — beide Zugewiesenen
-- erhalten dieselbe geteilte Zeit, unabhaengig von ihrer EIGENEN Zeit.
-- Exakt die Abfrage aus services/timesheets/timesheet.service.ts fuer den
-- Legacy-Fallback-Pfad (job_assignments-Inner-Join, status=completed,
-- job_type=single) — bewusst weiterhin als Nachweis, dass die geteilte Uhr
-- selbst unveraendert genau EINE Dauer traegt.
do $$
declare v text;
begin
  select string_agg(distinct x.gleich_dauer::text, ',' order by x.gleich_dauer::text) into v
  from (
    select (j.completed_at - j.started_at) = interval '120 minutes' as gleich_dauer
    from public.jobs j
    join public.job_assignments ja on ja.job_id = j.id
    join public.profiles p         on p.id      = ja.employee_id
    where j.id = 'f4000000-0000-0000-0000-000000000001'
      and j.status   = 'completed'
      and j.job_type = 'single'
      and j.started_at   is not null
      and j.completed_at is not null
  ) x;
  insert into _r values (8,'Stundenzettel-Praedikat: BEIDE Zugewiesenen erhalten dieselbe geteilte Dauer',
    'true', v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9: NIEMAND KANN DIE EIGENE TEILNAHME ZWEIMAL ABSCHLIESSEN. AHMED
-- wiederholt SEINE EIGENE Vervollstaendigung: idempotenter No-Op, seine
-- eigene Endzeit bleibt unveraendert, der Auftrag bleibt completed (keine
-- Wiedereroeffnung, kein zweites Event).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000001',
                                    current_setting('phase16_test.anchor_j1')::timestamptz + interval '2 hours');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/eigenes_ende_unveraendert='||
       (employee_completed_at = current_setting('phase16_test.anchor_j1')::timestamptz + interval '2 hours')::text
    into v
  from public.job_assignments
  where job_id='f4000000-0000-0000-0000-000000000001' and employee_id='f2000000-0000-0000-0000-000000000002';

  insert into _r values (9,'AHMED wiederholt eigenen Abschluss: idempotenter No-Op, eigene Endzeit unveraendert',
    'OK/eigenes_ende_unveraendert=true', v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: Genau EIN job_started + EIN job_completed Outbox-Event (keine
-- Doppel-Benachrichtigung durch Mohammeds eigenen Start-Nachzuegler-Aufruf
-- oder Ahmeds wiederholten Abschluss).
do $$
declare v text;
begin
  select 'gestartet='||count(*) filter (where event_type='job_started')::text
       ||'/abgeschlossen='||count(*) filter (where event_type='job_completed')::text
       ||'/abschluss_akteur='||coalesce(string_agg(distinct employee_name, ',') filter (where event_type='job_completed'),'-')
    into v
  from public.notification_outbox
  where job_id='f4000000-0000-0000-0000-000000000001';
  insert into _r values (10,'Je Auftrag genau EIN job_started + EIN job_completed Event, Abschluss-Akteur=Mohammed',
    'gestartet=1/abgeschlossen=1/abschluss_akteur=Mohammed Ende', v);
  raise notice 'CASE 10 -> %', v;
end $$;


-- =========================================================
-- B. SZENARIO 2 — Gegenrichtung: der sekundaere startet zuerst,
--    der Primaere schliesst als LETZTER ab
-- =========================================================

-- CASE 11: An J2 ist MOHAMMED der Legacy-Primaer. AHMED (sekundaer) startet.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000002',
                                 current_setting('phase16_test.anchor_j2')::timestamptz);
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status||'/start_by='||coalesce(j.started_by::text,'NULL')
       ||'/legacy='||coalesce(j.assigned_to::text,'NULL')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000002';

  insert into _r values (11,'Sekundaerer AHMED startet J2; der Legacy-Zeiger bleibt unveraendert bei MOHAMMED',
    'OK/status=in_progress/start_by=f2000000-0000-0000-0000-000000000002/legacy=f2000000-0000-0000-0000-000000000003', v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- CASE 12: MOHAMMED "startet" danach ebenfalls (No-Op auf Auftragsebene,
-- aber PFLICHT fuer seine eigene spaetere Vervollstaendigung) — derselbe
-- Anker wie Ahmeds Start, liefert deshalb denselben Wert zurueck.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    select 'rueckgabe_gleich_anker='||(
             public.start_own_job('f4000000-0000-0000-0000-000000000002',
                                  current_setting('phase16_test.anchor_j2')::timestamptz)
             = current_setting('phase16_test.anchor_j2')::timestamptz
           )::text
      into v;
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/eigener_start_gesetzt='||(employee_started_at is not null)::text into v
  from public.job_assignments
  where job_id='f4000000-0000-0000-0000-000000000002' and employee_id='f2000000-0000-0000-0000-000000000003';

  insert into _r values (12,'MOHAMMED startet danach ebenfalls (Nachzuegler-Zweig, eigene Startzeit gesetzt)',
    'rueckgabe_gleich_anker=true/eigener_start_gesetzt=true', v);
  raise notice 'CASE 12 -> %', v;
end $$;

-- CASE 13: AHMED (sekundaer) schliesst seine eigene Teilnahme ZUERST ab —
-- der Auftrag bleibt in_progress (MOHAMMED noch offen).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000002',
                                    current_setting('phase16_test.anchor_j2')::timestamptz + interval '3 hours');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||status into v from public.jobs where id='f4000000-0000-0000-0000-000000000002';
  insert into _r values (13,'AHMED (sekundaer) schliesst eigene Teilnahme zuerst ab -> Auftrag bleibt in_progress',
    'OK/status=in_progress', v);
  raise notice 'CASE 13 -> %', v;
end $$;

-- CASE 14: Primaerer MOHAMMED schliesst als LETZTER ab -> Auftrag completed,
-- geteilte Dauer 180 Min (keine Regression fuer den vormals einzig
-- Berechtigten, jetzt zusaetzlich mit eigenem Start als Voraussetzung).
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('f4000000-0000-0000-0000-000000000002',
                                    current_setting('phase16_test.anchor_j2')::timestamptz + interval '3 hours');
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status||'/dauer_min='||(extract(epoch from (j.completed_at - j.started_at))/60)::int::text
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000002';

  insert into _r values (14,'Primaerer MOHAMMED schliesst als LETZTER ab (geteilte Dauer 180 Min)',
    'OK/status=completed/dauer_min=180', v);
  raise notice 'CASE 14 -> %', v;
end $$;


-- =========================================================
-- C. SZENARIO 3 — nicht Zugewiesene bleiben aussen (Phase 16 unveraendert:
--    diese Ablehnungen kommen aus der Berechtigungs-SELECT, VOR jeder
--    Termin-/Eigenstart-Pruefung)
-- =========================================================

-- CASE 15: FREMD A (Firma A, aber J6 nicht zugewiesen) kann nicht starten.
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
  insert into _r values (15,'Nicht zugewiesener Mitarbeiter derselben Firma kann NICHT starten','ABGELEHNT',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16: und auch nicht abschliessen (J2 laeuft/ist fertig, er ist nicht
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
  insert into _r values (16,'Nicht zugewiesener Mitarbeiter kann NICHT abschliessen','ABGELEHNT',v);
  raise notice 'CASE 16 -> %', v;
end $$;

-- CASE 17: Mitarbeiter der FREMDEN Firma kann den Firma-A-Auftrag nicht
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
  insert into _r values (17,'Mitarbeiter einer FREMDEN Firma kann nicht starten','ABGELEHNT',v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- CASE 18: DEAKTIVIERTES Konto kann seinen zugewiesenen Auftrag nicht
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
  insert into _r values (18,'Deaktivierter Mitarbeiter kann seinen zugewiesenen Auftrag NICHT starten','ABGELEHNT',v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- CASE 19: der ADMIN der eigenen Firma kann ebenfalls nicht ueber die RPC
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
  insert into _r values (19,'Admin kann nicht ueber start_own_job starten','ABGELEHNT',v);
  raise notice 'CASE 19 -> %', v;
end $$;

-- CASE 20: J6 ist nach allen Fehlversuchen unveraendert offen.
do $$
declare v text;
begin
  select 'status='||status
       ||'/start='||coalesce(started_at::text,'NULL')
       ||'/start_by='||coalesce(started_by::text,'NULL')
    into v
  from public.jobs where id='f4000000-0000-0000-0000-000000000006';
  insert into _r values (20,'J6 bleibt nach allen abgelehnten Versuchen unberuehrt offen',
    'status=open/start=NULL/start_by=NULL', v);
  raise notice 'CASE 20 -> %', v;
end $$;


-- =========================================================
-- D. SZENARIO 4 — Recurring-Parent bleibt nicht ausfuehrbar (unveraendert:
--    job_type='single' steht ausserhalb der ODER-Klammer und wird VOR jeder
--    Termin-/Eigenstart-Pruefung verlangt)
-- =========================================================

-- CASE 21: MOHAMMED ist der Parent-REGEL J3 zugewiesen (Vorlage, Phase 4).
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
  insert into _r values (21,'Zugewiesener kann eine RECURRING-PARENT-Regel NICHT starten','ABGELEHNT',v);
  raise notice 'CASE 21 -> %', v;
end $$;

-- CASE 22: Gegenprobe, dass CASE 21 nicht an der Zuweisung scheiterte.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'zugewiesen='||public.is_assigned_to_job('f4000000-0000-0000-0000-000000000003')::text into v;
  execute 'reset role';
  insert into _r values (22,'Gegenprobe: MOHAMMED IST der Parent-Regel zugewiesen (Ablehnung kam von job_type)',
    'zugewiesen=true', v);
  raise notice 'CASE 22 -> %', v;
end $$;

-- CASE 23: die Parent-Regel ist unveraendert offen geblieben.
do $$
declare v text;
begin
  select 'status='||status||'/start='||coalesce(started_at::text,'NULL') into v
  from public.jobs where id='f4000000-0000-0000-0000-000000000003';
  insert into _r values (23,'Parent-Regel J3 bleibt unberuehrt offen','status=open/start=NULL',v);
  raise notice 'CASE 23 -> %', v;
end $$;


-- =========================================================
-- E. Bestandsfall: nur Legacy-Zeiger, keine Zuweisungszeile
-- =========================================================

-- CASE 24: AHMED darf J4 starten, obwohl KEINE job_assignments-Zeile
-- existiert (Bestandsschutz). Eigener Anker, damit J4.date passt.
do $$
declare v_anchor timestamptz := now() - interval '6 hours';
declare v text;
begin
  update public.jobs set date = pg_temp.bdate(v_anchor) where id='f4000000-0000-0000-0000-000000000004';

  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000004', v_anchor);
    v := 'OK';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status||'/start_by='||coalesce(j.started_by::text,'NULL')
       ||'/anzahl_zuweisungen='||(select count(*)::text from public.job_assignments where job_id=j.id)
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000004';

  insert into _r values (24,'Legacy-Primaer ohne Zuweisungszeile kann weiterhin starten (Bestandsschutz)',
    'OK/status=in_progress/start_by=f2000000-0000-0000-0000-000000000002/anzahl_zuweisungen=0', v);
  raise notice 'CASE 24 -> %', v;
end $$;

-- CASE 25: MOHAMMED darf J4 NICHT abschliessen — an diesem Auftrag ist er
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
  insert into _r values (25,'An einem Auftrag ohne eigene Zuweisung bleibt MOHAMMED abgewiesen','ABGELEHNT',v);
  raise notice 'CASE 25 -> %', v;
end $$;


-- =========================================================
-- F. Zustandsuebergaenge
-- =========================================================

-- CASE 26: J6 ist offen. Abschluss ohne Start bleibt abgelehnt — hier sogar
-- doppelt begruendet (Status 'open' UND kein eigener Start), der Auftrag
-- wird ueber die Statuspruefung abgewiesen, bevor die Eigenstart-Pruefung
-- ueberhaupt erreicht wird. Zuweisung dafuer auf den aktiven AHMED
-- umstellen.
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

  insert into _r values (26,'Abschluss eines NICHT gestarteten Auftrags wird abgelehnt (kein completed_by)',
    'ABGELEHNT/status=open/ende_by=NULL', v);
  raise notice 'CASE 26 -> %', v;
end $$;

-- CASE 27: Neustart eines abgeschlossenen Auftrags aendert nichts (J1 ist
-- completed, siehe CASE 6). Derselbe Anker wie Ahmeds urspruenglicher
-- Start — schliesst jedes Risiko einer Terminablehnung durch Zeitversatz
-- kategorisch aus, unabhaengig davon, welche Uhrzeit "jetzt" gerade ist.
do $$
declare v text;
begin
  perform pg_temp.act_as('f2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('f4000000-0000-0000-0000-000000000001',
                                 current_setting('phase16_test.anchor_j1')::timestamptz);
    v := 'OK(No-Op)';
  exception when others then v := 'FEHLER: '||sqlerrm;
  end;
  execute 'reset role';

  select v||'/status='||j.status
       ||'/ende_by='||coalesce(j.completed_by::text,'NULL')
    into v
  from public.jobs j where j.id='f4000000-0000-0000-0000-000000000001';

  insert into _r values (27,'Neustart auf einem abgeschlossenen Auftrag ist No-Op und nullt den Abschluss NICHT',
    'OK(No-Op)/status=completed/ende_by=f2000000-0000-0000-0000-000000000003', v);
  raise notice 'CASE 27 -> %', v;
end $$;


-- =========================================================
-- G. Was diese Phase (7) ausdruecklich NICHT anfasst — jetzt im Licht von
--    Phase 16 aktualisiert
-- =========================================================

-- CASE 28: Worked-Time-Zeitstempel (Migration 20260812000000) UND
-- Phase-16-Eigenstart-Pflicht zusammen betrachtet: weil seit Phase 16
-- NIEMAND mehr abschliessen kann, ohne selbst gestartet zu haben, und BEIDE
-- Auftraege (J1, J2) vollstaendig auf 'completed' stehen, tragen jetzt ALLE
-- VIER betrachteten Zuweisungszeilen (AHMED/MOHAMMED je J1/J2) sowohl eine
-- eigene Start- als auch eine eigene Abschlusszeit — anders als vor Phase 16
-- (dort 4 Startzeiten, aber nur 3 Abschlusszeiten, weil ein Sekundaerer ohne
-- eigenen Start abschliessen durfte). Das ist keine Kuerzung, sondern die
-- direkte Konsequenz der neuen Regel. Die geteilte Job-Uhr auf jobs bleibt
-- davon unberuehrt (weiterhin GENAU EINE offizielle Dauer, siehe CASE 7/14).
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
  insert into _r values (28,'Phase 16: ALLE vier Zuweisungszeilen tragen jetzt eigenen Start UND eigenen Abschluss',
    'attendance=completed/emp_start_gesetzt=4/emp_ende_gesetzt=4/counts=true', v);
  raise notice 'CASE 28 -> %', v;
end $$;

-- CASE 29: der Kommentar-Schreibpfad ist von Phase 16 unberuehrt — MOHAMMED
-- (secondary) darf weiterhin kommentieren (seit 20260826000001).
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
  insert into _r values (29,'Kommentar-INSERT fuer den Sekundaeren bleibt erlaubt (Phase 16 unberuehrt)','AKZEPTIERT',v);
  raise notice 'CASE 29 -> %', v;
end $$;

-- CASE 30: Mitarbeiter haben weiterhin KEIN direktes UPDATE auf jobs — der
-- Statuswechsel bleibt auf die RPCs beschraenkt (Phase 16 unberuehrt).
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

  insert into _r values (30,'Mitarbeiter kann jobs nicht direkt aendern (kein neues UPDATE-Recht)',
    'zeilen=0/kunde=K1', v);
  raise notice 'CASE 30 -> %', v;
end $$;


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _r order by case_no;

do $$
declare fails int; gesamt int; liste text;
begin
  select count(*), count(*) filter (where ergebnis is distinct from erwartet) into gesamt, fails from _r;
  select coalesce(string_agg('#'||case_no||' '||beschreibung||' (erw='||erwartet||' ist='||coalesce(ergebnis,'NULL')||')', ' ;; ' order by case_no), '')
    into liste from _r where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'SHARED JOB TIME TEST: % von % FEHLGESCHLAGEN -> %', fails, gesamt, liste;
  end if;
  raise notice 'ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
