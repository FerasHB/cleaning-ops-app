-- =========================================================
-- TEST: enforce_profile_field_guard (Migration 20260716000000)
-- =========================================================
-- Prüft, dass ein normaler Mitarbeiter role/company_id/is_active NICHT
-- an seinem eigenen Profil ändern kann, Admins die Mitarbeiterverwaltung
-- aber weiter nutzen können und service_role/Edge-Function-Pfade frei
-- bleiben.
--
-- AUSFÜHREN: im Supabase SQL Editor (läuft als postgres) einfach komplett
-- einfügen und ausführen. Das Skript legt Testdaten an, simuliert die
-- verschiedenen Aufrufer über SET ROLE + request.jwt.claims und macht am
-- Ende ROLLBACK — es bleiben KEINE Testdaten zurück.
--
-- Ergebnis: eine Tabelle am Ende (case_no | beschreibung | erwartet |
-- ergebnis | verdikt) sowie NOTICE-Meldungen im Messages-/Log-Panel.
-- =========================================================

begin;

-- Fixe IDs für Lesbarkeit
--   Firma A = 111…  | Firma B = 222…
--   adminA  = a0…1  | empA (aktiv) = e0…2 | empDeact (inaktiv) = d0…3
do $$
begin
  -- Testnutzer in auth.users anlegen. Der handle_new_user-Trigger legt
  -- dazu automatisch die zugehörige profiles-Zeile an (role=employee,
  -- is_active=true, company_id=null).
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','a0000000-0000-0000-0000-000000000001','authenticated','authenticated','guardtest-admin@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','e0000000-0000-0000-0000-000000000002','authenticated','authenticated','guardtest-emp@example.test','{"full_name":"Mitarbeiter A"}'),
    ('00000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000003','authenticated','authenticated','guardtest-deact@example.test','{"full_name":"Mitarbeiter Deaktiviert"}'),
    ('00000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000004','authenticated','authenticated','guardtest-adminb@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000005','authenticated','authenticated','guardtest-fresh1@example.test','{"full_name":"Fresh User 1"}'),
    ('00000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000006','authenticated','authenticated','guardtest-fresh2@example.test','{"full_name":"Fresh User 2"}');
end $$;

-- Firmen anlegen (als postgres → vom Guard ausgenommen)
insert into public.companies (id, name, slug) values
  ('11111111-1111-1111-1111-111111111111','Guardtest Firma A','guardtest-firma-a'),
  ('22222222-2222-2222-2222-222222222222','Guardtest Firma B','guardtest-firma-b');

-- Profile in den Zielzustand bringen (als postgres → erlaubt/ausgenommen)
update public.profiles set role='admin',    company_id='11111111-1111-1111-1111-111111111111', is_active=true  where id='a0000000-0000-0000-0000-000000000001';
update public.profiles set role='employee', company_id='11111111-1111-1111-1111-111111111111', is_active=true  where id='e0000000-0000-0000-0000-000000000002';
update public.profiles set role='employee', company_id='11111111-1111-1111-1111-111111111111', is_active=false where id='d0000000-0000-0000-0000-000000000003';
update public.profiles set role='admin',    company_id='22222222-2222-2222-2222-222222222222', is_active=true  where id='b0000000-0000-0000-0000-000000000004';
-- Fresh User 1 + 2 bleiben bewusst wie von handle_new_user angelegt:
-- role='employee', company_id=NULL, is_active=true (für Registrierung/Setup-Test).

-- Ergebnis-Sammeltabelle
create temp table _guard_results (
  case_no  int,
  beschreibung text,
  erwartet text,
  ergebnis text
) on commit drop;

-- =========================================================
-- CASE 1: Mitarbeiter ändert seinen Namen → ERLAUBT
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"e0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set full_name='Mitarbeiter A (neu)' where id='e0000000-0000-0000-0000-000000000002';
    v := 'ALLOWED';
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (1,'Mitarbeiter ändert full_name (self)','ALLOWED',v);
  raise notice 'CASE 1 (rename self) -> %', v;
end $$;

-- =========================================================
-- CASE 2: Mitarbeiter setzt sich selbst auf role='admin' → BLOCKIERT
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"e0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set role='admin' where id='e0000000-0000-0000-0000-000000000002';
    v := 'ALLOWED';
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (2,'Mitarbeiter setzt role=admin (self)','BLOCKED',v);
  raise notice 'CASE 2 (self role=admin) -> %', v;
end $$;

-- =========================================================
-- CASE 3: Mitarbeiter ändert company_id → BLOCKIERT
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"e0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set company_id='22222222-2222-2222-2222-222222222222' where id='e0000000-0000-0000-0000-000000000002';
    v := 'ALLOWED';
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (3,'Mitarbeiter ändert company_id (self)','BLOCKED',v);
  raise notice 'CASE 3 (self company_id) -> %', v;
end $$;

-- =========================================================
-- CASE 4: Deaktivierter Mitarbeiter setzt is_active=true → BLOCKIERT
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"d0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set is_active=true where id='d0000000-0000-0000-0000-000000000003';
    v := 'ALLOWED';
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (4,'Deaktivierter Mitarbeiter reaktiviert sich (self)','BLOCKED',v);
  raise notice 'CASE 4 (deactivated self-reactivate) -> %', v;
end $$;

-- =========================================================
-- CASE 5: Admin deaktiviert einen Mitarbeiter → ERLAUBT
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set is_active=false, expo_push_token=null where id='e0000000-0000-0000-0000-000000000002';
    v := 'ALLOWED';
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (5,'Admin deaktiviert Mitarbeiter (gleiche Firma)','ALLOWED',v);
  raise notice 'CASE 5 (admin deactivates) -> %', v;
end $$;

-- =========================================================
-- CASE 6: Admin reaktiviert einen Mitarbeiter → ERLAUBT
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set is_active=true where id='e0000000-0000-0000-0000-000000000002';
    v := 'ALLOWED';
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (6,'Admin reaktiviert Mitarbeiter (gleiche Firma)','ALLOWED',v);
  raise notice 'CASE 6 (admin reactivates) -> %', v;
end $$;

-- =========================================================
-- CASE 7: service_role (Edge Function) ändert geschütztes Feld → ERLAUBT
-- =========================================================
do $$
declare v text;
begin
  execute 'set local role service_role';
  begin
    update public.profiles set is_active=false where id='e0000000-0000-0000-0000-000000000002';
    v := 'ALLOWED';
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (7,'service_role ändert is_active (Edge Function)','ALLOWED',v);
  raise notice 'CASE 7 (service_role) -> %', v;
end $$;

-- =========================================================
-- CASE 8: Admin einer FREMDEN Firma ändert Mitarbeiter → BLOCKIERT
-- (RLS filtert die Zeile → 0 Zeilen; zusätzlich würde der Trigger greifen)
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"b0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set is_active=false where id='e0000000-0000-0000-0000-000000000002';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows/RLS)'; else v := 'ALLOWED'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (8,'Admin fremde Firma ändert Mitarbeiter','BLOCKED',v);
  raise notice 'CASE 8 (cross-company admin) -> %', v;
end $$;

-- =========================================================
-- CASE 9: App-Pfad setEmployeeActive (Admin, gleiche Firma) → ERLAUBT
-- Exakt die UPDATE-Form aus services/jobs/jobs.service.ts:
--   update profiles set is_active=?, expo_push_token=null
--   where id=? and role='employee'
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set is_active=true, expo_push_token=null
      where id='e0000000-0000-0000-0000-000000000002' and role='employee';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (9,'App setEmployeeActive (Admin, gleiche Firma)','ALLOWED',v);
  raise notice 'CASE 9 (setEmployeeActive) -> %', v;
end $$;

-- =========================================================
-- CASE 10: Registrierung via register_admin_with_company → ERLAUBT
-- (SECURITY DEFINER → current_user=postgres → vom Guard ausgenommen)
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"f0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.register_admin_with_company('Test Owner','Guardtest Firma C','guardtest-firma-c');
    v := 'ALLOWED';
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (10,'Registrierung register_admin_with_company','ALLOWED',v);
  raise notice 'CASE 10 (register_admin_with_company) -> %', v;
end $$;

-- =========================================================
-- CASE 11: setup_company_for_admin (User ohne Firma) → ERLAUBT
-- (SECURITY DEFINER → current_user=postgres → vom Guard ausgenommen)
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"f0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.setup_company_for_admin('Guardtest Firma D');
    v := 'ALLOWED';
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (11,'setup_company_for_admin (User ohne Firma)','ALLOWED',v);
  raise notice 'CASE 11 (setup_company_for_admin) -> %', v;
end $$;

-- =========================================================
-- Ergebnisübersicht
-- =========================================================
select
  case_no,
  beschreibung,
  erwartet,
  ergebnis,
  case
    when erwartet = 'ALLOWED' and ergebnis = 'ALLOWED' then 'PASS'
    when erwartet = 'BLOCKED' and (ergebnis like 'BLOCKED%' or ergebnis like 'NOOP%') then 'PASS'
    else 'FAIL'
  end as verdikt
from _guard_results
order by case_no;

-- Nichts persistieren — reine Prüfung.
rollback;
