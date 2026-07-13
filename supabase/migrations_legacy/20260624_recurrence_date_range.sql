-- =========================================================
-- MIGRATION: Startdatum + Enddatum für Recurring Jobs
-- Datum: 2026-06-24
-- Zweck:
--   - recurrence_start_date / recurrence_end_date auf jobs
--   - Constraint: end >= start
--   - generate_job_occurrences ohne weeks_ahead, liest aus Parent
--   - update_job_occurrences ohne weeks_ahead, analog
-- =========================================================
-- HINWEIS: Bestehende Daten werden nicht verändert.
-- Bestehende Recurring-Jobs ohne Datum-Felder funktionieren
-- weiter via Fallback-Logik in den RPCs.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Neue Spalten
-- ---------------------------------------------------------
-- Nur auf Parent-Recurring-Jobs gesetzt.
-- Single-Jobs und Occurrences bleiben NULL.
-- Nullable: bestehende Zeilen behalten NULL ohne Datenmigration.

alter table public.jobs
  add column if not exists recurrence_start_date date,
  add column if not exists recurrence_end_date   date;


-- ---------------------------------------------------------
-- 2. Constraint: Enddatum darf nicht vor Startdatum liegen
-- ---------------------------------------------------------
-- Greift nur wenn beide Felder gesetzt sind.
-- NULL-Werte werden explizit ausgenommen.

alter table public.jobs
  drop constraint if exists chk_recurrence_dates;

alter table public.jobs
  add constraint chk_recurrence_dates check (
    recurrence_end_date   is null
    or recurrence_start_date is null
    or recurrence_end_date >= recurrence_start_date
  );


-- ---------------------------------------------------------
-- 3. generate_job_occurrences (ersetzt alte Version)
-- ---------------------------------------------------------
-- Änderungen gegenüber Vorgänger:
--   - Parameter weeks_ahead entfällt
--   - Liest recurrence_start_date / recurrence_end_date aus Parent
--   - generation_start = max(recurrence_start_date, current_date)
--     → keine alten Termine massenhaft erzeugen
--   - generation_end:
--       wenn recurrence_end_date gesetzt → recurrence_end_date
--       sonst                            → generation_start + 3 Monate
--       hartes Maximum                  → generation_start + 730 Tage
--   - Fallback: recurrence_start_date NULL → current_date
--   - Idempotent via ON CONFLICT (partieller Unique Index)

create or replace function public.generate_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  parent           public.jobs%rowtype;
  generation_start date;
  generation_end   date;
  hard_limit       date;
  check_date       date;
  day_code         text;
  inserted_count   int := 0;
  rows_affected    int;
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

  -- Startpunkt: frühestens heute — damit keine massenhaften Alttermine entstehen
  generation_start := greatest(
    coalesce(parent.recurrence_start_date, current_date),
    current_date
  );

  -- Hartes Limit: maximal 730 Tage (≈ 2 Jahre) ab Generierungsstart
  hard_limit := generation_start + interval '730 days';

  -- Endpunkt: Enddatum des Parents, begrenzt durch hard_limit
  -- Kein Enddatum gesetzt → 3 Monate voraus
  generation_end := least(
    case
      when parent.recurrence_end_date is not null
        then parent.recurrence_end_date
      else generation_start + interval '3 months'
    end,
    hard_limit
  );

  -- Über jeden Kalendertag im Bereich iterieren
  check_date := generation_start;
  while check_date <= generation_end loop

    -- extract(isodow) ist locale-unabhängig: 1=Mo … 7=So
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
        -- scheduled_start: Kompatibilitäts-Fallback für bestehende Anzeigen.
        -- Primärquelle bleibt date + start_time.
        case
          when parent.start_time is not null
          then (check_date::text || ' ' || parent.start_time::text)::timestamptz
          else null
        end,
        parent.is_active,
        parent.created_by
      )
      -- Partieller Index: WHERE-Bedingung muss in ON CONFLICT wiederholt werden.
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
'Erzeugt konkrete Single-Jobs aus einer Recurring-Regel. Liest Zeitraum aus '
'recurrence_start_date/recurrence_end_date; Fallback: current_date + 3 Monate. '
'Hartes Maximum: 730 Tage. Idempotent.';


-- ---------------------------------------------------------
-- 4. update_job_occurrences (ersetzt alte Version)
-- ---------------------------------------------------------
-- Löscht nur zukünftige offene Occurrences, regeneriert neu.
-- Abgeschlossene / laufende Occurrences bleiben erhalten.
-- weeks_ahead-Parameter entfällt — Zeitraum kommt aus dem Parent.

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

  -- Nur zukünftige offene Occurrences entfernen.
  -- 'in_progress' und 'completed' bleiben unangetastet.
  delete from public.jobs
  where parent_job_id = parent_job_id_input
    and status        = 'open'
    and date          >= current_date;

  -- Neu generieren auf Basis der aktualisierten Regel
  select public.generate_job_occurrences(parent_job_id_input)
  into new_count;

  return new_count;
end;
$$;

grant execute on function public.update_job_occurrences(uuid) to authenticated;

comment on function public.update_job_occurrences(uuid) is
'Löscht zukünftige offene Occurrences und regeneriert auf Basis der aktuellen Regel. '
'Abgeschlossene / laufende Occurrences bleiben erhalten.';
