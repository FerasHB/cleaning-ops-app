-- =========================================================
-- TEST: RPC public.get_company_employee_emails()
-- (Migration 20260912000001_get_company_employee_emails_rpc.sql)
-- =========================================================
-- HINTERGRUND
--   public.profiles hat keine email-Spalte; die E-Mail liegt ausschliesslich
--   in auth.users. getEmployees() (services/jobs/jobs.service.ts) setzte
--   email deshalb bisher hart auf null, obwohl sowohl die Mitarbeiter-Liste
--   (app/(admin-tabs)/employees.tsx) als auch EmployeeDetailScreen bereits
--   eine E-Mail-Zeile rendern.
--
--   Die neue RPC ist SECURITY DEFINER, liest auth.users NUR intern (kein
--   neues Grant fuer den Client) und gibt AUSSCHLIESSLICH (id, email)
--   zurueck. Ihre Sichtbarkeit ist eine ECHTE Verengung des Praedikats der
--   bestehenden Policy "admin read profiles in own company":
--     p.role = 'employee'
--     AND p.company_id = current_user_company_id() AND current_user_role() = 'admin'
--   Kein Firmen-Parameter — die Firma kommt ausschliesslich aus dem
--   aufrufenden JWT ueber current_user_company_id(). Die zusaetzliche
--   role='employee'-Klausel blendet auch andere Admins derselben Firma aus
--   (ein Admin kennt die eigene E-Mail ohnehin bereits ueber die Session).
--
-- WAS DIESER TEST FESTSCHREIBT
--   A. Admin sieht genau die E-Mails der eigenen Firma MIT role=employee
--      (nicht die eigene Admin-Zeile, keine andere Admin-Zeile), keine Zeile
--      fehlt, keine zusaetzliche.
--   B. Employee (nicht admin) bekommt NICHTS zurueck, auch nicht die eigene
--      E-Mail.
--   C. Admin einer ANDEREN Firma bekommt NICHTS von Firma A zurueck (auch
--      nicht die eigene Admin-E-Mail, da role=employee gefordert ist) —
--      keine firmenuebergreifende Leckage in beide Richtungen.
--   D. Inaktiver Admin (is_active=false) bekommt NICHTS zurueck
--      (current_user_role()/current_user_company_id() liefern NULL fuer
--      inaktive Profile — bestehendes fail-closed-Verhalten, hier fuer diese
--      RPC bestaetigt).
--   E. anon hat kein EXECUTE (statisch) UND ein tatsaechlicher Aufruf wird
--      mit 42501 abgelehnt.
--   F. Sicherheitsmodell: SECURITY DEFINER, STABLE, fixierter search_path.
--   G. EXECUTE-Grants: nur authenticated + service_role.
--   H. Rueckgabeform: GENAU zwei Spalten (id, email) — keine weiteren
--      auth.users-Felder werden exponiert.
--   I. auth.users-Berechtigungen unveraendert: authenticated/anon haben
--      weiterhin KEIN SELECT auf auth.users direkt.
--   J. Regression: profiles-RLS-Policies unveraendert vorhanden (Anzahl +
--      Namen identisch zur Baseline-Erwartung).
--
-- DETERMINISMUS: feste Zeitliterale nicht noetig (keine Zeit-Logik). Alle
--   Zugriffe laufen als ECHTE Rollen (SET ROLE authenticated +
--   request.jwt.claims), also ueber denselben Pfad wie die App via PostgREST.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende.
-- =========================================================

begin;

-- ── Fixdaten (eigener ID-Raum 952x/962x, kollisionsfrei zu anderen Test-
--    Suiten und zu echten Daten) ──
-- Firma A = 95200000…0001 | Firma B = 95200000…0002
-- Admin A     = 96200000…0001 ("Gee Admin A", aktiv)
-- Mitarbeiter1= 96200000…0002 ("Gee Mitarbeiter Eins")
-- Mitarbeiter2= 96200000…0003 ("Gee Mitarbeiter Zwei")
-- Admin B     = 96200000…0004 (andere Firma, Gegenprobe)
-- Inaktiv-Admin=96200000…0005 (Firma A, is_active=false)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000001','authenticated','authenticated','gee-adminA@example.test','{"full_name":"Gee Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000002','authenticated','authenticated','gee-m1@example.test','{"full_name":"Gee Mitarbeiter Eins"}'),
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000003','authenticated','authenticated','gee-m2@example.test','{"full_name":"Gee Mitarbeiter Zwei"}'),
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000004','authenticated','authenticated','gee-adminB@example.test','{"full_name":"Gee Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000005','authenticated','authenticated','gee-inaktiv@example.test','{"full_name":"Gee Inaktiv"}');
end $$;

-- handle_new_user ist in der lokalen Baseline nicht enthalten — Profile
-- explizit anlegen (gleiches Vorgehen wie get_job_comments_rpc.test.sql).
insert into public.profiles (id, full_name) values
  ('96200000-0000-0000-0000-000000000001','Gee Admin A'),
  ('96200000-0000-0000-0000-000000000002','Gee Mitarbeiter Eins'),
  ('96200000-0000-0000-0000-000000000003','Gee Mitarbeiter Zwei'),
  ('96200000-0000-0000-0000-000000000004','Gee Admin B'),
  ('96200000-0000-0000-0000-000000000005','Gee Inaktiv')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('95200000-0000-0000-0000-000000000001','GEE Firma A','gee-firma-a-test'),
  ('95200000-0000-0000-0000-000000000002','GEE Firma B','gee-firma-b-test');

update public.profiles set company_id='95200000-0000-0000-0000-000000000001', role='admin',    is_active=true  where id='96200000-0000-0000-0000-000000000001';
update public.profiles set company_id='95200000-0000-0000-0000-000000000001', role='employee', is_active=true  where id in
  ('96200000-0000-0000-0000-000000000002','96200000-0000-0000-0000-000000000003');
update public.profiles set company_id='95200000-0000-0000-0000-000000000002', role='admin',    is_active=true  where id='96200000-0000-0000-0000-000000000004';
update public.profiles set company_id='95200000-0000-0000-0000-000000000001', role='admin',    is_active=false where id='96200000-0000-0000-0000-000000000005';

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;

-- Ruft die RPC als <uid> auf und gibt eine deterministische, sortierte
-- Zusammenfassung "kurz-id:email" zurueck (| getrennt).
create or replace function pg_temp.emails_as(uid uuid) returns text language plpgsql as $f$
declare v text;
begin
  perform pg_temp.act_as(uid);
  execute 'set local role authenticated';
  select string_agg(right(g.id::text,4) || ':' || g.email, ' | ' order by g.id)
    into v
  from public.get_company_employee_emails() g;
  execute 'reset role';
  return coalesce(v, '<leer>');
end $f$;

create or replace function pg_temp.count_emails_as(uid uuid) returns text language plpgsql as $f$
declare n int;
begin
  perform pg_temp.act_as(uid);
  execute 'set local role authenticated';
  select count(*) into n from public.get_company_employee_emails() g;
  execute 'reset role';
  return 'treffer='||n::text;
end $f$;

-- =========================================================
-- CASES
-- =========================================================

-- CASE 1: Admin A sieht GENAU die 2 Mitarbeiter-E-Mails der eigenen Firma
-- (nicht die eigene Admin-Zeile, nicht den inaktiven Admin derselben Firma),
-- korrekt sortiert, keine fremde Zeile.
do $$
declare v text;
begin
  v := pg_temp.emails_as('96200000-0000-0000-0000-000000000001');
  insert into _r values (1,'Admin A: nur Mitarbeiter-E-Mails der eigenen Firma',
    '0002:gee-m1@example.test | 0003:gee-m2@example.test', v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2: Mitarbeiter (nicht admin) bekommt NICHTS zurueck, auch nicht die
-- eigene E-Mail.
do $$
declare v text;
begin
  v := pg_temp.count_emails_as('96200000-0000-0000-0000-000000000002');
  insert into _r values (2,'Mitarbeiter (kein Admin): keine Zeilen','treffer=0', v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3: Admin B (andere Firma, hat KEINE Mitarbeiter, nur sich selbst als
-- Admin) bekommt NICHTS von Firma A UND auch nicht die eigene Admin-E-Mail
-- (role=employee gefordert) -> leer.
do $$
declare v text;
begin
  v := pg_temp.emails_as('96200000-0000-0000-0000-000000000004');
  insert into _r values (3,'Admin B: keine Zeilen (keine Mitarbeiter in Firma B, eigene Admin-Zeile ausgeblendet)','<leer>', v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4: Inaktiver Admin (is_active=false) bekommt NICHTS zurueck —
-- current_user_role()/current_user_company_id() liefern NULL fuer inaktive
-- Profile (bestehendes fail-closed-Verhalten).
do $$
declare v text;
begin
  v := pg_temp.count_emails_as('96200000-0000-0000-0000-000000000005');
  insert into _r values (4,'Inaktiver Admin: keine Zeilen (fail-closed)','treffer=0', v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- CASE 5: anon hat KEIN EXECUTE auf der RPC (statisch).
do $$
declare v text;
begin
  select 'anon='||has_function_privilege('anon','public.get_company_employee_emails()','execute')::text into v;
  insert into _r values (5,'anon hat kein EXECUTE','anon=false', v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6: tatsaechlicher Aufruf als anon wird abgelehnt (42501).
do $$
declare v text;
begin
  begin
    execute 'set local role anon';
    perform * from public.get_company_employee_emails();
    execute 'reset role';
    v := 'KEIN FEHLER';
  exception when insufficient_privilege then
    v := 'ABGELEHNT('||sqlstate||')';
  when others then
    v := 'ABGELEHNT('||sqlstate||')';
  end;
  begin execute 'reset role'; exception when others then null; end;
  insert into _r values (6,'anon-Aufruf der RPC wird abgelehnt','ABGELEHNT(42501)', v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: Sicherheitsmodell — SECURITY DEFINER, STABLE, fixierter search_path.
do $$
declare v text;
begin
  select 'definer='||p.prosecdef::text
       ||',volatil='||p.provolatile::text
       ||',search_path='||(p.proconfig::text like '%search_path=public, pg_temp%')::text
    into v
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='get_company_employee_emails';
  insert into _r values (7,'RPC ist SECURITY DEFINER + STABLE + fixierter search_path',
    'definer=true,volatil=s,search_path=true', v);
  raise notice 'CASE 7 -> %', v;
end $$;

-- CASE 8: EXECUTE-Grants — nur authenticated + service_role.
do $$
declare v text;
begin
  select 'anon='||has_function_privilege('anon','public.get_company_employee_emails()','execute')::text
      ||',auth='||has_function_privilege('authenticated','public.get_company_employee_emails()','execute')::text
      ||',service='||has_function_privilege('service_role','public.get_company_employee_emails()','execute')::text
    into v;
  insert into _r values (8,'EXECUTE nur authenticated + service_role',
    'anon=false,auth=true,service=true', v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9: Rueckgabeform — GENAU zwei Spalten (id uuid, email text), keine
-- weiteren auth.users-Felder. pg_get_function_result() liefert die
-- deklarierte RETURNS-TABLE-Signatur als Text.
do $$
declare v text;
begin
  select pg_get_function_result(p.oid)
    into v
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_company_employee_emails';
  insert into _r values (9,'Rueckgabe: genau (id uuid, email text), keine weiteren Felder',
    'TABLE(id uuid, email text)', v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: auth.users-Berechtigungen unveraendert — authenticated/anon haben
-- weiterhin KEIN direktes SELECT auf auth.users.
do $$
declare v text;
begin
  select 'anon='||has_table_privilege('anon','auth.users','select')::text
      ||',auth='||has_table_privilege('authenticated','auth.users','select')::text
    into v;
  insert into _r values (10,'auth.users bleibt ohne Client-Grant',
    'anon=false,auth=false', v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- CASE 11: Regression — "admin read profiles in own company" existiert
-- weiterhin unveraendert (diese Migration fasst profiles-RLS nicht an).
do $$
declare v text;
begin
  select 'existiert='||(count(*) > 0)::text
    into v
  from pg_policies
  where schemaname='public' and tablename='profiles'
    and policyname='admin read profiles in own company';
  insert into _r values (11,'profiles-Policy "admin read..." unveraendert vorhanden',
    'existiert=true', v);
  raise notice 'CASE 11 -> %', v;
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
    raise exception 'GET_COMPANY_EMPLOYEE_EMAILS RPC TEST: % von % Faellen FEHLGESCHLAGEN', fails, gesamt;
  end if;
  raise notice 'ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
