-- =========================================================
-- TEST: Client-Compatibility-Fundament
-- (Migration 20260916120000_client_compatibility_foundation,
--  plus die in 20260917000000 fortgefuehrte Waechter-Klausel)
-- =========================================================
-- Deckt ab:
--   1. Enforcement AUS: Alt-Client ohne Header bleibt erlaubt.
--   2. Enforcement AN: fehlende/unbekannte Plattform, fehlender/nicht-
--      numerischer Build, Build unter Minimum -> jeweils dieselbe deutsche
--      Meldung, errcode 22023 (vom bestehenden Fehler-Klassifizierer
--      sicher durchgereicht UND vom Offline-Sync-Klassifizierer als
--      dauerhaft erkennbar).
--   3. Exakter Minimalwert -> erlaubt (Grenzfall, kein Off-by-one).
--   4. Dieselbe Pruefung unter der VON 20260917000000 NEU ERSTELLTEN
--      Fassung von start_own_job/complete_own_job/set_job_assignments —
--      bestaetigt, dass die Aktivierung von Phase 16 das Gate nicht
--      entfernt hat.
--   5. update_my_push_token: alte 1-Parameter-Aufrufform bleibt gueltig;
--      neue Form schreibt die Telemetrie-Spalten korrekt.
--
-- Simuliert PostgREST-Header ueber set_config('request.headers', ..., true)
-- (transaktionslokal) — derselbe GUC, der in der empirischen Verifikation
-- gegen Staging bestaetigt wurde. Ohne diese Simulation liefert
-- current_setting('request.headers', true) hier NULL (kein HTTP-Kontext),
-- was in den Tests deshalb selbst als "Alt-Client ohne Header" genutzt wird.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende.
-- =========================================================

begin;

create temp table _r (
  case_no   int,
  bereich   text,
  beschreibung text,
  erwartet  text,
  ergebnis  text
) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
end $f$;

create or replace function pg_temp.note(
  p_case int, p_bereich text, p_besch text, p_erw text, p_erg text
) returns void language plpgsql as $f$
begin
  insert into _r values (p_case, p_bereich, p_besch, p_erw, p_erg);
  raise notice 'CASE % [%] -> %', p_case, p_bereich, p_erg;
end $f$;

-- Simuliert die Header, die der Supabase-JS-Client global anhaengt.
-- p_platform/p_build = null -> Header fehlt (Alt-Client).
create or replace function pg_temp.set_headers(p_platform text, p_build text) returns void language plpgsql as $f$
declare
  v jsonb := '{}'::jsonb;
begin
  if p_platform is not null then
    v := v || jsonb_build_object('x-taskops-platform', p_platform);
  end if;
  if p_build is not null then
    v := v || jsonb_build_object('x-taskops-build', p_build);
  end if;
  perform set_config('request.headers', v::text, true);
end $f$;

create or replace function pg_temp.clear_headers() returns void language plpgsql as $f$
begin
  perform set_config('request.headers', '{}', true);
end $f$;

-- Ruft enforce_min_client_version() auf und meldet OK/die Ablehnungsmeldung.
create or replace function pg_temp.try_gate() returns text language plpgsql as $f$
begin
  perform public.enforce_min_client_version();
  return 'OK';
exception when others then
  return sqlstate || ':' || sqlerrm;
end $f$;


-- ── Fixdaten ────────────────────────────────────────────────────────
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','c6000000-0000-0000-0000-000000000001','authenticated','authenticated','compat-admin@example.test','{"full_name":"Compat Admin"}'),
    ('00000000-0000-0000-0000-000000000000','c6000000-0000-0000-0000-000000000002','authenticated','authenticated','compat-emp@example.test','{"full_name":"Compat Employee"}');
end $$;

insert into public.profiles (id, full_name) values
  ('c6000000-0000-0000-0000-000000000001','Compat Admin'),
  ('c6000000-0000-0000-0000-000000000002','Compat Employee')
on conflict (id) do nothing;

insert into public.companies (id,name,slug,timezone) values
  ('c6100000-0000-0000-0000-000000000001','Compat Test Firma','compat-test-firma','Europe/Berlin');

update public.profiles set company_id='c6100000-0000-0000-0000-000000000001', role='admin', is_active=true
  where id='c6000000-0000-0000-0000-000000000001';
update public.profiles set company_id='c6100000-0000-0000-0000-000000000001', role='employee', is_active=true
  where id='c6000000-0000-0000-0000-000000000002';

-- Bekannte, testeigene Minimalwerte — unabhaengig von den echten
-- app_config-Werten, damit der Test nicht von der aktuellen Produktions-
-- Konfiguration abhaengt.
update public.app_config set value = '10'::jsonb where key = 'min_build_ios';
update public.app_config set value = '20'::jsonb where key = 'min_build_android';
update public.app_config set value = 'false'::jsonb where key = 'enforcement_enabled';


-- ── Teil 1: Enforcement AUS ─────────────────────────────────────────
select pg_temp.act_as('c6000000-0000-0000-0000-000000000002');
select pg_temp.clear_headers();
select pg_temp.note(1, 'Gate', 'Enforcement aus + keine Header (Alt-Client)', 'OK', pg_temp.try_gate());

select pg_temp.set_headers('android', '5'); -- unter dem Minimum, aber Enforcement ist aus
select pg_temp.note(2, 'Gate', 'Enforcement aus + Header unter Minimum', 'OK', pg_temp.try_gate());


-- ── Teil 2: Enforcement AN ──────────────────────────────────────────
update public.app_config set value = 'true'::jsonb where key = 'enforcement_enabled';

select pg_temp.clear_headers();
select pg_temp.note(3, 'Gate', 'Enforcement an + keine Header (Alt-Client)',
  '22023', pg_temp.try_gate());

select pg_temp.set_headers('web', '999');
select pg_temp.note(4, 'Gate', 'Enforcement an + unbekannte Plattform', '22023', pg_temp.try_gate());

select pg_temp.set_headers(null, '15');
select pg_temp.note(5, 'Gate', 'Enforcement an + Plattform fehlt', '22023', pg_temp.try_gate());

select pg_temp.set_headers('ios', null);
select pg_temp.note(6, 'Gate', 'Enforcement an + Build fehlt', '22023', pg_temp.try_gate());

select pg_temp.set_headers('ios', 'abc');
select pg_temp.note(7, 'Gate', 'Enforcement an + Build nicht numerisch', '22023', pg_temp.try_gate());

select pg_temp.set_headers('ios', '-5');
select pg_temp.note(8, 'Gate', 'Enforcement an + Build negativ (regex lehnt Vorzeichen ab)', '22023', pg_temp.try_gate());

select pg_temp.set_headers('ios', '9');
select pg_temp.note(9, 'Gate', 'Enforcement an + iOS-Build unter Minimum (9 < 10)', '22023', pg_temp.try_gate());

select pg_temp.set_headers('android', '19');
select pg_temp.note(10, 'Gate', 'Enforcement an + Android-Build unter Minimum (19 < 20)', '22023', pg_temp.try_gate());

select pg_temp.set_headers('ios', '10');
select pg_temp.note(11, 'Gate', 'Enforcement an + iOS-Build exakt am Minimum (10 = 10)', 'OK', pg_temp.try_gate());

select pg_temp.set_headers('android', '20');
select pg_temp.note(12, 'Gate', 'Enforcement an + Android-Build exakt am Minimum (20 = 20)', 'OK', pg_temp.try_gate());

select pg_temp.set_headers('ios', '999');
select pg_temp.note(13, 'Gate', 'Enforcement an + iOS-Build weit ueber Minimum', 'OK', pg_temp.try_gate());

select pg_temp.set_headers('android', '999');
select pg_temp.note(14, 'Gate', 'Enforcement an + Android-Build weit ueber Minimum', 'OK', pg_temp.try_gate());

-- Exakte Meldung, damit der Offline-Sync-Klassifizierer und toUserMessage
-- denselben Text sicher wiedererkennen.
select pg_temp.set_headers(null, null);
select pg_temp.note(15, 'Gate', 'Meldungstext exakt wie vom Client erwartet',
  'Diese App-Version wird nicht mehr unterstützt. Bitte aktualisiere die App.',
  split_part(pg_temp.try_gate(), ':', 2));


-- ── Teil 3: dieselbe Pruefung ueber die ECHTEN geschuetzten RPCs ────
-- start_own_job muss die Ablehnung VOR jeder Geschaeftslogik auswerten —
-- unabhaengig davon, ob dieser Aufruf inhaltlich sonst erlaubt waere.
insert into public.jobs (id, company_id, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time,
                         is_active, created_at, updated_at)
values ('c6200000-0000-0000-0000-000000000001','c6100000-0000-0000-0000-000000000001',
        'c6000000-0000-0000-0000-000000000001','Compat Job','Test','Teststr. 1',
        'open','single', current_date, '10:00', true, now(), now());

insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by)
values ('c6200000-0000-0000-0000-000000000001','c6000000-0000-0000-0000-000000000002','Compat Employee','c6000000-0000-0000-0000-000000000001');

select pg_temp.act_as('c6000000-0000-0000-0000-000000000002');
select pg_temp.clear_headers();

do $$
declare
  v_result text;
begin
  begin
    perform public.start_own_job('c6200000-0000-0000-0000-000000000001'::uuid);
    v_result := 'OK';
  exception when others then
    v_result := sqlstate;
  end;
  perform pg_temp.note(16, 'RPC', 'start_own_job ueber echten Aufruf ohne Header, Enforcement an',
    '22023', v_result);
end $$;

select pg_temp.set_headers('ios', '999');
do $$
declare
  v_result text;
begin
  begin
    perform public.start_own_job('c6200000-0000-0000-0000-000000000001'::uuid);
    v_result := 'OK';
  exception when others then
    v_result := sqlstate;
  end;
  perform pg_temp.note(17, 'RPC', 'start_own_job ueber echten Aufruf MIT gueltigen Headern gelingt',
    'OK', v_result);
end $$;

do $$
declare
  v_result text;
begin
  begin
    perform public.complete_own_job('c6200000-0000-0000-0000-000000000001'::uuid);
    v_result := 'OK';
  exception when others then
    v_result := sqlstate;
  end;
  perform pg_temp.note(18, 'RPC', 'complete_own_job ueber echten Aufruf MIT gueltigen Headern gelingt',
    'OK', v_result);
end $$;

select pg_temp.clear_headers();
select pg_temp.act_as('c6000000-0000-0000-0000-000000000001');
do $$
declare
  v_result text;
begin
  begin
    perform public.set_job_assignments('c6200000-0000-0000-0000-000000000001'::uuid, array['c6000000-0000-0000-0000-000000000002']::uuid[]);
    v_result := 'OK';
  exception when others then
    v_result := sqlstate;
  end;
  perform pg_temp.note(19, 'RPC', 'set_job_assignments ohne Header, Enforcement an', '22023', v_result);
end $$;


-- ── Teil 4: update_my_push_token — abwaertskompatibel ───────────────
select pg_temp.act_as('c6000000-0000-0000-0000-000000000002');

-- Alte, 1-Parameter-Aufrufform (Alt-Client) muss weiterhin gelingen.
do $$
declare
  v_result text;
begin
  begin
    perform public.update_my_push_token('ExponentPushToken[compat-old-client-test]');
    v_result := 'OK';
  exception when others then
    v_result := sqlstate || ':' || sqlerrm;
  end;
  perform pg_temp.note(20, 'Telemetrie', 'update_my_push_token alte 1-Parameter-Form', 'OK', v_result);
end $$;

select pg_temp.note(21, 'Telemetrie', 'Telemetrie bleibt NULL, wenn nicht mitgeliefert',
  'leer', coalesce((select last_seen_app_build::text from public.profiles where id='c6000000-0000-0000-0000-000000000002'), 'leer'));

-- Neue Form: Telemetrie wird geschrieben.
select public.update_my_push_token('ExponentPushToken[compat-new-client-test]', 142, 'ios');

select pg_temp.note(22, 'Telemetrie', 'Build-Telemetrie korrekt geschrieben', '142',
  (select last_seen_app_build::text from public.profiles where id='c6000000-0000-0000-0000-000000000002'));

select pg_temp.note(23, 'Telemetrie', 'Plattform-Telemetrie korrekt geschrieben', 'ios',
  (select last_seen_app_platform from public.profiles where id='c6000000-0000-0000-0000-000000000002'));


-- ── Auswertung ──────────────────────────────────────────────────────
do $$
declare
  r record;
  fail_count int := 0;
  gesamt int;
begin
  select count(*) into gesamt from _r;
  for r in select * from _r order by case_no loop
    if r.ergebnis is distinct from r.erwartet then
      fail_count := fail_count + 1;
      raise warning 'FAIL CASE %: % — erwartet [%] bekommen [%]', r.case_no, r.beschreibung, r.erwartet, r.ergebnis;
    end if;
  end loop;

  if fail_count > 0 then
    raise exception '% von % FAELLEN FEHLGESCHLAGEN', fail_count, gesamt;
  end if;

  raise notice 'CLIENT COMPATIBILITY TEST: ALLE % FAELLE PASS', gesamt;
end $$;

select case_no, bereich, beschreibung, erwartet, ergebnis,
  case when ergebnis is not distinct from erwartet then 'PASS' else 'FAIL' end as verdikt
from _r
order by case_no;

rollback;
