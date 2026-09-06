-- =========================================================
-- TEST: accept_own_invite() nach dem Invite-Limbo-Fix
-- (Migration 20260906000000_accept_own_invite_recovery_completion.sql)
-- =========================================================
-- HINTERGRUND
--   Staging-Diagnose 2026-09-05/06: ein Mitarbeiter, dessen
--   Einladungs-Deep-Link-Sitzungstoken abläuft, BEVOR er im
--   accept-invite-Screen ein Passwort setzt, bleibt dauerhaft mit
--   bestätigter E-Mail, aber profiles.invite_accepted_at = NULL hängen —
--   app/index.tsx leitet ihn bei JEDEM Login auf /accept-invite um, dort
--   ohne gültiges Einladungstoken nur "Einladung ungültig" ohne
--   Selbsthilfe-Ausweg. ResetPasswordScreen ruft seit diesem Fix dieselbe
--   RPC auf, die bislang NUR AcceptInviteScreen aufrief.
--
--   Damit dieser zusätzliche Aufrufer nichts falsch macht, wurde
--   accept_own_invite() zugleich um `role = 'employee'` verschärft (Admins/
--   Legacy-Konten dürfen NIE über diesen Weg berührt werden) und der
--   Rückgabetyp von void auf boolean geändert (true = eine Zeile wurde
--   WIRKLICH geändert — der Aufrufer muss "erwartetes No-Op" von "RPC
--   fehlgeschlagen" unterscheiden können).
--
-- WAS DIESER TEST FESTSCHREIBT
--   CASE 1  — Mitarbeiter, invite_accepted_at NULL, aktiv: RPC gibt TRUE
--             zurück, invite_accepted_at wird gesetzt (der eigentliche
--             Limbo-Rettungs-Pfad).
--   CASE 2  — Erneuter Aufruf DERSELBEN Zeile (Doppel-Tap/Retry): RPC gibt
--             FALSE zurück, Zeitstempel bleibt UNVERÄNDERT (Idempotenz).
--   CASE 3  — Mitarbeiter, invite_accepted_at bereits gesetzt (Legacy-/
--             Bestandsfall): RPC gibt FALSE zurück, Zeitstempel unverändert
--             — "bereits akzeptierter Mitarbeiter" wird nicht angefasst.
--   CASE 4  — Admin, invite_accepted_at NULL (z.B. Zeitfenster zwischen
--             signUp() und setup_company_for_admin()): RPC gibt FALSE
--             zurück, bleibt NULL — role-Gate verhindert, dass ein
--             Passwort-Reset versehentlich Admin-Onboarding-Semantik ändert.
--   CASE 5  — Mitarbeiter, is_active = false, invite_accepted_at NULL: RPC
--             gibt FALSE zurück, bleibt NULL — bestehender is_active-Schutz
--             bleibt durch den neuen Aufrufer unverändert bestehen.
--   CASE 6  — Aufruf als Mitarbeiter A berührt NIEMALS die Zeile von
--             Mitarbeiter B, obwohl B ebenfalls null+aktiv+employee ist
--             (id = auth.uid()-Scope bleibt bestehen).
--   CASE 7  — Ohne Sitzung (auth.uid() IS NULL): RPC wirft weiterhin
--             'Not authenticated' (unverändertes Verhalten).
--   CASE 8  — EXECUTE-Grant unverändert: authenticated + service_role,
--             nicht anon (die DROP+CREATE-Neuanlage widerruft anon/PUBLIC
--             wieder explizit, siehe Migrationskommentar).
--   CASE 9  — RPC bleibt SECURITY DEFINER (unverändert).
--
-- Alle Aufrufe laufen als echte Rollen (SET ROLE + request.jwt.claims), also
-- über denselben Pfad wie die App über PostgREST/RPC.
--
-- Läuft transaktional (BEGIN … ROLLBACK): keine Rückstände, keine
-- Produktionsdaten. Ausführen lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/invite_limbo_recovery_completion.test.sql
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma      = 99000000-…-1
-- ADMIN      = 98000000-…-1 (role=admin, invite_accepted_at=NULL — CASE 4)
-- LIMBO      = 98000000-…-2 (role=employee, aktiv, invite_accepted_at=NULL — CASE 1+2)
-- ACCEPTED   = 98000000-…-3 (role=employee, aktiv, invite_accepted_at bereits gesetzt — CASE 3)
-- INACTIVE   = 98000000-…-4 (role=employee, is_active=false, invite_accepted_at=NULL — CASE 5)
-- LIMBO_B    = 98000000-…-5 (role=employee, aktiv, invite_accepted_at=NULL — Ziel von CASE 6, darf NICHT berührt werden)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','98000000-0000-0000-0000-000000000001','authenticated','authenticated','u-admin@example.test','{"full_name":"Admin Testfall"}'),
    ('00000000-0000-0000-0000-000000000000','98000000-0000-0000-0000-000000000002','authenticated','authenticated','u-limbo@example.test','{"full_name":"Limbo Mitarbeiter"}'),
    ('00000000-0000-0000-0000-000000000000','98000000-0000-0000-0000-000000000003','authenticated','authenticated','u-accepted@example.test','{"full_name":"Akzeptiert Mitarbeiter"}'),
    ('00000000-0000-0000-0000-000000000000','98000000-0000-0000-0000-000000000004','authenticated','authenticated','u-inactive@example.test','{"full_name":"Inaktiv Mitarbeiter"}'),
    ('00000000-0000-0000-0000-000000000000','98000000-0000-0000-0000-000000000005','authenticated','authenticated','u-limbob@example.test','{"full_name":"Limbo B Mitarbeiter"}');
end $$;

-- Der auth-Trigger handle_new_user ist in der lokalen Baseline nicht
-- enthalten — Profile werden deshalb explizit angelegt.
insert into public.profiles (id, full_name) values
  ('98000000-0000-0000-0000-000000000001','Admin Testfall'),
  ('98000000-0000-0000-0000-000000000002','Limbo Mitarbeiter'),
  ('98000000-0000-0000-0000-000000000003','Akzeptiert Mitarbeiter'),
  ('98000000-0000-0000-0000-000000000004','Inaktiv Mitarbeiter'),
  ('98000000-0000-0000-0000-000000000005','Limbo B Mitarbeiter')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('99000000-0000-0000-0000-000000000001','Invite Limbo Firma','invite-limbo-firma-test');

update public.profiles set company_id='99000000-0000-0000-0000-000000000001', role='admin', is_active=true, invite_accepted_at=null
  where id='98000000-0000-0000-0000-000000000001';
update public.profiles set company_id='99000000-0000-0000-0000-000000000001', role='employee', is_active=true, invite_accepted_at=null
  where id in ('98000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000005');
update public.profiles set company_id='99000000-0000-0000-0000-000000000001', role='employee', is_active=true, invite_accepted_at=timestamptz '2026-01-01 09:00+00'
  where id='98000000-0000-0000-0000-000000000003';
update public.profiles set company_id='99000000-0000-0000-0000-000000000001', role='employee', is_active=false, invite_accepted_at=null
  where id='98000000-0000-0000-0000-000000000004';

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;

-- Ruft accept_own_invite() als <uid> auf und liefert "rpc=<rückgabe>,feld=<invite_accepted_at von uid>".
-- Ein RLS-/Rechteverstoß wird als ABGELEHNT(<sqlstate>) zurückgegeben statt
-- den Test abzubrechen.
create or replace function pg_temp.accept(uid uuid) returns text language plpgsql as $f$
declare v_rpc text; v_feld text;
begin
  perform pg_temp.act_as(uid);
  execute 'set local role authenticated';
  begin
    select public.accept_own_invite()::text into v_rpc;
  exception when others then
    v_rpc := 'ABGELEHNT('||sqlstate||')';
  end;
  execute 'reset role';
  select coalesce(invite_accepted_at::text,'NULL') into v_feld from public.profiles where id=uid;
  return 'rpc='||v_rpc||',feld='||(case when v_feld='NULL' then 'NULL' else 'GESETZT' end);
end $f$;

-- =========================================================
-- CASE 1: LIMBO (employee, aktiv, invite_accepted_at NULL) -> RPC=true, gesetzt.
-- =========================================================
do $$
declare v text;
begin
  v := pg_temp.accept('98000000-0000-0000-0000-000000000002');
  insert into _r values (1,'LIMBO-Mitarbeiter: RPC setzt invite_accepted_at und liefert true','rpc=true,feld=GESETZT',v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- =========================================================
-- CASE 2: erneuter Aufruf DERSELBEN Zeile (Doppel-Tap) -> RPC=false, unverändert.
-- =========================================================
do $$
declare v text; v_ts_vorher timestamptz; v_ts_nachher timestamptz;
begin
  select invite_accepted_at into v_ts_vorher from public.profiles where id='98000000-0000-0000-0000-000000000002';
  v := pg_temp.accept('98000000-0000-0000-0000-000000000002');
  select invite_accepted_at into v_ts_nachher from public.profiles where id='98000000-0000-0000-0000-000000000002';
  insert into _r values (2,'LIMBO-Mitarbeiter erneut: RPC liefert false, Zeitstempel bleibt gleich',
    'rpc=false,feld=GESETZT,idempotent=true',
    v||',idempotent='||(v_ts_vorher = v_ts_nachher)::text);
  raise notice 'CASE 2 -> %', v;
end $$;

-- =========================================================
-- CASE 3: bereits akzeptierter Mitarbeiter -> RPC=false, unverändert.
-- =========================================================
do $$
declare v text; v_ts_vorher timestamptz; v_ts_nachher timestamptz;
begin
  select invite_accepted_at into v_ts_vorher from public.profiles where id='98000000-0000-0000-0000-000000000003';
  v := pg_temp.accept('98000000-0000-0000-0000-000000000003');
  select invite_accepted_at into v_ts_nachher from public.profiles where id='98000000-0000-0000-0000-000000000003';
  insert into _r values (3,'Bereits akzeptierter Mitarbeiter: RPC liefert false, unveraendert',
    'rpc=false,feld=GESETZT,unveraendert=true',
    v||',unveraendert='||(v_ts_vorher = v_ts_nachher)::text);
  raise notice 'CASE 3 -> %', v;
end $$;

-- =========================================================
-- CASE 4: Admin mit invite_accepted_at NULL -> RPC=false, bleibt NULL
-- (role-Gate — Admin-Onboarding-Semantik wird NICHT beruehrt).
-- =========================================================
do $$
declare v text;
begin
  v := pg_temp.accept('98000000-0000-0000-0000-000000000001');
  insert into _r values (4,'Admin (invite_accepted_at NULL): RPC ruehrt Admin-Zeile nicht an','rpc=false,feld=NULL',v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- =========================================================
-- CASE 5: inaktiver Mitarbeiter mit invite_accepted_at NULL -> RPC=false, bleibt NULL
-- (bestehender is_active-Schutz bleibt bestehen).
-- =========================================================
do $$
declare v text;
begin
  v := pg_temp.accept('98000000-0000-0000-0000-000000000004');
  insert into _r values (5,'Inaktiver Mitarbeiter: RPC ruehrt deaktiviertes Konto nicht an','rpc=false,feld=NULL',v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- =========================================================
-- CASE 6: Aufruf als LIMBO_B beruehrt NIEMALS die (bereits akzeptierte)
-- Zeile von LIMBO A — id=auth.uid()-Scope bleibt bestehen.
-- =========================================================
do $$
declare v text; v_feld_a text;
begin
  v := pg_temp.accept('98000000-0000-0000-0000-000000000005');
  select coalesce(invite_accepted_at::text,'NULL') into v_feld_a from public.profiles where id='98000000-0000-0000-0000-000000000002';
  insert into _r values (6,'Aufruf als LIMBO B ruehrt LIMBO A (fremde Zeile) nicht erneut an',
    'rpc=true,feld=GESETZT,fremd_unveraendert=true',
    v||',fremd_unveraendert='||(v_feld_a <> 'NULL')::text);
  raise notice 'CASE 6 -> %', v;
end $$;

-- =========================================================
-- CASE 7: ohne Sitzung (auth.uid() IS NULL) -> weiterhin 'Not authenticated'.
-- =========================================================
do $$
declare v text;
begin
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.accept_own_invite();
    v := 'KEIN FEHLER (FALSCH)';
  exception when others then
    v := sqlerrm;
  end;
  insert into _r values (7,'Ohne Sitzung: RPC wirft weiterhin Not authenticated','Not authenticated',v);
  raise notice 'CASE 7 -> %', v;
end $$;

-- =========================================================
-- CASE 8: EXECUTE-Grants wie in 20260723000002 gehaertet (authenticated +
-- service_role, nicht anon) -- DROP+CREATE darf das nicht zuruecksetzen.
-- =========================================================
do $$
declare v text;
begin
  select 'anon='||has_function_privilege('anon','public.accept_own_invite()','execute')::text
      ||',auth='||has_function_privilege('authenticated','public.accept_own_invite()','execute')::text
      ||',service_role='||has_function_privilege('service_role','public.accept_own_invite()','execute')::text
    into v;
  insert into _r values (8,'EXECUTE-Grants der RPC wie gehaertet (nicht anon)','anon=false,auth=true,service_role=true',v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- =========================================================
-- CASE 9: RPC bleibt SECURITY DEFINER.
-- =========================================================
do $$
declare v text;
begin
  select 'definer='||p.prosecdef::text into v
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='accept_own_invite';
  insert into _r values (9,'RPC bleibt SECURITY DEFINER','definer=true',v);
  raise notice 'CASE 9 -> %', v;
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
    raise exception 'INVITE LIMBO RECOVERY COMPLETION TEST: % von % Faellen FEHLGESCHLAGEN', fails, gesamt;
  end if;
  raise notice 'ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
