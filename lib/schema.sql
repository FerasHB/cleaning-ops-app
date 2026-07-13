-- =========================================================
-- CLEANING EMPLOYEE APP
-- FINAL SAFE SCHEMA
-- passend zu jobs.service.ts
-- =========================================================

create extension if not exists pgcrypto;

-- =========================================================
-- ENUMS
-- =========================================================

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'app_role'
  ) then
    create type public.app_role as enum ('admin', 'employee');
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'job_status'
  ) then
    create type public.job_status as enum ('open', 'in_progress', 'completed');
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'job_type'
  ) then
    create type public.job_type as enum ('single', 'recurring');
  end if;
end
$$;

-- =========================================================
-- TABLES
-- =========================================================

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  full_name text,
  role public.app_role not null default 'employee',
  phone text,
  is_active boolean not null default true,
  expo_push_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_name text not null,
  service_name text not null,
  location_address text not null,
  notes text,
  status public.job_status not null default 'open',
  assigned_to uuid references public.profiles(id) on delete set null,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  -- ── Terminierung: einmalig (single) vs. wiederkehrend (recurring) ──
  -- single:    date + start_time gesetzt, recurring_days null
  -- recurring: recurring_days (Wochentage) + start_time gesetzt, date null
  job_type public.job_type not null default 'single',
  date date,
  start_time time,
  recurring_days text[],
  is_active boolean not null default true,
  -- ── Recurring-Job-Materialisierung ──
  -- Gesetzt wenn dieser Job eine generierte Occurrence eines Recurring-Parents ist.
  -- NULL bei normalen Single-Jobs und bei Recurring-Parent-Regeln selbst.
  -- ON DELETE CASCADE: Parent löschen → alle Occurrences verschwinden automatisch.
  parent_job_id uuid references public.jobs(id) on delete cascade,
  -- Gültigkeitszeitraum der Recurring-Regel (nur auf Parent-Zeilen gesetzt).
  -- recurrence_start_date: frühestmöglicher Termin (Pflicht bei recurring).
  -- recurrence_end_date:   letzter Termin, optional (NULL = läuft weiter).
  recurrence_start_date date,
  recurrence_end_date   date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotente Erweiterung für bestehende Installationen (jobs-Tabelle existierte
-- bereits ohne Terminierungs-Spalten). Bestehende Zeilen werden zu single.
alter table public.jobs add column if not exists job_type public.job_type not null default 'single';
alter table public.jobs add column if not exists date date;
alter table public.jobs add column if not exists start_time time;
alter table public.jobs add column if not exists recurring_days text[];
alter table public.jobs add column if not exists is_active boolean not null default true;
alter table public.jobs add column if not exists parent_job_id uuid references public.jobs(id) on delete cascade;
alter table public.jobs add column if not exists recurrence_start_date date;
alter table public.jobs add column if not exists recurrence_end_date   date;

-- Constraint: Enddatum darf nicht vor Startdatum liegen (NULL-Werte ausgenommen).
alter table public.jobs
  drop constraint if exists chk_recurrence_dates;
alter table public.jobs
  add constraint chk_recurrence_dates check (
    recurrence_end_date   is null
    or recurrence_start_date is null
    or recurrence_end_date >= recurrence_start_date
  );

-- Job-Kommentare (append-only): Mitarbeiter schreiben kurze Nachrichten zu
-- ihren Jobs, Admins lesen (und schreiben optional) firmenweit.
-- Bewusst KEIN updated_at / Edit / Delete (siehe RLS unten).
-- author_id ist nullable + on delete set null: verlässt ein Mitarbeiter die
-- Firma (profiles wird via auth.users gelöscht), bleiben seine Kommentare
-- erhalten, nur der Autor-Verweis wird auf null gesetzt — analog jobs.created_by.
create table if not exists public.job_comments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  message text not null,
  created_at timestamptz not null default now()
);

-- Read-State pro User + Job für ungelesene Kommentare (roter Punkt, MVP).
-- Genau EIN Zeitstempel pro (job_id, user_id): wann der User die Kommentare
-- dieses Jobs zuletzt gesehen hat. Kein per-Kommentar-Read, kein Chat.
-- Scope läuft über EXISTS auf jobs (RLS) — daher KEIN company_id nötig.
create table if not exists public.job_comment_reads (
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  primary key (job_id, user_id)
);

-- Job-Fotos (Nachweise, append-only, online-only). Mitarbeiter/Admins laden
-- Fotos zu Jobs hoch; gespeichert wird nur die Metadaten-Zeile, die Datei liegt
-- im privaten Storage-Bucket "job-photos". Kein Löschen im MVP (siehe RLS unten).
-- uploaded_by ist nullable + on delete set null: verlässt ein Mitarbeiter die
-- Firma, bleibt das Foto als Nachweis erhalten, nur der Uploader-Verweis entfällt
-- (analog jobs.created_by / job_comments.author_id).
-- Pfadkonvention im Bucket: {company_id}/{job_id}/{timestamp}_{random}.{ext}
-- (siehe services/photos/photos.service.ts → buildStoragePath).
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

-- =========================================================
-- INDEXES
-- =========================================================

create index if not exists idx_profiles_company_id on public.profiles(company_id);
create index if not exists idx_profiles_role on public.profiles(role);
create index if not exists idx_profiles_is_active on public.profiles(is_active);

create index if not exists idx_jobs_company_id on public.jobs(company_id);
create index if not exists idx_jobs_assigned_to on public.jobs(assigned_to);
create index if not exists idx_jobs_status on public.jobs(status);
create index if not exists idx_jobs_created_at on public.jobs(created_at);
create index if not exists idx_jobs_job_type on public.jobs(job_type);
create index if not exists idx_jobs_is_active on public.jobs(is_active);
create index if not exists idx_jobs_parent_job_id on public.jobs(parent_job_id);

-- Verhindert Duplikate: Pro Parent + Datum + Uhrzeit nur eine Occurrence.
create unique index if not exists idx_jobs_occurrence_unique
  on public.jobs(parent_job_id, date, start_time)
  where parent_job_id is not null;

create index if not exists idx_job_comments_job_id on public.job_comments(job_id);

create index if not exists idx_job_comment_reads_user_id on public.job_comment_reads(user_id);

create index if not exists idx_job_photos_job_id on public.job_photos(job_id);
create index if not exists idx_job_photos_company_id on public.job_photos(company_id);
create index if not exists idx_job_photos_created_at on public.job_photos(created_at);

-- =========================================================
-- FUNCTIONS
-- =========================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

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
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- WICHTIG: liefert für ein inaktives Profil (is_active = false) bewusst
-- NULL statt der echten Rolle. Praktisch jede RLS-Policy und jede
-- SECURITY DEFINER-RPC in diesem Schema läuft über current_user_role()/
-- current_user_company_id() — NULL propagiert automatisch durch alle
-- WHERE/USING/WITH CHECK-Klauseln und sperrt einen deaktivierten Nutzer
-- damit zentral, ohne jede einzelne Policy separat ändern zu müssen
-- (siehe supabase/migrations/20260713_enforce_inactive_employee_access.sql).
create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
    and is_active = true
  limit 1;
$$;

create or replace function public.current_user_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id
  from public.profiles
  where id = auth.uid()
    and is_active = true
  limit 1;
$$;

revoke all on function public.current_user_role() from public;
revoke all on function public.current_user_company_id() from public;

grant execute on function public.current_user_role() to authenticated;
grant execute on function public.current_user_company_id() to authenticated;

-- =========================================================
-- RPC: SETUP COMPANY FOR ADMIN
-- =========================================================

create or replace function public.setup_company_for_admin(company_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_company_id uuid;
  new_slug text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if trim(coalesce(company_name, '')) = '' then
    raise exception 'Company name is required';
  end if;

  if exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and company_id is not null
  ) then
    raise exception 'User already belongs to a company';
  end if;

  new_slug := lower(trim(company_name));
  new_slug := regexp_replace(new_slug, '\s+', '-', 'g');
  new_slug := regexp_replace(new_slug, '[^a-z0-9\-]', '', 'g');
  new_slug := new_slug || '-' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6);

  insert into public.companies (name, slug)
  values (trim(company_name), new_slug)
  returning id into new_company_id;

  update public.profiles
  set
    company_id = new_company_id,
    role = 'admin'
  where id = auth.uid();

  return new_company_id;
end;
$$;

grant execute on function public.setup_company_for_admin(text) to authenticated;

-- =========================================================
-- RPC: UPDATE OWN PUSH TOKEN
-- =========================================================

-- Schlägt bewusst fehl, wenn das aufrufende Profil inaktiv ist — ein
-- deaktivierter Mitarbeiter darf sich nicht durch einen App-Neustart
-- erneut einen gültigen Push-Token registrieren.
create or replace function public.update_my_push_token(new_token text)
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
  set expo_push_token = new_token
  where id = auth.uid()
    and is_active = true;

  if not found then
    raise exception 'Account is inactive or not found';
  end if;
end;
$$;

grant execute on function public.update_my_push_token(text) to authenticated;

-- Löscht den eigenen Push-Token IMMER, unabhängig von is_active — läuft
-- beim Logout (siehe context/AuthContext.tsx). Muss best effort sein
-- (kein raise bei fehlender Session), damit Logout nie blockiert wird.
create or replace function public.clear_my_push_token()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  update public.profiles
  set expo_push_token = null
  where id = auth.uid();
end;
$$;

grant execute on function public.clear_my_push_token() to authenticated;

-- =========================================================
-- RPC: START OWN JOB
-- =========================================================

create or replace function public.start_own_job(
  job_id_input uuid,
  started_at_input timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.jobs
  set
    status = 'in_progress',
    started_at = started_at_input,
    completed_at = null
  where id = job_id_input
    and assigned_to = auth.uid()
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single';   -- Parent-Recurring-Regeln dürfen nicht gestartet werden

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  return started_at_input;
end;
$$;

grant execute on function public.start_own_job(uuid, timestamptz) to authenticated;

-- =========================================================
-- RPC: COMPLETE OWN JOB
-- =========================================================

create or replace function public.complete_own_job(
  job_id_input uuid,
  completed_at_input timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.jobs
  set
    status = 'completed',
    completed_at = completed_at_input
  where id = job_id_input
    and assigned_to = auth.uid()
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single';   -- Parent-Recurring-Regeln dürfen nicht abgeschlossen werden

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  return completed_at_input;
end;
$$;

grant execute on function public.complete_own_job(uuid, timestamptz) to authenticated;

-- =========================================================
-- RPC: UNGELESENE KOMMENTAR-JOB-IDS
-- =========================================================
-- Liefert die Job-IDs, bei denen es für den aktuellen User ungelesene
-- Kommentare gibt: neuester Kommentar-Zeitpunkt > eigenes last_seen_at.
-- - Admin: alle Jobs der eigenen Firma
-- - Employee: nur eigene (zugewiesene) Jobs
-- - eigene Kommentare zählen NICHT als ungelesen (author_id != auth.uid())

create or replace function public.get_unread_comment_job_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.job_id
  from public.job_comments c
  join public.jobs j on j.id = c.job_id
  where j.company_id = public.current_user_company_id()
    and (
      public.current_user_role() = 'admin'
      or (
        public.current_user_role() = 'employee'
        and j.assigned_to = auth.uid()
      )
    )
    and c.author_id is distinct from auth.uid()
  group by c.job_id
  having max(c.created_at) > coalesce(
    (
      select r.last_seen_at
      from public.job_comment_reads r
      where r.job_id = c.job_id
        and r.user_id = auth.uid()
    ),
    'epoch'::timestamptz
  );
$$;

grant execute on function public.get_unread_comment_job_ids() to authenticated;

-- =========================================================
-- TRIGGERS
-- =========================================================

drop trigger if exists set_companies_updated_at on public.companies;
create trigger set_companies_updated_at
before update on public.companies
for each row
execute function public.set_updated_at();

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

drop trigger if exists set_jobs_updated_at on public.jobs;
create trigger set_jobs_updated_at
before update on public.jobs
for each row
execute function public.set_updated_at();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

-- Verhindert (Neu-)Zuweisung eines Jobs an einen inaktiven Mitarbeiter —
-- Ein Job darf nur einem GÜLTIGEN Mitarbeiter zugewiesen werden: Profil
-- existiert, is_active = true, role = 'employee', gleiche company_id wie
-- der Job. Läuft als Tabellen-Trigger, greift also unabhängig davon, ob
-- der Schreibzugriff über RLS (Admin-Client) oder eine SECURITY DEFINER-RPC
-- erfolgt (z. B. generate_job_occurrences, das zusätzlich selbst schon auf
-- effective_assigned_to reduziert, siehe oben). Geprüft bei INSERT immer,
-- bei UPDATE sobald sich assigned_to ODER company_id ändert.
create or replace function public.enforce_active_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  must_check boolean := false;
begin
  -- Ohne Zuweisung gibt es nichts zu prüfen (offener Job ist erlaubt).
  if new.assigned_to is null then
    return new;
  end if;

  -- OLD wird bewusst NUR im UPDATE-Zweig gelesen (bei INSERT existiert es
  -- nicht). Re-Validierung bei UPDATE, wenn sich assigned_to oder
  -- company_id ändert (Firmenwechsel des Jobs muss die bestehende
  -- Zuweisung erneut gegen die neue Firma prüfen).
  if tg_op = 'INSERT' then
    must_check := true;
  else
    must_check :=
      new.assigned_to is distinct from old.assigned_to
      or new.company_id is distinct from old.company_id;
  end if;

  if not must_check then
    return new;
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id         = new.assigned_to
      and p.is_active  = true
      and p.role       = 'employee'
      and p.company_id = new.company_id
  ) then
    raise exception 'Assignee must be an active employee of the same company';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_active_assignee_on_jobs on public.jobs;
create trigger enforce_active_assignee_on_jobs
before insert or update on public.jobs
for each row
execute function public.enforce_active_assignee();

-- Serverseitige Garantie, dass ein deaktiviertes Profil keinen Push-Token
-- behält — unabhängig vom schreibenden Pfad (Admin-Client, RPC, direktes
-- SQL). Der Client (setEmployeeActive) setzt beides bereits in EINEM UPDATE;
-- dieser Trigger stellt sicher, dass der Client nicht die einzige Stelle ist.
-- Nicht SECURITY DEFINER: mutiert nur NEW im Kontext des Aufrufers.
create or replace function public.clear_push_token_on_deactivate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_active = false and coalesce(old.is_active, true) = true then
    new.expo_push_token := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_push_token_on_deactivate_trg on public.profiles;
create trigger clear_push_token_on_deactivate_trg
before update on public.profiles
for each row
execute function public.clear_push_token_on_deactivate();

-- Realtime: profiles muss Teil der supabase_realtime-Publication sein, damit
-- der Live-Deaktivierungs-Kanal (context/AuthContext.tsx) UPDATE-Events der
-- eigenen Profilzeile empfängt. jobs wurde per Dashboard hinzugefügt; profiles
-- ergänzt die Migration 20260713_enforce_inactive_employee_access.sql
-- (idempotent + guarded). REPLICA IDENTITY FULL, damit der Payload is_active
-- enthält. Der AppState-Foreground-Recheck im AuthContext ist der
-- realtime-UNABHÄNGIGE Fallback, falls Realtime nicht konfiguriert ist.
alter table public.profiles replica identity full;

-- =========================================================
-- ENABLE RLS
-- =========================================================

alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.job_comments enable row level security;
alter table public.job_comment_reads enable row level security;
alter table public.job_photos enable row level security;

-- =========================================================
-- DROP OLD POLICIES
-- =========================================================

drop policy if exists "read own company" on public.companies;
drop policy if exists "admin read own company" on public.companies;

drop policy if exists "employee read own profile" on public.profiles;
drop policy if exists "admin read profiles in own company" on public.profiles;
drop policy if exists "admin update profiles in own company" on public.profiles;
drop policy if exists "update own profile" on public.profiles;

drop policy if exists "admin read jobs in own company" on public.jobs;
drop policy if exists "employee read own assigned jobs" on public.jobs;
drop policy if exists "admin insert jobs in own company" on public.jobs;
drop policy if exists "admin update jobs in own company" on public.jobs;
drop policy if exists "employee update own assigned jobs" on public.jobs;
drop policy if exists "admin delete jobs in own company" on public.jobs;

drop policy if exists "admin read comments in own company" on public.job_comments;
drop policy if exists "employee read comments on own jobs" on public.job_comments;
drop policy if exists "employee insert comments on own jobs" on public.job_comments;
drop policy if exists "admin insert comments in own company" on public.job_comments;

drop policy if exists "read own comment-read state" on public.job_comment_reads;
drop policy if exists "insert own comment-read state" on public.job_comment_reads;
drop policy if exists "update own comment-read state" on public.job_comment_reads;

-- =========================================================
-- RLS: COMPANIES
-- =========================================================

create policy "read own company"
on public.companies
for select
to authenticated
using (
  id = public.current_user_company_id()
);

-- =========================================================
-- RLS: PROFILES
-- =========================================================

create policy "employee read own profile"
on public.profiles
for select
to authenticated
using (
  id = auth.uid()
);

create policy "admin read profiles in own company"
on public.profiles
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

create policy "admin update profiles in own company"
on public.profiles
for update
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
)
with check (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

-- WICHTIG:
-- absichtlich KEINE allgemeine "update own profile" Policy.
-- Sonst könnte der User evtl. role/company_id/is_active manipulieren.
-- Push Token läuft stattdessen über RPC update_my_push_token(...)

-- =========================================================
-- RLS: JOBS
-- =========================================================

create policy "admin read jobs in own company"
on public.jobs
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

-- Employees sehen nur job_type = 'single' (konkrete Termine).
-- Das schließt Parent-Recurring-Regeln (job_type = 'recurring') aus.
-- Gilt für normale Single-Jobs (parent_job_id IS NULL) und
-- generierte Occurrences (parent_job_id IS NOT NULL) gleichermaßen.
create policy "employee read own assigned jobs"
on public.jobs
for select
to authenticated
using (
  public.current_user_role() = 'employee'
  and job_type = 'single'
  and assigned_to = auth.uid()
  and company_id = public.current_user_company_id()
);

create policy "admin insert jobs in own company"
on public.jobs
for insert
to authenticated
with check (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

create policy "admin update jobs in own company"
on public.jobs
for update
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
)
with check (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

create policy "admin delete jobs in own company"
on public.jobs
for delete
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

-- WICHTIG:
-- absichtlich KEINE direkte employee update policy auf jobs.
-- Employee darf Start/Complete nur über RPC:
--   start_own_job(...)
--   complete_own_job(...)

-- =========================================================
-- RLS: JOB_COMMENTS
-- =========================================================

-- Admin liest alle Kommentare der eigenen Firma.
create policy "admin read comments in own company"
on public.job_comments
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

-- Employee liest nur Kommentare zu den ihm zugewiesenen Jobs.
create policy "employee read comments on own jobs"
on public.job_comments
for select
to authenticated
using (
  public.current_user_role() = 'employee'
  and company_id = public.current_user_company_id()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_comments.job_id
      and j.assigned_to = auth.uid()
  )
);

-- Employee schreibt nur zu eigenen Jobs und nur als eigener Autor.
create policy "employee insert comments on own jobs"
on public.job_comments
for insert
to authenticated
with check (
  public.current_user_role() = 'employee'
  and author_id = auth.uid()
  and company_id = public.current_user_company_id()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_comments.job_id
      and j.assigned_to = auth.uid()
      and j.company_id = public.current_user_company_id()
  )
);

-- Admin schreibt zu jedem Job der eigenen Firma und nur als eigener Autor.
create policy "admin insert comments in own company"
on public.job_comments
for insert
to authenticated
with check (
  public.current_user_role() = 'admin'
  and author_id = auth.uid()
  and company_id = public.current_user_company_id()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_comments.job_id
      and j.company_id = public.current_user_company_id()
  )
);

-- WICHTIG:
-- absichtlich KEINE update/delete policy auf job_comments.
-- Kommentare sind append-only (kein Edit/Delete) → bei aktivem RLS
-- sind UPDATE/DELETE damit für alle gesperrt.

-- =========================================================
-- RLS: JOB_COMMENT_READS
-- =========================================================

-- Jeder liest nur seinen eigenen Read-State.
create policy "read own comment-read state"
on public.job_comment_reads
for select
to authenticated
using (
  user_id = auth.uid()
);

-- Eigenen Read-State anlegen — nur für Jobs, die man sehen darf
-- (Admin: Firmen-Jobs, Employee: eigene Jobs).
create policy "insert own comment-read state"
on public.job_comment_reads
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_comment_reads.job_id
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

-- Eigenen Read-State aktualisieren (zweite Hälfte des Upserts).
create policy "update own comment-read state"
on public.job_comment_reads
for update
to authenticated
using (
  user_id = auth.uid()
)
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_comment_reads.job_id
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

-- WICHTIG:
-- absichtlich KEINE delete policy auf job_comment_reads.

-- =========================================================
-- RLS: JOB_PHOTOS
-- =========================================================
-- Spiegelt die job_comments-Policies: Admin sieht firmenweit, Employee nur
-- eigene zugewiesene Jobs. Insert nur als eigener Uploader (uploaded_by).
-- Idempotent via drop-if-exists, damit Schema + Migration mehrfach laufen können.

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
-- Fotos sind append-only Nachweise (kein Edit/Delete in der UI) → bei aktivem
-- RLS sind UPDATE/DELETE damit für alle gesperrt. Der best-effort Rollback in
-- photos.service.ts entfernt nur die STORAGE-Datei (siehe Storage-DELETE-Policy
-- unten), nicht die Tabellen-Zeile — die Zeile wird bei DB-Fehler gar nicht
-- erst angelegt.

-- =========================================================
-- STORAGE: BUCKET job-photos
-- =========================================================
-- Privater Bucket. Zugriff nur über Signed URLs (services/photos/photos.service.ts).
-- Limits/MIME-Typen entsprechen der clientseitigen Validierung im Service:
--   10 MB, image/jpeg | image/png | image/webp.
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

-- =========================================================
-- STORAGE: POLICIES auf storage.objects (Bucket job-photos)
-- =========================================================
-- Pfadkonvention: {company_id}/{job_id}/{datei}
--   (storage.foldername(name))[1] = company_id
--   (storage.foldername(name))[2] = job_id
-- Jede Policy bindet zusätzlich an die eigene Firma → kein Cross-Company-Zugriff.

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
-- best-effort Rollback in photos.service.ts (uploadJobPhoto entfernt die Datei,
-- wenn der anschließende Tabellen-Insert fehlschlägt). Erlaubt ist daher nur:
--   - der Uploader selbst (owner = auth.uid())
--   - innerhalb des eigenen Firmen-Pfads
--   - für einen Job der eigenen Firma
-- Keine breite Lösch-Freigabe, kein Zugriff auf fremde Firmen.
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

-- =========================================================
-- RPC: GENERATE JOB OCCURRENCES
-- =========================================================
-- Erzeugt konkrete Single-Job-Einträge für einen Recurring-Parent.
-- Zeitraum aus recurrence_start_date / recurrence_end_date des Parents.
-- Hartes Maximum: 730 Tage. Idempotent via Unique Index.
--
-- ACHTUNG Operativ: frühere Migrationen (20260624_fix_generate_occurrences_
-- conflict.sql, 20260624_recurrence_date_range.sql) haben je nach
-- Ausführungsreihenfolge im SQL Editor potenziell einen zweiten Overload
-- generate_job_occurrences(uuid, int) hinterlassen. Prüfen mit:
--   select p.proname, pg_get_function_identity_arguments(p.oid)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('generate_job_occurrences', 'update_job_occurrences');
-- Liefert das mehr als eine Zeile pro Funktionsname, existiert der Overload
-- noch live und macht Aufrufe mit einem Argument mehrdeutig (SQLSTATE 42725)
-- — dann supabase/migrations/20260713_enforce_inactive_employee_access.sql
-- (enthält den defensiven DROP) im SQL Editor ausführen.

create or replace function public.generate_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  parent                public.jobs%rowtype;
  generation_start      date;
  generation_end        date;
  hard_limit            date;
  check_date            date;
  day_code              text;
  inserted_count        int := 0;
  rows_affected         int;
  effective_assigned_to uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- IS DISTINCT FROM statt !=: current_user_role() liefert für ein
  -- inaktives/fehlendes Profil NULL. "NULL != 'admin'" ist NULL, und
  -- "IF NULL THEN" löst in PL/pgSQL NICHT aus — der Guard würde sonst
  -- für einen deaktivierten Admin still übersprungen.
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can generate occurrences';
  end if;

  select * into parent
  from public.jobs
  where id          = parent_job_id_input
    and company_id  = public.current_user_company_id()
    and job_type    = 'recurring'
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found or not accessible';
  end if;

  -- Ist der zugewiesene Mitarbeiter inzwischen deaktiviert, werden neue
  -- Occurrences offen (unassigned) statt an ihn gebunden erzeugt.
  select case
    when parent.assigned_to is not null
      and exists (
        select 1 from public.profiles p
        where p.id = parent.assigned_to
          and p.is_active = true
      )
    then parent.assigned_to
    else null
  end
  into effective_assigned_to;

  -- Startpunkt: frühestens heute, damit keine Alttermine entstehen
  generation_start := greatest(
    coalesce(parent.recurrence_start_date, current_date),
    current_date
  );

  -- Hartes Maximum: 730 Tage ab Startpunkt
  hard_limit := generation_start + interval '730 days';

  -- Endpunkt: Enddatum des Parents (begrenzt durch hard_limit)
  -- Kein Enddatum → 3 Monate voraus
  generation_end := least(
    case
      when parent.recurrence_end_date is not null
        then parent.recurrence_end_date
      else generation_start + interval '3 months'
    end,
    hard_limit
  );

  check_date := generation_start;
  while check_date <= generation_end loop

    -- extract(isodow) ist locale-unabhängig: 1=Mo, 2=Di, ..., 7=So
    day_code := case extract(isodow from check_date)::int
      when 1 then 'mon'
      when 2 then 'tue'
      when 3 then 'wed'
      when 4 then 'thu'
      when 5 then 'fri'
      when 6 then 'sat'
      when 7 then 'sun'
    end;

    if parent.recurring_days @> array[day_code] then
      insert into public.jobs (
        company_id, parent_job_id, customer_name, service_name,
        location_address, notes, status, assigned_to,
        job_type, date, start_time, scheduled_start, is_active, created_by
      )
      values (
        parent.company_id, parent.id, parent.customer_name, parent.service_name,
        parent.location_address, parent.notes, 'open', effective_assigned_to,
        'single', check_date, parent.start_time,
        case
          when parent.start_time is not null
          then (check_date::text || ' ' || parent.start_time::text)::timestamptz
          else null
        end,
        parent.is_active, parent.created_by
      )
      on conflict (parent_job_id, date, start_time)
        where parent_job_id is not null
      do nothing;

      get diagnostics rows_affected = row_count;
      inserted_count := inserted_count + rows_affected;
    end if;

    check_date := check_date + 1;
  end loop;

  return inserted_count;
end;
$$;

grant execute on function public.generate_job_occurrences(uuid) to authenticated;

comment on function public.generate_job_occurrences(uuid) is
'Erzeugt konkrete Single-Jobs aus Recurring-Regel. Zeitraum aus recurrence_start/end_date. '
'Hartes Maximum: 730 Tage. Idempotent. Weist keine Occurrence einem inaktiven Mitarbeiter zu.';


-- =========================================================
-- RPC: UPDATE JOB OCCURRENCES
-- =========================================================
-- Löscht zukünftige offene Occurrences, regeneriert auf Basis der aktuellen Regel.
-- Abgeschlossene / laufende Occurrences bleiben erhalten.

create or replace function public.update_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  parent    public.jobs%rowtype;
  new_count int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- IS DISTINCT FROM: siehe Kommentar in generate_job_occurrences oben.
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can update occurrences';
  end if;

  select * into parent
  from public.jobs
  where id         = parent_job_id_input
    and company_id = public.current_user_company_id()
    and job_type   = 'recurring'
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found';
  end if;

  delete from public.jobs
  where parent_job_id = parent_job_id_input
    and status        = 'open'
    and date          >= current_date;

  select public.generate_job_occurrences(parent_job_id_input)
  into new_count;

  return new_count;
end;
$$;

grant execute on function public.update_job_occurrences(uuid) to authenticated;

comment on function public.update_job_occurrences(uuid) is
'Löscht zukünftige offene Occurrences und regeneriert auf Basis der aktuellen Regel.';


-- =========================================================
-- OPTIONAL HARDENING
-- =========================================================

alter table public.profiles
alter column expo_push_token drop default;

comment on function public.setup_company_for_admin(text) is
'Creates a company for the current user, assigns company_id and promotes the user to admin.';

comment on function public.update_my_push_token(text) is
'Updates only the current user expo push token safely via RPC. Fails if the caller profile is inactive.';

comment on function public.clear_my_push_token() is
'Clears only the current user expo push token. Always succeeds for any authenticated caller (active or not) — used on logout so a shared device never keeps a stale token bound to the previous user.';

comment on function public.start_own_job(uuid, timestamptz) is
'Employee can start only own assigned job inside own company.';

comment on function public.complete_own_job(uuid, timestamptz) is
'Employee can complete only own assigned job inside own company.';

comment on function public.enforce_active_assignee() is
'BEFORE INSERT/UPDATE Guard auf jobs: Zuweisung nur an ein aktives Profil mit role=employee derselben company_id. Prüft bei INSERT und bei UPDATE mit geändertem assigned_to oder company_id. Unabhängig vom schreibenden Pfad (RLS oder SECURITY DEFINER RPC).';

comment on function public.clear_push_token_on_deactivate() is
'BEFORE UPDATE Guard auf profiles: nullt expo_push_token, sobald is_active true->false wechselt — serverseitige Garantie, unabhängig vom schreibenden Pfad.';