-- =========================================================
-- TEST: Foto-Isolation im Storage + kein direktes Employee-UPDATE auf jobs
-- (Migration 20260805000000_lock_down_job_photo_storage_and_job_updates)
-- =========================================================
-- Prueft die vier Aussagen, auf denen die Migration steht:
--
--   1. Ein Mitarbeiter kommt NICHT an Fotos von Auftraegen, die ihm nicht
--      zugewiesen sind — weder lesend noch schreibend —, auch nicht
--      innerhalb der EIGENEN Firma. Das war das Leck (T1/T2).
--   2. Wer legitim zugreifen darf, kann es weiterhin: Admin der Firma auf
--      alles, zugewiesener Mitarbeiter auf seinen Auftrag. Kein
--      Overblocking.
--   3. Ein Mitarbeiter kann status/started_at/completed_at NICHT mehr per
--      direktem UPDATE setzen (T4) — die beiden RPCs bleiben der einzige
--      Weg und funktionieren unveraendert, inklusive geteilter Job-Uhr.
--   4. Die Firmen-Isolation war und bleibt intakt.
--
-- Alle Zugriffe laufen als ECHTE Rollen (SET ROLE authenticated +
-- request.jwt.claims), also ueber denselben Pfad wie die App ueber
-- PostgREST. An KEINER Stelle wird service_role verwendet und an keiner
-- Stelle wird RLS umgangen. Die Fixture wird als Login-/Owner-Rolle
-- aufgebaut (vor dem ersten SET ROLE) — das ist Testaufbau, nicht
-- Testgegenstand.
--
-- HINWEIS ZU „VERWEIGERT"-PFADEN: der lokale Supabase-Container stuerzt
-- bei permission-denied (FEHLENDES PRIVILEG) ab, siehe
-- job_assignments_rls.test.sql. Dieser Test loest so etwas nicht aus:
-- `authenticated` besitzt auf storage.objects und public.jobs volle
-- DML-GRANTS (verifiziert), jede Ablehnung hier kommt also aus einer
-- RLS-Policy — entweder als 0 betroffene Zeilen (SELECT/UPDATE) oder als
-- sauberer 42501 „new row violates row-level security policy" (INSERT).
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende.
-- Ausfuehren lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/job_photo_storage_isolation.test.sql
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = b1…1 | Firma B = b1…2
-- Admin A = b2…1
-- ANNA    = b2…2  Legacy-PRIMAER von J1        -> darf lesen + hochladen
-- BERND   = b2…3  SEKUNDAER auf J1             -> darf lesen, NICHT hochladen
-- CARLA   = b2…4  Firma A, J1 NICHT zugewiesen -> der Angreifer
-- Admin B = b2…5 | DORA = b2…6 (Firma B)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000001','authenticated','authenticated','p-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000002','authenticated','authenticated','p-anna@example.test','{"full_name":"Anna Primaer"}'),
    ('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000003','authenticated','authenticated','p-bernd@example.test','{"full_name":"Bernd Sekundaer"}'),
    ('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000004','authenticated','authenticated','p-carla@example.test','{"full_name":"Carla Fremd"}'),
    ('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000005','authenticated','authenticated','p-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000006','authenticated','authenticated','p-dora@example.test','{"full_name":"Dora Fremdfirma"}');
end $$;

-- Der auth-Trigger handle_new_user ist in der lokalen Baseline nicht
-- enthalten — Profile werden deshalb explizit angelegt (auf Produktion
-- legt der Trigger sie an, daher on conflict do nothing).
insert into public.profiles (id, full_name) values
  ('b2000000-0000-0000-0000-000000000001','Admin A'),
  ('b2000000-0000-0000-0000-000000000002','Anna Primaer'),
  ('b2000000-0000-0000-0000-000000000003','Bernd Sekundaer'),
  ('b2000000-0000-0000-0000-000000000004','Carla Fremd'),
  ('b2000000-0000-0000-0000-000000000005','Admin B'),
  ('b2000000-0000-0000-0000-000000000006','Dora Fremdfirma')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('b1000000-0000-0000-0000-000000000001','Foto Firma A','foto-firma-a-test'),
  ('b1000000-0000-0000-0000-000000000002','Foto Firma B','foto-firma-b-test');

update public.profiles set company_id='b1000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='b2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='b1000000-0000-0000-0000-000000000001', role='employee', is_active=true where id in
  ('b2000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000003','b2000000-0000-0000-0000-000000000004');
update public.profiles set company_id='b1000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='b2000000-0000-0000-0000-000000000005';
update public.profiles set company_id='b1000000-0000-0000-0000-000000000002', role='employee', is_active=true where id='b2000000-0000-0000-0000-000000000006';

-- Auftraege:
--   J1 = b4…1  Firma A, single, {ANNA primaer, BERND sekundaer}
--   J2 = b4…2  Firma A, single, {CARLA}   -> Kontrollfall gegen Overblocking
--   J5 = b4…5  Firma B, single, {DORA}
insert into public.jobs
  (id,company_id,assigned_to,created_by,customer_name,service_name,location_address,status,job_type,date,start_time,recurring_days,is_active,created_at,updated_at,scheduled_start) values
  ('b4000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001',null,'b2000000-0000-0000-0000-000000000001','K1','S1','O1','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('b4000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001',null,'b2000000-0000-0000-0000-000000000001','K2','S2','O2','open','single',current_date,'09:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null),
  ('b4000000-0000-0000-0000-000000000005','b1000000-0000-0000-0000-000000000002',null,'b2000000-0000-0000-0000-000000000005','K5','S5','O5','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00',null);

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;

-- Pfad-Helfer: <company_id>/<job_id>/<datei>
create or replace function pg_temp.p(co uuid, job uuid, datei text) returns text language sql immutable as $f$
  select co::text||'/'||job::text||'/'||datei;
$f$;

-- Der Bucket wird von KEINER Migration angelegt (nur in lib/schema.sql
-- beschrieben) — weitere Drift. Fuer den Test defensiv sicherstellen.
insert into storage.buckets (id, name, public)
values ('job-photos','job-photos',false)
on conflict (id) do nothing;


-- =========================================================
-- Ausgangslage: Zuweisungen deterministisch setzen
-- =========================================================
-- Der Legacy-Zeiger muss deterministisch stehen, sonst ist „sekundaer"
-- nicht nachweisbar: erst den gewuenschten Primaer ALLEIN setzen, dann den
-- Zweiten ergaenzen (Regel 1 von compat_primary_assignee, vgl.
-- shared_job_time_multi_assignment.test.sql).
do $$
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';

  perform public.set_job_assignments('b4000000-0000-0000-0000-000000000001',
    array['b2000000-0000-0000-0000-000000000002']::uuid[]);
  perform public.set_job_assignments('b4000000-0000-0000-0000-000000000001',
    array['b2000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000003']::uuid[]);

  perform public.set_job_assignments('b4000000-0000-0000-0000-000000000002',
    array['b2000000-0000-0000-0000-000000000004']::uuid[]);

  execute 'reset role';
end $$;

-- Fremdfirmen-Zuweisung direkt verdrahten (ein zweiter Rollenwechsel als
-- Admin B braechte keinen Erkenntnisgewinn).
insert into public.job_assignments (job_id, employee_id, employee_name_snapshot)
values ('b4000000-0000-0000-0000-000000000005','b2000000-0000-0000-0000-000000000006','Dora Fremdfirma');
update public.jobs set assigned_to='b2000000-0000-0000-0000-000000000006'
where id='b4000000-0000-0000-0000-000000000005';

-- Bestandsobjekte im Bucket (als Owner-Rolle angelegt = Testaufbau):
--   OBJ_J1 gehoert ANNA und liegt in Firma A / J1
--   OBJ_J5 gehoert DORA und liegt in Firma B / J5
insert into storage.objects (id, bucket_id, name, owner, owner_id) values
  ('b5000000-0000-0000-0000-000000000001','job-photos',
   pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','anna.jpg'),
   'b2000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000002'),
  ('b5000000-0000-0000-0000-000000000005','job-photos',
   pg_temp.p('b1000000-0000-0000-0000-000000000002','b4000000-0000-0000-0000-000000000005','dora.jpg'),
   'b2000000-0000-0000-0000-000000000006','b2000000-0000-0000-0000-000000000006');

-- Sanity: die Ausgangslage ist die, die wir glauben.
do $$
declare v text;
begin
  select assigned_to::text into v from public.jobs where id='b4000000-0000-0000-0000-000000000001';
  if v <> 'b2000000-0000-0000-0000-000000000002' then
    raise exception 'FIXTURE KAPUTT: Legacy-Primaer von J1 ist % statt ANNA', v;
  end if;
  if (select count(*) from public.job_assignments where job_id='b4000000-0000-0000-0000-000000000001') <> 2 then
    raise exception 'FIXTURE KAPUTT: J1 hat nicht genau 2 Zuweisungen';
  end if;
end $$;


-- =========================================================
-- TEIL A — STORAGE: das Leck ist zu (P0-1)
-- =========================================================

-- CASE 1: CARLA (Firma A, J1 NICHT zugewiesen) liest das Foto von J1.
-- Das ist der Kernfall des Lecks — vor der Migration lieferte er 1.
do $$
declare n int;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  select count(*) into n from storage.objects
   where bucket_id='job-photos'
     and name = pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','anna.jpg');
  execute 'reset role';
  insert into _r values (1,'Nicht zugewiesener Mitarbeiter liest FREMDES Auftragsfoto','0',n::text);
  raise notice 'CASE 1 -> %', n;
end $$;

-- CASE 2: CARLA laedt in den Auftragsordner von J1 hoch.
do $$
declare v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','carla-hack.jpg'),
       'b2000000-0000-0000-0000-000000000004','b2000000-0000-0000-0000-000000000004');
    v := 'ERLAUBT';
  exception when insufficient_privilege then v := 'ABGELEHNT';
            when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (2,'Nicht zugewiesener Mitarbeiter laedt in FREMDEN Auftragsordner','ABGELEHNT',v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3: ANNA (Primaer, zugewiesen) liest ihr Auftragsfoto -> muss gehen.
do $$
declare n int;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  select count(*) into n from storage.objects
   where bucket_id='job-photos'
     and name = pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','anna.jpg');
  execute 'reset role';
  insert into _r values (3,'Zugewiesener Mitarbeiter (Primaer) liest sein Auftragsfoto','1',n::text);
  raise notice 'CASE 3 -> %', n;
end $$;

-- CASE 4: ANNA laedt in ihren eigenen Auftragsordner hoch -> muss gehen.
do $$
declare v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','anna-neu.jpg'),
       'b2000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000002');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (4,'Zugewiesener Mitarbeiter (Primaer) laedt in EIGENEN Auftragsordner','ERLAUBT',v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- CASE 5: BERND (SEKUNDAER zugewiesen) liest das Foto -> muss gehen.
-- Die Zuweisungsmenge zaehlt beim LESEN (Stand seit 20260730000000).
do $$
declare n int;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  select count(*) into n from storage.objects
   where bucket_id='job-photos'
     and name = pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','anna.jpg');
  execute 'reset role';
  insert into _r values (5,'SEKUNDAER Zugewiesener liest Auftragsfoto (Zuweisungsmenge)','1',n::text);
  raise notice 'CASE 5 -> %', n;
end $$;

-- CASE 6: BERND laedt hoch -> ABGELEHNT.
-- BEWUSSTE, DOKUMENTIERTE ASYMMETRIE: der Foto-/Kommentar-SCHREIBPFAD
-- haengt projektweit am Legacy-Primaer (assigned_to), nicht an der
-- Zuweisungsmenge — siehe CLAUDE.md und Abschnitt 2 der Migration. Die App
-- bietet Bernd den Upload gar nicht erst an (isPrimaryAssignee). Dieser
-- Fall haelt den Status quo fest, damit eine spaetere Angleichung eine
-- BEWUSSTE Aenderung ist und kein Versehen.
do $$
declare v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','bernd.jpg'),
       'b2000000-0000-0000-0000-000000000003','b2000000-0000-0000-0000-000000000003');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (6,'SEKUNDAER Zugewiesener laedt hoch (Schreibpfad bleibt am Primaer)','ABGELEHNT',v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: Admin A liest das Foto -> muss gehen (Admin sieht alles der Firma).
do $$
declare n int;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select count(*) into n from storage.objects
   where bucket_id='job-photos'
     and name = pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','anna.jpg');
  execute 'reset role';
  insert into _r values (7,'Admin liest Foto eines Auftrags seiner Firma','1',n::text);
  raise notice 'CASE 7 -> %', n;
end $$;

-- CASE 8: Admin A laedt in einen Auftragsordner hoch, dem er selbst nicht
-- zugewiesen ist -> muss gehen.
do $$
declare v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','admin.jpg'),
       'b2000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (8,'Admin laedt in beliebigen Auftragsordner seiner Firma hoch','ERLAUBT',v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9: Admin A sieht ALLE Fotos seiner Firma (nach CASE 4 + 8 sind es 3).
do $$
declare n int;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select count(*) into n from storage.objects
   where bucket_id='job-photos'
     and (storage.foldername(name))[1] = 'b1000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (9,'Admin verwaltet saemtliche Firmenfotos (anna+anna-neu+admin)','3',n::text);
  raise notice 'CASE 9 -> %', n;
end $$;

-- CASE 10: CARLA liest ihren EIGENEN Auftragsordner -> kein Overblocking.
-- (Sie hat auf J2 noch kein Foto; entscheidend ist, dass der Upload geht.)
do $$
declare v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000002','carla-eigen.jpg'),
       'b2000000-0000-0000-0000-000000000004','b2000000-0000-0000-0000-000000000004');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (10,'Kein Overblocking: Mitarbeiter laedt in EIGENEN Auftragsordner','ERLAUBT',v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- CASE 11: DORA (Firma B) liest das Foto aus Firma A -> Firmen-Isolation.
do $$
declare n int;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000006');
  execute 'set local role authenticated';
  select count(*) into n from storage.objects
   where bucket_id='job-photos'
     and name = pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','anna.jpg');
  execute 'reset role';
  insert into _r values (11,'Mitarbeiter FREMDER Firma liest Foto','0',n::text);
  raise notice 'CASE 11 -> %', n;
end $$;

-- CASE 12: Admin B liest das Foto aus Firma A -> Firmen-Isolation.
do $$
declare n int;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000005');
  execute 'set local role authenticated';
  select count(*) into n from storage.objects
   where bucket_id='job-photos'
     and (storage.foldername(name))[1] = 'b1000000-0000-0000-0000-000000000001';
  execute 'reset role';
  insert into _r values (12,'Admin FREMDER Firma liest Fotos','0',n::text);
  raise notice 'CASE 12 -> %', n;
end $$;

-- CASE 13: DORA laedt in einen Ordner von Firma A hoch -> ABGELEHNT.
do $$
declare v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000006');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','dora-hack.jpg'),
       'b2000000-0000-0000-0000-000000000006','b2000000-0000-0000-0000-000000000006');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (13,'Mitarbeiter FREMDER Firma laedt in Firma-A-Ordner','ABGELEHNT',v);
  raise notice 'CASE 13 -> %', v;
end $$;

-- CASE 14: Pfad-Manipulation. ANNA schreibt ihre EIGENE company_id, haengt
-- aber ein zweites Segment an, das auf keinen Auftrag zeigt — einmal als
-- syntaktisch gueltiges, aber nicht existierendes UUID, einmal als
-- voelliger Unsinn ("not-a-uuid"). BEIDE muessen abgelehnt werden, und der
-- zweite Fall darf KEINEN Cast-Fehler (22P02) ausloesen, sondern ein
-- schlichtes „Policy trifft nicht zu".
do $$
declare v1 text; v2 text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';

  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-0000000000ff','ghost.jpg'),
       'b2000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000002');
    v1 := 'ERLAUBT';
  exception when others then v1 := 'ABGELEHNT';
  end;

  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', 'b1000000-0000-0000-0000-000000000001/not-a-uuid/kaputt.jpg',
       'b2000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000002');
    v2 := 'ERLAUBT';
  exception when invalid_text_representation then v2 := 'CAST-FEHLER(22P02)';
            when others then v2 := 'ABGELEHNT';
  end;

  execute 'reset role';
  insert into _r values (14,'Upload unter ungueltigem 2. Pfadsegment (nicht existierend / kein UUID)',
    'ghost=ABGELEHNT/muell=ABGELEHNT','ghost='||v1||'/muell='||v2);
  raise notice 'CASE 14 -> ghost=% muell=%', v1, v2;
end $$;

-- CASE 15: DER EIGENTLICHE GRUND FUER DEN TEXTVERGLEICH.
-- Ein Objekt mit kaputtem Pfadsegment liegt bereits im Bucket (hier als
-- Owner-Rolle eingeschleust, also am RLS vorbei — genau wie eine Altlast
-- oder ein am Storage-API vorbei angelegtes Objekt). Danach listet ANNA
-- ganz normal die Fotos ihrer Firma.
--
-- Mit `((storage.foldername(name))[2])::uuid` wuerde diese Abfrage mit
-- 22P02 ABBRECHEN — ein einziges kaputtes Objekt legte die Fotoliste der
-- gesamten Firma lahm. Mit dem Textvergleich wird die kaputte Zeile
-- schlicht nicht sichtbar und alles andere funktioniert weiter.
insert into storage.objects (bucket_id, name, owner, owner_id) values
  ('job-photos','b1000000-0000-0000-0000-000000000001/nicht-mal-ansatzweise-uuid/altlast.jpg',
   'b2000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001');

do $$
declare v text; n int;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    select count(*) into n from storage.objects
     where bucket_id='job-photos'
       and (storage.foldername(name))[1] = 'b1000000-0000-0000-0000-000000000001';
    v := 'zeilen='||n::text;
  exception when invalid_text_representation then v := 'CAST-FEHLER(22P02)';
            when others then v := 'FEHLER('||sqlstate||')';
  end;
  execute 'reset role';
  -- ANNA sieht genau die drei Objekte von J1 (anna.jpg + anna-neu.jpg aus
  -- CASE 4 + admin.jpg aus CASE 8). Das Altlast-Objekt bleibt unsichtbar,
  -- und carla-eigen.jpg aus CASE 10 gehoert zu J2.
  insert into _r values (15,'Kaputt benanntes Bestandsobjekt bricht die Fotoliste NICHT',
    'zeilen=3',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16: Die beiden weiten Drift-Policies existieren nicht mehr, und auf
-- storage.objects stehen genau die drei beabsichtigten job-photos-Policies.
do $$
declare weit int; gesamt int;
begin
  select count(*) into weit from pg_policies
   where schemaname='storage' and tablename='objects'
     and policyname in ('job-photos storage: Lesen aus eigenem Firma-Ordner',
                        'job-photos storage: Hochladen in eigenen Firma-Ordner');
  select count(*) into gesamt from pg_policies
   where schemaname='storage' and tablename='objects' and policyname like 'job-photos%';
  insert into _r values (16,'Policy-Inventar storage.objects (weit=0, job-photos gesamt=3)',
    'weit=0/gesamt=3','weit='||weit::text||'/gesamt='||gesamt::text);
  raise notice 'CASE 16 -> weit=% gesamt=%', weit, gesamt;
end $$;


-- =========================================================
-- TEIL B — jobs: kein direktes UPDATE mehr (P0-2)
-- =========================================================
-- WICHTIG ZUR ABGRENZUNG: shared_job_time_multi_assignment.test.sql
-- CASE 26 prueft dasselbe Thema, aber mit einem SEKUNDAER Zugewiesenen —
-- der scheiterte schon immer an `assigned_to = auth.uid()`. Der Fall war
-- damit falsche Sicherheit: der LEGACY-PRIMAER kam durch. Alle Faelle hier
-- laufen deshalb bewusst als ANNA, dem Primaer von J1.

-- CASE 17: ANNA faelscht started_at.
do $$
declare n int; v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    update public.jobs set started_at = now() - interval '9 hours'
     where id='b4000000-0000-0000-0000-000000000001';
    get diagnostics n = row_count;
    v := 'zeilen='||n::text;
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (17,'Primaer faelscht started_at per direktem UPDATE','zeilen=0',v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- CASE 18: ANNA faelscht completed_at + status in einem Rutsch.
do $$
declare n int; v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    update public.jobs set completed_at = now(), status = 'completed'
     where id='b4000000-0000-0000-0000-000000000001';
    get diagnostics n = row_count;
    v := 'zeilen='||n::text;
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (18,'Primaer faelscht completed_at + status per direktem UPDATE','zeilen=0',v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- CASE 19: und auch sonst nichts (Gegenprobe auf ein Nicht-Zeit-Feld).
do $$
declare n int; v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    update public.jobs set customer_name='Gekapert'
     where id='b4000000-0000-0000-0000-000000000001';
    get diagnostics n = row_count;
    v := 'zeilen='||n::text;
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (19,'Primaer aendert customer_name per direktem UPDATE','zeilen=0',v);
  raise notice 'CASE 19 -> %', v;
end $$;

-- CASE 20: der Auftrag ist nach 16–18 unveraendert.
do $$
declare v text;
begin
  select status::text||'/'||coalesce(started_at::text,'null')||'/'||coalesce(completed_at::text,'null')||'/'||customer_name
    into v from public.jobs where id='b4000000-0000-0000-0000-000000000001';
  insert into _r values (20,'Auftrag nach den UPDATE-Versuchen unveraendert','open/null/null/K1',v);
  raise notice 'CASE 20 -> %', v;
end $$;

-- CASE 21: die Policy existiert nicht mehr; Mitarbeiter haben auf jobs
-- ausschliesslich SELECT.
do $$
declare v text;
begin
  select coalesce(string_agg(cmd,',' order by cmd),'(keine)') into v
  from pg_policies where schemaname='public' and tablename='jobs' and policyname like 'employee%';
  insert into _r values (21,'Verbleibende Employee-Policies auf jobs','SELECT',v);
  raise notice 'CASE 21 -> %', v;
end $$;

-- CASE 22: start_own_job funktioniert unveraendert (ANNA, Primaer).
do $$
declare v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('b4000000-0000-0000-0000-000000000001', timestamptz '2026-08-05 08:00+00');
    v := 'OK';
  exception when others then v := 'FEHLER('||sqlstate||')';
  end;
  execute 'reset role';
  select v||'/'||status::text into v from public.jobs where id='b4000000-0000-0000-0000-000000000001';
  insert into _r values (22,'start_own_job weiterhin funktionsfaehig (RPC nicht gebrochen)','OK/in_progress',v);
  raise notice 'CASE 22 -> %', v;
end $$;

-- CASE 23: complete_own_job durch den SEKUNDAEREN — geteilte Job-Uhr bleibt
-- intakt (Anna startet, Bernd schliesst ab).
do $$
declare v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('b4000000-0000-0000-0000-000000000001', timestamptz '2026-08-05 10:00+00');
    v := 'OK';
  exception when others then v := 'FEHLER('||sqlstate||')';
  end;
  execute 'reset role';
  select v||'/'||status::text||'/dauer='||(completed_at - started_at)::text
    into v from public.jobs where id='b4000000-0000-0000-0000-000000000001';
  insert into _r values (23,'complete_own_job durch Sekundaeren; geteilte Job-Uhr intakt','OK/completed/dauer=02:00:00',v);
  raise notice 'CASE 23 -> %', v;
end $$;

-- CASE 24: der Admin kann Auftraege weiterhin direkt aendern.
do $$
declare n int; v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    update public.jobs set customer_name='K1 neu'
     where id='b4000000-0000-0000-0000-000000000001';
    get diagnostics n = row_count;
    v := 'zeilen='||n::text;
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (24,'Admin aendert Auftrag seiner Firma weiterhin','zeilen=1',v);
  raise notice 'CASE 24 -> %', v;
end $$;

-- CASE 25: der Admin der FREMDEN Firma kann es nicht.
do $$
declare n int; v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000005');
  execute 'set local role authenticated';
  begin
    update public.jobs set customer_name='Fremd gekapert'
     where id='b4000000-0000-0000-0000-000000000001';
    get diagnostics n = row_count;
    v := 'zeilen='||n::text;
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (25,'Admin FREMDER Firma aendert Auftrag','zeilen=0',v);
  raise notice 'CASE 25 -> %', v;
end $$;

-- CASE 26: Gegenprobe zur Tabellen-Policy — CARLA kann auch keine
-- job_photos-ZEILE zu einem fremden Auftrag anlegen. (Diese Policy wurde
-- nicht geaendert; der Fall haelt fest, dass Storage und Tabelle nach der
-- Migration dieselbe Grenze ziehen.)
do $$
declare v text;
begin
  perform pg_temp.act_as('b2000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    insert into public.job_photos (job_id, company_id, uploaded_by, storage_path, file_name)
    values ('b4000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001',
            'b2000000-0000-0000-0000-000000000004',
            pg_temp.p('b1000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','carla-hack.jpg'),
            'carla-hack.jpg');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (26,'job_photos-ZEILE zu fremdem Auftrag (Tabellen-Policy, unveraendert)','ABGELEHNT',v);
  raise notice 'CASE 26 -> %', v;
end $$;


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _r order by case_no;

do $$
declare fails int; gesamt int;
begin
  select count(*), count(*) filter (where ergebnis is distinct from erwartet)
    into gesamt, fails from _r;
  if fails > 0 then
    raise exception 'FOTO-ISOLATION TEST: % von % Faellen FEHLGESCHLAGEN', fails, gesamt;
  end if;
  raise notice 'ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
