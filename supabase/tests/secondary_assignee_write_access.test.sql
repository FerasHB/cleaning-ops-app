-- =========================================================
-- TEST: Schreibzugriff für sekundär Zugewiesene (Kommentare, Fotos)
-- (Migration 20260826000001_secondary_assignee_write_access)
-- =========================================================
-- Prüft die volle Zugriffsmatrix aus dem Audit "Multi-Assignee Comments /
-- Photos RLS" für die fünf von dieser Migration geänderten Policies:
--
--   1. public.job_comments        INSERT
--   2. public.job_photos          INSERT
--   3. public.job_comment_reads   INSERT
--   4. public.job_comment_reads   UPDATE
--   5. storage.objects            INSERT (Bucket job-photos)
--
-- Matrix je Ressource (Kommentare, Fotos, Ungelesen-Status, Storage-Upload):
--   A. PRIMÄR zugewiesen (Legacy-Zeiger)      -> erlaubt
--   B. SEKUNDÄR zugewiesen (job_assignments)  -> erlaubt (DIES ist die Änderung)
--   C. gleiche Firma, NICHT zugewiesen        -> verweigert
--   D. andere Firma                           -> verweigert
--   E. Admin, gleiche Firma                   -> erlaubt
--   F. Admin, andere Firma                    -> verweigert
--
-- Alle Zugriffe laufen als echte Rollen (SET ROLE + request.jwt.claims),
-- also über denselben Pfad wie die App über PostgREST.
--
-- HINWEIS ZU „VERWEIGERT"-PFADEN: der lokale Supabase-Container stürzt bei
-- FEHLENDEM PRIVILEG ab (siehe job_assignments_rls.test.sql). `authenticated`
-- besitzt auf allen hier betroffenen Tabellen sowie storage.objects volle
-- DML-Grants — jede Ablehnung hier kommt also aus einer RLS-Policy (0 Zeilen
-- bei SELECT/UPDATE, sauberer 42501 bei INSERT), nicht aus einem fehlenden
-- Privileg.
--
-- Läuft transaktional (BEGIN … ROLLBACK): keine Rückstände, keine
-- Produktionsdaten. Ausführen lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/secondary_assignee_write_access.test.sql
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = 91…1 | Firma B = 91…2
-- Admin A  = 92…1
-- PRIMÄR   = 92…2  (Legacy-Zeiger jobs.assigned_to zeigt auf ihn, J1)
-- SEKUNDÄR = 92…3  (nur über job_assignments zugewiesen, J1)
-- FREMD A  = 92…4  (Firma A, J1 NICHT zugewiesen)
-- Admin B  = 92…5 | Employee B = 92…6 (andere Firma)
-- LEGACY   = 92…7  (nur jobs.assigned_to, KEINE job_assignments-Zeile, J2)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000001','authenticated','authenticated','w-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000002','authenticated','authenticated','w-primaer@example.test','{"full_name":"Paula Primaer"}'),
    ('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000003','authenticated','authenticated','w-sekundaer@example.test','{"full_name":"Simon Sekundaer"}'),
    ('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000004','authenticated','authenticated','w-fremd@example.test','{"full_name":"Frida Fremd"}'),
    ('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000005','authenticated','authenticated','w-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000006','authenticated','authenticated','w-b1@example.test','{"full_name":"Bea Fremdfirma"}'),
    ('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000007','authenticated','authenticated','w-legacy@example.test','{"full_name":"Lena Legacy"}');
end $$;

-- Der auth-Trigger handle_new_user ist in der lokalen Baseline nicht
-- enthalten — Profile werden deshalb explizit angelegt.
insert into public.profiles (id, full_name) values
  ('92000000-0000-0000-0000-000000000001','Admin A'),
  ('92000000-0000-0000-0000-000000000002','Paula Primaer'),
  ('92000000-0000-0000-0000-000000000003','Simon Sekundaer'),
  ('92000000-0000-0000-0000-000000000004','Frida Fremd'),
  ('92000000-0000-0000-0000-000000000005','Admin B'),
  ('92000000-0000-0000-0000-000000000006','Bea Fremdfirma'),
  ('92000000-0000-0000-0000-000000000007','Lena Legacy')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('91000000-0000-0000-0000-000000000001','Schreib Firma A','schreib-firma-a-test'),
  ('91000000-0000-0000-0000-000000000002','Schreib Firma B','schreib-firma-b-test');

update public.profiles set company_id='91000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='92000000-0000-0000-0000-000000000001';
update public.profiles set company_id='91000000-0000-0000-0000-000000000001', role='employee', is_active=true where id in
  ('92000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000003','92000000-0000-0000-0000-000000000004','92000000-0000-0000-0000-000000000007');
update public.profiles set company_id='91000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='92000000-0000-0000-0000-000000000005';
update public.profiles set company_id='91000000-0000-0000-0000-000000000002', role='employee', is_active=true where id='92000000-0000-0000-0000-000000000006';

-- Aufträge:
--   J1 = Firma A, single, {PRIMÄR, SEKUNDÄR} über job_assignments
--   J2 = Firma A, single, NUR jobs.assigned_to = LEGACY (keine job_assignments-Zeile)
insert into public.jobs (id, company_id, assigned_to, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time, recurring_days,
                         is_active, created_at, updated_at) values
  ('94000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001',null,'92000000-0000-0000-0000-000000000001','K1','S1','O1','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00'),
  ('94000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000007','92000000-0000-0000-0000-000000000001','K2','S2','O2','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00');

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;

-- Pfad-Helfer für Storage: <company_id>/<job_id>/<datei>
create or replace function pg_temp.p(co uuid, job uuid, datei text) returns text language sql immutable as $f$
  select co::text||'/'||job::text||'/'||datei;
$f$;

insert into storage.buckets (id, name, public)
values ('job-photos','job-photos',false)
on conflict (id) do nothing;

-- ── Zuweisungen auf J1 herstellen ──
-- PRIMÄR zuerst allein (Legacy-Zeiger deckt ihn), dann SEKUNDÄR ergänzen
-- (Legacy-Zeiger bleibt auf PRIMÄR stehen, siehe compat_primary_assignee).
do $$
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('94000000-0000-0000-0000-000000000001',
    array['92000000-0000-0000-0000-000000000002']::uuid[]);
  perform public.set_job_assignments('94000000-0000-0000-0000-000000000001',
    array['92000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000003']::uuid[]);
  execute 'reset role';
end $$;

-- Sanity: Ausgangslage wie angenommen.
do $$
declare v text;
begin
  select assigned_to::text into v from public.jobs where id='94000000-0000-0000-0000-000000000001';
  if v <> '92000000-0000-0000-0000-000000000002' then
    raise exception 'FIXTURE KAPUTT: Legacy-Primaer von J1 ist % statt PRIMAER', v;
  end if;
  if (select count(*) from public.job_assignments where job_id='94000000-0000-0000-0000-000000000001') <> 2 then
    raise exception 'FIXTURE KAPUTT: J1 hat nicht genau 2 Zuweisungen';
  end if;
end $$;


-- =========================================================
-- TEIL A — public.job_comments INSERT
-- =========================================================

-- CASE 1 (Matrix A): PRIMÄR kommentiert J1 -> erlaubt.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    insert into public.job_comments (company_id, job_id, author_id, message)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000002','Von Primaer');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (1,'Matrix A: PRIMAER kommentiert J1','ERLAUBT',v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2 (Matrix B): SEKUNDÄR kommentiert J1 -> erlaubt (DIE ÄNDERUNG).
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    insert into public.job_comments (company_id, job_id, author_id, message)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000003','Von Sekundaer');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (2,'Matrix B: SEKUNDAER kommentiert J1','ERLAUBT',v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3 (Matrix C): nicht zugewiesener Mitarbeiter derselben Firma -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    insert into public.job_comments (company_id, job_id, author_id, message)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000004','Versuch Fremd');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (3,'Matrix C: nicht zugewiesener Mitarbeiter (gleiche Firma) kommentiert J1','ABGELEHNT',v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4 (Matrix D): Mitarbeiter ANDERER Firma -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000006');
  execute 'set local role authenticated';
  begin
    insert into public.job_comments (company_id, job_id, author_id, message)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000006','Versuch Fremdfirma');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (4,'Matrix D: Mitarbeiter ANDERER Firma kommentiert J1','ABGELEHNT',v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- CASE 5 (Matrix E): Admin A kommentiert J1 -> erlaubt.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    insert into public.job_comments (company_id, job_id, author_id, message)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000001','Von Admin');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (5,'Matrix E: Admin A kommentiert J1 (eigene Firma)','ERLAUBT',v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6 (Matrix F): Admin ANDERER Firma -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000005');
  execute 'set local role authenticated';
  begin
    insert into public.job_comments (company_id, job_id, author_id, message)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000005','Versuch Admin Fremdfirma');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (6,'Matrix F: Admin ANDERER Firma kommentiert J1','ABGELEHNT',v);
  raise notice 'CASE 6 -> %', v;
end $$;


-- =========================================================
-- TEIL B — public.job_photos INSERT
-- =========================================================

-- CASE 7 (Matrix A): PRIMÄR legt Foto-Zeile an -> erlaubt.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    insert into public.job_photos (company_id, job_id, uploaded_by, storage_path, file_name)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000002', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','primaer.jpg'),'primaer.jpg');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (7,'Matrix A: PRIMAER legt Foto-Zeile zu J1 an','ERLAUBT',v);
  raise notice 'CASE 7 -> %', v;
end $$;

-- CASE 8 (Matrix B): SEKUNDÄR legt Foto-Zeile an -> erlaubt (DIE ÄNDERUNG).
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    insert into public.job_photos (company_id, job_id, uploaded_by, storage_path, file_name)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000003', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','sekundaer.jpg'),'sekundaer.jpg');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (8,'Matrix B: SEKUNDAER legt Foto-Zeile zu J1 an','ERLAUBT',v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9 (Matrix C): nicht zugewiesener Mitarbeiter (gleiche Firma) -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    insert into public.job_photos (company_id, job_id, uploaded_by, storage_path, file_name)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000004', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','fremd.jpg'),'fremd.jpg');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (9,'Matrix C: nicht zugewiesener Mitarbeiter legt Foto-Zeile zu J1 an','ABGELEHNT',v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10 (Matrix D): Mitarbeiter ANDERER Firma -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000006');
  execute 'set local role authenticated';
  begin
    insert into public.job_photos (company_id, job_id, uploaded_by, storage_path, file_name)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000006', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','fremdfirma.jpg'),'fremdfirma.jpg');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (10,'Matrix D: Mitarbeiter ANDERER Firma legt Foto-Zeile zu J1 an','ABGELEHNT',v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- CASE 11 (Matrix E): Admin A -> erlaubt.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    insert into public.job_photos (company_id, job_id, uploaded_by, storage_path, file_name)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000001', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','admin.jpg'),'admin.jpg');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (11,'Matrix E: Admin A legt Foto-Zeile zu J1 an (eigene Firma)','ERLAUBT',v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- CASE 12 (Matrix F): Admin ANDERER Firma -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000005');
  execute 'set local role authenticated';
  begin
    insert into public.job_photos (company_id, job_id, uploaded_by, storage_path, file_name)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
            '92000000-0000-0000-0000-000000000005', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','adminfremd.jpg'),'adminfremd.jpg');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (12,'Matrix F: Admin ANDERER Firma legt Foto-Zeile zu J1 an','ABGELEHNT',v);
  raise notice 'CASE 12 -> %', v;
end $$;


-- =========================================================
-- TEIL C — public.job_comment_reads INSERT/UPDATE (Ungelesen-Status)
-- =========================================================

-- CASE 13 (Matrix A): PRIMÄR markiert J1 als gelesen -> erlaubt.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    insert into public.job_comment_reads (job_id, user_id, last_seen_at)
    values ('94000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000002', now());
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (13,'Matrix A: PRIMAER schreibt eigenen Read-State fuer J1','ERLAUBT',v);
  raise notice 'CASE 13 -> %', v;
end $$;

-- CASE 14 (Matrix B): SEKUNDÄR markiert J1 als gelesen -> erlaubt (DIE ÄNDERUNG).
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    insert into public.job_comment_reads (job_id, user_id, last_seen_at)
    values ('94000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000003', now());
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (14,'Matrix B: SEKUNDAER schreibt eigenen Read-State fuer J1','ERLAUBT',v);
  raise notice 'CASE 14 -> %', v;
end $$;

-- CASE 15: SEKUNDÄR aktualisiert seinen eigenen Read-State (Upsert-Hälfte 2)
-- -> erlaubt. Setzt CASE 14 voraus.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    insert into public.job_comment_reads (job_id, user_id, last_seen_at)
    values ('94000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000003', now())
    on conflict (job_id, user_id) do update set last_seen_at = excluded.last_seen_at;
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (15,'SEKUNDAER aktualisiert eigenen Read-State fuer J1 (Upsert)','ERLAUBT',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16 (Matrix C): nicht zugewiesener Mitarbeiter (gleiche Firma) -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    insert into public.job_comment_reads (job_id, user_id, last_seen_at)
    values ('94000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000004', now());
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (16,'Matrix C: nicht zugewiesener Mitarbeiter schreibt Read-State fuer J1','ABGELEHNT',v);
  raise notice 'CASE 16 -> %', v;
end $$;

-- CASE 17 (Matrix E): Admin A -> erlaubt.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    insert into public.job_comment_reads (job_id, user_id, last_seen_at)
    values ('94000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001', now());
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (17,'Matrix E: Admin A schreibt eigenen Read-State fuer J1','ERLAUBT',v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- CASE 18 (Matrix F): Admin ANDERER Firma -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000005');
  execute 'set local role authenticated';
  begin
    insert into public.job_comment_reads (job_id, user_id, last_seen_at)
    values ('94000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000005', now());
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (18,'Matrix F: Admin ANDERER Firma schreibt Read-State fuer J1','ABGELEHNT',v);
  raise notice 'CASE 18 -> %', v;
end $$;


-- =========================================================
-- TEIL D — storage.objects INSERT (Bucket job-photos)
-- =========================================================

-- CASE 19 (Matrix A): PRIMÄR lädt hoch -> erlaubt.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','primaer-upload.jpg'),
       '92000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000002');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (19,'Matrix A: PRIMAER laedt Datei in den Auftragsordner von J1 hoch','ERLAUBT',v);
  raise notice 'CASE 19 -> %', v;
end $$;

-- CASE 20 (Matrix B): SEKUNDÄR lädt hoch -> erlaubt (DIE ÄNDERUNG — vor
-- dieser Migration war das per Design ABGELEHNT, siehe
-- job_photo_storage_isolation.test.sql CASE 6 vor 20260826000001).
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','sekundaer-upload.jpg'),
       '92000000-0000-0000-0000-000000000003','92000000-0000-0000-0000-000000000003');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (20,'Matrix B: SEKUNDAER laedt Datei in den Auftragsordner von J1 hoch','ERLAUBT',v);
  raise notice 'CASE 20 -> %', v;
end $$;

-- CASE 21 (Matrix C): nicht zugewiesener Mitarbeiter (gleiche Firma) -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','fremd-upload.jpg'),
       '92000000-0000-0000-0000-000000000004','92000000-0000-0000-0000-000000000004');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (21,'Matrix C: nicht zugewiesener Mitarbeiter laedt in Auftragsordner von J1 hoch','ABGELEHNT',v);
  raise notice 'CASE 21 -> %', v;
end $$;

-- CASE 22 (Matrix D): Mitarbeiter ANDERER Firma -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000006');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','fremdfirma-upload.jpg'),
       '92000000-0000-0000-0000-000000000006','92000000-0000-0000-0000-000000000006');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (22,'Matrix D: Mitarbeiter ANDERER Firma laedt in Auftragsordner von J1 hoch','ABGELEHNT',v);
  raise notice 'CASE 22 -> %', v;
end $$;

-- CASE 23 (Matrix E): Admin A -> erlaubt.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','admin-upload.jpg'),
       '92000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (23,'Matrix E: Admin A laedt in Auftragsordner von J1 hoch (eigene Firma)','ERLAUBT',v);
  raise notice 'CASE 23 -> %', v;
end $$;

-- CASE 24 (Matrix F): Admin ANDERER Firma -> verweigert.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000005');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','adminfremd-upload.jpg'),
       '92000000-0000-0000-0000-000000000005','92000000-0000-0000-0000-000000000005');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (24,'Matrix F: Admin ANDERER Firma laedt in Auftragsordner von J1 hoch','ABGELEHNT',v);
  raise notice 'CASE 24 -> %', v;
end $$;


-- =========================================================
-- TEIL E — Legacy-Fallback (Job OHNE job_assignments-Zeile)
-- =========================================================
-- STEP 4 des Audits verlangt eine explizite Prüfung, ob der Fallback auf
-- jobs.assigned_to für Bestandsaufträge ohne job_assignments-Zeile nötig
-- ist. J2 hat NUR den Legacy-Zeiger (LEGACY, 92…7), keine job_assignments-
-- Zeile. Der ODER-Zweig muss ihn weiterhin abdecken — sonst verlöre ein
-- Bestandsauftrag durch diese Migration Schreibzugriff.

-- CASE 25: LEGACY (nur assigned_to, keine job_assignments-Zeile) kommentiert
-- J2 -> muss weiterhin erlaubt sein (Obermengen-Eigenschaft der Migration).
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000007');
  execute 'set local role authenticated';
  begin
    insert into public.job_comments (company_id, job_id, author_id, message)
    values ('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002',
            '92000000-0000-0000-0000-000000000007','Von Legacy-Primaer ohne assignments-Zeile');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (25,'Legacy-Fallback: Primaer OHNE job_assignments-Zeile kommentiert J2','ERLAUBT',v);
  raise notice 'CASE 25 -> %', v;
end $$;

-- CASE 26: dieselbe Person lädt für J2 ein Foto hoch -> ebenfalls erlaubt.
do $$
declare v text;
begin
  perform pg_temp.act_as('92000000-0000-0000-0000-000000000007');
  execute 'set local role authenticated';
  begin
    insert into storage.objects (bucket_id, name, owner, owner_id) values
      ('job-photos', pg_temp.p('91000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002','legacy-upload.jpg'),
       '92000000-0000-0000-0000-000000000007','92000000-0000-0000-0000-000000000007');
    v := 'ERLAUBT';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (26,'Legacy-Fallback: Primaer OHNE job_assignments-Zeile laedt Foto zu J2 hoch','ERLAUBT',v);
  raise notice 'CASE 26 -> %', v;
end $$;


-- =========================================================
-- TEIL F — Strukturzusicherungen
-- =========================================================

-- CASE 27: append-only bleibt gewahrt — weiterhin keine UPDATE/DELETE-Policy
-- auf job_comments/job_photos.
do $$
declare v text;
begin
  select coalesce(string_agg(distinct tablename||':'||cmd, ',' order by tablename||':'||cmd),'(keine)')
    into v
  from pg_policies
  where schemaname='public' and tablename in ('job_comments','job_photos')
    and cmd in ('UPDATE','DELETE');
  insert into _r values (27,'job_comments/job_photos bleiben ohne UPDATE/DELETE-Policy (append-only)','(keine)',v);
  raise notice 'CASE 27 -> %', v;
end $$;

-- CASE 28: genau die fünf erwarteten Schreib-Policies tragen jetzt den
-- Zuweisungs-Helfer (Gegenprobe zu employee_read_via_assignments.test.sql
-- CASE 21, die vor dieser Migration schreibpolicies_mit_helfer=0 erwartete).
do $$
declare v text;
begin
  select 'schreibpolicies_mit_helfer='||count(*)::text into v
  from pg_policies
  where cmd <> 'SELECT'
    and (coalesce(qual,'') like '%is_assigned_to_job%'
      or coalesce(with_check,'') like '%is_assigned_to_job%');
  insert into _r values (28,'Fuenf Schreib-Policies nutzen jetzt is_assigned_to_job',
    'schreibpolicies_mit_helfer=5',v);
  raise notice 'CASE 28 -> %', v;
end $$;

-- CASE 29: get_unread_comment_job_ids() bleibt UNVERAENDERT (kein Helfer,
-- weiterhin STABLE/DEFINER) — bewusst nicht Teil dieser Migration, siehe
-- deren Kopfkommentar.
do $$
declare v text;
begin
  select 'nutzt_helfer='||(pg_get_functiondef(p.oid) like '%is_assigned_to_job%')::text into v
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='get_unread_comment_job_ids';
  insert into _r values (29,'Ungelesen-RPC unveraendert (bewusst nicht erweitert)','nutzt_helfer=false',v);
  raise notice 'CASE 29 -> %', v;
end $$;


-- =========================================================
-- Ergebnisübersicht
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
    raise exception 'SECONDARY ASSIGNEE WRITE ACCESS TEST: % von % Faellen FEHLGESCHLAGEN', fails, gesamt;
  end if;
  raise notice 'ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
