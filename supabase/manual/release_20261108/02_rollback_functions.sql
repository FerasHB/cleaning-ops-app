-- =========================================================
-- ROLLBACK 2026-11-08: restores the exact Production definitions
-- captured read-only before the deploy, removes the 4 bookkeeping rows.
-- Does NOT reopen jobs completed in the meantime (see 03/04).
-- =========================================================
begin;
CREATE OR REPLACE FUNCTION public.maybe_complete_job(p_job_id uuid, p_actor uuid, p_at timestamp with time zone, p_emit_event boolean DEFAULT true)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_job      public.jobs%rowtype;
  v_pending  boolean;
  v_emp_name text;
begin
  -- Kein FOR UPDATE: der Aufrufer haelt die Sperre bereits (siehe Kopf).
  select * into v_job from public.jobs where id = p_job_id;

  if not found or v_job.status <> 'in_progress' then
    return false;
  end if;

  select exists (
    select 1
    from public.job_assignments ja
    where ja.job_id = p_job_id
      and public.job_assignment_unresolved(
            ja.employee_id, ja.employee_started_at, ja.employee_completed_at)
  ) into v_pending;

  if v_pending then
    return false;
  end if;

  update public.jobs
  set status       = 'completed',
      completed_at = p_at,
      completed_by = p_actor
  where id = p_job_id
    and status = 'in_progress';

  if not found then
    return false;
  end if;

  if p_emit_event then
    select full_name into v_emp_name from public.profiles where id = p_actor;

    insert into public.notification_outbox (
      company_id, job_id, event_type, job_status,
      employee_id, employee_name, customer_name, service_name
    )
    values (
      v_job.company_id, v_job.id, 'job_completed', 'completed',
      p_actor, v_emp_name, v_job.customer_name, v_job.service_name
    )
    on conflict (job_id, event_type) where event_type in ('job_started', 'job_completed')
    do nothing;
  end if;

  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_company_worktime_export()
 RETURNS TABLE(record_kind text, employee_id uuid, employee_name text, work_date date, start_local text, end_local text, started_at timestamp with time zone, ended_at timestamp with time zone, duration_minutes integer, raw_started_at timestamp with time zone, raw_ended_at timestamp with time zone, corrected boolean, correction_count integer, last_correction_origin text, last_corrected_at timestamp with time zone, time_adjustment_count integer, job_id uuid, assignment_id uuid, timezone text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
           coalesce(ca.employee_started_at, ca.job_started_at) as s,
           coalesce(ca.employee_completed_at, ca.job_completed_at) as f,
           null::timestamptz as rs, null::timestamptz as rf,
           false as corr, 0 as corr_count,
           null::text as corr_origin, null::timestamptz as corr_at,
           (select count(*)::int from public.employee_time_adjustments eta
             where eta.assignment_id = ca.id) as adj_count,
           ca.job_id as jid, ca.id as aid
    from company_assignments ca
    left join public.profiles p on p.id = ca.employee_id
    where ca.time_tracking_mode = 'legacy'
      and coalesce(ca.employee_started_at, ca.job_started_at) is not null
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
$function$;

CREATE OR REPLACE FUNCTION public.get_work_recovery_queue()
 RETURNS TABLE(assignment_id uuid, job_id uuid, employee_id uuid, employee_name text, customer_name text, service_name text, job_status job_status, employee_started_at timestamp with time zone, first_session_start timestamp with time zone, last_session_end timestamp with time zone, open_session_id uuid, open_session_started_at timestamp with time zone, recorded_seconds numeric, effective_seconds numeric, review_required boolean, reason_code text, stuck_since timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if public.current_user_role() is distinct from 'admin'
     or public.current_user_company_id() is null then
    raise exception 'Only admins can read the recovery queue' using errcode = '42501';
  end if;

  return query
  select ja.id,
         j.id,
         ja.employee_id,
         coalesce(nullif(btrim(p.full_name),''), ja.employee_name_snapshot, 'Unbekannt'),
         j.customer_name,
         j.service_name,
         j.status,
         ja.employee_started_at,
         agg.first_start,
         agg.last_end,
         agg.open_id,
         agg.open_started,
         agg.recorded_seconds,
         agg.effective_seconds,
         ja.work_review_required,
         case
           when agg.open_id is not null then 'open_session_expired'
           when ja.work_review_required and last_op.operation_type = 'pause'    then 'late_pause'
           when ja.work_review_required and last_op.operation_type = 'complete' then 'late_complete'
           when ja.work_review_required then 'review_required'
           else 'expired_unresolved'
         end,
         ja.employee_started_at + interval '12 hours'
  from public.job_assignments ja
  join public.jobs j on j.id = ja.job_id
  left join public.profiles p on p.id = ja.employee_id
  left join lateral (
    select min(e.effective_started_at)                              as first_start,
           max(e.effective_ended_at)                                as last_end,
           (array_agg(e.session_id) filter (where e.raw_ended_at is null))[1]    as open_id,
           (array_agg(e.raw_started_at) filter (where e.raw_ended_at is null))[1] as open_started,
           coalesce(sum(extract(epoch from e.raw_ended_at - e.raw_started_at))
             filter (where not exists (
               select 1 from public.session_time_corrections stc
               where stc.work_session_id = e.session_id
                 and stc.revision_no = 1 and stc.origin = 'admin_closed')),0)                 as recorded_seconds,
           coalesce(sum(extract(epoch from e.effective_ended_at - e.effective_started_at)),0) as effective_seconds
    from public._effective_sessions(array[ja.id]) e
  ) agg on true
  left join lateral (
    select r.operation_type from public.work_operation_receipts r
    where r.job_assignment_id = ja.id and r.operation_type <> 'admin_review'
    order by r.created_at desc limit 1
  ) last_op on true
  where j.company_id = public.current_user_company_id()
    and ja.time_tracking_mode = 'sessions'
    and ja.employee_completed_at is null
    and ( ja.work_review_required
          or ja.employee_started_at < now() - interval '12 hours' )
  order by ja.employee_started_at;
end $function$;

revoke all on function public.maybe_complete_job(uuid, uuid, timestamptz, boolean) from public, anon, authenticated;
delete from supabase_migrations.schema_migrations where version in ('20261029000000','20261030000000','20261030000001','20261030000002');
do $chk$ begin
  if (select md5(prosrc) from pg_proc where proname='maybe_complete_job') <> '733e7d14135b2791ce20c8918c00a906'
     or (select md5(prosrc) from pg_proc where proname='get_company_worktime_export') <> '95dd11d181b31210c8656b432ab405e4'
     or (select md5(prosrc) from pg_proc where proname='get_work_recovery_queue') <> '1aece1d361efaf30ec5a2bafd06bac18' then
    raise exception 'ROLLBACK CHECK: definitions do not match the pre-deploy baseline'; end if;
end $chk$;
commit;
