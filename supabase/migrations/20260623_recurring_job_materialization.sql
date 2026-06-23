-- =========================================================
-- MIGRATION: Recurring Job Materialisierung
-- Datum: 2026-06-23
-- Zweck: parent_job_id-Spalte, Indexe gegen Duplikate,
--        generate/update_job_occurrences RPCs,
--        RLS-Anpassung für Employees,
--        Absicherung start_own_job / complete_own_job
-- =========================================================
-- WICHTIG: Im Supabase SQL Editor ausführen.
-- Bestehende Daten (Single Jobs, bestehende Recurring Jobs)
-- werden NICHT verändert oder gelöscht.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Neue Spalte parent_job_id
-- ---------------------------------------------------------
-- Nullable FK auf jobs(id). Ist gesetzt, wenn dieser Job
-- eine generierte Occurrence eines Recurring-Parent ist.
-- ON DELETE CASCADE: Parent löschen → alle Occurrences weg.
-- Bestehende Zeilen behalten NULL → kein Datenverlust.

alter table public.jobs
  add column if not exists parent_job_id uuid
    references public.jobs(id) on delete cascade;


-- ---------------------------------------------------------
-- 2. Index für FK-Lookup (Performance)
-- ---------------------------------------------------------

create index if not exists idx_jobs_parent_job_id
  on public.jobs(parent_job_id);


-- ---------------------------------------------------------
-- 3. Unique Index gegen Duplikate
-- ---------------------------------------------------------
-- Verhindert, dass für denselben Parent an demselben Tag
-- zur selben Uhrzeit zwei Occurrences entstehen.
-- Nur auf Zeilen mit parent_job_id (WHERE-Klausel).
-- Idempotent: ON CONFLICT DO NOTHING in der RPC greift hier.

create unique index if not exists idx_jobs_occurrence_unique
  on public.jobs(parent_job_id, date, start_time)
  where parent_job_id is not null;


-- ---------------------------------------------------------
-- 4. RLS: Employee sieht nur job_type = 'single'
-- ---------------------------------------------------------
-- Ersetzt die bestehende Policy.
-- Employees sehen:
--   - normale Single-Jobs (parent_job_id IS NULL, job_type = 'single')
--   - generierte Occurrences  (parent_job_id IS NOT NULL, job_type = 'single')
-- Employees sehen NICHT:
--   - Parent-Recurring-Regeln (job_type = 'recurring')

drop policy if exists "employee read own assigned jobs" on public.jobs;

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


-- ---------------------------------------------------------
-- 5. RPC: generate_job_occurrences
-- ---------------------------------------------------------
-- Erzeugt konkrete Single-Job-Einträge für einen
-- Recurring-Parent für die nächsten N Wochen.
-- Idempotent: ON CONFLICT DO NOTHING (Unique Index oben).
-- Gibt Anzahl neu eingefügter Zeilen zurück.

create or replace function public.generate_job_occurrences(
  parent_job_id_input uuid,
  weeks_ahead         int default 8
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  parent         public.jobs%rowtype;
  check_date     date := current_date;
  end_date_      date := current_date + (weeks_ahead * 7);
  day_code       text;
  inserted_count int  := 0;
  rows_affected  int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if public.current_user_role() != 'admin' then
    raise exception 'Only admins can generate occurrences';
  end if;

  -- Parent-Job laden: muss recurring sein, darf selbst keine Occurrence sein
  select * into parent
  from public.jobs
  where id          = parent_job_id_input
    and company_id  = public.current_user_company_id()
    and job_type    = 'recurring'
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found or not accessible';
  end if;

  -- Über jeden Kalendertag im Bereich iterieren
  while check_date <= end_date_ loop

    -- PostgreSQL liefert 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'
    -- → auf 3 Zeichen kürzen und lowercasen → 'mon', 'tue', ...
    day_code := lower(to_char(check_date, 'Dy'));

    -- Ist dieser Wochentag in den recurring_days des Parents enthalten?
    if parent.recurring_days @> array[day_code] then

      insert into public.jobs (
        company_id,
        parent_job_id,
        customer_name,
        service_name,
        location_address,
        notes,
        status,
        assigned_to,
        job_type,
        date,
        start_time,
        -- scheduled_start nur als Kompatibilitäts-Fallback für bestehende
        -- Anzeigen (JobDetailScreen, Sortierung). Primärquelle bleibt date + start_time.
        -- Kein Zeitzonen-Handling: einfache Konkatenation, Supabase speichert in UTC.
        scheduled_start,
        is_active,
        created_by
      )
      values (
        parent.company_id,
        parent.id,
        parent.customer_name,
        parent.service_name,
        parent.location_address,
        parent.notes,
        'open',
        parent.assigned_to,
        'single',
        check_date,
        parent.start_time,
        -- scheduled_start: nur setzen wenn start_time vorhanden
        case
          when parent.start_time is not null
          then (check_date::text || ' ' || parent.start_time::text)::timestamptz
          else null
        end,
        parent.is_active,
        parent.created_by
      )
      on conflict (parent_job_id, date, start_time) do nothing;

      -- Zeilen, die wirklich eingefügt wurden (nicht durch CONFLICT übersprungen)
      get diagnostics rows_affected = row_count;
      inserted_count := inserted_count + rows_affected;

    end if;

    check_date := check_date + 1;
  end loop;

  return inserted_count;
end;
$$;

grant execute on function public.generate_job_occurrences(uuid, int) to authenticated;

comment on function public.generate_job_occurrences(uuid, int) is
'Erzeugt konkrete Single-Job-Einträge für einen Recurring-Parent. Idempotent.';


-- ---------------------------------------------------------
-- 6. RPC: update_job_occurrences
-- ---------------------------------------------------------
-- Wird nach Admin-Edit einer Recurring-Regel aufgerufen.
-- Löscht nur zukünftige OFFENE Occurrences und regeneriert.
-- Abgeschlossene / laufende Occurrences bleiben erhalten.

create or replace function public.update_job_occurrences(
  parent_job_id_input uuid,
  weeks_ahead         int default 8
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  parent        public.jobs%rowtype;
  new_count     int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if public.current_user_role() != 'admin' then
    raise exception 'Only admins can update occurrences';
  end if;

  -- Sicherheitscheck: Parent muss zur eigenen Firma gehören
  select * into parent
  from public.jobs
  where id         = parent_job_id_input
    and company_id = public.current_user_company_id()
    and job_type   = 'recurring'
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found';
  end if;

  -- Nur zukünftige, noch offene Occurrences entfernen.
  -- 'in_progress' und 'completed' werden bewusst nicht angefasst
  -- (Mitarbeiter hat damit bereits interagiert).
  delete from public.jobs
  where parent_job_id = parent_job_id_input
    and status        = 'open'
    and date          >= current_date;

  -- Neue Occurrences auf Basis der aktualisierten Regel erzeugen
  select public.generate_job_occurrences(parent_job_id_input, weeks_ahead)
  into new_count;

  return new_count;
end;
$$;

grant execute on function public.update_job_occurrences(uuid, int) to authenticated;

comment on function public.update_job_occurrences(uuid, int) is
'Löscht zukünftige offene Occurrences und regeneriert auf Basis der aktuellen Regel.';


-- ---------------------------------------------------------
-- 7. start_own_job absichern
-- ---------------------------------------------------------
-- Verhindert, dass ein Employee versehentlich eine
-- Parent-Recurring-Regel startet (sollte durch RLS nicht
-- erreichbar sein, aber Defense-in-Depth).

create or replace function public.start_own_job(
  job_id_input     uuid,
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
    status     = 'in_progress',
    started_at = started_at_input,
    completed_at = null
  where id          = job_id_input
    and assigned_to = auth.uid()
    and company_id  = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type    = 'single';   -- Parent-Recurring-Regeln dürfen nicht gestartet werden

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  return started_at_input;
end;
$$;

grant execute on function public.start_own_job(uuid, timestamptz) to authenticated;


-- ---------------------------------------------------------
-- 8. complete_own_job absichern
-- ---------------------------------------------------------

create or replace function public.complete_own_job(
  job_id_input       uuid,
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
    status       = 'completed',
    completed_at = completed_at_input
  where id          = job_id_input
    and assigned_to = auth.uid()
    and company_id  = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type    = 'single';   -- Parent-Recurring-Regeln dürfen nicht abgeschlossen werden

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  return completed_at_input;
end;
$$;

grant execute on function public.complete_own_job(uuid, timestamptz) to authenticated;
