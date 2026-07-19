-- Employee invitation flow: profiles.invited_at / invite_accepted_at + RPC.
--
-- invited_at         — wann die (letzte) Einladung verschickt wurde (create-employee /
--                       resend-invite Edge Functions setzen das per Service-Role).
-- invite_accepted_at — wann der Mitarbeiter sein eigenes Passwort gesetzt hat
--                       (accept-invite-Screen ruft dafür die RPC unten auf).
--                       NULL = Einladung noch nicht abgeschlossen.
--
-- WICHTIG — Backfill: profiles ohne Einladungs-Historie (alle vor diesem Feature
-- angelegten Admins/Mitarbeiter) dürfen NICHT rückwirkend als "nicht akzeptiert"
-- gelten — sonst würde die neue Routing-Gate-Prüfung in app/index.tsx sie beim
-- nächsten Login auf accept-invite umleiten, obwohl sie bereits ein Passwort
-- haben. Daher: bestehende Zeilen sofort als akzeptiert markieren.
--
-- REIHENFOLGE BEIM DEPLOY: Diese Migration MUSS vor dem App-Release mit dem
-- aktualisierten Client-Code angewendet werden — getProfileByUserId() selektiert
-- invite_accepted_at bei JEDEM Login, nicht nur bei neuen Einladungen. Ohne diese
-- Migration schlägt der Login für ALLE Nutzer fehl ("column does not exist").

alter table public.profiles
  add column if not exists invited_at timestamptz;

alter table public.profiles
  add column if not exists invite_accepted_at timestamptz;

update public.profiles
set invite_accepted_at = coalesce(invite_accepted_at, created_at)
where invite_accepted_at is null;

-- Markiert die eigene Einladung als abgeschlossen (einmalig, null -> now()).
-- Wird vom accept-invite-Screen aufgerufen, nachdem updateUser({password})
-- erfolgreich war. security definer, weil Mitarbeiter keine UPDATE-Policy auf
-- profiles haben (siehe "admin update profiles in own company" / RLS-Kommentar
-- weiter oben in lib/schema.sql) — exakt dasselbe Muster wie update_my_push_token.
create or replace function public.accept_own_invite()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.profiles
  set invite_accepted_at = now()
  where id = auth.uid()
    and is_active = true
    and invite_accepted_at is null;

  -- Kein raise bei "not found": wird die RPC nach bereits erfolgter Annahme
  -- (Doppel-Tap, Retry) oder bei inzwischen deaktiviertem Konto erneut
  -- aufgerufen, soll das kein harter Fehler sein — der Aufrufer (Screen) zeigt
  -- ohnehin schon "Erfolg" an, sobald updateUser({password}) durchging.
end;
$$;

grant execute on function public.accept_own_invite() to authenticated;
