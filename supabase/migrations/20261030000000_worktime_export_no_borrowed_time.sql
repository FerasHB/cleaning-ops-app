-- =========================================================
-- MIGRATION: Arbeitszeit-Export ohne geliehene Auftragszeit
-- Datum: 2026-10-30
-- =========================================================
-- PROBLEM:
--   get_company_worktime_export() (20261028000000) bildete Legacy-Zeilen
--   spaltenweise als coalesce(eigene Zeit, geteilte Job-Uhr). Folgen:
--     * Ein Zugewiesener, der NIE gestartet hat, bekam die volle
--       Auftragsdauer eines Kollegen als Arbeitszeit im Export.
--     * Ein eigener Start ohne eigenes Ende wurde mit dem geteilten Ende
--       kombiniert (gemischtes Paar, erfundene Dauer).
--   Der Export ist der Aufbewahrungsnachweis des Arbeitgebers vor der
--   Firmenloeschung. Der App-Stundenzettel (timesheet.service.ts, mapEntry)
--   schliesst genau diese Faelle seit PR #88 bewusst aus. Mit der neuen
--   Abschlussregel (20261029000000) werden Auftraege mit nie gestarteten
--   Zugewiesenen regulaer abgeschlossen — der Fehler traefe damit jeden
--   solchen Auftrag.
--
-- REGEL (identisch zu mapEntry, Cutoff = utils/jobCorrection.ts
-- PHASE1_CUTOFF_ISO = 2026-08-12T00:00:00Z):
--   1. Eigenes Paar vollstaendig            -> eigene Zeiten.
--   2. Sonst, Auftrag VOR dem Cutoff abgeschlossen und geteilte Uhr
--      vollstaendig                         -> geteilte Uhr (einzige Quelle).
--   3. Sonst                                -> nur eigene Werte, nie geliehen;
--      ohne eigenen Start keine Zeile.
--
-- UNVERAENDERT: Signatur, Spalten, Berechtigung (nur aktive Admins der
--   eigenen Firma), Sitzungszweig, Sortierung, Grants.
-- ROLLBACK: Funktion aus 20261028000000 erneut einspielen. Keine
--   Daten- oder Schemaaenderung.
-- =========================================================

begin;

create or replace function public.get_company_worktime_export()
returns table (
  record_kind text,
  employee_id uuid,
  employee_name text,
  work_date date,
  start_local text,
  end_local text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_minutes integer,
  raw_started_at timestamptz,
  raw_ended_at timestamptz,
  corrected boolean,
  correction_count integer,
  last_correction_origin text,
  last_corrected_at timestamptz,
  time_adjustment_count integer,
  job_id uuid,
  assignment_id uuid,
  timezone text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_role text;
  v_company_id uuid;
  v_is_active boolean;
  v_tz text;
begin
  if v_caller is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select p.role, p.company_id, p.is_active
    into v_role, v_company_id, v_is_active
  from public.profiles p
  where p.id = v_caller;

  if not found or v_role is distinct from 'admin' or v_company_id is null
     or v_is_active is distinct from true then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select coalesce(nullif(c.timezone, ''), 'Europe/Berlin')
    into v_tz
  from public.companies c
  where c.id = v_company_id;

  return query
  with company_assignments as (
    select ja.id, ja.job_id, ja.employee_id, ja.employee_name_snapshot,
           ja.time_tracking_mode, ja.employee_started_at, ja.employee_completed_at,
           j.started_at as job_started_at, j.completed_at as job_completed_at
    from public.job_assignments ja
    join public.jobs j on j.id = ja.job_id
    where j.company_id = v_company_id
  ),
  sessions as (
    select 'session'::text as kind, ca.employee_id as emp,
           coalesce(p.full_name, ca.employee_name_snapshot) as emp_name,
           e.effective_started_at as s, e.effective_ended_at as f,
           e.raw_started_at as rs, e.raw_ended_at as rf,
           e.reviewed as corr,
           (select count(*)::int from public.session_time_corrections stc
             where stc.work_session_id = e.session_id) as corr_count,
           lc.origin as corr_origin, lc.created_at as corr_at,
           0 as adj_count,
           ca.job_id as jid, ca.id as aid
    from public._effective_sessions(
           (select coalesce(array_agg(id), '{}') from company_assignments)) e
    join company_assignments ca on ca.id = e.job_assignment_id
    left join public.profiles p on p.id = ca.employee_id
    left join lateral (
      select stc.origin, stc.created_at
      from public.session_time_corrections stc
      where stc.work_session_id = e.session_id
      order by stc.revision_no desc
      limit 1
    ) lc on true
  ),
  legacy as (
    select 'assignment'::text as kind, ca.employee_id as emp,
           coalesce(p.full_name, ca.employee_name_snapshot) as emp_name,
           src.s, src.f,
           null::timestamptz as rs, null::timestamptz as rf,
           false as corr, 0 as corr_count,
           null::text as corr_origin, null::timestamptz as corr_at,
           (select count(*)::int from public.employee_time_adjustments eta
             where eta.assignment_id = ca.id) as adj_count,
           ca.job_id as jid, ca.id as aid
    from company_assignments ca
    left join public.profiles p on p.id = ca.employee_id
    -- Quelle pro Zeile wie mapEntry: nie eigene und geteilte Werte mischen.
    cross join lateral (
      select
        case
          when ca.employee_started_at is not null
               and ca.employee_completed_at is not null
            then ca.employee_started_at
          when ca.job_completed_at < timestamptz '2026-08-12 00:00:00+00'
               and ca.job_started_at is not null
            then ca.job_started_at
          else ca.employee_started_at
        end as s,
        case
          when ca.employee_started_at is not null
               and ca.employee_completed_at is not null
            then ca.employee_completed_at
          when ca.job_completed_at < timestamptz '2026-08-12 00:00:00+00'
               and ca.job_started_at is not null
            then ca.job_completed_at
          else null::timestamptz
        end as f
    ) src
    where ca.time_tracking_mode = 'legacy'
      and src.s is not null
  )
  select r.kind, r.emp, r.emp_name,
         (r.s at time zone v_tz)::date,
         to_char(r.s at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
         to_char(r.f at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
         r.s, r.f,
         case when r.f is null then null
              else greatest(0, round(extract(epoch from (r.f - r.s)) / 60))::int end,
         r.rs, r.rf, r.corr, r.corr_count, r.corr_origin, r.corr_at, r.adj_count,
         r.jid, r.aid, v_tz
  from (select * from sessions union all select * from legacy) r
  order by r.emp_name nulls last, r.s, r.aid;
end;
$$;

comment on function public.get_company_worktime_export() is
'Arbeitszeit-Export der eigenen Firma für aktive Admins (vor der Firmenlöschung). Nur Arbeitszeit-Fakten; keine Abwesenheiten/Gesundheitsdaten, Notizen, Kommentare, Fotos, Kundendaten.';

revoke all on function public.get_company_worktime_export() from public, anon;
grant execute on function public.get_company_worktime_export() to authenticated;

commit;
