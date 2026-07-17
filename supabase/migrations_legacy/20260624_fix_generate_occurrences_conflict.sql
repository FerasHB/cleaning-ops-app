-- =========================================================
-- FIX: generate_job_occurrences — ON CONFLICT partieller Index
-- Datum: 2026-06-24
-- Problem: Der Unique Index idx_jobs_occurrence_unique ist ein
--   partieller Index (WHERE parent_job_id IS NOT NULL).
--   PostgreSQL verlangt, dass ON CONFLICT dieselbe WHERE-Bedingung
--   wiederholt — sonst findet er den Index nicht und wirft:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- Fix: WHERE parent_job_id IS NOT NULL zur ON CONFLICT-Klausel ergänzt.
-- =========================================================
-- Nur diese Datei im Supabase SQL Editor ausführen.
-- Keine Daten werden gelöscht oder verändert.
-- =========================================================

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

  select * into parent
  from public.jobs
  where id          = parent_job_id_input
    and company_id  = public.current_user_company_id()
    and job_type    = 'recurring'
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found or not accessible';
  end if;

  while check_date <= end_date_ loop

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
        case
          when parent.start_time is not null
          then (check_date::text || ' ' || parent.start_time::text)::timestamptz
          else null
        end,
        parent.is_active,
        parent.created_by
      )
      -- Partieller Index: WHERE-Bedingung muss in ON CONFLICT wiederholt werden,
      -- sonst findet PostgreSQL den Index nicht (Fehler 42P10).
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

grant execute on function public.generate_job_occurrences(uuid, int) to authenticated;
