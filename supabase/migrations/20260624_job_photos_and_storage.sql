-- =========================================================
-- MIGRATION: Job-Fotos + Storage
-- Datum: 2026-06-24
-- Zweck: public.job_photos-Tabelle (Metadaten der Foto-Uploads),
--        Indizes, RLS (SELECT/INSERT für Admin + Employee, kein UPDATE/DELETE),
--        privater Storage-Bucket "job-photos",
--        Storage-Policies (SELECT/INSERT + eng begrenztes DELETE für Rollback).
-- =========================================================
-- WICHTIG: Im Supabase SQL Editor ausführen.
-- Bildet den Stand ab, den services/photos/photos.service.ts +
-- types/photo.ts bereits erwarten. Idempotent — mehrfaches Ausführen ist sicher.
-- Bestehende Daten werden NICHT verändert oder gelöscht.
-- =========================================================


-- ---------------------------------------------------------
-- TABELLE: public.job_photos
-- ---------------------------------------------------------
-- Append-only Nachweise, online-only. Datei liegt im privaten Bucket
-- "job-photos", hier nur die Metadaten. uploaded_by ist nullable +
-- on delete set null (Foto bleibt erhalten, wenn der Uploader die Firma verlässt).
-- Pfadkonvention im Bucket: {company_id}/{job_id}/{timestamp}_{random}.{ext}
create table if not exists public.job_photos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  uploaded_by uuid references public.profiles(id) on delete set null,
  storage_path text not null,
  file_name text not null,
  file_size bigint,
  mime_type text,
  created_at timestamptz not null default now()
);


-- ---------------------------------------------------------
-- INDIZES
-- ---------------------------------------------------------
create index if not exists idx_job_photos_job_id on public.job_photos(job_id);
create index if not exists idx_job_photos_company_id on public.job_photos(company_id);
create index if not exists idx_job_photos_created_at on public.job_photos(created_at);


-- ---------------------------------------------------------
-- RLS aktivieren
-- ---------------------------------------------------------
alter table public.job_photos enable row level security;


-- ---------------------------------------------------------
-- RLS: JOB_PHOTOS (spiegelt job_comments)
-- ---------------------------------------------------------

-- Admin liest alle Fotos der eigenen Firma.
drop policy if exists "admin read photos in own company" on public.job_photos;
create policy "admin read photos in own company"
on public.job_photos
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

-- Employee liest nur Fotos zu den ihm zugewiesenen Jobs.
drop policy if exists "employee read photos on own jobs" on public.job_photos;
create policy "employee read photos on own jobs"
on public.job_photos
for select
to authenticated
using (
  public.current_user_role() = 'employee'
  and company_id = public.current_user_company_id()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_photos.job_id
      and j.assigned_to = auth.uid()
  )
);

-- Employee lädt nur zu eigenen Jobs hoch und nur als eigener Uploader.
drop policy if exists "employee insert photos on own jobs" on public.job_photos;
create policy "employee insert photos on own jobs"
on public.job_photos
for insert
to authenticated
with check (
  public.current_user_role() = 'employee'
  and uploaded_by = auth.uid()
  and company_id = public.current_user_company_id()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_photos.job_id
      and j.assigned_to = auth.uid()
      and j.company_id = public.current_user_company_id()
  )
);

-- Admin lädt zu jedem Job der eigenen Firma hoch und nur als eigener Uploader.
drop policy if exists "admin insert photos in own company" on public.job_photos;
create policy "admin insert photos in own company"
on public.job_photos
for insert
to authenticated
with check (
  public.current_user_role() = 'admin'
  and uploaded_by = auth.uid()
  and company_id = public.current_user_company_id()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_photos.job_id
      and j.company_id = public.current_user_company_id()
  )
);

-- WICHTIG:
-- absichtlich KEINE update/delete policy auf public.job_photos.
-- Fotos sind append-only Nachweise → UPDATE/DELETE bei aktivem RLS gesperrt.


-- ---------------------------------------------------------
-- STORAGE: BUCKET job-photos
-- ---------------------------------------------------------
-- Privater Bucket, Zugriff nur über Signed URLs. Limits/MIME-Typen entsprechen
-- der clientseitigen Validierung im Service (10 MB, JPEG/PNG/WebP).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-photos',
  'job-photos',
  false,
  10485760, -- 10 MB (= MAX_FILE_SIZE_BYTES)
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ---------------------------------------------------------
-- STORAGE: POLICIES auf storage.objects (Bucket job-photos)
-- ---------------------------------------------------------
-- Pfadkonvention: {company_id}/{job_id}/{datei}
--   (storage.foldername(name))[1] = company_id
--   (storage.foldername(name))[2] = job_id
-- Jede Policy bindet an die eigene Firma → kein Cross-Company-Zugriff.

-- SELECT (= Signed URLs erzeugen): Admin firmenweit, Employee nur eigene Jobs.
drop policy if exists "job-photos read allowed" on storage.objects;
create policy "job-photos read allowed"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'job-photos'
  and (storage.foldername(name))[1] = public.current_user_company_id()::text
  and exists (
    select 1
    from public.jobs j
    where j.id = ((storage.foldername(name))[2])::uuid
      and j.company_id = public.current_user_company_id()
      and (
        public.current_user_role() = 'admin'
        or (
          public.current_user_role() = 'employee'
          and j.assigned_to = auth.uid()
        )
      )
  )
);

-- INSERT (= Upload): nur in den eigenen Firmen-Pfad und nur für erlaubte Jobs.
drop policy if exists "job-photos insert allowed" on storage.objects;
create policy "job-photos insert allowed"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'job-photos'
  and (storage.foldername(name))[1] = public.current_user_company_id()::text
  and exists (
    select 1
    from public.jobs j
    where j.id = ((storage.foldername(name))[2])::uuid
      and j.company_id = public.current_user_company_id()
      and (
        public.current_user_role() = 'admin'
        or (
          public.current_user_role() = 'employee'
          and j.assigned_to = auth.uid()
        )
      )
  )
);

-- DELETE (eng begrenzt): KEIN UI-Feature. Nur technische Absicherung für den
-- best-effort Rollback in photos.service.ts. Erlaubt nur: Uploader selbst
-- (owner = auth.uid()), eigener Firmen-Pfad, Job der eigenen Firma.
drop policy if exists "job-photos delete own upload" on storage.objects;
create policy "job-photos delete own upload"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'job-photos'
  and owner = auth.uid()
  and (storage.foldername(name))[1] = public.current_user_company_id()::text
  and exists (
    select 1
    from public.jobs j
    where j.id = ((storage.foldername(name))[2])::uuid
      and j.company_id = public.current_user_company_id()
  )
);
