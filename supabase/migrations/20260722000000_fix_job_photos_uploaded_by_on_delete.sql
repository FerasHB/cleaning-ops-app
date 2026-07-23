-- Fix: job_photos.uploaded_by ON DELETE RESTRICT -> SET NULL
--
-- Kontext: In der Produktions-DB war der Fremdschlüssel
-- job_photos_uploaded_by_fkey mit ON DELETE RESTRICT angelegt (Drift gegenüber
-- lib/schema.sql, das seit jeher SET NULL dokumentiert). RESTRICT verhindert die
-- Löschung eines Profils, sobald der Nutzer mindestens EIN Job-Foto hochgeladen
-- hat: admin.deleteUser(auth.users) -> CASCADE auf profiles wird durch den
-- RESTRICT-FK blockiert, die gesamte Kontolöschung schlägt fehl.
--
-- Das bricht die In-App-Kontolöschung (Edge Function delete-account) und damit
-- die Google-Play-Account-Deletion-Policy: Ein Mitarbeiter, der Nachweisfotos
-- hochgeladen hat, könnte sein Konto nicht löschen.
--
-- Korrektes Verhalten (wie bei jobs.created_by / job_comments.author_id):
-- uploaded_by wird auf NULL gesetzt, das Foto bleibt als betrieblicher Nachweis
-- erhalten, ist danach aber nicht mehr mit dem gelöschten Konto verknüpft
-- (anonymisiert). Idempotent: nur ändern, wenn der FK aktuell nicht SET NULL ist.

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'job_photos_uploaded_by_fkey'
      and conrelid = 'public.job_photos'::regclass
      and confdeltype <> 'n'   -- 'n' = SET NULL
  ) then
    alter table public.job_photos
      drop constraint job_photos_uploaded_by_fkey;

    alter table public.job_photos
      add constraint job_photos_uploaded_by_fkey
      foreign key (uploaded_by)
      references public.profiles(id)
      on delete set null;
  end if;
end $$;
