-- =========================================================
-- TEST: Profile Locale Foundation (Phase E)
-- Migration 20260915000000_profile_locale_foundation.sql
-- =========================================================
-- Deckt ab:
--   profiles.locale — Spalte + Default 'de', CHECK-Whitelist (de/en/ar/tr),
--   Selbstpflege ueber die bestehende "update own profile"-RLS-Policy
--   (KEINE neue Policy noetig), Ablehnung fremder Locale-Updates (RLS),
--   und dass claim_notification_deliveries() die Empfaengersprache als
--   recipient_locale mitliefert (fuer dispatch-notifications).
--
-- Alle Zugriffe als ECHTE Rollen (SET ROLE + request.jwt.claims), also ueber
-- denselben Pfad wie die App via PostgREST. Transaktional (BEGIN … ROLLBACK) —
-- keine Rueckstaende, laeuft auch gegen die befuellte Staging-DB.
--
-- Lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/profile_locale.test.sql
-- =========================================================

begin;

-- ── Fixdaten (eigener ID-Raum 9x3000000…) ──
-- Firma A = 95300000…0001
-- Nutzer A (self-update)   = 96300000…0001
-- Nutzer B (fremde Zeile)  = 96300000…0002
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','96300000-0000-0000-0000-000000000001','authenticated','authenticated','pl-userA@example.test','{"full_name":"User A"}'),
    ('00000000-0000-0000-0000-000000000000','96300000-0000-0000-0000-000000000002','authenticated','authenticated','pl-userB@example.test','{"full_name":"User B"}');
end $$;

insert into public.profiles (id, full_name) values
  ('96300000-0000-0000-0000-000000000001','User A'),
  ('96300000-0000-0000-0000-000000000002','User B')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('95300000-0000-0000-0000-000000000001','PL Firma A','pl-firma-a-test');

update public.profiles set company_id='95300000-0000-0000-0000-000000000001', role='employee', is_active=true
where id in ('96300000-0000-0000-0000-000000000001','96300000-0000-0000-0000-000000000002');

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

-- CASE 1: Spalte existiert, NOT NULL, Default 'de'.
do $$
declare v text;
begin
  select is_nullable||'/'||column_default into v
  from information_schema.columns
  where table_schema='public' and table_name='profiles' and column_name='locale';
  insert into _r values (1,'profiles.locale: NOT NULL + Default de','NO/''de''::text', v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2: neue Zeile ohne explizite locale -> Default 'de'.
do $$
declare v text;
begin
  select locale into v from public.profiles where id='96300000-0000-0000-0000-000000000001';
  insert into _r values (2,'Default-Wert fuer bestehende Zeile','de', v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3: CHECK locale — en/ar/tr erlaubt, ungueltiger Wert abgelehnt (23514).
do $$
declare v1 text; v2 text; v3 text; v4 text;
begin
  begin update public.profiles set locale='en' where id='96300000-0000-0000-0000-000000000001'; v1:='OK';
  exception when others then v1:='ERR('||sqlstate||')'; end;
  begin update public.profiles set locale='ar' where id='96300000-0000-0000-0000-000000000001'; v2:='OK';
  exception when others then v2:='ERR('||sqlstate||')'; end;
  begin update public.profiles set locale='tr' where id='96300000-0000-0000-0000-000000000001'; v3:='OK';
  exception when others then v3:='ERR('||sqlstate||')'; end;
  begin update public.profiles set locale='fr' where id='96300000-0000-0000-0000-000000000001'; v4:='OK';
  exception when others then v4:='ERR('||sqlstate||')'; end;
  insert into _r values (3,'CHECK locale: en/ar/tr ok, fr abgelehnt',
    'OK|OK|OK|ERR(23514)', v1||'|'||v2||'|'||v3||'|'||v4);
  raise notice 'CASE 3 -> %|%|%|%', v1,v2,v3,v4;
end $$;

-- Locale von User A fuer die folgenden Faelle zuruecksetzen.
update public.profiles set locale='de' where id='96300000-0000-0000-0000-000000000001';

-- CASE 4: Selbst-Update auf gueltige Locale -> ERLAUBT (bestehende RLS-Policy
-- "update own profile", KEINE neue Policy noetig).
do $$
declare v text;
begin
  v := pg_temp.try_as('96300000-0000-0000-0000-000000000001',
    $q$ update public.profiles set locale='tr' where id='96300000-0000-0000-0000-000000000001' $q$);
  insert into _r values (4,'Self-Update locale=tr (eigene Zeile)','OK', v);
  raise notice 'CASE 4 -> %', v;
end $$;

do $$
declare v text;
begin
  select locale into v from public.profiles where id='96300000-0000-0000-0000-000000000001';
  insert into _r values (5,'Self-Update: Wert tatsaechlich persistiert','tr', v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6: Selbst-Update auf ungueltige Locale -> CHECK-Constraint blockt (23514),
-- auch ueber den authenticated-Pfad (nicht nur als postgres in CASE 3).
do $$
declare v text;
begin
  v := pg_temp.try_as('96300000-0000-0000-0000-000000000001',
    $q$ update public.profiles set locale='xx' where id='96300000-0000-0000-0000-000000000001' $q$);
  insert into _r values (6,'Self-Update locale=xx (ungueltig)','ERR(23514)', v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: User A versucht, die locale von User B (fremde Zeile) zu aendern
-- -> RLS blockt (0 Zeilen, kein Fehler — "update own profile" filtert per USING).
do $$
declare rc int; v text;
begin
  perform pg_temp.act_as('96300000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  update public.profiles set locale='en' where id='96300000-0000-0000-0000-000000000002';
  get diagnostics rc = row_count;
  execute 'reset role';
  v := case when rc = 0 then 'NOOP(0 rows)' else 'ALLOWED('||rc||' rows)' end;
  insert into _r values (7,'User A aendert locale von User B (fremd)','NOOP(0 rows)', v);
  raise notice 'CASE 7 -> %', v;
end $$;

do $$
declare v text;
begin
  select locale into v from public.profiles where id='96300000-0000-0000-0000-000000000002';
  insert into _r values (8,'User B locale unveraendert (Default de)','de', v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- CASE 9: claim_notification_deliveries liefert recipient_locale in der
-- Rueckgabe-Signatur (Spalte existiert in returns table).
do $$
declare v text;
begin
  select case when count(*) = 1 then 'PRESENT' else 'MISSING' end into v
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_notification_deliveries'
    and pg_get_function_result(p.oid) like '%recipient_locale text%';
  insert into _r values (9,'claim_notification_deliveries: recipient_locale in Signatur','PRESENT', v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: claim_notification_deliveries liefert TATSAECHLICH die locale des
-- Empfaengers (End-to-End ueber einen echten job_assigned-Outbox-Eintrag).
do $$
declare v text; v_job_id uuid := '95300000-0000-0000-0000-0000000000aa';
begin
  update public.profiles set locale='ar' where id='96300000-0000-0000-0000-000000000002';

  insert into public.jobs (id, company_id, customer_name, location_address, service_name, status, job_type, is_active)
  values (v_job_id, '95300000-0000-0000-0000-000000000001', 'PL Kunde', 'PL Ort', 'PL Leistung', 'open', 'single', true);

  insert into public.notification_outbox (event_type, company_id, job_id, job_status, employee_id, employee_name, customer_name, service_name)
  values ('job_assigned', '95300000-0000-0000-0000-000000000001', v_job_id, 'open',
          '96300000-0000-0000-0000-000000000002', 'User B', 'PL Kunde', 'PL Leistung');

  insert into public.notification_deliveries (outbox_id, recipient_id, company_id, status, next_attempt_at)
  select o.id, '96300000-0000-0000-0000-000000000002', '95300000-0000-0000-0000-000000000001', 'pending', now()
  from public.notification_outbox o
  where o.job_id = v_job_id and o.event_type = 'job_assigned';

  select recipient_locale into v
  from public.claim_notification_deliveries('95300000-0000-0000-0000-000000000001'::uuid, 50, 120)
  where recipient_id = '96300000-0000-0000-0000-000000000002';

  insert into _r values (10,'claim_notification_deliveries: recipient_locale = Empfaenger-Locale (ar)','ar', coalesce(v,'<null>'));
  raise notice 'CASE 10 -> %', v;
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
    raise exception 'PROFILE LOCALE TEST: % von % Faellen FEHLGESCHLAGEN', fails, gesamt;
  end if;
  raise notice 'ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
