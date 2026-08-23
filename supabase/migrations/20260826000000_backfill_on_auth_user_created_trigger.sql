-- =========================================================
-- Backfill: on_auth_user_created trigger auf auth.users
-- =========================================================
-- Hintergrund: public.handle_new_user() existiert bereits seit der
-- Baseline-Migration (20260713000000_remote_baseline.sql, ein Dump des
-- *public*-Schemas). Der zugehoerige TRIGGER auf auth.users liegt jedoch im
-- Supabase-verwalteten auth-Schema und wurde beim urspruenglichen
-- Projekt-Setup nur manuell auf Production angelegt (siehe lib/schema.sql,
-- das ihn bereits als Referenz dokumentiert) — nie als Migration erfasst.
-- Frisch aus Migrationen provisionierte Umgebungen (Staging, lokale Dev-DB)
-- haben deshalb die Funktion, aber nicht den Trigger: Admin-Registrierung
-- legt zwar die Firma an, aber setup_company_for_admin()s abschliessendes
-- UPDATE auf public.profiles betrifft 0 Zeilen (kein Fehler, da ungeprueft)
-- — das Profil bleibt unverknuepft.
--
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS/CREATE TRIGGER,
-- sicher erneut anwendbar auch dort, wo Funktion/Trigger schon existieren
-- (Production). Dort ersetzt DROP+CREATE den bestehenden Trigger durch
-- exakt dieselbe, bereits verifizierte Definition (kein 'New User'-
-- Fallback-Unterschied zu lib/schema.sql) — verhaltenserhaltend, ohne
-- Duplikat, auch wenn es technisch kein reiner No-op auf DB-Ebene ist.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', 'New User')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();
