-- =========================================================
-- TEST: prepare_self_account_deletion / rollback_self_account_deletion /
--       recover_stale_account_deletion_reservations
-- (Migrationen 20260723000000_last_admin_deletion_reservation +
--  20260723000001_account_deletion_reservation_tokens)
-- =========================================================
-- Deckt die Token-basierte Last-Admin-Reservierung ab: ein Mitarbeiter darf
-- immer vorbereiten, ein einzelner (letzter) Admin wird abgelehnt, ein Admin
-- von zweien wird reserviert (Token, OHNE is_active zu ändern) ohne den
-- anderen Admin zu berühren, ein zweiter Admin wird danach korrekt
-- abgelehnt, Rollback mit korrektem Token stellt den Ausgangszustand wieder
-- her, Rollback mit falschem/fremdem Token schlägt fehl, ein administrativ
-- deaktiviertes Konto darf keine Löschung anstoßen, veraltete Reservierungen
-- werden von der Recovery-Funktion entfernt (frische bleiben unberührt),
-- und weder anon noch normale authenticated-Nutzer können die
-- privilegierten Pfade missbrauchen.
--
-- AUSFÜHREN: im Supabase SQL Editor (läuft als postgres) komplett einfügen
-- und ausführen, oder lokal via
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
--     -f supabase/tests/last_admin_deletion_reservation.test.sql
-- Legt Testdaten an, simuliert Aufrufer über SET ROLE + request.jwt.claims,
-- macht am Ende ROLLBACK — es bleiben KEINE Testdaten zurück.
--
-- Ergebnis: eine Tabelle am Ende (case_no | beschreibung | erwartet |
-- ergebnis | verdikt) sowie NOTICE-Meldungen im Messages-/Log-Panel.
-- =========================================================

begin;

-- Fixe IDs für Lesbarkeit:
--   Firma Solo (ein Admin)              = 31111111…
--   Firma Duo  (2 Admins + 1 Mitarbeiter) = 32222222…
--   Firma Inactive (1 administrativ deaktivierter Admin) = 33333333…
--   Firma Recovery (2 Admins, für Recovery-Fixtures)     = 34444444…
--   adminSolo=41…1 | adminX=42…2 | adminY=43…3 | employeeZ=44…4
--   adminInactive=45…5 | adminOld=46…6 | adminFresh=47…7
do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000','41000000-0000-0000-0000-000000000001','authenticated','authenticated','lastadmin-solo@example.test','{"full_name":"Admin Solo"}'),
    ('00000000-0000-0000-0000-000000000000','42000000-0000-0000-0000-000000000002','authenticated','authenticated','lastadmin-x@example.test','{"full_name":"Admin X"}'),
    ('00000000-0000-0000-0000-000000000000','43000000-0000-0000-0000-000000000003','authenticated','authenticated','lastadmin-y@example.test','{"full_name":"Admin Y"}'),
    ('00000000-0000-0000-0000-000000000000','44000000-0000-0000-0000-000000000004','authenticated','authenticated','lastadmin-emp@example.test','{"full_name":"Mitarbeiter Z"}'),
    ('00000000-0000-0000-0000-000000000000','45000000-0000-0000-0000-000000000005','authenticated','authenticated','lastadmin-inactive@example.test','{"full_name":"Admin Inactive"}'),
    ('00000000-0000-0000-0000-000000000000','46000000-0000-0000-0000-000000000006','authenticated','authenticated','lastadmin-old@example.test','{"full_name":"Admin Old"}'),
    ('00000000-0000-0000-0000-000000000000','47000000-0000-0000-0000-000000000007','authenticated','authenticated','lastadmin-fresh@example.test','{"full_name":"Admin Fresh"}');
end $$;

-- Absicherung für lokale Baselines ohne den auth.users-Trigger
-- handle_new_user (siehe Hinweis in supabase/tests/profile_field_guard.test.sql-
-- Historie / Projekt-Memory): legt die profiles-Zeile nur an, falls der
-- Trigger sie nicht schon erzeugt hat. Auf einer Umgebung MIT Trigger ist
-- dies ein reines No-op (ON CONFLICT DO NOTHING), auf einer Umgebung ohne
-- Trigger übernimmt es dessen Aufgabe für den Test.
insert into public.profiles (id, full_name) values
  ('41000000-0000-0000-0000-000000000001','Admin Solo'),
  ('42000000-0000-0000-0000-000000000002','Admin X'),
  ('43000000-0000-0000-0000-000000000003','Admin Y'),
  ('44000000-0000-0000-0000-000000000004','Mitarbeiter Z'),
  ('45000000-0000-0000-0000-000000000005','Admin Inactive'),
  ('46000000-0000-0000-0000-000000000006','Admin Old'),
  ('47000000-0000-0000-0000-000000000007','Admin Fresh')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('31111111-1111-1111-1111-111111111111','Lastadmin Firma Solo','lastadmin-firma-solo'),
  ('32222222-2222-2222-2222-222222222222','Lastadmin Firma Duo','lastadmin-firma-duo'),
  ('33333333-3333-3333-3333-333333333333','Lastadmin Firma Inactive','lastadmin-firma-inactive'),
  ('34444444-4444-4444-4444-444444444444','Lastadmin Firma Recovery','lastadmin-firma-recovery');

update public.profiles set role='admin',    company_id='31111111-1111-1111-1111-111111111111', is_active=true  where id='41000000-0000-0000-0000-000000000001';
update public.profiles set role='admin',    company_id='32222222-2222-2222-2222-222222222222', is_active=true  where id='42000000-0000-0000-0000-000000000002';
update public.profiles set role='admin',    company_id='32222222-2222-2222-2222-222222222222', is_active=true  where id='43000000-0000-0000-0000-000000000003';
update public.profiles set role='employee', company_id='32222222-2222-2222-2222-222222222222', is_active=true  where id='44000000-0000-0000-0000-000000000004';
update public.profiles set role='admin',    company_id='33333333-3333-3333-3333-333333333333', is_active=false where id='45000000-0000-0000-0000-000000000005';
update public.profiles set role='admin',    company_id='34444444-4444-4444-4444-444444444444', is_active=true  where id='46000000-0000-0000-0000-000000000006';
update public.profiles set role='admin',    company_id='34444444-4444-4444-4444-444444444444', is_active=true  where id='47000000-0000-0000-0000-000000000007';

create temp table _lastadmin_results (
  case_no  int,
  beschreibung text,
  erwartet text,
  ergebnis text
) on commit drop;

-- Stash für Tokens zwischen den Cases (jede do-Block-Ausführung hat einen
-- eigenen PL/pgSQL-Scope, Werte müssen also zwischengespeichert werden).
create temp table _lastadmin_tokens (
  who text primary key,
  token uuid
) on commit drop;

-- =========================================================
-- CASE 1 (Anforderung 1): Einziger Admin seiner Firma -> BLOCKIERT
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
  insert into _lastadmin_results values (1,'Einziger Admin (Firma Solo) bereitet Löschung vor','ERROR:last_admin',v);
  raise notice 'CASE 1 (solo admin) -> %', v;
end $$;

-- =========================================================
-- CASE 2 (Anforderung 2): Admin X (Firma Duo, hat Admin Y) -> ERLAUBT,
-- gibt einen Token zurück (kein NULL/leerer Wert)
-- =========================================================
do $$
declare v text; v_token uuid;
begin
  perform set_config('request.jwt.claims','{"sub":"42000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    select public.prepare_self_account_deletion() into v_token;
    v := case when v_token is not null then 'ALLOWED:token' else 'ALLOWED:NULL_TOKEN' end;
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';
  if v_token is not null then
    insert into _lastadmin_tokens values ('adminX', v_token);
  end if;
  insert into _lastadmin_results values (2,'Admin X (Firma Duo) bereitet vor, bekommt Token','ALLOWED:token',v);
  raise notice 'CASE 2 (admin X of two) -> % (token=%)', v, v_token;
end $$;

-- =========================================================
-- CASE 3 (Anforderung 3): Admin Y nach Admin X-Reservierung -> BLOCKIERT
-- (X zählt nicht mehr als "verfügbar", da er einen Token hat)
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
  insert into _lastadmin_results values (3,'Admin Y nach Admin X-Reservierung','ERROR:last_admin',v);
  raise notice 'CASE 3 (admin Y after X reserved) -> %', v;
end $$;

-- =========================================================
-- CASE 4 (Anforderung 4): Reservierung ändert is_active NICHT
-- =========================================================
do $$
declare active_x boolean; v text;
begin
  select is_active into active_x from public.profiles where id='42000000-0000-0000-0000-000000000002';
  v := 'is_active='||coalesce(active_x::text,'null');
  insert into _lastadmin_results values (4,'Admin X ist nach prepare weiterhin is_active=true','is_active=true',v);
  raise notice 'CASE 4 (is_active unaffected) -> %', v;
end $$;

-- =========================================================
-- CASE 5 (Anforderung 5): Rollback mit korrektem Token -> ERFOLG
-- =========================================================
do $$
declare v text; v_token uuid; token_after uuid;
begin
  select token into v_token from _lastadmin_tokens where who='adminX';
  perform set_config('request.jwt.claims','{"sub":"42000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.rollback_self_account_deletion(v_token);
    v := 'CALLED';
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';
  select account_deletion_token into token_after from public.profiles where id='42000000-0000-0000-0000-000000000002';
  if v = 'CALLED' then
    v := case when token_after is null then 'OK:token_cleared' else 'FEHLER:token_noch_gesetzt' end;
  end if;
  insert into _lastadmin_results values (5,'Rollback mit korrektem Token','OK:token_cleared',v);
  raise notice 'CASE 5 (rollback correct token) -> %', v;
end $$;

-- =========================================================
-- CASE 6 (Anforderung 6): Rollback mit FALSCHEM Token -> FEHLER
-- (frische Reservierung für Admin X, dann Rollback mit zufälligem Token)
-- =========================================================
do $$
declare v text; v_token uuid;
begin
  perform set_config('request.jwt.claims','{"sub":"42000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    select public.prepare_self_account_deletion() into v_token;
  exception
    when others then v_token := null;
  end;
  begin
    perform public.rollback_self_account_deletion(gen_random_uuid());
    v := 'ALLOWED';
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';
  if v_token is not null then
    insert into _lastadmin_tokens values ('adminX', v_token)
      on conflict (who) do update set token = excluded.token;
  end if;
  insert into _lastadmin_results values (6,'Rollback mit falschem/fremdem Token','ERROR:reservation_not_found',v);
  raise notice 'CASE 6 (rollback wrong token) -> %', v;
end $$;

-- =========================================================
-- CASE 7 (Anforderung 7): Admin Y versucht Rollback von Admin X''s
-- Reservierung mit dessen ECHTEM Token -> FEHLER (eigene Zeile != X)
-- =========================================================
do $$
declare v text; v_token uuid; token_x_after uuid;
begin
  select token into v_token from _lastadmin_tokens where who='adminX';
  perform set_config('request.jwt.claims','{"sub":"43000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.rollback_self_account_deletion(v_token);
    v := 'ALLOWED';
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';
  select account_deletion_token into token_x_after from public.profiles where id='42000000-0000-0000-0000-000000000002';
  if token_x_after is distinct from v_token then
    v := v || ' + FEHLER:X_wurde_veraendert';
  end if;
  insert into _lastadmin_results values (7,'Admin Y versucht Rollback von Admin X''s Reservierung','ERROR:reservation_not_found',v);
  raise notice 'CASE 7 (cross-user rollback blocked) -> %', v;
end $$;

-- =========================================================
-- CASE 8 (Anforderung 8): Administrativ deaktivierter Admin -> BLOCKIERT
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims','{"sub":"45000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.prepare_self_account_deletion();
    v := 'ALLOWED';
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';
  insert into _lastadmin_results values (8,'Administrativ deaktivierter Admin bereitet Löschung vor','ERROR:inactive_account',v);
  raise notice 'CASE 8 (inactive admin blocked) -> %', v;
end $$;

-- =========================================================
-- CASE 9 + 10 (Anforderung 9+10): Recovery entfernt NUR veraltete
-- Reservierungen (> 15 Min.), frische bleiben unberührt
-- =========================================================
do $$
declare v9 text; v10 text; cleared int;
begin
  -- Fixtures direkt setzen (als postgres) statt über prepare(), damit die
  -- Last-Admin-Logik hier nicht mit hineinspielt — dieser Case testet nur
  -- recover_stale_account_deletion_reservations() isoliert.
  update public.profiles
     set account_deletion_token = gen_random_uuid(),
         account_deletion_reserved_at = now() - interval '30 minutes'
   where id = '46000000-0000-0000-0000-000000000006';

  update public.profiles
     set account_deletion_token = gen_random_uuid(),
         account_deletion_reserved_at = now()
   where id = '47000000-0000-0000-0000-000000000007';

  execute 'set local role service_role';
  select public.recover_stale_account_deletion_reservations() into cleared;
  execute 'reset role';

  select case when account_deletion_token is null then 'OK:cleared' else 'FEHLER:not_cleared' end
    into v9
  from public.profiles where id='46000000-0000-0000-0000-000000000006';

  select case when account_deletion_token is not null then 'OK:kept' else 'FEHLER:cleared' end
    into v10
  from public.profiles where id='47000000-0000-0000-0000-000000000007';

  insert into _lastadmin_results values (9,'Recovery entfernt veraltete Reservierung (>15 Min.)','OK:cleared',v9);
  insert into _lastadmin_results values (10,'Recovery lässt frische Reservierung unberührt','OK:kept',v10);
  raise notice 'CASE 9 (stale removed) -> % | CASE 10 (fresh kept) -> % | cleared_rows=%', v9, v10, cleared;
end $$;

-- =========================================================
-- CASE 11/12/13 (Anforderung 11): Rechte-Matrix via has_function_privilege()
-- statt eines echten Aufrufs als anon/authenticated.
--
-- Hinweis: ein ECHTER Aufruf mit tatsächlich fehlendem EXECUTE-Recht
-- (SET LOCAL ROLE anon; perform public.<fn>();) bringt den lokalen
-- Supabase-Postgres-Container auf diesem Rechner reproduzierbar zum Absturz
-- (SIGSEGV — bestätigt in den Server-Logs, auch mit der bereits vorher
-- existierenden Funktion current_user_role() nach explizitem REVOKE FROM
-- anon; ein Docker-Image-/Postgres-Build-Fehler, unabhängig von dieser
-- Migration). has_function_privilege() prüft dieselbe ACL-Information ohne
-- die Funktion aufzurufen und ist deshalb hier die sichere Alternative.
-- =========================================================
do $$
declare
  v11 text; v12 text; v13a text; v13b text;
begin
  v11 := case when has_function_privilege('anon','public.prepare_self_account_deletion()','EXECUTE')
              then 'ALLOWED' else 'BLOCKED' end;
  v12 := case when has_function_privilege('anon','public.rollback_self_account_deletion(uuid)','EXECUTE')
              then 'ALLOWED' else 'BLOCKED' end;
  v13a := case when has_function_privilege('authenticated','public.recover_stale_account_deletion_reservations()','EXECUTE')
              then 'ALLOWED' else 'BLOCKED' end;
  v13b := case when has_function_privilege('service_role','public.recover_stale_account_deletion_reservations()','EXECUTE')
              then 'ALLOWED' else 'BLOCKED' end;

  insert into _lastadmin_results values (11,'anon: EXECUTE auf prepare_self_account_deletion()','BLOCKED',v11);
  insert into _lastadmin_results values (12,'anon: EXECUTE auf rollback_self_account_deletion(uuid)','BLOCKED',v12);
  insert into _lastadmin_results values (13,'authenticated: EXECUTE auf recover_stale_...() (muss BLOCKED sein) / service_role (muss ALLOWED sein)','BLOCKED+ALLOWED',v13a||'+'||v13b);
  raise notice 'CASE 11 -> % | CASE 12 -> % | CASE 13 -> %+%', v11, v12, v13a, v13b;
end $$;

-- =========================================================
-- CASE 14 (Anforderung 12): Rollback OHNE laufende Reservierung ändert
-- weder is_active noch sonst etwas am Profil (Mitarbeiter Z, nie reserviert)
-- =========================================================
do $$
declare v text; active_before boolean; active_after boolean; role_before text; role_after text;
begin
  select is_active, role into active_before, role_before from public.profiles where id='44000000-0000-0000-0000-000000000004';

  perform set_config('request.jwt.claims','{"sub":"44000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.rollback_self_account_deletion(null);
    v := 'ALLOWED';
  exception
    when others then v := 'ERROR:'||sqlerrm;
  end;
  execute 'reset role';

  select is_active, role into active_after, role_after from public.profiles where id='44000000-0000-0000-0000-000000000004';
  if active_before is distinct from active_after or role_before is distinct from role_after then
    v := v || ' + FEHLER:Profil_veraendert';
  end if;
  insert into _lastadmin_results values (14,'Rollback ohne laufende Reservierung (Mitarbeiter Z)','ERROR:reservation_not_found',v);
  raise notice 'CASE 14 (rollback without reservation, no-op) -> %', v;
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
    when ergebnis like (erwartet || '%') then 'PASS'
    when erwartet = ergebnis then 'PASS'
    else 'FAIL'
  end as verdikt
from _lastadmin_results
order by case_no;

-- Nichts persistieren — reine Prüfung.
rollback;
