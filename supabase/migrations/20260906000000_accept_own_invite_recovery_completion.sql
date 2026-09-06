-- Invite-Limbo-Fix (Staging-Diagnose 2026-09-05/06): schließt die Lücke, dass
-- ein Mitarbeiter, dessen Einladungs-Deep-Link-Sitzungstoken ABLÄUFT, BEVOR
-- er im accept-invite-Screen ein Passwort setzt, dauerhaft hängen bleibt —
-- die E-Mail ist über /verify bereits bestätigt (auth.users.confirmed_at
-- gesetzt), aber profiles.invite_accepted_at bleibt für immer NULL, weil
-- bislang NUR AcceptInviteScreen accept_own_invite() aufrief. app/index.tsx
-- leitet einen Mitarbeiter mit invite_accepted_at = NULL bei JEDEM Login auf
-- /accept-invite um — ohne gültiges Einladungstoken zeigt der Screen dort
-- "Einladung ungültig" ohne Selbsthilfe-Ausweg (Redirect-Loop).
--
-- Diese Migration macht zwei Änderungen an public.accept_own_invite(), damit
-- ResetPasswordScreen (features/auth/ResetPasswordScreen.tsx) denselben
-- Abschluss-Schritt sicher mit-erledigen kann:
--
--  1. role = 'employee' zusätzlich zur WHERE-Klausel. Vorher hätte JEDER
--     authentifizierte Nutzer mit invite_accepted_at = NULL (z.B. ein frisch
--     selbst-registrierter Admin zwischen signUp() und
--     setup_company_for_admin(), siehe dortiger Kommentar) das Feld gesetzt
--     bekommen, obwohl es für Admins keine Bedeutung hat (kein Admin-Onboarding
--     läuft je über diesen Aufruf). Verteidigung in der Tiefe — ändert nichts
--     an bestehenden Aufrufern, da is_active/invite_accepted_at-Bestandsdaten
--     für Admins durch den Backfill in 20260718000000 bereits nicht-NULL sind.
--
--  2. Rückgabetyp void -> boolean (true = eine Zeile wurde geändert). Ohne
--     dieses Signal kann ein Aufrufer "kein Treffer, weil No-Op erwartet
--     (Admin/bereits akzeptiert/Legacy)" nicht von "kein Treffer, weil die RPC
--     fehlgeschlagen ist" unterscheiden. ResetPasswordScreen braucht das, um
--     einen echten Fehlschlag NICHT stillschweigend als vollen Erfolg
--     darzustellen (siehe dortiger Kommentar). CREATE OR REPLACE kann den
--     Rückgabetyp einer bestehenden Funktion nicht ändern — daher DROP davor.
--     Bestehende Aufrufer (AcceptInviteScreen) destrukturieren nur `error`,
--     der zusätzliche `data`-Wert bricht dort nichts.
--
--     WICHTIG -- Grants nach DROP: eine frisch angelegte Funktion bekommt
--     Postgres' Default-ACL (EXECUTE fuer PUBLIC, was anon automatisch
--     erbt). 20260723000002_harden_rpc_execute_grants.sql hatte anon/PUBLIC
--     hier bereits bewusst entzogen (Least-Privilege) und stattdessen
--     authenticated + service_role gegrantet -- DROP+CREATE wuerde das
--     stillschweigend rueckgaengig machen. Deshalb unten REVOKE vor GRANT,
--     exakt wie in jener Migration.

drop function if exists public.accept_own_invite();

create function public.accept_own_invite()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.profiles
  set invite_accepted_at = now()
  where id = auth.uid()
    and role = 'employee'
    and is_active = true
    and invite_accepted_at is null;

  get diagnostics v_rows = row_count;

  -- Kein raise bei v_rows = 0: erneuter Aufruf nach bereits erfolgter Annahme
  -- (Doppel-Tap, Retry), Aufruf durch einen Admin/Legacy-Nutzer oder ein
  -- inzwischen deaktiviertes Konto ist kein harter Fehler — der Rückgabewert
  -- allein signalisiert dem Aufrufer, ob wirklich etwas geändert wurde.
  return v_rows > 0;
end;
$$;

revoke execute on function public.accept_own_invite() from public, anon;
grant  execute on function public.accept_own_invite() to authenticated, service_role;
