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

create index if not exists idx_job_comments_job_id on public.job_comments(job_id);

create index if not exists idx_job_comment_reads_user_id on public.job_comment_reads(user_id);

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
  where id = auth.uid();
end;
$$;

grant execute on function public.update_my_push_token(text) to authenticated;

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
    and public.current_user_role() = 'employee';

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
    and public.current_user_role() = 'employee';

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

-- =========================================================
-- ENABLE RLS
-- =========================================================

alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.job_comments enable row level security;
alter table public.job_comment_reads enable row level security;

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

create policy "employee read own assigned jobs"
on public.jobs
for select
to authenticated
using (
  public.current_user_role() = 'employee'
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
-- OPTIONAL HARDENING
-- =========================================================

alter table public.profiles
alter column expo_push_token drop default;

comment on function public.setup_company_for_admin(text) is
'Creates a company for the current user, assigns company_id and promotes the user to admin.';

comment on function public.update_my_push_token(text) is
'Updates only the current user expo push token safely via RPC.';

comment on function public.start_own_job(uuid, timestamptz) is
'Employee can start only own assigned job inside own company.';

comment on function public.complete_own_job(uuid, timestamptz) is
'Employee can complete only own assigned job inside own company.';