-- =========================================================
-- TEST: RPC public.get_job_comments(p_job_id uuid)
-- (Migration 20260911000000_get_job_comments_rpc.sql)
-- =========================================================
-- HINTERGRUND
--   getJobComments() lud den Autornamen bisher ueber den PostgREST-Embed
--   job_comments -> profiles:author_id(full_name). Der Embed laeuft unter der
--   RLS DES AUFRUFERS; die einzige profiles-SELECT-Policy eines Mitarbeiters
--   ist "employee read own profile" (id = auth.uid()). Folge: ein Mitarbeiter
--   sah bei einem Admin- oder Kollegen-Kommentar den Namen "Unbekannt"
--   (authorName = null -> UI-Fallback). Ein Admin nicht (Policy
--   "admin read profiles in own company").
--
--   Die neue RPC ist SECURITY DEFINER und liest profiles ungefiltert, gibt
--   aber NUR (id, job_id, author_id, author_name, message, created_at) zurueck
--   und koppelt ihre Sichtbarkeit EXAKT an die beiden bestehenden
--   job_comments-SELECT-Policies:
--     j.company_id = current_user_company_id()
--     AND ( role='admin'
--           OR (role='employee' AND (jobs.assigned_to = auth.uid()
--                                    OR is_assigned_to_job(job))) )
--
-- WAS DIESER TEST FESTSCHREIBT
--   A. Admin sieht Autornamen (eigen + Mitarbeiter).
--   B. Zugewiesener Mitarbeiter (Legacy-Primaer) sieht den ADMIN-Namen
--      (= der eigentliche Fix) sowie eigenen + Kollegen-Namen.
--   C. Sekundaer Zugewiesener (nur job_assignments) sieht alle Namen.
--   D. Mitarbeiter/Admin einer ANDEREN Firma bekommt fuer den Job NICHTS
--      zurueck (keine Namen, keine Nachrichten — keine firmenuebergreifende
--      Leckage).
--   E. anon kann die RPC nicht ausfuehren (kein EXECUTE + tatsaechlicher
--      Aufruf wird mit 42501 abgelehnt).
--   F. Authentifizierter, dem Job NICHT zugewiesener Mitarbeiter derselben
--      Firma bekommt NICHTS zurueck.
--   G. Geloeschter Autor (author_id NULL) -> Kommentar bleibt, author_name
--      NULL (UI zeigt weiter "Unbekannt").
--   H. Sicherheitsmodell: SECURITY DEFINER, STABLE, fixierter search_path,
--      EXECUTE nur authenticated + service_role.
--   I. Regression: get_unread_comment_job_ids() bleibt aufrufbar.
--
-- DETERMINISMUS: feste Zeitliterale. Alle Zugriffe laufen als ECHTE Rollen
--   (SET ROLE authenticated + request.jwt.claims), also ueber denselben Pfad
--   wie die App via PostgREST.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende. Lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/get_job_comments_rpc.test.sql
-- =========================================================

begin;

-- ── Fixdaten (eigener ID-Raum 9x1000000…, damit der Test auch gegen eine
--    befuellte Umgebung wie Staging kollisionsfrei laeuft) ──
-- Firma A = 95100000…0001 | Firma B = 95100000…0002
-- Admin A  = 96100000…0001 ("Feras Hababa")
-- PRIMAER  = 96100000…0002 ("Emil Primaer")   jobs.assigned_to von J1 + Zuweisung
-- SEKUNDAER= 96100000…0003 ("Sina Sekundaer") NUR job_assignments auf J1
-- FREMD A  = 96100000…0004 ("Uwe Unassigned") Firma A, J1 nicht zugewiesen
-- Admin B  = 96100000…0005 | Employee B = 96100000…0006 (andere Firma)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','96100000-0000-0000-0000-000000000001','authenticated','authenticated','gjc-adminA@example.test','{"full_name":"Feras Hababa"}'),
    ('00000000-0000-0000-0000-000000000000','96100000-0000-0000-0000-000000000002','authenticated','authenticated','gjc-primaer@example.test','{"full_name":"Emil Primaer"}'),
    ('00000000-0000-0000-0000-000000000000','96100000-0000-0000-0000-000000000003','authenticated','authenticated','gjc-sekundaer@example.test','{"full_name":"Sina Sekundaer"}'),
    ('00000000-0000-0000-0000-000000000000','96100000-0000-0000-0000-000000000004','authenticated','authenticated','gjc-fremd@example.test','{"full_name":"Uwe Unassigned"}'),
    ('00000000-0000-0000-0000-000000000000','96100000-0000-0000-0000-000000000005','authenticated','authenticated','gjc-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','96100000-0000-0000-0000-000000000006','authenticated','authenticated','gjc-b1@example.test','{"full_name":"Bea Fremdfirma"}');
end $$;

-- handle_new_user ist in der lokalen Baseline nicht enthalten — Profile
-- explizit anlegen (gleiches Vorgehen wie secondary_assignee_unread_comments).
insert into public.profiles (id, full_name) values
  ('96100000-0000-0000-0000-000000000001','Feras Hababa'),
  ('96100000-0000-0000-0000-000000000002','Emil Primaer'),
  ('96100000-0000-0000-0000-000000000003','Sina Sekundaer'),
  ('96100000-0000-0000-0000-000000000004','Uwe Unassigned'),
  ('96100000-0000-0000-0000-000000000005','Admin B'),
  ('96100000-0000-0000-0000-000000000006','Bea Fremdfirma')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('95100000-0000-0000-0000-000000000001','GJC Firma A','gjc-firma-a-test'),
  ('95100000-0000-0000-0000-000000000002','GJC Firma B','gjc-firma-b-test');

update public.profiles set company_id='95100000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='96100000-0000-0000-0000-000000000001';
update public.profiles set company_id='95100000-0000-0000-0000-000000000001', role='employee', is_active=true where id in
  ('96100000-0000-0000-0000-000000000002','96100000-0000-0000-0000-000000000003','96100000-0000-0000-0000-000000000004');
update public.profiles set company_id='95100000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='96100000-0000-0000-0000-000000000005';
update public.profiles set company_id='95100000-0000-0000-0000-000000000002', role='employee', is_active=true where id='96100000-0000-0000-0000-000000000006';

-- Auftraege: J1 = Firma A (Legacy-Primaer + Sekundaer via job_assignments),
--            J2 = Firma B (fuer die firmenuebergreifende Gegenprobe)
insert into public.jobs (id, company_id, assigned_to, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time, recurring_days,
                         is_active, created_at, updated_at) values
  ('97100000-0000-0000-0000-000000000001','95100000-0000-0000-0000-000000000001',null,'96100000-0000-0000-0000-000000000001','K1','S1','O1','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00'),
  ('97100000-0000-0000-0000-000000000002','95100000-0000-0000-0000-000000000002',null,'96100000-0000-0000-0000-000000000005','K2','S2','O2','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00');

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;

-- Ruft die RPC als <uid> (Rolle authenticated) fuer <job> auf und gibt eine
-- deterministische, sortierte Zusammenfassung "author_id-kurz:author_name"
-- je Zeile zurueck (| getrennt). So deckt EIN Vergleich Sichtbarkeit,
-- Namensaufloesung UND Reihenfolge ab.
create or replace function pg_temp.comments_as(uid uuid, job uuid) returns text language plpgsql as $f$
declare v text;
begin
  perform pg_temp.act_as(uid);
  execute 'set local role authenticated';
  select string_agg(
           right(coalesce(g.author_id::text,'NULL'),4) || ':' || coalesce(g.author_name,'<null>'),
           ' | ' order by g.created_at, g.id)
    into v
  from public.get_job_comments(job) g;
  execute 'reset role';
  return coalesce(v, '<leer>');
end $f$;

-- Zaehlt die von der RPC zurueckgegebenen Zeilen als <uid> fuer <job>.
create or replace function pg_temp.count_as(uid uuid, job uuid) returns text language plpgsql as $f$
declare n int;
begin
  perform pg_temp.act_as(uid);
  execute 'set local role authenticated';
  select count(*) into n from public.get_job_comments(job) g;
  execute 'reset role';
  return 'treffer='||n::text;
end $f$;

-- ── Zuweisungen: PRIMAER zuerst allein (setzt jobs.assigned_to), dann
--    SEKUNDAER ergaenzen (Zeiger bleibt auf PRIMAER, siehe compat_primary_assignee).
do $$
begin
  perform pg_temp.act_as('96100000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('97100000-0000-0000-0000-000000000001',
    array['96100000-0000-0000-0000-000000000002']::uuid[]);
  perform public.set_job_assignments('97100000-0000-0000-0000-000000000001',
    array['96100000-0000-0000-0000-000000000002','96100000-0000-0000-0000-000000000003']::uuid[]);
  execute 'reset role';
end $$;

-- Sanity: Fixture wie angenommen.
do $$
begin
  if (select assigned_to::text from public.jobs where id='97100000-0000-0000-0000-000000000001')
     <> '96100000-0000-0000-0000-000000000002' then
    raise exception 'FIXTURE KAPUTT: Legacy-Primaer von J1 falsch';
  end if;
  if (select count(*) from public.job_assignments where job_id='97100000-0000-0000-0000-000000000001') <> 2 then
    raise exception 'FIXTURE KAPUTT: J1 hat nicht genau 2 Zuweisungen';
  end if;
end $$;

-- ── Kommentare auf J1 (chronologisch gemischt) + einer auf J2 (Firma B) ──
--   09:00 Admin A     98100000…0001
--   09:30 PRIMAER     98100000…0002
--   10:00 SEKUNDAER   98100000…0003
--   10:30 (Autor wird gleich auf NULL gesetzt = geloeschtes Konto)  98100000…0004
insert into public.job_comments (id, company_id, job_id, author_id, message, created_at) values
  ('98100000-0000-0000-0000-000000000001','95100000-0000-0000-0000-000000000001','97100000-0000-0000-0000-000000000001','96100000-0000-0000-0000-000000000001','Admin-Kommentar auf J1',      timestamptz '2026-01-01 09:00+00'),
  ('98100000-0000-0000-0000-000000000002','95100000-0000-0000-0000-000000000001','97100000-0000-0000-0000-000000000001','96100000-0000-0000-0000-000000000002','Primaer-Kommentar auf J1',    timestamptz '2026-01-01 09:30+00'),
  ('98100000-0000-0000-0000-000000000003','95100000-0000-0000-0000-000000000001','97100000-0000-0000-0000-000000000001','96100000-0000-0000-0000-000000000003','Sekundaer-Kommentar auf J1',  timestamptz '2026-01-01 10:00+00'),
  ('98100000-0000-0000-0000-000000000004','95100000-0000-0000-0000-000000000001','97100000-0000-0000-0000-000000000001','96100000-0000-0000-0000-000000000004','Kommentar von geloeschtem Konto', timestamptz '2026-01-01 10:30+00'),
  ('98100000-0000-0000-0000-000000000005','95100000-0000-0000-0000-000000000002','97100000-0000-0000-0000-000000000002','96100000-0000-0000-0000-000000000005','Admin-B-Kommentar auf J2',    timestamptz '2026-01-01 09:00+00');

-- "Autor geloescht": author_id -> NULL (entspricht FK on delete set null).
update public.job_comments set author_id = null where id='98100000-0000-0000-0000-000000000004';


-- =========================================================
-- CASES
-- =========================================================

-- CASE 1: Admin A sieht ALLE Autornamen auf J1 (eigen + Mitarbeiter),
-- geloeschter Autor als <null>, korrekte Reihenfolge.
do $$
declare v text;
begin
  v := pg_temp.comments_as('96100000-0000-0000-0000-000000000001','97100000-0000-0000-0000-000000000001');
  insert into _r values (1,'Admin A: alle Autornamen auf J1',
    '0001:Feras Hababa | 0002:Emil Primaer | 0003:Sina Sekundaer | NULL:<null>', v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2 (DER FIX): zugewiesener Mitarbeiter (Legacy-Primaer) sieht den
-- ADMIN-Namen "Feras Hababa" statt "Unbekannt" — und eigenen + Kollegen-Namen.
do $$
declare v text;
begin
  v := pg_temp.comments_as('96100000-0000-0000-0000-000000000002','97100000-0000-0000-0000-000000000001');
  insert into _r values (2,'PRIMAER-Mitarbeiter: sieht Admin- + Kollegen-Namen',
    '0001:Feras Hababa | 0002:Emil Primaer | 0003:Sina Sekundaer | NULL:<null>', v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3: sekundaer Zugewiesener (NUR job_assignments) sieht ebenfalls alle Namen.
do $$
declare v text;
begin
  v := pg_temp.comments_as('96100000-0000-0000-0000-000000000003','97100000-0000-0000-0000-000000000001');
  insert into _r values (3,'SEKUNDAER-Mitarbeiter: sieht Admin- + Kollegen-Namen',
    '0001:Feras Hababa | 0002:Emil Primaer | 0003:Sina Sekundaer | NULL:<null>', v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4: Mitarbeiter derselben Firma, dem J1 NICHT zugewiesen ist -> NICHTS.
do $$
declare v text;
begin
  v := pg_temp.count_as('96100000-0000-0000-0000-000000000004','97100000-0000-0000-0000-000000000001');
  insert into _r values (4,'FREMD (Firma A, nicht zugewiesen): keine Zeilen','treffer=0', v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- CASE 5: Mitarbeiter einer ANDEREN Firma -> NICHTS fuer J1 (keine Namen,
-- keine Nachrichten firmenuebergreifend).
do $$
declare v text;
begin
  v := pg_temp.count_as('96100000-0000-0000-0000-000000000006','97100000-0000-0000-0000-000000000001');
  insert into _r values (5,'Employee Firma B: keine Zeilen fuer Firma-A-Job','treffer=0', v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6: Admin einer ANDEREN Firma -> NICHTS fuer J1.
do $$
declare v text;
begin
  v := pg_temp.count_as('96100000-0000-0000-0000-000000000005','97100000-0000-0000-0000-000000000001');
  insert into _r values (6,'Admin Firma B: keine Zeilen fuer Firma-A-Job','treffer=0', v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: geloeschter Autor -> Kommentar bleibt sichtbar, author_name NULL.
-- (bereits in CASE 1-3 als "NULL:<null>" enthalten; hier explizit als
--  eigenstaendige Zusicherung fuer den PRIMAER.)
do $$
declare v text;
begin
  perform pg_temp.act_as('96100000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  select coalesce(g.author_name,'<null>')||'/'||g.message
    into v
  from public.get_job_comments('97100000-0000-0000-0000-000000000001') g
  where g.id='98100000-0000-0000-0000-000000000004';
  execute 'reset role';
  insert into _r values (7,'Geloeschter Autor: Kommentar bleibt, Name NULL',
    '<null>/Kommentar von geloeschtem Konto', coalesce(v,'<fehlt>'));
  raise notice 'CASE 7 -> %', v;
end $$;

-- CASE 8: anon hat KEIN EXECUTE auf der RPC.
do $$
declare v text;
begin
  select 'anon='||has_function_privilege('anon','public.get_job_comments(uuid)','execute')::text into v;
  insert into _r values (8,'anon hat kein EXECUTE','anon=false', v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9: tatsaechlicher Aufruf als anon wird abgelehnt (42501).
do $$
declare v text;
begin
  begin
    execute 'set local role anon';
    perform * from public.get_job_comments('97100000-0000-0000-0000-000000000001');
    execute 'reset role';
    v := 'KEIN FEHLER';
  exception when insufficient_privilege then
    v := 'ABGELEHNT('||sqlstate||')';
  when others then
    v := 'ABGELEHNT('||sqlstate||')';
  end;
  -- role nach evtl. Subtransaktions-Rollback wieder sicher zuruecksetzen
  begin execute 'reset role'; exception when others then null; end;
  insert into _r values (9,'anon-Aufruf der RPC wird abgelehnt','ABGELEHNT(42501)', v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: Sicherheitsmodell — SECURITY DEFINER, STABLE, fixierter search_path.
do $$
declare v text;
begin
  select 'definer='||p.prosecdef::text
       ||',volatil='||p.provolatile::text
       ||',search_path='||(p.proconfig::text like '%search_path=public, pg_temp%')::text
    into v
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='get_job_comments';
  insert into _r values (10,'RPC ist SECURITY DEFINER + STABLE + fixierter search_path',
    'definer=true,volatil=s,search_path=true', v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- CASE 11: EXECUTE-Grants — nur authenticated + service_role.
do $$
declare v text;
begin
  select 'anon='||has_function_privilege('anon','public.get_job_comments(uuid)','execute')::text
      ||',auth='||has_function_privilege('authenticated','public.get_job_comments(uuid)','execute')::text
      ||',service='||has_function_privilege('service_role','public.get_job_comments(uuid)','execute')::text
    into v;
  insert into _r values (11,'EXECUTE nur authenticated + service_role',
    'anon=false,auth=true,service=true', v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- CASE 12: Regression — get_unread_comment_job_ids() bleibt als authenticated
-- aufrufbar (keine Kollateral-Aenderung an der Ungelesen-RPC).
do $$
declare v text; n int;
begin
  perform pg_temp.act_as('96100000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    select count(*) into n from public.get_unread_comment_job_ids() g;
    v := 'ok';
  exception when others then
    v := 'FEHLER('||sqlstate||')';
  end;
  execute 'reset role';
  insert into _r values (12,'Regression: get_unread_comment_job_ids weiterhin aufrufbar','ok', v);
  raise notice 'CASE 12 -> %', v;
end $$;

-- CASE 13: Reihenfolge + Vollstaendigkeit — PRIMAER bekommt genau 4 Zeilen auf J1.
do $$
declare v text;
begin
  v := pg_temp.count_as('96100000-0000-0000-0000-000000000002','97100000-0000-0000-0000-000000000001');
  insert into _r values (13,'PRIMAER bekommt alle 4 J1-Kommentare','treffer=4', v);
  raise notice 'CASE 13 -> %', v;
end $$;

-- CASE 14: Nachrichteninhalt leckt NICHT firmenuebergreifend — Employee B
-- bekommt fuer J1 keinerlei message-Text (Gegenprobe zu CASE 5 auf Inhaltsebene).
do $$
declare v text;
begin
  perform pg_temp.act_as('96100000-0000-0000-0000-000000000006');
  execute 'set local role authenticated';
  select coalesce(string_agg(g.message,','),'<leer>')
    into v
  from public.get_job_comments('97100000-0000-0000-0000-000000000001') g;
  execute 'reset role';
  insert into _r values (14,'Employee Firma B sieht keinen J1-Nachrichtentext','<leer>', v);
  raise notice 'CASE 14 -> %', v;
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
    raise exception 'GET_JOB_COMMENTS RPC TEST: % von % Faellen FEHLGESCHLAGEN', fails, gesamt;
  end if;
  raise notice 'ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
