-- =========================================================
-- TEST: prepare_self_account_deletion / rollback_self_account_deletion
-- (Migration 20260723000000_last_admin_deletion_reservation)
-- =========================================================
-- Prüft die atomare Last-Admin-Reservierung für die Kontolöschung: ein
-- Mitarbeiter darf immer vorbereiten, ein einzelner (letzter) Admin wird
-- abgelehnt, ein Admin von zweien wird reserviert (is_active=false) ohne
-- den anderen Admin zu berühren, ein zweiter Admin wird danach korrekt
-- abgelehnt, rollback stellt den Ausgangszustand wieder her, und weder
-- anon noch ein anderer Nutzer können die Reservierung für ein fremdes
-- Konto auslösen.
--
-- AUSFÜHREN: im Supabase SQL Editor (läuft als postgres) komplett einfügen
-- und ausführen. Legt Testdaten an, simuliert Aufrufer über SET ROLE +
-- request.jwt.claims, macht am Ende ROLLBACK — es bleiben KEINE Testdaten
-- zurück.
--
-- Ergebnis: eine Tabelle am Ende (case_no | beschreibung | erwartet |
-- ergebnis | verdikt) sowie NOTICE-Meldungen im Messages-/Log-Panel.
-- =========================================================

begin;

-- Fixe IDs für Lesbarkeit:
--   Firma Solo (ein Admin)  = 31111111…
--   Firma Duo  (zwei Admins + ein Mitarbeiter) = 32222222…
--   adminSolo = 41…1 | adminX = 42…2 | adminY = 43…3 | employeeZ = 44…4
do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','41000000-0000-0000-0000-000000000001','authenticated','authenticated','lastadmin-solo@example.test','{"full_name":"Admin Solo"}'),
    ('00000000-0000-0000-0000-000000000000','42000000-0000-0000-0000-000000000002','authenticated','authenticated','lastadmin-x@example.test','{"full_name":"Admin X"}'),
    ('00000000-0000-0000-0000-000000000000','43000000-0000-0000-0000-000000000003','authenticated','authenticated','lastadmin-y@example.test','{"full_name":"Admin Y"}'),
    ('00000000-0000-0000-0000-000000000000','44000000-0000-0000-0000-000000000004','authenticated','authenticated','lastadmin-emp@example.test','{"full_name":"Mitarbeiter Z"}');
end $$;

insert into public.companies (id, name, slug) values
  ('31111111-1111-1111-1111-111111111111','Lastadmin Firma Solo','lastadmin-firma-solo'),
  ('32222222-2222-2222-2222-222222222222','Lastadmin Firma Duo','lastadmin-firma-duo');

update public.profiles set role='admin',    company_id='31111111-1111-1111-1111-111111111111', is_active=true where id='41000000-0000-0000-0000-000000000001';
update public.profiles set role='admin',    company_id='32222222-2222-2222-2222-222222222222', is_active=true where id='42000000-0000-0000-0000-000000000002';
update public.profiles set role='admin',    company_id='32222222-2222-2222-2222-222222222222', is_active=true where id='43000000-0000-0000-0000-000000000003';
update public.profiles set role='employee', company_id='32222222-2222-2222-2222-222222222222', is_active=true where id='44000000-0000-0000-0000-000000000004';

create temp table _lastadmin_results (
  case_no  int,
  beschreibung text,
  erwartet text,
  ergebnis text
) on commit drop;

-- =========================================================
-- CASE 1: Mitarbeiter bereitet Löschung vor → ERLAUBT, keine Reservierung
-- (is_active bleibt true — Mitarbeiter brauchen keine Sperre)
-- =========================================================
do $$
declare v text; active_after boolean;
begin
  perform set_config('request.jwt.claims','{"sub":"44000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.prepare_self_account_deletion();
    v := 'ALLOWED';
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';
  select is_active into active_after from public.profiles where id='44000000-0000-0000-0000-000000000004';
  if v = 'ALLOWED' and active_after is distinct from true then
    v := 'ALLOWED_BUT_DEACTIVATED';
  end if;
  insert into _lastadmin_results values (1,'Mitarbeiter bereitet Löschung vor','ALLOWED',v);
  raise notice 'CASE 1 (employee prepares) -> %', v;
end $$;

-- =========================================================
-- CASE 2: Einziger Admin seiner Firma bereitet Löschung vor → BLOCKIERT
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"41000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.prepare_self_account_deletion();
    v := 'ALLOWED';
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';
  insert into _lastadmin_results values (2,'Einziger Admin (Firma Solo) bereitet Löschung vor','ERROR:last_admin',v);
  raise notice 'CASE 2 (solo admin) -> %', v;
end $$;

-- =========================================================
-- CASE 3: Admin X (Firma Duo, hat Admin Y als Kollege) → ERLAUBT
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"42000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.prepare_self_account_deletion();
    v := 'ALLOWED';
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';
  insert into _lastadmin_results values (3,'Admin X (Firma Duo, mit Admin Y aktiv) bereitet vor','ALLOWED',v);
  raise notice 'CASE 3 (admin X of two) -> %', v;
end $$;

-- =========================================================
-- CASE 4: Admin X wurde reserviert (is_active=false) — eigener Zustand
-- =========================================================
do $$
declare active_x boolean; v text;
begin
  select is_active into active_x from public.profiles where id='42000000-0000-0000-0000-000000000002';
  v := case when active_x = false then 'is_active=false' else 'is_active='||coalesce(active_x::text,'null') end;
  insert into _lastadmin_results values (4,'Admin X ist nach prepare reserviert (is_active=false)','is_active=false',v);
  raise notice 'CASE 4 (admin X reserved) -> %', v;
end $$;

-- =========================================================
-- CASE 5: Admin Y (fremdes Konto aus Sicht von Admin X) bleibt UNBERÜHRT
-- — belegt, dass prepare_self_account_deletion() ausschließlich auf die
-- eigene Zeile (auth.uid()) wirkt und niemals ein fremdes Konto anfassen
-- kann (es gibt auch keinen user_id-Parameter, der das erlauben würde).
-- =========================================================
do $$
declare active_y boolean; v text;
begin
  select is_active into active_y from public.profiles where id='43000000-0000-0000-0000-000000000003';
  v := case when active_y = true then 'is_active=true (unberührt)' else 'is_active='||coalesce(active_y::text,'null')||' (FEHLER: fremdes Konto verändert)' end;
  insert into _lastadmin_results values (5,'Admin Y bleibt unberührt von Admin X''s prepare-Aufruf','is_active=true (unberührt)',v);
  raise notice 'CASE 5 (admin Y untouched) -> %', v;
end $$;

-- =========================================================
-- CASE 6: Admin Y bereitet jetzt vor (Admin X bereits reserviert/inaktiv)
-- → BLOCKIERT, da aus Sicht von Y kein anderer AKTIVER Admin mehr existiert
-- (genau der Fall, den die alte SELECT-dann-deleteUser-Logik verpasst hätte)
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"43000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.prepare_self_account_deletion();
    v := 'ALLOWED';
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';
  insert into _lastadmin_results values (6,'Admin Y nach Admin X-Reservierung -> BLOCKIERT','ERROR:last_admin',v);
  raise notice 'CASE 6 (admin Y after X reserved) -> %', v;
end $$;

-- =========================================================
-- CASE 7: Rollback stellt Admin X wieder auf is_active=true
-- =========================================================
do $$
declare v text; active_after boolean;
begin
  perform set_config('request.jwt.claims','{"sub":"42000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.rollback_self_account_deletion();
    v := 'CALLED';
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';
  select is_active into active_after from public.profiles where id='42000000-0000-0000-0000-000000000002';
  if v = 'CALLED' then
    v := case when active_after = true then 'is_active=true' else 'is_active='||coalesce(active_after::text,'null') end;
  end if;
  insert into _lastadmin_results values (7,'Rollback stellt Admin X auf is_active=true zurück','is_active=true',v);
  raise notice 'CASE 7 (rollback restores X) -> %', v;
end $$;

-- =========================================================
-- CASE 8: anon kann die RPC NICHT ausführen (BLOCKIERT, insufficient_privilege)
-- =========================================================
do $$
declare v text;
begin
  execute 'set local role anon';
  begin
    perform public.prepare_self_account_deletion();
    v := 'ALLOWED';
  exception
    when insufficient_privilege then v := 'BLOCKED(42501)';
    when others then v := 'ERROR:'||sqlstate||':'||sqlerrm;
  end;
  execute 'reset role';
  insert into _lastadmin_results values (8,'anon ruft prepare_self_account_deletion() auf','BLOCKED(42501)',v);
  raise notice 'CASE 8 (anon blocked) -> %', v;
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
    when erwartet = ergebnis then 'PASS'
    when erwartet = 'ALLOWED' and ergebnis = 'ALLOWED' then 'PASS'
    else 'FAIL'
  end as verdikt
from _lastadmin_results
order by case_no;

-- Nichts persistieren — reine Prüfung.
rollback;
