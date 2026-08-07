-- =========================================================
-- MIGRATION: Storage-Bucket "job-photos" versioniert anlegen
-- Datum: 2026-08-05
-- =========================================================
-- ZWECK
--   Schliesst die letzte bekannte Storage-Drift. Bisher wurde der Bucket
--   NUR in lib/schema.sql beschrieben — und die Datei ist ausdrueckliche
--   REFERENZ, keine ausgefuehrte Quelle. Folge: jede aus Migrationen
--   gebaute Umgebung (lokal, CI, Staging) hatte GAR KEINEN Bucket, waehrend
--   Produktion einen hat. Auf Staging ist das am 2026-08-05 konkret
--   aufgefallen: die drei "job-photos"-Policies auf storage.objects waren
--   vorhanden (Migration 20260805000000), aber jeder Foto-Upload lief ins
--   Leere, weil das Ziel schlicht nicht existierte.
--
--   20260805000000 hat die POLICIES ins Repository geholt und den Bucket
--   selbst ausdruecklich noch offen gelassen. Das wird hier nachgeholt.
--
-- WERTE NICHT GERATEN, SONDERN AUS PRODUKTION UEBERNOMMEN
--   Ausgelesen am 2026-08-05 per GET /storage/v1/bucket/job-photos gegen
--   Produktion (rein lesend, nichts veraendert). Drei Quellen stimmen exakt
--   ueberein — deshalb sind die Werte hier belastbar und keine Annahme:
--
--     Produktion (live)          public=false  10485760  jpeg,png,webp
--     lib/schema.sql             public=false  10485760  jpeg,png,webp
--     services/photos/photos.service.ts
--       MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  = 10485760
--       ALLOWED_MIME_TYPES  = image/jpeg | image/png | image/webp
--
--   Der Bucket ist PRIVAT (public=false). Der Zugriff laeuft ausschliesslich
--   ueber Signed URLs aus services/photos/photos.service.ts; wer eine Datei
--   sehen oder anlegen darf, entscheiden allein die drei RLS-Policies auf
--   storage.objects aus 20260805000000. Diese Migration vergibt KEINE
--   Rechte — sie legt nur das Ziel an.
--
--   Serverseitiges file_size_limit/allowed_mime_types ist bewusst die
--   ZWEITE Verteidigungslinie: die clientseitige Pruefung im Service ist
--   Komfort (fruehe, verstaendliche Fehlermeldung), erzwungen wird sie hier.
--
-- WIRKUNG JE UMGEBUNG
--   Produktion : reiner No-Op. Der Bucket existiert seit 2026-06-11 mit
--                exakt diesen Werten; das ON CONFLICT schreibt identische
--                Werte zurueck. Es gehen KEINE Objekte verloren — die
--                Dateien haengen an storage.objects, nicht an dieser Zeile.
--   Staging/lokal/CI : legt den Bucket erstmals an und macht Foto-Tests
--                ueberhaupt erst moeglich.
--
-- IDEMPOTENT: beliebig oft ausfuehrbar (ON CONFLICT DO UPDATE).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-photos',
  'job-photos',
  false,
  10485760, -- 10 MB = MAX_FILE_SIZE_BYTES in services/photos/photos.service.ts
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set name               = excluded.name,
      public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- =========================================================
-- ROLLBACK (manuell)
-- =========================================================
-- NICHT einfach "delete from storage.buckets where id='job-photos'" —
-- das schlaegt fehl, solange Objekte im Bucket liegen (FK von
-- storage.objects.bucket_id), und waere dort, wo es durchginge, ein
-- DATENVERLUST. Ein Rollback ist praktisch nur in einer frisch gebauten
-- Umgebung sinnvoll:
--
--   delete from storage.objects where bucket_id = 'job-photos';  -- Datenverlust!
--   delete from storage.buckets where id = 'job-photos';
--
-- In Produktion ist diese Migration ohnehin ein No-Op, dort gibt es nichts
-- zurueckzurollen.
