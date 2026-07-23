-- =========================================================
-- TEST: enforce_profile_field_guard (Migration 20260716000000)
-- =========================================================
-- Prüft, dass ein normaler Mitarbeiter role/company_id/is_active NICHT
-- an seinem eigenen Profil ändern kann, Admins die Mitarbeiterverwaltung
-- aber weiter nutzen können und service_role/Edge-Function-Pfade frei
-- bleiben.
--
-- AUSFÜHREN: gegen eine lokale Supabase-DB (docker psql / supabase db) ODER
-- im Supabase SQL Editor. Das Skript legt Testdaten an, simuliert die
-- verschiedenen Aufrufer über SET ROLE + request.jwt.claims und macht am
-- Ende ROLLBACK — es bleiben KEINE Testdaten zurück.
--
-- ROBUSTHEIT (Fix gegenüber der Vorversion):
--   * Die Vorversion legte KEINE profiles-Zeilen explizit an, sondern verließ
--     sich auf den auth.users→profiles-Trigger (handle_new_user). Auf einer
--     frischen lokalen Baseline ohne diesen Trigger trafen die Setup-UPDATEs
--     dann 0 Zeilen, und weil die BLOCKED-Fälle nur "keine Exception" prüften,
--     meldeten sie fälschlich ALLOWED (false pass) bzw. FAIL (false fail) —
--     ganz ohne echte Guard-Aussage.
--   * Diese Version legt alle profiles-Zeilen EXPLIZIT an (insert ... on
--     conflict do update, unabhängig vom Trigger), prüft die Seed-Zeilenzahl
--     hart ab (raise bei Abweichung) und wertet in jedem Fall ROW_COUNT aus:
--       - ALLOWED  gilt nur bei tatsächlich ≥1 betroffener Zeile.
--       - TRIGGER_BLOCK gilt nur bei echter 42501-Exception (nicht bei 0 rows).
--       - RLS_NOOP gilt bei 0 Zeilen ODER permission-denied (RLS/Grant).
--   * Am Ende schlägt das Skript LAUT fehl (raise exception), falls irgendein
--     Fall nicht PASS ist — die Ergebnistabelle wird vorher noch ausgegeben.
--
-- Ergebnis: eine Tabelle (case_no | beschreibung | erwartet | ergebnis |
-- verdikt) plus NOTICE-Meldungen; bei einem Fehlschlag zusätzlich eine
-- Exception, sodass CI/psql (-v ON_ERROR_STOP=1) einen Fehler signalisiert.
-- =========================================================

begin;

-- Fixe IDs für Lesbarkeit
--   Firma A = 111…  | Firma B = 222…
--   adminA  = a0…1  | empA (aktiv) = e0…2 | empDeact (inaktiv) = d0…3
--   adminB  = b0…4  | fresh1 = f0…5 | fresh2 = f0…6
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000','a0000000-0000-0000-0000-000000000001','authenticated','authenticated','guardtest-admin@example.test','{"full_name":"Admin A"}'),
  ('00000000-0000-0000-0000-000000000000','e0000000-0000-0000-0000-000000000002','authenticated','authenticated','guardtest-emp@example.test','{"full_name":"Mitarbeiter A"}'),
  ('00000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000003','authenticated','authenticated','guardtest-deact@example.test','{"full_name":"Mitarbeiter Deaktiviert"}'),
  ('00000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000004','authenticated','authenticated','guardtest-adminb@example.test','{"full_name":"Admin B"}'),
  ('00000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000005','authenticated','authenticated','guardtest-fresh1@example.test','{"full_name":"Fresh User 1"}'),
  ('00000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000006','authenticated','authenticated','guardtest-fresh2@example.test','{"full_name":"Fresh User 2"}')
on conflict (id) do nothing;

-- Firmen anlegen (als postgres → vom Guard ausgenommen)
insert into public.companies (id, name, slug) values
  ('11111111-1111-1111-1111-111111111111','Guardtest Firma A','guardtest-firma-a'),
  ('22222222-2222-2222-2222-222222222222','Guardtest Firma B','guardtest-firma-b')
on conflict (id) do nothing;

-- Profile EXPLIZIT in den Zielzustand bringen. on conflict do update deckt
-- BEIDE Baselines ab: mit handle_new_user-Trigger (Zeile existiert schon →
-- update) und ohne Trigger (Zeile wird hier erst angelegt → insert).
insert into public.profiles (id, company_id, full_name, role, is_active) values
  ('a0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Admin A','admin',   true),
  ('e0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Mitarbeiter A','employee', true),
  ('d0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Mitarbeiter Deaktiviert','employee', false),
  ('b0000000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','Admin B','admin',   true),
  -- fresh1/fresh2: bewusst ohne Firma (company_id=NULL) für Registrierung/Setup.
  ('f0000000-0000-0000-0000-000000000005', null, 'Fresh User 1','employee', true),
  ('f0000000-0000-0000-0000-000000000006', null, 'Fresh User 2','employee', true)
on conflict (id) do update set
  company_id = excluded.company_id,
  full_name  = excluded.full_name,
  role       = excluded.role,
  is_active  = excluded.is_active;

-- SETUP-ASSERTION: bricht laut ab, falls der Seed nicht exakt stimmt. Damit
-- kann kein Fall auf einer falsch vorbereiteten Basis "grün" werden.
do $$
declare n int;
begin
  select count(*) into n from public.profiles
   where id in (
     'a0000000-0000-0000-0000-000000000001',
     'e0000000-0000-0000-0000-000000000002',
     'd0000000-0000-0000-0000-000000000003',
     'b0000000-0000-0000-0000-000000000004',
     'f0000000-0000-0000-0000-000000000005',
     'f0000000-0000-0000-0000-000000000006'
   );
  if n <> 6 then
    raise exception 'SETUP FEHLGESCHLAGEN: erwartet 6 Seed-Profile, gefunden %', n;
  end if;

  perform 1 from public.profiles
   where id='a0000000-0000-0000-0000-000000000001' and role='admin'
     and company_id='11111111-1111-1111-1111-111111111111' and is_active;
  if not found then raise exception 'SETUP FEHLGESCHLAGEN: adminA nicht korrekt'; end if;

  perform 1 from public.profiles
   where id='e0000000-0000-0000-0000-000000000002' and role='employee'
     and company_id='11111111-1111-1111-1111-111111111111' and is_active;
  if not found then raise exception 'SETUP FEHLGESCHLAGEN: empA nicht korrekt'; end if;

  perform 1 from public.profiles
   where id='d0000000-0000-0000-0000-000000000003' and role='employee'
     and company_id='11111111-1111-1111-1111-111111111111' and is_active = false;
  if not found then raise exception 'SETUP FEHLGESCHLAGEN: empDeact nicht korrekt'; end if;

  perform 1 from public.profiles
   where id='b0000000-0000-0000-0000-000000000004' and role='admin'
     and company_id='22222222-2222-2222-2222-222222222222' and is_active;
  if not found then raise exception 'SETUP FEHLGESCHLAGEN: adminB nicht korrekt'; end if;

  perform 1 from public.profiles
   where id='f0000000-0000-0000-0000-000000000005' and company_id is null;
  if not found then raise exception 'SETUP FEHLGESCHLAGEN: fresh1 sollte ohne Firma sein'; end if;

  raise notice 'SETUP OK: 6 Profile korrekt vorbereitet';
end $$;

-- Ergebnis-Sammeltabelle. erwartet kodiert die erwartete ART des Ergebnisses:
--   ALLOWED       = UPDATE muss ≥1 Zeile treffen (kein Block)
--   TRIGGER_BLOCK = Guard muss mit 42501 werfen
--   RLS_NOOP      = RLS/Grant blockt → 0 Zeilen oder permission-denied
--   DEFINER_OK    = SECURITY DEFINER-RPC läuft durch UND hat Wirkung
create temp table _guard_results (
  case_no  int,
  beschreibung text,
  erwartet text,
  ergebnis text
) on commit drop;

-- =========================================================
-- CASE 1: Mitarbeiter ändert seinen Namen (self) → ERLAUBT
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"e0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set full_name='Mitarbeiter A (neu)' where id='e0000000-0000-0000-0000-000000000002';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED('||rc||' rows)'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (1,'Mitarbeiter ändert full_name (self)','ALLOWED',v);
  raise notice 'CASE 1 (rename self) -> %', v;
end $$;

-- =========================================================
-- CASE 2: Mitarbeiter setzt sich selbst auf role='admin' → BLOCKIERT (Trigger)
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"e0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set role='admin' where id='e0000000-0000-0000-0000-000000000002';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED('||rc||' rows)'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (2,'Mitarbeiter setzt role=admin (self)','TRIGGER_BLOCK',v);
  raise notice 'CASE 2 (self role=admin) -> %', v;
end $$;

-- =========================================================
-- CASE 3: Mitarbeiter ändert company_id (self) → BLOCKIERT (Trigger)
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"e0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set company_id='22222222-2222-2222-2222-222222222222' where id='e0000000-0000-0000-0000-000000000002';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED('||rc||' rows)'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (3,'Mitarbeiter ändert company_id (self)','TRIGGER_BLOCK',v);
  raise notice 'CASE 3 (self company_id) -> %', v;
end $$;

-- =========================================================
-- CASE 4: Deaktivierter Mitarbeiter setzt is_active=true (self) → BLOCKIERT (Trigger)
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"d0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set is_active=true where id='d0000000-0000-0000-0000-000000000003';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED('||rc||' rows)'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (4,'Deaktivierter Mitarbeiter reaktiviert sich (self)','TRIGGER_BLOCK',v);
  raise notice 'CASE 4 (deactivated self-reactivate) -> %', v;
end $$;

-- =========================================================
-- CASE 5: Admin deaktiviert einen Mitarbeiter (gleiche Firma) → ERLAUBT
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set is_active=false, expo_push_token=null where id='e0000000-0000-0000-0000-000000000002';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED('||rc||' rows)'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (5,'Admin deaktiviert Mitarbeiter (gleiche Firma)','ALLOWED',v);
  raise notice 'CASE 5 (admin deactivates) -> %', v;
end $$;

-- =========================================================
-- CASE 6: Admin reaktiviert einen Mitarbeiter (gleiche Firma) → ERLAUBT
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set is_active=true where id='e0000000-0000-0000-0000-000000000002';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED('||rc||' rows)'; end if;
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
declare v text; rc int;
begin
  execute 'set local role service_role';
  begin
    update public.profiles set is_active=false where id='e0000000-0000-0000-0000-000000000002';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED('||rc||' rows)'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (7,'service_role ändert is_active (Edge Function)','ALLOWED',v);
  raise notice 'CASE 7 (service_role) -> %', v;
end $$;

-- =========================================================
-- CASE 8: Admin einer FREMDEN Firma ändert Mitarbeiter → BLOCKIERT (RLS 0 rows)
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"b0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    update public.profiles set is_active=false where id='e0000000-0000-0000-0000-000000000002';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED('||rc||' rows)'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (8,'Admin fremde Firma ändert Mitarbeiter','RLS_NOOP',v);
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
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED('||rc||' rows)'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (9,'App setEmployeeActive (Admin, gleiche Firma)','ALLOWED',v);
  raise notice 'CASE 9 (setEmployeeActive) -> %', v;
end $$;

-- =========================================================
-- CASE 10: Anonymer Nutzer (kein Login) versucht ein Profil zu ändern → BLOCKIERT
-- request.jwt.claims wird geleert ({}), damit auth.uid() NULL ist.
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{}', true);
  execute 'set local role anon';
  begin
    update public.profiles set is_active=false where id='e0000000-0000-0000-0000-000000000002';
    get diagnostics rc = row_count;
    if rc = 0 then v := 'NOOP(0 rows)'; else v := 'ALLOWED('||rc||' rows)'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (10,'Anonymer Nutzer ändert Profil','RLS_NOOP',v);
  raise notice 'CASE 10 (anon update) -> %', v;
end $$;

-- =========================================================
-- CASE 11: Registrierung register_admin_with_company → ERLAUBT (DEFINER-Pfad)
-- (SECURITY DEFINER → current_user=postgres → vom Guard ausgenommen)
-- Post-Bedingung: fresh1 hat danach eine Firma.
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"f0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.register_admin_with_company('Test Owner','Guardtest Firma C','guardtest-firma-c');
    select count(*) into rc from public.profiles
      where id='f0000000-0000-0000-0000-000000000005' and company_id is not null;
    if rc = 1 then v := 'DEFINER_OK'; else v := 'NO_EFFECT(rc='||rc||')'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (11,'register_admin_with_company (DEFINER)','DEFINER_OK',v);
  raise notice 'CASE 11 (register_admin_with_company) -> %', v;
end $$;

-- =========================================================
-- CASE 12: setup_company_for_admin (User ohne Firma) → ERLAUBT (DEFINER-Pfad)
-- Post-Bedingung: fresh2 hat danach eine Firma.
-- =========================================================
do $$
declare v text; rc int;
begin
  perform set_config('request.jwt.claims','{"sub":"f0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.setup_company_for_admin('Guardtest Firma D');
    select count(*) into rc from public.profiles
      where id='f0000000-0000-0000-0000-000000000006' and company_id is not null and role='admin';
    if rc = 1 then v := 'DEFINER_OK'; else v := 'NO_EFFECT(rc='||rc||')'; end if;
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate;
  end;
  execute 'reset role';
  insert into _guard_results values (12,'setup_company_for_admin (DEFINER)','DEFINER_OK',v);
  raise notice 'CASE 12 (setup_company_for_admin) -> %', v;
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
    when erwartet = 'ALLOWED'       and ergebnis like 'ALLOWED(%'                                then 'PASS'
    when erwartet = 'TRIGGER_BLOCK' and ergebnis = 'BLOCKED(42501)'                              then 'PASS'
    when erwartet = 'RLS_NOOP'      and (ergebnis = 'NOOP(0 rows)' or ergebnis like 'BLOCKED%')  then 'PASS'
    when erwartet = 'DEFINER_OK'    and ergebnis = 'DEFINER_OK'                                  then 'PASS'
    else 'FAIL'
  end as verdikt
from _guard_results
order by case_no;

-- LAUTER Fehlschlag, falls irgendein Fall nicht PASS ist (nachdem die Tabelle
-- oben bereits ausgegeben wurde). So bricht psql (-v ON_ERROR_STOP=1) / CI ab.
do $$
declare fails int;
begin
  select count(*) into fails from _guard_results r
  where not (
    (r.erwartet = 'ALLOWED'       and r.ergebnis like 'ALLOWED(%')
    or (r.erwartet = 'TRIGGER_BLOCK' and r.ergebnis = 'BLOCKED(42501)')
    or (r.erwartet = 'RLS_NOOP'      and (r.ergebnis = 'NOOP(0 rows)' or r.ergebnis like 'BLOCKED%'))
    or (r.erwartet = 'DEFINER_OK'    and r.ergebnis = 'DEFINER_OK')
  );
  if fails > 0 then
    raise exception 'PROFILE FIELD GUARD TEST: % Fall/Fälle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE 12 FÄLLE PASS';
end $$;

-- Nichts persistieren — reine Prüfung.
rollback;
