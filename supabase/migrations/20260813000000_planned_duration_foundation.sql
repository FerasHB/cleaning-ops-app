-- =========================================================
-- MIGRATION: Planned Duration — Grundlage (Phase 3)
-- Datum: 2026-08-13
-- =========================================================
-- ZWECK
--   jobs traegt bislang keine geplante Dauer — nur einen geplanten Start
--   (date/start_time). jobs.scheduled_end existiert als Spalte, wird aber
--   von KEINEM Schreibpfad befuellt (siehe Architektur-Audit); diese
--   Migration nutzt sie NICHT und aendert nichts an ihr.
--
--   Neu: jobs.planned_duration_minutes (nullable). Zusammen mit dem
--   bereits vorhandenen start_time bleibt "Start + Dauer" die EINZIGE
--   Quelle der geplanten Terminierung — kein zweiter, potenziell
--   abweichender Zeitstempel wie scheduled_end.
--
-- BEWUSST NICHT TEIL DIESER MIGRATION
--   * Keine Overlap-Erkennung (weder geplant noch tatsaechlich).
--   * Keine Pflichtfeld-Validierung — planned_duration_minutes ist und
--     bleibt optional; bestehende Jobs funktionieren unveraendert mit
--     NULL weiter.
--   * Keine Aenderung an jobs.scheduled_end, an dessen Schreib- oder
--     Lesepfaden.
--   * Keine Aenderung an Autorisierung/RLS.
--
-- PROPAGATION AUF OCCURRENCES
--   generate_job_occurrences kopiert planned_duration_minutes von der
--   Parent-Regel auf jede neu erzeugte Occurrence — exakt wie start_time.
--   update_job_occurrences behandelt es wie die uebrigen Inhaltsfelder
--   (customer_name, service_name, location_address, notes, is_active) im
--   SYNC-Schritt: nicht individuell angepasste, zukuenftige, offene
--   Termine erhalten die neue Dauer der Regel. NICHT wie start_time im
--   PRUNE-Schritt behandelt — eine Dauer-Aenderung allein macht einen
--   Termin nicht "nicht mehr zur Regel passend" (anders als ein Wochentag-
--   oder Uhrzeit-Wechsel, der den Termin selbst verschiebt).
--
-- IDEMPOTENZ
--   Spalte via ADD COLUMN IF NOT EXISTS, Constraint via DROP + ADD,
--   Funktionen via CREATE OR REPLACE (identische Signaturen) — vollstaendig
--   wiederholbar.
--
-- ANWENDUNG
--   Wie alle Schemaaenderungen hier MANUELL im Supabase SQL Editor
--   ausfuehren (siehe CLAUDE.md). Diese Migration wurde NICHT auf der
--   Produktionsdatenbank ausgefuehrt.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Spalte
-- ---------------------------------------------------------
alter table public.jobs
  add column if not exists planned_duration_minutes integer;

alter table public.jobs
  drop constraint if exists chk_jobs_planned_duration_positive;

alter table public.jobs
  add constraint chk_jobs_planned_duration_positive
  check (planned_duration_minutes is null or planned_duration_minutes > 0);

comment on column public.jobs.planned_duration_minutes is
'Optionale geplante Dauer in Minuten. NULL = keine Dauer geplant (Bestand). '
'Zusammen mit start_time die EINZIGE Quelle der geplanten Terminierung — '
'scheduled_end wird hierfuer bewusst NICHT verwendet (siehe Migrationskopf). '
'Bei recurring-Parent-Regeln die Dauer je Occurrence, propagiert ueber '
'generate_job_occurrences/update_job_occurrences.';


-- ---------------------------------------------------------
-- 2. generate_job_occurrences: Dauer mit erzeugen
-- ---------------------------------------------------------
-- Unveraendert gegenueber 20260728000000_occurrence_assignment_inheritance.sql
-- bis auf die zusaetzliche Spalte planned_duration_minutes im INSERT
-- (kopiert von der Parent-Regel, exakt wie start_time).
create or replace function public.generate_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
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

  generation_start := greatest(
    coalesce(parent.recurrence_start_date, current_date),
    current_date
  );

  hard_limit := generation_start + interval '730 days';

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
        job_type, date, start_time, planned_duration_minutes,
        scheduled_start, is_active, created_by
      )
      values (
        parent.company_id, parent.id, parent.customer_name, parent.service_name,
        parent.location_address, parent.notes, 'open', effective_assigned_to,
        'single', check_date, parent.start_time, parent.planned_duration_minutes,
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

  -- Vollstaendige Zuweisungsmenge der Regel auf die nicht angepassten
  -- Termine uebertragen (unveraendert seit Phase 4).
  perform public.inherit_occurrence_assignments(parent_job_id_input);

  return inserted_count;
end;
$$;

grant execute on function public.generate_job_occurrences(uuid) to authenticated;

comment on function public.generate_job_occurrences(uuid) is
'Erzeugt konkrete Single-Jobs aus einer Recurring-Regel. Zeitraum aus '
'recurrence_start/end_date, hartes Maximum 730 Tage, idempotent. Weist keine '
'Occurrence einem inaktiven Mitarbeiter zu. Kopiert planned_duration_minutes '
'von der Regel auf jede erzeugte Occurrence (Phase 3 Planned Duration, '
'20260813000000). Uebertraegt die vollstaendige Zuweisungsmenge der Regel '
'auf nicht angepasste Termine.';


-- ---------------------------------------------------------
-- 3. update_job_occurrences: Dauer im SYNC-Schritt mitfuehren
-- ---------------------------------------------------------
-- Unveraendert gegenueber 20260728000000_occurrence_assignment_inheritance.sql
-- bis auf planned_duration_minutes im SYNC-UPDATE (Behandlung wie
-- customer_name/notes — ein Inhaltsfeld, kein PRUNE-Kriterium wie
-- start_time, siehe Migrationskopf).
create or replace function public.update_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent    public.jobs%rowtype;
  new_count int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can update occurrences';
  end if;

  select * into parent
  from public.jobs
  where id         = parent_job_id_input
    and company_id = public.current_user_company_id()
    and job_type   = 'recurring'
    and parent_job_id is null
  for update;

  if not found then
    raise exception 'Recurring parent job not found';
  end if;

  -- ── 1) PRUNE ── unveraendert.
  delete from public.jobs c
  where c.parent_job_id = parent_job_id_input
    and c.date >= current_date
    and c.status = 'open'
    and c.started_at is null
    and c.completed_at is null
    and not exists (select 1 from public.job_comments      x where x.job_id = c.id)
    and not exists (select 1 from public.job_photos        x where x.job_id = c.id)
    and not exists (select 1 from public.job_comment_reads x where x.job_id = c.id)
    and (
          not (parent.recurring_days @> array[
            case extract(isodow from c.date)::int
              when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
              when 4 then 'thu' when 5 then 'fri' when 6 then 'sat'
              when 7 then 'sun'
            end
          ])
          or c.start_time is distinct from parent.start_time
          or (parent.recurrence_end_date   is not null and c.date > parent.recurrence_end_date)
          or (parent.recurrence_start_date is not null and c.date < parent.recurrence_start_date)
        );

  -- ── 2) SYNC (OHNE assigned_to) ── planned_duration_minutes NEU dabei,
  -- behandelt wie die uebrigen Inhaltsfelder.
  update public.jobs c
  set
    customer_name             = parent.customer_name,
    service_name              = parent.service_name,
    location_address          = parent.location_address,
    notes                     = parent.notes,
    is_active                 = parent.is_active,
    planned_duration_minutes  = parent.planned_duration_minutes
  where c.parent_job_id = parent_job_id_input
    and c.date >= current_date
    and c.status = 'open'
    and c.started_at is null
    and c.completed_at is null
    and (
         c.customer_name             is distinct from parent.customer_name
      or c.service_name              is distinct from parent.service_name
      or c.location_address          is distinct from parent.location_address
      or c.notes                     is distinct from parent.notes
      or c.is_active                 is distinct from parent.is_active
      or c.planned_duration_minutes  is distinct from parent.planned_duration_minutes
    );

  -- ── 3) GENERATE (inkl. Mengenabgleich) ── unveraendert.
  select public.generate_job_occurrences(parent_job_id_input)
  into new_count;

  return new_count;
end;
$$;

grant execute on function public.update_job_occurrences(uuid) to authenticated;

comment on function public.update_job_occurrences(uuid) is
'Nicht-destruktiv: prunt nur unberuehrte, nicht mehr passende Zukunfts-Termine, '
'synct Inhaltsfelder (customer_name/service_name/location_address/notes/'
'is_active/planned_duration_minutes, OHNE assigned_to) und gleicht die '
'Zuweisungsmenge nicht angepasster Termine an die Regel an. Individuell '
'angepasste Termine behalten ihre Zuweisungen. Bewahrt in_progress/completed, '
'Zeitstempel, Kommentare und Fotos. planned_duration_minutes-Aenderungen '
'loesen KEIN Prunen aus (Phase 3 Planned Duration, 20260813000000) — anders '
'als start_time verschieben sie den Termin selbst nicht.';
