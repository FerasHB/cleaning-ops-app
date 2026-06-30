-- =========================================================
-- MIGRATION: Recurring Horizon (pg_cron) + is_active-Durchsetzung
--            + Funktions-Konsolidierung
-- Datum: 2026-07-01
-- Zweck (Phase 1A + 1B):
--   1A) Overload-Konflikt von generate_job_occurrences bereinigen.
--       Hintergrund: Die früheren Migrationen (20260623 / 20260624_fix /
--       20260624_recurrence_date_range) hinterlassen bei `db push` ZWEI
--       Overloads: generate_job_occurrences(uuid) UND (uuid, int default 8).
--       Ein 1-Argument-Aufruf (jobs.service.ts) ist dann mehrdeutig
--       (SQLSTATE 42725 "function ... is not unique") → Occurrences werden
--       nie erzeugt. Diese Migration droppt ALLE Overloads und stellt genau
--       eine kanonische (uuid)-Version her.
--   1B) Rollierender Horizont: gemeinsame Kern-Generierungslogik
--       (_generate_occurrences_core) + täglicher pg_cron-Lauf
--       (cron_generate_due_occurrences), der den 90-Tage-Horizont aller
--       aktiven Serien automatisch nachfüllt.
--   is_active: server-seitige Durchsetzung in RLS + start_own_job /
--       complete_own_job + Generierung (inaktive Serien erzeugen nichts).
-- =========================================================
-- WICHTIG: Im Supabase SQL Editor ausführen.
-- Bestehende jobs-Daten werden NICHT gelöscht (nur Funktionsdefinitionen,
-- RLS-Policy und — bei update_job_occurrences — zukünftige OFFENE Occurrences).
-- Idempotent: mehrfaches Ausführen ist sicher.
-- =========================================================


-- ---------------------------------------------------------
-- 1A) Funktions-Konsolidierung: ALLE Overloads droppen
-- ---------------------------------------------------------
drop function if exists public.generate_job_occurrences(uuid, int);
drop function if exists public.generate_job_occurrences(uuid);
drop function if exists public.update_job_occurrences(uuid, int);
drop function if exists public.update_job_occurrences(uuid);


-- ---------------------------------------------------------
-- 1B) Kern-Generierungslogik (eine Quelle der Wahrheit)
-- ---------------------------------------------------------
-- Rollierender Horizont: erzeugt Occurrences ab heute (bzw.
-- recurrence_start_date) bis heute + 90 Tage, begrenzt durch
-- recurrence_end_date und ein hartes Maximum (generation_start + 730 Tage).
-- Inaktive Serien (is_active = false) erzeugen NICHTS.
-- Dedup auf Tagesebene (NOT EXISTS parent+date) verhindert eine zweite
-- Occurrence an einem Tag, der bereits eine (auch laufende/erledigte) hat;
-- ON CONFLICT bleibt als Sicherheitsnetz gegen Races.
create or replace function public._generate_occurrences_core(parent public.jobs)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  generation_start date;
  generation_end   date;
  check_date       date;
  day_code         text;
  inserted_count   int := 0;
  rows_affected    int;
begin
  -- Deaktivierte Serien: keine Occurrences
  if parent.is_active is not true then
    return 0;
  end if;

  -- Startpunkt: frühestens heute (keine Alttermine)
  generation_start := greatest(coalesce(parent.recurrence_start_date, current_date), current_date);

  -- Endpunkt: rollierende 90 Tage, gedeckelt durch Enddatum und hartes Maximum
  generation_end := least(
    coalesce(parent.recurrence_end_date, current_date + 90),
    current_date + 90,
    generation_start + 730
  );

  check_date := generation_start;
  while check_date <= generation_end loop
    -- extract(isodow) ist locale-unabhängig: 1=Mo … 7=So
    day_code := case extract(isodow from check_date)::int
      when 1 then 'mon' when 2 then 'tue' when 3 then 'wed' when 4 then 'thu'
      when 5 then 'fri' when 6 then 'sat' when 7 then 'sun'
    end;

    if parent.recurring_days @> array[day_code]
       and not exists (
         select 1 from public.jobs o
         where o.parent_job_id = parent.id and o.date = check_date
       )
    then
      insert into public.jobs (
        company_id, parent_job_id, customer_name, service_name,
        location_address, notes, status, assigned_to,
        job_type, date, start_time, scheduled_start, is_active, created_by
      )
      values (
        parent.company_id, parent.id, parent.customer_name, parent.service_name,
        parent.location_address, parent.notes, 'open', parent.assigned_to,
        'single', check_date, parent.start_time,
        -- scheduled_start: Kompatibilitäts-Fallback (Primärquelle: date + start_time)
        case when parent.start_time is not null
             then (check_date::text || ' ' || parent.start_time::text)::timestamptz
             else null end,
        parent.is_active, parent.created_by
      )
      on conflict (parent_job_id, date, start_time) where parent_job_id is not null
      do nothing;

      get diagnostics rows_affected = row_count;
      inserted_count := inserted_count + rows_affected;
    end if;

    check_date := check_date + 1;
  end loop;

  return inserted_count;
end;
$$;

-- Interne Funktion: nicht direkt durch Clients aufrufbar.
revoke all on function public._generate_occurrences_core(public.jobs) from public;

comment on function public._generate_occurrences_core(public.jobs) is
'Interne Kern-Generierung von Recurring-Occurrences (rollierender 90-Tage-Horizont, '
'is_active-Guard, Tages-Dedup). Wird von generate_/update_job_occurrences und dem Cron geteilt.';


-- ---------------------------------------------------------
-- Kanonische User-RPC: generate_job_occurrences(uuid)
-- ---------------------------------------------------------
create or replace function public.generate_job_occurrences(parent_job_id_input uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  parent public.jobs%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if public.current_user_role() != 'admin' then
    raise exception 'Only admins can generate occurrences';
  end if;

  select * into parent
  from public.jobs
  where id = parent_job_id_input
    and company_id = public.current_user_company_id()
    and job_type = 'recurring'
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found or not accessible';
  end if;

  return public._generate_occurrences_core(parent);
end;
$$;

grant execute on function public.generate_job_occurrences(uuid) to authenticated;

comment on function public.generate_job_occurrences(uuid) is
'Erzeugt Occurrences einer Recurring-Regel (Admin, eigene Firma). Delegiert an '
'_generate_occurrences_core. Idempotent.';


-- ---------------------------------------------------------
-- Kanonische User-RPC: update_job_occurrences(uuid)
-- ---------------------------------------------------------
-- Löscht NUR zukünftige offene Occurrences und regeneriert.
-- in_progress / completed bleiben unangetastet (Historie/Nachweis).
-- Bei deaktivierter Regel werden die zukünftigen offenen gelöscht und NICHT
-- neu erzeugt (Kernfunktion gibt für is_active=false 0 zurück) → "Serie pausiert".
create or replace function public.update_job_occurrences(parent_job_id_input uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  parent public.jobs%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if public.current_user_role() != 'admin' then
    raise exception 'Only admins can update occurrences';
  end if;

  select * into parent
  from public.jobs
  where id = parent_job_id_input
    and company_id = public.current_user_company_id()
    and job_type = 'recurring'
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found';
  end if;

  delete from public.jobs
  where parent_job_id = parent_job_id_input
    and status = 'open'
    and date >= current_date;

  return public._generate_occurrences_core(parent);
end;
$$;

grant execute on function public.update_job_occurrences(uuid) to authenticated;

comment on function public.update_job_occurrences(uuid) is
'Löscht zukünftige offene Occurrences und regeneriert (Abgeschlossene/laufende bleiben). '
'Bei deaktivierter Regel werden keine neuen erzeugt.';


-- ---------------------------------------------------------
-- 1B) Cron-Funktion: rollierenden Horizont firmenübergreifend auffüllen
-- ---------------------------------------------------------
-- Läuft OHNE Auth-Kontext (durch pg_cron als DB-Owner). Iteriert alle aktiven,
-- nicht-abgelaufenen Recurring-Parents und füllt via Kernfunktion auf.
-- Bewusst NICHT an authenticated freigegeben (umgeht Auth-/Firmen-Scope).
create or replace function public.cron_generate_due_occurrences()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  parent public.jobs%rowtype;
  total  int := 0;
begin
  for parent in
    select * from public.jobs
    where job_type = 'recurring'
      and parent_job_id is null
      and is_active = true
      and (recurrence_end_date is null or recurrence_end_date >= current_date)
  loop
    total := total + public._generate_occurrences_core(parent);
  end loop;
  return total;
end;
$$;

revoke all on function public.cron_generate_due_occurrences() from public;

comment on function public.cron_generate_due_occurrences() is
'Täglicher pg_cron-Lauf: füllt den rollierenden Horizont aller aktiven Recurring-Serien auf.';


-- ---------------------------------------------------------
-- 1B) pg_cron: täglicher Lauf (02:00 UTC).
-- ---------------------------------------------------------
-- Konditional, damit dieselbe Datei auch ohne pg_cron (z. B. Test-DB) durchläuft.
-- Auf Supabase: pg_cron muss aktiviert sein (Dashboard → Database → Extensions,
-- oder dieser create extension-Aufruf im SQL Editor).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    begin
      perform cron.unschedule('generate-recurring-occurrences');
    exception when others then null;
    end;
    perform cron.schedule(
      'generate-recurring-occurrences',
      '0 2 * * *',
      'select public.cron_generate_due_occurrences();'
    );
  else
    raise notice 'pg_cron nicht verfügbar — Scheduling übersprungen (lokale/Test-DB).';
  end if;
end $$;


-- ---------------------------------------------------------
-- is_active vollständig durchsetzen (RLS + RPCs)
-- ---------------------------------------------------------
-- Employee sieht nur AKTIVE Single-Jobs/Occurrences.
drop policy if exists "employee read own assigned jobs" on public.jobs;
create policy "employee read own assigned jobs"
on public.jobs
for select
to authenticated
using (
  public.current_user_role() = 'employee'
  and job_type = 'single'
  and is_active = true
  and assigned_to = auth.uid()
  and company_id = public.current_user_company_id()
);

-- start_own_job: zusätzlich is_active = true (deaktivierte nicht startbar).
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
  set status = 'in_progress', started_at = started_at_input, completed_at = null
  where id = job_id_input
    and assigned_to = auth.uid()
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and is_active = true;

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  return started_at_input;
end;
$$;

grant execute on function public.start_own_job(uuid, timestamptz) to authenticated;

-- complete_own_job: analog is_active = true.
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
  set status = 'completed', completed_at = completed_at_input
  where id = job_id_input
    and assigned_to = auth.uid()
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and is_active = true;

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  return completed_at_input;
end;
$$;

grant execute on function public.complete_own_job(uuid, timestamptz) to authenticated;
