-- =========================================================
-- TEST: Employee-Lesezugriff ueber job_assignments
-- (Migration 20260730000000_employee_read_via_assignments)
-- =========================================================
-- Prueft, dass ein SEKUNDAERER Zugewiesener (also einer, der NICHT der von
-- der Kompatibilitaetsschicht bestimmte Legacy-Primaer ist) Auftrag,
-- Kommentare und Fotos LESEN darf — und dass dabei WEDER Schreibrechte
-- NOCH die Sichtbarkeit von Recurring-Parent-Regeln NOCH firmenfremde
-- Daten aufgehen.
--
-- Die Ungelesen-Kennzeichnung (get_unread_comment_job_ids) bleibt
-- ABSICHTLICH am Legacy-Primaer: sie haengt am Schreibpfad
-- job_comment_reads, der in dieser Lese-Phase nicht angefasst wird. Die
-- Faelle 12, 12b und 12c sichern genau diese Kopplung ab — sie ist der
-- Grund, warum ein blosses Erweitern der RPC einen dauerhaft haengenden
-- Ungelesen-Punkt erzeugt haette.
--
-- Alle Zugriffe laufen als echte Rollen (SET ROLE + request.jwt.claims),
-- also ueber denselben Pfad wie die App ueber PostgREST.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende, keine
-- Produktionsdaten. Ausfuehren lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/employee_read_via_assignments.test.sql
-- =========================================================

begin;

-- =========================================================
-- HINWEIS ZU „VERWEIGERT"-PFADEN
-- =========================================================
-- Wie in job_assignments_rls.test.sql ausfuehrlich begruendet: der lokale
-- Supabase-Container stuerzt bei einem permission-denied-Fehler ab. Alle
-- Verweigerungen in DIESEM Test laufen jedoch ueber RLS-POLICIES (nicht
-- ueber fehlende Privilegien) — ein Nutzer sieht schlicht keine Zeile
-- bzw. ein INSERT wird durch die WITH-CHECK-Klausel abgelehnt. Solche
-- Faelle loesen keinen permission-denied-Fehler aus und werden hier
-- deshalb durch echte Zugriffe geprueft.
-- =========================================================

-- ── Fixdaten ──
-- Firma A = e1…1 | Firma B = e1…2
-- Admin A  = e2…1
-- PRIMAER  = e2…2  (Legacy-Zeiger jobs.assigned_to zeigt auf ihn)
-- SEKUNDAER= e2…3  (nur ueber job_assignments zugewiesen)
-- FREMD A  = e2…4  (Firma A, diesem Auftrag NICHT zugewiesen)
-- Admin B  = e2…5 | Employee B = e2…6 (andere Firma)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000001','authenticated','authenticated','v-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000002','authenticated','authenticated','v-primaer@example.test','{"full_name":"Paula Primaer"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000003','authenticated','authenticated','v-sekundaer@example.test','{"full_name":"Simon Sekundaer"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000004','authenticated','authenticated','v-fremd@example.test','{"full_name":"Frida Fremd"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000005','authenticated','authenticated','v-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000006','authenticated','authenticated','v-b1@example.test','{"full_name":"Bea Fremdfirma"}');
end $$;

-- Der auth-Trigger handle_new_user ist in der lokalen Baseline nicht
-- enthalten — Profile werden deshalb explizit angelegt.
insert into public.profiles (id, full_name) values
  ('e2000000-0000-0000-0000-000000000001','Admin A'),
  ('e2000000-0000-0000-0000-000000000002','Paula Primaer'),
  ('e2000000-0000-0000-0000-000000000003','Simon Sekundaer'),
  ('e2000000-0000-0000-0000-000000000004','Frida Fremd'),
  ('e2000000-0000-0000-0000-000000000005','Admin B'),
  ('e2000000-0000-0000-0000-000000000006','Bea Fremdfirma')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('e1000000-0000-0000-0000-000000000001','Lese Firma A','lese-firma-a-test'),
  ('e1000000-0000-0000-0000-000000000002','Lese Firma B','lese-firma-b-test');

update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='e2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id in
  ('e2000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000004');
update public.profiles set company_id='e1000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='e2000000-0000-0000-0000-000000000005';
update public.profiles set company_id='e1000000-0000-0000-0000-000000000002', role='employee', is_active=true where id='e2000000-0000-0000-0000-000000000006';

-- Auftraege:
--   J1 = Firma A, single, spaeter {PRIMAER, SEKUNDAER}
--   J2 = Firma A, single, unzugewiesen (Kontrollgruppe)
--   J3 = Firma B, single, dortiger Mitarbeiter zugewiesen (Firmengrenze)
--   J4 = Firma A, RECURRING-PARENT — bekommt eine Zuweisung als Vorlage
--   J5 = Firma A, single, Occurrence von J4
insert into public.jobs (id, company_id, assigned_to, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time, recurring_days,
                         is_active, created_at, updated_at, parent_job_id) values
  ('e4000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',null,'e2000000-0000-0000-0000-000000000001','K1','S1','O1','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('e4000000-0000-0000-0000-000000000002','e1000000-0000-0000-0000-000000000001',null,'e2000000-0000-0000-0000-000000000001','K2','S2','O2','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('e4000000-0000-0000-0000-000000000003','e1000000-0000-0000-0000-000000000002',null,'e2000000-0000-0000-0000-000000000005','K3','S3','O3','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('e4000000-0000-0000-0000-000000000004','e1000000-0000-0000-0000-000000000001',null,'e2000000-0000-0000-0000-000000000001','K4','S4','O4','open','recurring',null,'08:00',array['mon'],true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('e4000000-0000-0000-0000-000000000005','e1000000-0000-0000-0000-000000000001',null,'e2000000-0000-0000-0000-000000000001','K5','S5','O5','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00','e4000000-0000-0000-0000-000000000004');

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;


-- =========================================================
-- Ausgangslage herstellen
-- =========================================================
-- WICHTIG fuer die Aussagekraft des gesamten Tests: der Legacy-Zeiger
-- muss DETERMINISTISCH auf PRIMAER stehen, damit SEKUNDAER wirklich der
-- nicht-primaere Fall ist. Phase 2 waehlt bei zeitgleichen Zuweisungen
-- ueber den zufaelligen id-Tiebreaker. Deshalb wird PRIMAER zuerst
-- gesetzt (Regel 1 von compat_primary_assignee behaelt einen gedeckten
-- Zeiger bei) und SEKUNDAER erst danach ergaenzt.
do $$
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  -- Schritt 1: nur PRIMAER -> Legacy-Zeiger steht eindeutig auf ihm.
  perform public.set_job_assignments('e4000000-0000-0000-0000-000000000001',
    array['e2000000-0000-0000-0000-000000000002']::uuid[]);
  -- Schritt 2: SEKUNDAER ergaenzen -> Zeiger bleibt auf PRIMAER.
  perform public.set_job_assignments('e4000000-0000-0000-0000-000000000001',
    array['e2000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000003']::uuid[]);
  -- Recurring-Parent bekommt SEKUNDAER als Vorlage (Phase 4).
  perform public.set_job_assignments('e4000000-0000-0000-0000-000000000004',
    array['e2000000-0000-0000-0000-000000000003']::uuid[]);
  execute 'reset role';
end $$;

-- Fremdfirmen-Auftrag J3 direkt verdrahten (kein RPC noetig, Admin B waere
-- ein zweiter Rollenwechsel ohne zusaetzlichen Erkenntnisgewinn).
insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
values ('e4000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000006','Bea Fremdfirma');

-- Kommentare und Fotos an J1 (vom Admin verfasst — eigene Kommentare
-- zaehlen nie als ungelesen, der Autor muss also ein anderer sein).
insert into public.job_comments (id, company_id, job_id, author_id, message, created_at) values
  ('e5000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','e4000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000001','Hinweis vom Admin', now());

insert into public.job_photos (id, company_id, job_id, uploaded_by, storage_path, file_name) values
  ('e6000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','e4000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-000000000001/e4000000-0000-0000-0000-000000000001/foto.jpg','foto.jpg');

-- CASE 0: Ausgangslage — Legacy-Zeiger steht auf PRIMAER, Menge ist {P,S}
do $$
declare v text;
begin
  select 'legacy='||coalesce(j.assigned_to::text,'NULL')
       ||'/anzahl='||(select count(*)::text from public.job_assignments ja where ja.job_id=j.id)
    into v
  from public.jobs j where j.id='e4000000-0000-0000-0000-000000000001';
  insert into _r values (0,'Ausgangslage: Legacy-Primaer ist PRIMAER, Menge hat 2 Zuweisungen',
    'legacy=e2000000-0000-0000-0000-000000000002/anzahl=2', v);
  raise notice 'CASE 0 -> %', v;
end $$;


-- =========================================================
-- A. Die eigentliche Erweiterung: Lesen als SEKUNDAER
-- =========================================================

-- CASE 1: SEKUNDAER sieht die jobs-Zeile (vor der Migration: NICHT sichtbar)
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'sichtbar='||count(*)::text into v
  from public.jobs where id='e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (1,'Sekundaerer Zugewiesener sieht den Auftrag','sichtbar=1',v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2: PRIMAER sieht ihn weiterhin (keine Regression)
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  select 'sichtbar='||count(*)::text into v
  from public.jobs where id='e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (2,'Primaerer Zugewiesener sieht den Auftrag weiterhin','sichtbar=1',v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3: nicht zugewiesener Mitarbeiter derselben Firma sieht ihn NICHT
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  select 'sichtbar='||count(*)::text into v
  from public.jobs where id='e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (3,'Nicht zugewiesener Mitarbeiter sieht den Auftrag nicht','sichtbar=0',v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4: Mitarbeiter der FREMDEN Firma sieht ihn nicht (Firmengrenze haelt)
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000006');
  execute 'set local role authenticated';
  select 'fremd_sichtbar='||count(*)::text into v
  from public.jobs where id='e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (4,'Mitarbeiter fremder Firma sieht den Auftrag nicht','fremd_sichtbar=0',v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- CASE 5: SEKUNDAER sieht auch die Zuweisungszeilen der Kollegen (Phase 3)
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'zuweisungen='||count(*)::text into v
  from public.job_assignments where job_id='e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (5,'Sekundaerer sieht die vollstaendige Zuweisungsmenge','zuweisungen=2',v);
  raise notice 'CASE 5 -> %', v;
end $$;


-- =========================================================
-- B. Die Falle: Recurring-Parent-Regeln bleiben unsichtbar
-- =========================================================

-- CASE 6: SEKUNDAER ist der Parent-REGEL zugewiesen, darf sie aber NICHT
-- sehen (job_type='single' steht ausserhalb der ODER-Klammer).
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'parent_sichtbar='||count(*)::text into v
  from public.jobs where id='e4000000-0000-0000-0000-000000000004';
  execute 'reset role';
  insert into _r values (6,'Recurring-Parent-Regel bleibt fuer Mitarbeiter unsichtbar (trotz Zuweisung)',
    'parent_sichtbar=0',v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: Gegenprobe — eine Occurrence (job_type='single') derselben Regel
-- ist sichtbar, sobald sie zugewiesen ist.
do $$
declare v text;
begin
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
  values ('e4000000-0000-0000-0000-000000000005','e2000000-0000-0000-0000-000000000003','Simon Sekundaer');

  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'occurrence_sichtbar='||count(*)::text into v
  from public.jobs where id='e4000000-0000-0000-0000-000000000005';
  execute 'reset role';
  insert into _r values (7,'Occurrence der Regel ist sichtbar (Gegenprobe zu Fall 6)',
    'occurrence_sichtbar=1',v);
  raise notice 'CASE 7 -> %', v;
end $$;


-- =========================================================
-- C. Kommentare, Fotos, Ungelesen-Kennzeichnung
-- =========================================================

-- CASE 8: SEKUNDAER liest die Kommentare des Auftrags
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'kommentare='||count(*)::text into v
  from public.job_comments where job_id='e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (8,'Sekundaerer liest Kommentare des Auftrags','kommentare=1',v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9: nicht Zugewiesener liest sie nicht
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  select 'kommentare='||count(*)::text into v
  from public.job_comments where job_id='e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (9,'Nicht Zugewiesener liest keine Kommentare','kommentare=0',v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: SEKUNDAER sieht die Foto-Zeile
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'fotos='||count(*)::text into v
  from public.job_photos where job_id='e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (10,'Sekundaerer sieht die Fotos des Auftrags','fotos=1',v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- CASE 11: nicht Zugewiesener sieht sie nicht
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  select 'fotos='||count(*)::text into v
  from public.job_photos where job_id='e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (11,'Nicht Zugewiesener sieht keine Fotos','fotos=0',v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- CASE 12: Ungelesen-RPC meldet dem SEKUNDAEREN NICHTS.
--
-- Das ist BEABSICHTIGT und der Kern der Entscheidung aus Abschnitt 5 der
-- Migration: die RPC bleibt unveraendert am Legacy-Primaer. Wuerde man sie
-- erweitern, ohne die Schreib-Policies von job_comment_reads mitzuziehen,
-- entstuende ein dauerhaft haengender Ungelesen-Punkt (Fall 12b).
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select 'ungelesen='||count(*)::text into v
  from public.get_unread_comment_job_ids() g
  where g = 'e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (12,'Ungelesen-RPC bleibt am Legacy-Primaer (Sekundaerer erhaelt nichts)','ungelesen=0',v);
  raise notice 'CASE 12 -> %', v;
end $$;

-- CASE 12b: der Grund dafuer, als harter Regressionsschutz.
-- Der Sekundaere darf den Ungelesen-Status NICHT schreiben. Solange das so
-- ist, DARF die RPC ihn ihm auch nicht melden — sonst haengt der Punkt.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    insert into public.job_comment_reads (job_id, user_id, last_seen_at)
    values ('e4000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000003', now())
    on conflict (job_id, user_id) do update set last_seen_at = excluded.last_seen_at;
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (121,'Sekundaerer kann Ungelesen-Status nicht schreiben (Schreibpfad unveraendert)',
    'ABGELEHNT',v);
  raise notice 'CASE 12b -> %', v;
end $$;

-- CASE 12c: der PRIMAER kann es weiterhin — kein Rueckschritt.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    insert into public.job_comment_reads (job_id, user_id, last_seen_at)
    values ('e4000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002', now())
    on conflict (job_id, user_id) do update set last_seen_at = excluded.last_seen_at;
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (122,'Primaerer kann den Ungelesen-Status weiterhin schreiben','AKZEPTIERT',v);
  raise notice 'CASE 12c -> %', v;
end $$;

-- CASE 13: und NICHT dem nicht Zugewiesenen
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  select 'ungelesen='||count(*)::text into v
  from public.get_unread_comment_job_ids() g
  where g = 'e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (13,'Ungelesen-RPC meldet nichts an Nicht-Zugewiesene','ungelesen=0',v);
  raise notice 'CASE 13 -> %', v;
end $$;


-- =========================================================
-- D. SCHREIBRECHTE BLEIBEN UNVERAENDERT (Kern der Read-Only-Zusicherung)
-- =========================================================

-- CASE 14: SEKUNDAER darf KEINEN Kommentar schreiben (Insert-Policy haengt
-- weiterhin an jobs.assigned_to). Bewusst so — Phase 6/7.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    insert into public.job_comments (company_id, job_id, author_id, message)
    values ('e1000000-0000-0000-0000-000000000001','e4000000-0000-0000-0000-000000000001',
            'e2000000-0000-0000-0000-000000000003','Versuch');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (14,'Sekundaerer darf KEINEN Kommentar schreiben (Schreibpfad unveraendert)',
    'ABGELEHNT',v);
  raise notice 'CASE 14 -> %', v;
end $$;

-- CASE 15: PRIMAER darf es weiterhin (keine Regression am Schreibpfad)
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    insert into public.job_comments (company_id, job_id, author_id, message)
    values ('e1000000-0000-0000-0000-000000000001','e4000000-0000-0000-0000-000000000001',
            'e2000000-0000-0000-0000-000000000002','Vom Primaer');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (15,'Primaerer darf weiterhin kommentieren','AKZEPTIERT',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16: SEKUNDAER darf keine Foto-Zeile anlegen.
--
-- DIESER FALL IST DER GRUND FUER ABSCHNITT 6 DER MIGRATION. Vor dem
-- Entfernen der beiden weiten Baseline-Policies schlug er fehl: die
-- Policy "job_photos: Firma darf Fotos hochladen" prueft die Zuweisung
-- nicht selbst, sondern nur, ob der Aufrufer die jobs-Zeile SEHEN kann —
-- eine Bedingung, die Abschnitt 1 dieser Migration gerade erweitert.
-- Damit haette eine reine Lese-Aenderung transitiv ein SCHREIBRECHT
-- geoeffnet. Der Fall bleibt hier als Regressionsschutz stehen.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    insert into public.job_photos (company_id, job_id, uploaded_by, storage_path, file_name)
    values ('e1000000-0000-0000-0000-000000000001','e4000000-0000-0000-0000-000000000001',
            'e2000000-0000-0000-0000-000000000003','p/q/r.jpg','r.jpg');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (16,'Sekundaerer darf kein Foto anlegen (Schreibpfad unveraendert)','ABGELEHNT',v);
  raise notice 'CASE 16 -> %', v;
end $$;

-- CASE 17: SEKUNDAER kann den Auftrag NICHT starten — start_own_job
-- verlangt weiterhin assigned_to = auth.uid(). Genau deshalb muss der
-- Client sein Aktions-Gating am Legacy-Primaer ausrichten.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('e4000000-0000-0000-0000-000000000001', now());
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (17,'Sekundaerer kann den Auftrag nicht starten (RPC unveraendert, Phase 7)',
    'ABGELEHNT',v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- CASE 18: SEKUNDAER darf die jobs-Zeile nicht direkt aendern
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    update public.jobs set notes='geaendert' where id='e4000000-0000-0000-0000-000000000001';
    v := 'zeilen='||(select count(*)::text from public.jobs
                     where id='e4000000-0000-0000-0000-000000000001' and notes='geaendert');
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  -- Es existiert keine employee-UPDATE-Policy auf jobs: das UPDATE trifft
  -- 0 Zeilen (kein Fehler, aber auch keine Wirkung).
  insert into _r values (18,'Sekundaerer kann die jobs-Zeile nicht veraendern','zeilen=0',v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- CASE 19: SEKUNDAER darf keine Zuweisung schreiben (kein Grant, Phase 3)
do $$
declare v text;
begin
  select 'insert_grant='||has_table_privilege('authenticated','public.job_assignments','insert')::text
       ||'/update_grant='||has_table_privilege('authenticated','public.job_assignments','update')::text
       ||'/delete_grant='||has_table_privilege('authenticated','public.job_assignments','delete')::text
    into v;
  insert into _r values (19,'authenticated hat weiterhin KEIN Schreibrecht auf job_assignments',
    'insert_grant=false/update_grant=false/delete_grant=false',v);
  raise notice 'CASE 19 -> %', v;
end $$;


-- =========================================================
-- E. Strukturzusicherungen der Migration
-- =========================================================

-- CASE 20: genau die vier erwarteten Policies tragen den neuen Helfer —
-- und zwar ausschliesslich SELECT-Policies.
do $$
declare v text;
begin
  select 'cmds='||coalesce(string_agg(distinct cmd, ',' order by cmd),'KEINE')
       ||'/anzahl='||count(*)::text
    into v
  from pg_policies
  where qual like '%is_assigned_to_job%'
    and (schemaname, tablename) in
        (('public','jobs'),('public','job_comments'),('public','job_photos'),('storage','objects'));
  insert into _r values (20,'Nur SELECT-Policies nutzen is_assigned_to_job (4 Stueck)','cmds=SELECT/anzahl=4',v);
  raise notice 'CASE 20 -> %', v;
end $$;

-- CASE 21: KEINE Schreib-Policy (INSERT/UPDATE/DELETE) wurde erweitert.
-- Geprueft wird die with_check-Seite ebenso wie die using-Seite.
do $$
declare v text;
begin
  select 'schreibpolicies_mit_helfer='||count(*)::text into v
  from pg_policies
  where cmd <> 'SELECT'
    and (coalesce(qual,'') like '%is_assigned_to_job%'
      or coalesce(with_check,'') like '%is_assigned_to_job%');
  insert into _r values (21,'Keine INSERT/UPDATE/DELETE-Policy nutzt den Helfer',
    'schreibpolicies_mit_helfer=0',v);
  raise notice 'CASE 21 -> %', v;
end $$;

-- CASE 22: die jobs-Policy behaelt die job_type-Einschraenkung UND den
-- Legacy-Zweig (Obermengen-Eigenschaft, siehe Entscheidung (A)).
do $$
declare v text;
begin
  select 'job_type='||(qual like '%job_type%')::text
       ||'/legacy='||(qual like '%assigned_to%')::text
       ||'/neu='||(qual like '%is_assigned_to_job%')::text
    into v
  from pg_policies
  where schemaname='public' and tablename='jobs' and policyname='employee read own assigned jobs';
  insert into _r values (22,'jobs-Policy: job_type-Grenze, Legacy-Zweig und neuer Zweig vorhanden',
    'job_type=true/legacy=true/neu=true',v);
  raise notice 'CASE 22 -> %', v;
end $$;

-- CASE 23: get_unread_comment_job_ids wurde NICHT erweitert.
-- Regressionsschutz: taucht is_assigned_to_job jemals im Funktionsrumpf auf,
-- ohne dass die job_comment_reads-Schreibpolicies nachgezogen wurden, ist der
-- haengende Ungelesen-Punkt zurueck.
do $$
declare v text;
begin
  select 'nutzt_helfer='||(pg_get_functiondef(p.oid) like '%is_assigned_to_job%')::text
       ||'/volatilitaet='||p.provolatile::text
       ||'/definer='||p.prosecdef::text into v
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='get_unread_comment_job_ids';
  insert into _r values (23,'Ungelesen-RPC unveraendert (kein Helfer, weiterhin STABLE/DEFINER)',
    'nutzt_helfer=false/volatilitaet=s/definer=true',v);
  raise notice 'CASE 23 -> %', v;
end $$;


-- CASE 24: die beiden weiten Baseline-Policies auf job_photos sind fort.
-- Sie waren die einzigen Policies dieses Schemas, deren Schutzwirkung
-- allein aus der jobs-Sichtbarkeit stammte (Unterabfrage auf jobs unter
-- der RLS des Aufrufers) — und damit die einzige Stelle, an der eine
-- Lese-Erweiterung transitiv ein Schreibrecht oeffnen konnte.
do $$
declare v text;
begin
  select 'weite_policies='||count(*)::text into v
  from pg_policies
  where schemaname='public' and tablename='job_photos'
    and policyname in ('job_photos: Firma darf Fotos lesen',
                       'job_photos: Firma darf Fotos hochladen');
  insert into _r values (24,'Weite Baseline-Policies auf job_photos entfernt','weite_policies=0',v);
  raise notice 'CASE 24 -> %', v;
end $$;

-- CASE 25: der PRIMAER kann weiterhin ein Foto anlegen — das Entfernen in
-- Fall 24 hat also niemandem ein heute nutzbares Recht genommen
-- (Nettowirkung auf Schreibrechte = null).
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    insert into public.job_photos (company_id, job_id, uploaded_by, storage_path, file_name)
    values ('e1000000-0000-0000-0000-000000000001','e4000000-0000-0000-0000-000000000001',
            'e2000000-0000-0000-0000-000000000002','x/y/z.jpg','z.jpg');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (25,'Primaerer kann weiterhin ein Foto anlegen','AKZEPTIERT',v);
  raise notice 'CASE 25 -> %', v;
end $$;

-- CASE 26: der Admin ebenfalls (die weite Policy war auch fuer ihn
-- redundant — "admin insert photos in own company" deckt ihn ab).
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    insert into public.job_photos (company_id, job_id, uploaded_by, storage_path, file_name)
    values ('e1000000-0000-0000-0000-000000000001','e4000000-0000-0000-0000-000000000002',
            'e2000000-0000-0000-0000-000000000001','a/b/admin.jpg','admin.jpg');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (26,'Admin kann weiterhin Fotos anlegen','AKZEPTIERT',v);
  raise notice 'CASE 26 -> %', v;
end $$;

-- CASE 27: und der Admin liest weiterhin alle Fotos der eigenen Firma
-- (Gegenprobe zum Entfernen der weiten LESE-Policy).
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select 'admin_fotos='||count(*)::text into v
  from public.job_photos where job_id='e4000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (27,'Admin liest weiterhin die Fotos der eigenen Firma','admin_fotos=2',v);
  raise notice 'CASE 27 -> %', v;
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
    raise exception 'EMPLOYEE READ VIA ASSIGNMENTS TEST: % Fall/Faelle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE 30 FAELLE PASS';
end $$;

rollback;
