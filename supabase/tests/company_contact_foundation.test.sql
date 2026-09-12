-- =========================================================
-- TEST: Company Identity & Contact Foundation (Phase 15)
-- Migration 20260912000000_company_contact_foundation.sql
-- =========================================================
-- Deckt ab:
--   Spalten + Defaults (timezone/locale), CHECK-Constraints (E.164-Phone,
--   E-Mail-Format, locale-Whitelist), RPC update_own_company (Rolle, Firmen-
--   Isolation, Feld-Allowlist, Normalisierung, Fehlermeldungen), erweiterte
--   RPC setup_company_for_admin (4-arg + Named-Arg-Rueckwaertskompatibilitaet),
--   EXECUTE-Grants, Sicherheitsmodell, und die Regression, dass
--   enforce_profile_field_guard phone/full_name-Selbstpflege weiterhin
--   erlaubt.
--
-- Alle Zugriffe als ECHTE Rollen (SET ROLE + request.jwt.claims), also ueber
-- denselben Pfad wie die App via PostgREST. Transaktional (BEGIN … ROLLBACK) —
-- keine Rueckstaende, laeuft auch gegen die befuellte Staging-DB.
--
-- Lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/company_contact_foundation.test.sql
-- =========================================================

begin;

-- ── Fixdaten (eigener ID-Raum 9x2000000…) ──
-- Firma A = 95200000…0001 | Firma B = 95200000…0002
-- Admin A    = 96200000…0001
-- Employee A = 96200000…0002
-- Admin B    = 96200000…0003
-- Inaktiv A  = 96200000…0004
-- Ohne Firma = 96200000…0005 (fuer setup_company_for_admin)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000001','authenticated','authenticated','ccf-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000002','authenticated','authenticated','ccf-empA@example.test','{"full_name":"Employee A"}'),
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000003','authenticated','authenticated','ccf-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000004','authenticated','authenticated','ccf-inaktiv@example.test','{"full_name":"Inaktiv A"}'),
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000005','authenticated','authenticated','ccf-nocompany@example.test','{"full_name":"Ohne Firma"}');
end $$;

insert into public.profiles (id, full_name) values
  ('96200000-0000-0000-0000-000000000001','Admin A'),
  ('96200000-0000-0000-0000-000000000002','Employee A'),
  ('96200000-0000-0000-0000-000000000003','Admin B'),
  ('96200000-0000-0000-0000-000000000004','Inaktiv A'),
  ('96200000-0000-0000-0000-000000000005','Ohne Firma')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('95200000-0000-0000-0000-000000000001','CCF Firma A','ccf-firma-a-test'),
  ('95200000-0000-0000-0000-000000000002','CCF Firma B','ccf-firma-b-test');

update public.profiles set company_id='95200000-0000-0000-0000-000000000001', role='admin',    is_active=true  where id='96200000-0000-0000-0000-000000000001';
update public.profiles set company_id='95200000-0000-0000-0000-000000000001', role='employee', is_active=true  where id='96200000-0000-0000-0000-000000000002';
update public.profiles set company_id='95200000-0000-0000-0000-000000000002', role='admin',    is_active=true  where id='96200000-0000-0000-0000-000000000003';
update public.profiles set company_id='95200000-0000-0000-0000-000000000001', role='employee', is_active=false where id='96200000-0000-0000-0000-000000000004';
-- 96200000…0005 bleibt company_id = NULL

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;

-- Fuehrt <sql> als Rolle authenticated fuer <uid> aus und faengt einen Fehler
-- als 'ERR(<sqlstate>):<message-prefix>' ab.
create or replace function pg_temp.try_as(uid uuid, sql text) returns text language plpgsql as $f$
declare v text;
begin
  perform pg_temp.act_as(uid);
  execute 'set local role authenticated';
  begin
    execute sql;
    v := 'OK';
  exception when others then
    v := 'ERR(' || sqlstate || ')';
  end;
  begin execute 'reset role'; exception when others then null; end;
  return v;
end $f$;


-- =========================================================
-- CASES
-- =========================================================

-- CASE 1: neue companies-Spalten existieren.
do $$
declare v text;
begin
  select string_agg(column_name, ',' order by column_name) into v
  from information_schema.columns
  where table_schema='public' and table_name='companies'
    and column_name in ('contact_email','contact_phone','timezone','locale');
  insert into _r values (1,'companies: neue Spalten vorhanden','contact_email,contact_phone,locale,timezone', v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2: profiles.phone_verified_at existiert, nullable.
do $$
declare v text;
begin
  select is_nullable into v from information_schema.columns
  where table_schema='public' and table_name='profiles' and column_name='phone_verified_at';
  insert into _r values (2,'profiles.phone_verified_at vorhanden + nullable','YES', coalesce(v,'<fehlt>'));
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3: timezone-Default = Europe/Berlin, locale-Default = de.
do $$
declare v text;
begin
  insert into public.companies (id,name,slug) values
    ('95200000-0000-0000-0000-0000000000ff','Default Probe','ccf-default-probe-test');
  select timezone||'/'||locale into v from public.companies where id='95200000-0000-0000-0000-0000000000ff';
  insert into _r values (3,'Defaults timezone/locale','Europe/Berlin/de', v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4: CHECK contact_phone — E.164 ok, alles andere abgelehnt (23514).
do $$
declare v1 text; v2 text; v3 text;
begin
  begin update public.companies set contact_phone='+491701234567' where id='95200000-0000-0000-0000-000000000001'; v1:='OK';
  exception when others then v1:='ERR('||sqlstate||')'; end;
  begin update public.companies set contact_phone='0170 1234567' where id='95200000-0000-0000-0000-000000000001'; v2:='OK';
  exception when others then v2:='ERR('||sqlstate||')'; end;
  begin update public.companies set contact_phone=null where id='95200000-0000-0000-0000-000000000001'; v3:='OK';
  exception when others then v3:='ERR('||sqlstate||')'; end;
  insert into _r values (4,'CHECK contact_phone: E.164 ok / roh abgelehnt / NULL ok',
    'OK|ERR(23514)|OK', v1||'|'||v2||'|'||v3);
  raise notice 'CASE 4 -> %|%|%', v1,v2,v3;
end $$;

-- CASE 5: CHECK contact_email — gut ok, kaputt abgelehnt.
do $$
declare v1 text; v2 text;
begin
  begin update public.companies set contact_email='info@firma-a.de' where id='95200000-0000-0000-0000-000000000001'; v1:='OK';
  exception when others then v1:='ERR('||sqlstate||')'; end;
  begin update public.companies set contact_email='kaputt' where id='95200000-0000-0000-0000-000000000001'; v2:='OK';
  exception when others then v2:='ERR('||sqlstate||')'; end;
  insert into _r values (5,'CHECK contact_email: gut ok / kaputt abgelehnt','OK|ERR(23514)', v1||'|'||v2);
  raise notice 'CASE 5 -> %|%', v1,v2;
end $$;

-- CASE 6: CHECK locale — de/en ok, fr abgelehnt.
do $$
declare v1 text; v2 text;
begin
  begin update public.companies set locale='en' where id='95200000-0000-0000-0000-000000000001'; v1:='OK';
  exception when others then v1:='ERR('||sqlstate||')'; end;
  begin update public.companies set locale='fr' where id='95200000-0000-0000-0000-000000000001'; v2:='OK';
  exception when others then v2:='ERR('||sqlstate||')'; end;
  insert into _r values (6,'CHECK locale: en ok / fr abgelehnt','OK|ERR(23514)', v1||'|'||v2);
  raise notice 'CASE 6 -> %|%', v1,v2;
end $$;

-- CASE 7: CHECK profiles.phone — E.164 ok, roh abgelehnt.
do $$
declare v1 text; v2 text;
begin
  begin update public.profiles set phone='+491701112233' where id='96200000-0000-0000-0000-000000000001'; v1:='OK';
  exception when others then v1:='ERR('||sqlstate||')'; end;
  begin update public.profiles set phone='0170/1112233' where id='96200000-0000-0000-0000-000000000001'; v2:='OK';
  exception when others then v2:='ERR('||sqlstate||')'; end;
  insert into _r values (7,'CHECK profiles.phone: E.164 ok / roh abgelehnt','OK|ERR(23514)', v1||'|'||v2);
  raise notice 'CASE 7 -> %|%', v1,v2;
end $$;

-- Kontaktfelder von Firma A fuer die RPC-Faelle zuruecksetzen.
update public.companies set contact_email=null, contact_phone=null, locale='de'
where id='95200000-0000-0000-0000-000000000001';

-- CASE 8: update_own_company — Admin A aktualisiert die eigene Firma;
-- E-Mail wird lowercased, Whitespace getrimmt.
do $$
declare v text;
begin
  perform pg_temp.act_as('96200000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.update_own_company('  Neue Firma A  ', '  INFO@Firma-A.DE ', '+49 170 9999999');
  execute 'reset role';
  select name||'|'||coalesce(contact_email,'<null>')||'|'||coalesce(contact_phone,'<null>')
    into v from public.companies where id='95200000-0000-0000-0000-000000000001';
  insert into _r values (8,'update_own_company: Admin A, Normalisierung',
    'Neue Firma A|info@firma-a.de|+491709999999', v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9: update_own_company — slug/id/created_at bleiben unberuehrt.
do $$
declare v text;
begin
  select (slug = 'ccf-firma-a-test')::text into v
  from public.companies where id='95200000-0000-0000-0000-000000000001';
  insert into _r values (9,'update_own_company: slug unveraendert','true', v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: update_own_company — Employee A abgelehnt (42501).
do $$
declare v text;
begin
  v := pg_temp.try_as('96200000-0000-0000-0000-000000000002',
    $q$ select public.update_own_company('Hack', null, null) $q$);
  insert into _r values (10,'update_own_company: Employee abgelehnt','ERR(42501)', v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- CASE 11: update_own_company — Admin B trifft NUR Firma B, Firma A unveraendert.
do $$
declare v text;
begin
  perform pg_temp.act_as('96200000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  perform public.update_own_company('Firma B neu', 'b@firma-b.de', null);
  execute 'reset role';
  select
    (select name from public.companies where id='95200000-0000-0000-0000-000000000002') || ' / A=' ||
    (select name from public.companies where id='95200000-0000-0000-0000-000000000001')
    into v;
  insert into _r values (11,'update_own_company: Firmen-Isolation (B trifft nicht A)',
    'Firma B neu / A=Neue Firma A', v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- CASE 12: update_own_company — ungueltige Telefonnummer, klare Meldung (P0001).
do $$
declare v text;
begin
  v := pg_temp.try_as('96200000-0000-0000-0000-000000000001',
    $q$ select public.update_own_company('Firma A', null, '12345') $q$);
  insert into _r values (12,'update_own_company: ungueltige Telefonnummer abgelehnt','ERR(P0001)', v);
  raise notice 'CASE 12 -> %', v;
end $$;

-- CASE 13: update_own_company — inaktiver Nutzer (current_user_company_id NULL) abgelehnt.
do $$
declare v text;
begin
  v := pg_temp.try_as('96200000-0000-0000-0000-000000000004',
    $q$ select public.update_own_company('Firma A', null, null) $q$);
  insert into _r values (13,'update_own_company: inaktiver Nutzer abgelehnt','ERR(42501)', v);
  raise notice 'CASE 13 -> %', v;
end $$;

-- CASE 14: update_own_company — anon abgelehnt.
do $$
declare v text;
begin
  begin
    execute 'set local role anon';
    perform public.update_own_company('x', null, null);
    v := 'KEIN FEHLER';
  exception when others then v := 'ERR('||sqlstate||')';
  end;
  begin execute 'reset role'; exception when others then null; end;
  insert into _r values (14,'update_own_company: anon abgelehnt','ERR(42501)', v);
  raise notice 'CASE 14 -> %', v;
end $$;

-- CASE 15: setup_company_for_admin (4-arg) — Nutzer ohne Firma legt eine an,
-- inkl. Kontaktdaten + eigener Telefonnummer.
do $$
declare v text; v_cid uuid;
begin
  perform pg_temp.act_as('96200000-0000-0000-0000-000000000005');
  execute 'set local role authenticated';
  select public.setup_company_for_admin('Setup Probe GmbH', 'kontakt@setup.de', '+49 30 1234567', '+49 171 7654321')
    into v_cid;
  execute 'reset role';
  select c.name||'|'||coalesce(c.contact_email,'<null>')||'|'||coalesce(c.contact_phone,'<null>')||'|'||coalesce(p.phone,'<null>')||'|'||p.role::text
    into v
  from public.companies c, public.profiles p
  where c.id = v_cid and p.id='96200000-0000-0000-0000-000000000005';
  insert into _r values (15,'setup_company_for_admin: Firma + Kontakt + Admin-Phone + Rolle',
    'Setup Probe GmbH|kontakt@setup.de|+49301234567|+491717654321|admin', v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16: setup_company_for_admin — Named-Arg-Rueckwaertskompatibilitaet
-- (nur company_name, wie services/company/setupCompanyForAdmin.ts es heute ruft).
do $$
declare v text;
begin
  -- Der Nutzer aus CASE 15 hat jetzt eine Firma -> "already belongs" erwartet,
  -- was BEWEIST, dass der 1-Named-Arg-Aufruf die 4-arg-Funktion trifft.
  v := pg_temp.try_as('96200000-0000-0000-0000-000000000005',
    $q$ select public.setup_company_for_admin(company_name => 'Zweite Firma') $q$);
  insert into _r values (16,'setup_company_for_admin: Named-Arg { company_name } trifft 4-arg-Fn','ERR(P0001)', v);
  raise notice 'CASE 16 -> %', v;
end $$;

-- CASE 17: setup_company_for_admin — ungueltige Admin-Telefonnummer abgelehnt.
do $$
declare v text;
begin
  -- frischer Nutzer ohne Firma
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','96200000-0000-0000-0000-000000000006','authenticated','authenticated','ccf-nc2@example.test','{"full_name":"NC2"}');
  insert into public.profiles (id, full_name) values ('96200000-0000-0000-0000-000000000006','NC2') on conflict (id) do nothing;
  v := pg_temp.try_as('96200000-0000-0000-0000-000000000006',
    $q$ select public.setup_company_for_admin('Firma X', null, null, 'abc') $q$);
  insert into _r values (17,'setup_company_for_admin: ungueltige Admin-Phone abgelehnt','ERR(P0001)', v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- CASE 18: EXECUTE-Grants — anon=false, authenticated=true fuer beide RPCs.
do $$
declare v text;
begin
  select
    'uoc_anon='||has_function_privilege('anon','public.update_own_company(text,text,text)','execute')::text
    ||',uoc_auth='||has_function_privilege('authenticated','public.update_own_company(text,text,text)','execute')::text
    ||',sca_anon='||has_function_privilege('anon','public.setup_company_for_admin(text,text,text,text)','execute')::text
    ||',sca_auth='||has_function_privilege('authenticated','public.setup_company_for_admin(text,text,text,text)','execute')::text
    into v;
  insert into _r values (18,'EXECUTE-Grants der RPCs',
    'uoc_anon=false,uoc_auth=true,sca_anon=false,sca_auth=true', v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- CASE 19: Sicherheitsmodell — beide RPCs SECURITY DEFINER.
do $$
declare v text;
begin
  select string_agg(p.proname||'='||p.prosecdef::text, ',' order by p.proname) into v
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('update_own_company','setup_company_for_admin');
  insert into _r values (19,'RPCs sind SECURITY DEFINER','setup_company_for_admin=true,update_own_company=true', v);
  raise notice 'CASE 19 -> %', v;
end $$;

-- CASE 20: Regression enforce_profile_field_guard — Employee darf phone +
-- full_name der EIGENEN Zeile weiter selbst setzen, role aber nicht.
do $$
declare v1 text; v2 text;
begin
  v1 := pg_temp.try_as('96200000-0000-0000-0000-000000000002',
    $q$ update public.profiles set full_name='Employee A neu', phone='+491702223344' where id='96200000-0000-0000-0000-000000000002' $q$);
  v2 := pg_temp.try_as('96200000-0000-0000-0000-000000000002',
    $q$ update public.profiles set role='admin' where id='96200000-0000-0000-0000-000000000002' $q$);
  insert into _r values (20,'Guard-Regression: Selbstpflege phone/full_name ok, role blockiert',
    'OK|ERR(42501)', v1||'|'||v2);
  raise notice 'CASE 20 -> %|%', v1,v2;
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
    raise exception 'COMPANY CONTACT FOUNDATION TEST: % von % Faellen FEHLGESCHLAGEN', fails, gesamt;
  end if;
  raise notice 'ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
