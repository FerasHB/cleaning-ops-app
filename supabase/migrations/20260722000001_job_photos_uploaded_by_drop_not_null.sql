-- Fix (Teil 2): job_photos.uploaded_by NOT NULL entfernen.
--
-- Ergänzung zu 20260722000000: Der FK ist jetzt ON DELETE SET NULL, aber die
-- Spalte uploaded_by war in der Produktions-DB zusätzlich NOT NULL (weiterer
-- Drift gegenüber lib/schema.sql, wo die Spalte nullable dokumentiert ist).
-- Solange NOT NULL gilt, kann SET NULL beim Löschen des Uploaders nicht greifen
-- ("null value in column uploaded_by violates not-null constraint") und die
-- Kontolöschung schlägt weiterhin fehl.
--
-- uploaded_by nullable machen (wie jobs.created_by / job_comments.author_id):
-- Das Foto bleibt als betrieblicher Nachweis erhalten, der Uploader-Verweis wird
-- beim Löschen des Kontos anonymisiert (NULL). Idempotent.

alter table public.job_photos
  alter column uploaded_by drop not null;
