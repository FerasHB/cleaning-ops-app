-- =========================================================
-- GUARD: Ein normaler End-Nutzer darf die sicherheitskritischen
-- Spalten seines EIGENEN profiles-Datensatzes NICHT selbst ändern:
--   role, company_id, is_active
-- =========================================================
--
-- Problem (vor dieser Migration):
--   Die RLS-Policy "update own profile" erlaubt UPDATE mit
--   USING (id = auth.uid()) und WITH CHECK (id = auth.uid()) — OHNE
--   jede Spalten-Einschränkung. Zusammen mit
--   GRANT ALL ON profiles TO authenticated (kein Column-Grant) konnte
--   jeder eingeloggte Mitarbeiter über die Supabase-API auf seiner
--   eigenen Zeile ausführen:
--
--     update profiles set role       = 'admin' where id = auth.uid();  -- Selbst-Admin
--     update profiles set is_active  = true    where id = auth.uid();  -- Deaktivierung aushebeln
--     update profiles set company_id = '<x>'   where id = auth.uid();  -- Firma wechseln / Mandantenbruch
--
--   Die Policy "update own profile" ist BEWUSST is_active-UNABHÄNGIG
--   (nötig für Realtime + Selbst-Lesen der eigenen Zeile). Sie kann einen
--   deaktivierten Nutzer daher nicht selbst am Reaktivieren hindern —
--   deshalb ist ein serverseitiger Trigger erforderlich.
--
-- Warum ein Trigger und KEIN spaltenweises REVOKE:
--   Admins ändern is_active von Mitarbeitern über einen DIREKTEN
--   authenticated-UPDATE (Policy "admin update profiles in own company",
--   genutzt von services/jobs/jobs.service.ts → setEmployeeActive). Admins
--   verbinden sich mit DERSELBEN Postgres-Rolle ('authenticated') wie
--   Mitarbeiter. Ein pauschales REVOKE UPDATE (is_active, role, company_id)
--   FROM authenticated würde also auch die Admin-De-/Reaktivierung
--   zerstören. Der Trigger kann beide Fälle unterscheiden
--   (Admin-der-gleichen-Firma vs. Selbst-Eskalation) und lässt alle
--   privilegierten/System-Pfade weiterhin durch.
--
-- Ausgenommene Pfade (müssen weiter funktionieren):
--   * service_role (Edge Function create-employee)
--       → current_user = 'service_role'
--   * SECURITY DEFINER-Funktionen im Besitz von postgres
--       (register_admin_with_company, setup_company_for_admin,
--        update_my_push_token, clear_my_push_token)
--       → current_user = 'postgres' innerhalb der Funktion
--   * postgres / Dashboard-SQL
--   Alle laufen unter einem anderen current_user als
--   'authenticated'/'anon' und werden bewusst NICHT geprüft.
--
-- Diese Migration ist additiv: sie ändert KEINE bereits deployte
-- Migration rückwirkend, sondern legt nur eine neue Funktion + einen
-- neuen Trigger an (CREATE OR REPLACE / DROP IF EXISTS + CREATE).

create or replace function public.enforce_profile_field_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Nur echte End-Nutzer-Requests werden geprüft. Alles andere
  -- (service_role, postgres-eigene SECURITY DEFINER-Funktionen,
  -- Dashboard/Superuser) läuft unter einem anderen current_user und ist
  -- per Design ausgenommen. Der Angreifer kann die DB ausschließlich als
  -- 'authenticated' erreichen (sein JWT) — genau dieser Fall wird gedeckt.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- Nichts Sicherheitskritisches geändert → nichts zu prüfen. So bleiben
  -- erlaubte Selbst-Änderungen (full_name, phone, expo_push_token, …)
  -- ungehindert möglich.
  if new.role       is not distinct from old.role
     and new.company_id is not distinct from old.company_id
     and new.is_active  is not distinct from old.is_active then
    return new;
  end if;

  -- Ab hier ändert ein DIREKTER End-Nutzer-Schreibvorgang mindestens eine
  -- geschützte Spalte. Erlaubt ist das NUR für einen aktiven Admin, der auf
  -- einer Zeile SEINER EIGENEN Firma arbeitet (Mitarbeiterverwaltung /
  -- setEmployeeActive). current_user_role() liefert für inaktive/fehlende
  -- Profile NULL (siehe 20260714…), 'admin' also nur für einen aktiven Admin.
  if public.current_user_role() = 'admin'
     and old.company_id is not distinct from public.current_user_company_id() then
    return new;
  end if;

  raise exception
    'Nicht erlaubt: role, company_id und is_active dürfen nur von einem Admin derselben Firma geändert werden.'
    using errcode = '42501';  -- insufficient_privilege → PostgREST 403
end;
$$;

-- BEWUSST NICHT security definer: die Funktion mutiert nur NEW und liest
-- über die (definer-)Helper current_user_role()/current_user_company_id()
-- den Aufrufer-Kontext — keine erweiterten Rechte nötig.
alter function public.enforce_profile_field_guard() owner to postgres;

drop trigger if exists enforce_profile_field_guard_trg on public.profiles;
create trigger enforce_profile_field_guard_trg
before update on public.profiles
for each row
execute function public.enforce_profile_field_guard();

comment on function public.enforce_profile_field_guard() is
'BEFORE UPDATE Guard auf profiles: blockiert Änderungen an role/company_id/is_active aus einem direkten authenticated-End-Nutzer-Schreibvorgang, außer der Aufrufer ist ein aktiver Admin der Firma der betroffenen Zeile. service_role und SECURITY DEFINER-Funktionen (anderer current_user) sind ausgenommen.';
