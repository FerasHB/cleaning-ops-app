-- Forward-only fix: recurring schedule instants use the company's IANA timezone.
-- Canonical schedule remains jobs.date + jobs.start_time. No existing rows are changed.
-- companies.timezone is the existing source; blank/invalid values use Europe/Berlin.
-- scheduled_end is intentionally untouched: recurrence never derives or writes it.

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
  company_timezone      text;
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

  select coalesce(tz.name, 'Europe/Berlin') into company_timezone
  from public.companies c
  left join pg_catalog.pg_timezone_names tz on tz.name = btrim(c.timezone)
  where c.id = parent.company_id;

  perform set_config('app.series_sync', 'on', true);

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
        job_type, date, occurrence_date, start_time, planned_duration_minutes,
        scheduled_start, is_active, created_by
      )
      values (
        parent.company_id, parent.id, parent.customer_name, parent.service_name,
        parent.location_address, parent.notes, 'open', effective_assigned_to,
        'single', check_date, check_date, parent.start_time, parent.planned_duration_minutes,
        case
          when parent.start_time is not null
          then (check_date + parent.start_time) at time zone company_timezone
          else null
        end,
        parent.is_active, parent.created_by
      )
      on conflict (parent_job_id, occurrence_date)
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

  perform set_config('app.series_sync', 'off', true);

  return inserted_count;
end;
$$;

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
  company_timezone text;
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

  select coalesce(tz.name, 'Europe/Berlin') into company_timezone
  from public.companies c
  left join pg_catalog.pg_timezone_names tz on tz.name = btrim(c.timezone)
  where c.id = parent.company_id;

  perform set_config('app.series_sync', 'on', true);

  -- ── 1) PRUNE ──────────────────────────────────────────────────────
  -- Nur noch ein Löschgrund: der SLOT gehört nicht mehr zur Regel
  -- (Wochentag entfernt oder außerhalb des Gültigkeitszeitraums). Eine
  -- geänderte Uhrzeit ist KEIN Löschgrund mehr — dafür gibt es Schritt 2.
  -- Schutz wie bisher: nichts Vergangenes, nichts Gestartetes/Abgeschlossenes,
  -- nichts mit Kommentaren/Fotos/Lesestatus. Zusätzlich ausgenommen: einzeln
  -- angepasste Termine (die hat ein Admin bewusst so gelegt).
  delete from public.jobs c
  where c.parent_job_id = parent_job_id_input
    and c.schedule_overridden = false
    and c.date >= current_date
    and coalesce(c.occurrence_date, c.date) >= current_date
    and c.status = 'open'
    and c.started_at is null
    and c.completed_at is null
    and not exists (select 1 from public.job_comments      x where x.job_id = c.id)
    and not exists (select 1 from public.job_photos        x where x.job_id = c.id)
    and not exists (select 1 from public.job_comment_reads x where x.job_id = c.id)
    and (
          not (parent.recurring_days @> array[
            case extract(isodow from coalesce(c.occurrence_date, c.date))::int
              when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
              when 4 then 'thu' when 5 then 'fri' when 6 then 'sat'
              when 7 then 'sun'
            end
          ])
          or (parent.recurrence_end_date   is not null and coalesce(c.occurrence_date, c.date) > parent.recurrence_end_date)
          or (parent.recurrence_start_date is not null and coalesce(c.occurrence_date, c.date) < parent.recurrence_start_date)
        );

  -- ── 2) RESCHEDULE ─────────────────────────────────────────────────
  -- DER FIX. Termine, die weiterhin zur Regel gehören, werden auf den
  -- aktuellen Regelstand VERSCHOBEN statt gelöscht und neu erzeugt.
  -- Gleiche id ⇒ Zuweisungen, Kommentare, Fotos, Lesestatus, Benachrichtigungen
  -- und jede andere Verknüpfung bleiben erhalten. Genau deshalb ist hier — im
  -- Gegensatz zu PRUNE — Spurenfreiheit KEINE Bedingung: beim Verschieben geht
  -- nichts verloren.
  --
  -- Nicht angefasst: Vergangenheit, in_progress/completed, gestartete oder
  -- abgeschlossene Zeilen, einzeln angepasste Termine.
  update public.jobs c
  set
    date            = coalesce(c.occurrence_date, c.date),
    start_time      = parent.start_time,
    scheduled_start = case
                        when parent.start_time is not null
                        then (coalesce(c.occurrence_date, c.date) + parent.start_time) at time zone company_timezone
                        else null
                      end
  where c.parent_job_id = parent_job_id_input
    and c.schedule_overridden = false
    and c.date >= current_date
    and coalesce(c.occurrence_date, c.date) >= current_date
    and c.status = 'open'
    and c.started_at is null
    and c.completed_at is null
    -- nur Slots, die weiterhin zur Regel gehören (der Rest ist in PRUNE
    -- gelandet oder absichtlich als Rest-Historie stehen geblieben)
    and parent.recurring_days @> array[
          case extract(isodow from coalesce(c.occurrence_date, c.date))::int
            when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
            when 4 then 'thu' when 5 then 'fri' when 6 then 'sat'
            when 7 then 'sun'
          end
        ]
    and (parent.recurrence_end_date   is null or coalesce(c.occurrence_date, c.date) <= parent.recurrence_end_date)
    and (parent.recurrence_start_date is null or coalesce(c.occurrence_date, c.date) >= parent.recurrence_start_date)
    and (
         c.date       is distinct from coalesce(c.occurrence_date, c.date)
      or c.start_time is distinct from parent.start_time
    );

  -- ── 3) SYNC ───────────────────────────────────────────────────────
  -- Inhaltsfelder (OHNE assigned_to, OHNE Terminfelder) — unverändert
  -- gegenüber 20260813000000. Bewusst OHNE schedule_overridden-Filter: ein
  -- einzeln verschobener Termin soll weiterhin den aktuellen Kunden-/Service-/
  -- Ortsstand der Regel zeigen. Individuell ist an ihm nur die TERMINIERUNG,
  -- und die schützt allein Schritt 2.
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

  -- ── 4) GENERATE ───────────────────────────────────────────────────
  -- Füllt nur noch LEERE Slots (setzt app.series_sync selbst).
  select public.generate_job_occurrences(parent_job_id_input)
  into new_count;

  perform set_config('app.series_sync', 'off', true);

  return new_count;
end;
$$;
