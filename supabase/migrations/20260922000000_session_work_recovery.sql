-- =========================================================
-- Admin Session Recovery (Phase 1 backend)
-- =========================================================
-- PROBLEM (Production-readiness audit): session-aware work could enter a state
-- that NOBODY was able to resolve.
--   * pause_own_job sets work_review_required when the pause lands more than
--     12 hours after employee_started_at;
--   * complete_own_job_v2 rejected both that flag and any completion past the
--     same 12-hour window;
--   * admin_correct_assignment_time refuses session-mode rows (20260919000002);
--   * admin_force_complete_job closes only the parent job and deliberately
--     never touches job_assignments.
-- The assignment therefore stayed unresolved for ever: zero payroll minutes for
-- real recorded work, a permanent timesheet gap and a parent job stuck in
-- 'in_progress'.
--
-- SECOND PROBLEM (product requirement): an employee who forgets to pause or to
-- complete produces an excessive raw interval — start 08:00, button pressed the
-- next day at 10:00. The recorded evidence is genuine (the button really was
-- pressed then) but it is NOT payroll time. An admin must be able to review the
-- case and approve the factual end, 16:30, WITHOUT destroying the raw record.
--
-- MODEL: work_sessions stays raw evidence. A separate append-only correction
-- layer carries the payroll-effective interval. Accounting resolves exactly one
-- value per session through _effective_sessions(); nothing adds durations
-- together, so raw and effective can never be double counted.
--
-- CEILING (absolute, enforced for every operation kind): the effective end may
-- never exceed what the app recorded. Where the employee recorded nothing, the
-- system bound least(now(), started_at + 12 hours) applies instead — the same
-- bound the first admin close already had to obey.

begin;

-- ---------------------------------------------------------
-- 1. Append-only correction layer
-- ---------------------------------------------------------
-- No customer name, address, notes or employee name is copied in: every one of
-- those is reachable by join and none of them is part of the audit question
-- ("who approved what, when, why, and what did the payroll duration become").
create table public.session_time_corrections (
  correction_id              uuid primary key,
  work_session_id            uuid not null
                               references public.work_sessions(id) on delete restrict,
  job_assignment_id          uuid not null
                               references public.job_assignments(id) on delete restrict,
  job_id                     uuid not null references public.jobs(id) on delete restrict,
  -- Mirrors work_sessions.employee_id: an account deletion anonymises the row
  -- but must never erase the audit trail.
  employee_id                uuid references public.profiles(id) on delete set null,
  revision_no                int  not null check (revision_no >= 1),
  origin                     text not null
                               check (origin in ('admin_reduced','admin_closed','admin_raised')),
  raw_started_at             timestamptz not null,
  raw_ended_at               timestamptz,
  raw_duration_seconds       numeric,
  -- Reserved: V1 never moves a start. sessionAccounting.ts requires
  -- employee_started_at to stay equal to the first session start.
  effective_started_at       timestamptz,
  effective_ended_at         timestamptz not null,
  effective_duration_seconds numeric not null check (effective_duration_seconds > 0),
  -- Generated, therefore NULL exactly when it is undefined: an admin_closed row
  -- has no raw end, so "how much was taken away" has no answer. Storing 0 there
  -- would be a fabrication.
  delta_seconds              numeric generated always as
                               (effective_duration_seconds - raw_duration_seconds) stored,
  performed_by               uuid references public.profiles(id) on delete set null,
  reason                     text not null,
  created_at                 timestamptz not null default now(),

  constraint session_time_corrections_revision_uq unique (work_session_id, revision_no),
  constraint session_time_corrections_raw_pair_chk
    check ((raw_ended_at is null) = (raw_duration_seconds is null)),
  constraint session_time_corrections_effective_after_start_chk
    check (effective_ended_at > coalesce(effective_started_at, raw_started_at)),
  -- The ceiling as a row-level invariant. Even an application bug cannot write
  -- an effective end above an employee-recorded end.
  constraint session_time_corrections_ceiling_chk
    check (raw_ended_at is null or effective_ended_at <= raw_ended_at),
  constraint session_time_corrections_origin_shape_chk
    check (
      case origin
        when 'admin_closed'  then raw_ended_at is null
        when 'admin_reduced' then raw_ended_at is not null
                                  and effective_duration_seconds <= raw_duration_seconds
        when 'admin_raised'  then true
      end
    ),
  constraint session_time_corrections_reason_chk
    check (length(btrim(reason)) >= 10)
);

comment on table public.session_time_corrections is
'Append-only payroll correction layer over work_sessions. work_sessions stays '
'raw employee/app evidence and is never rewritten; this table carries the '
'payroll-effective interval. origin distinguishes the two truthful cases: '
'admin_reduced = the employee recorded an excessive end that the admin reduced; '
'admin_closed = the employee never recorded an end and the admin supplied the '
'factual one (raw_ended_at and delta_seconds are NULL, because no raw duration '
'exists); admin_raised = an explicitly declared upward revision of an earlier, '
'too-low admin correction, still capped by the same ceiling. The active row for '
'a session is the one with the highest revision_no.';

comment on column public.session_time_corrections.delta_seconds is
'effective_duration_seconds - raw_duration_seconds. NULL for admin_closed, '
'because the employee never recorded an end and a raw duration therefore does '
'not exist. NULL means "no raw value to compare against", never "no change".';

create index session_time_corrections_session_rev
  on public.session_time_corrections(work_session_id, revision_no desc);
create index session_time_corrections_assignment
  on public.session_time_corrections(job_assignment_id);

-- Append-only: a correction is an audit event. Correcting a correction means
-- inserting revision_no + 1, never editing the earlier judgement.
create function public.guard_session_time_correction_write()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  raise exception 'Session time corrections are append-only' using errcode = '42501';
end $$;
create trigger guard_session_time_correction_write_trg
before update or delete on public.session_time_corrections
for each row execute function public.guard_session_time_correction_write();
revoke all on function public.guard_session_time_correction_write()
  from public, anon, authenticated;

-- Supabase public-schema defaults would otherwise expose a new table.
alter table public.session_time_corrections enable row level security;
revoke all on public.session_time_corrections
  from public, anon, authenticated, service_role;
grant select on public.session_time_corrections to service_role;
grant select on public.session_time_corrections to authenticated;

-- Admin SELECT within the own company only. Employees get NO policy at all:
-- the reason field may carry internal notes and must never leave the admin
-- boundary. Employees read their effective time through
-- get_effective_work_sessions() instead.
create policy session_time_corrections_admin_read on public.session_time_corrections
  for select to authenticated
  using (public.current_user_role() = 'admin'
         and public.job_in_current_company(job_id));

-- ---------------------------------------------------------
-- 2. Recovery-queue supporting index
-- ---------------------------------------------------------
-- The working set is tiny (unresolved session-mode assignments only), so the
-- partial index keeps get_work_recovery_queue() proportional to the matches
-- rather than to job_assignments.
create index job_assignments_unresolved_sessions
  on public.job_assignments(employee_started_at)
  where employee_completed_at is null and time_tracking_mode = 'sessions';

-- ---------------------------------------------------------
-- 3. The single payroll-effective overlay
-- ---------------------------------------------------------
-- ONE definition of "which interval counts". Every payroll consumer resolves
-- through this function; nothing else may compute a duration from work_sessions
-- directly. Internal and revoked: the SECURITY DEFINER wrappers below carry the
-- authorization, this function carries only the arithmetic.
create function public._effective_sessions(p_assignment_ids uuid[])
returns table (
  session_id           uuid,
  job_assignment_id    uuid,
  employee_id          uuid,
  raw_started_at       timestamptz,
  raw_ended_at         timestamptz,
  effective_started_at timestamptz,
  effective_ended_at   timestamptz,
  reviewed             boolean
)
language sql
stable
set search_path = public, pg_temp
as $$
  select ws.id, ws.job_assignment_id, ws.employee_id,
         ws.started_at, ws.ended_at,
         coalesce(c.effective_started_at, ws.started_at),
         coalesce(c.effective_ended_at,   ws.ended_at),
         c.correction_id is not null
  from public.work_sessions ws
  left join lateral (
    select stc.correction_id, stc.effective_started_at, stc.effective_ended_at
    from public.session_time_corrections stc
    where stc.work_session_id = ws.id
    order by stc.revision_no desc
    limit 1
  ) c on true
  where ws.job_assignment_id = any(p_assignment_ids);
$$;
revoke all on function public._effective_sessions(uuid[]) from public, anon, authenticated;

comment on function public._effective_sessions(uuid[]) is
'The single payroll-effective session source. Resolves each raw work_session '
'against its highest-revision correction. A correction REPLACES an endpoint, it '
'never adds a duration — raw and effective can therefore not be double counted.';

-- ---------------------------------------------------------
-- 4. Absolute ceiling per session
-- ---------------------------------------------------------
-- An admin-filled ended_at must NEVER be mistaken for an employee-recorded one.
-- The chain remembers which case it is: a revision_no = 1 row with origin
-- 'admin_closed' proves the employee recorded nothing, however many later
-- corrections exist and whatever work_sessions.ended_at now holds.
create function public._session_effective_ceiling(p_session_id uuid)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    case
      when exists (select 1 from public.session_time_corrections stc
                   where stc.work_session_id = ws.id
                     and stc.revision_no = 1
                     and stc.origin = 'admin_closed')
        then null                               -- employee never recorded an end
      else ws.ended_at                          -- the employee's own value
    end,
    least(now(), ws.started_at + interval '12 hours')
  )
  from public.work_sessions ws
  where ws.id = p_session_id;
$$;
revoke all on function public._session_effective_ceiling(uuid) from public, anon, authenticated;

comment on function public._session_effective_ceiling(uuid) is
'Absolute upper bound for a payroll-effective session end. Employee-recorded '
'end where one exists, otherwise least(now(), started_at + 12 hours). Applies '
'to every operation kind including admin_raised.';
-- ---------------------------------------------------------
-- 5. Execution RPC: durable review hand-off + effective seconds
-- ---------------------------------------------------------
create or replace function public._execute_work_session_operation(
  p_kind text, p_operation_id uuid, p_assignment_id uuid,
  p_expected_revision bigint, p_session_id uuid, p_action_at timestamptz
) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_job_id uuid;
  v_job public.jobs%rowtype;
  v_assignment public.job_assignments%rowtype;
  v_session public.work_sessions%rowtype;
  v_receipt public.work_operation_receipts%rowtype;
  v_payload jsonb;
  v_result jsonb;
  v_enabled jsonb;
  v_tz text;
  v_first_legacy boolean;
  v_last_end timestamptz;
  v_active_other uuid;
  v_new_state text;
  v_total_seconds numeric;
  v_active_session uuid;
  v_active_since timestamptz;
  v_latest_end timestamptz;
  v_review_handoff boolean := false;
  v_emp_name text;
begin
  perform public.enforce_min_client_version();
  if v_actor is null or public.current_user_role() is distinct from 'employee'
     or public.current_user_company_id() is null then
    raise exception 'Employee authentication required' using errcode = '42501';
  end if;
  if p_kind not in ('start','pause','resume','complete')
     or p_operation_id is null or p_assignment_id is null
     or p_expected_revision is null or p_expected_revision < 0
     or p_action_at is null
     or (p_kind in ('start','pause','resume') and p_session_id is null) then
    raise exception 'Invalid work operation' using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'kind', p_kind, 'assignment_id', p_assignment_id,
    'expected_revision', p_expected_revision, 'session_id', p_session_id,
    'action_at', p_action_at);

  -- A receipt must survive a lost response, later completion or age-window
  -- expiry. Authorization is checked again before returning its old result.
  select * into v_receipt from public.work_operation_receipts
  where operation_id = p_operation_id;
  if found then
    if v_receipt.actor_id is distinct from v_actor
       or v_receipt.job_assignment_id is distinct from p_assignment_id
       or not exists (
         select 1 from public.job_assignments ja
         join public.jobs j on j.id = ja.job_id
         where ja.id = p_assignment_id and ja.employee_id = v_actor
           and j.company_id = public.current_user_company_id()) then
      raise exception 'Operation ID belongs to another actor or assignment' using errcode = '42501';
    end if;
    if v_receipt.request_payload is distinct from v_payload then
      raise exception 'Operation ID reused with different request' using errcode = '22023';
    end if;
    return v_receipt.result_payload;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor::text, 16092026));
  -- A profile deletion cascades to assignments. Hold the employee row before
  -- the job row so that deletion cannot invert the lock order mid-operation.
  perform 1 from public.profiles p
    where p.id = v_actor and p.is_active and p.role = 'employee'
      and p.company_id = public.current_user_company_id()
    for key share;
  if not found then
    raise exception 'Employee account is no longer active' using errcode = '42501';
  end if;
  select * into v_receipt from public.work_operation_receipts
  where operation_id = p_operation_id;
  if found then
    if v_receipt.actor_id is distinct from v_actor
       or v_receipt.job_assignment_id is distinct from p_assignment_id
       or not exists (
         select 1 from public.job_assignments ja
         join public.jobs j on j.id = ja.job_id
         where ja.id = p_assignment_id and ja.employee_id = v_actor
           and j.company_id = public.current_user_company_id()) then
      raise exception 'Operation ID belongs to another actor or assignment' using errcode = '42501';
    end if;
    if v_receipt.request_payload is distinct from v_payload then
      raise exception 'Operation ID reused with different request' using errcode = '22023';
    end if;
    return v_receipt.result_payload;
  end if;

  select value into v_enabled from public.app_config where key = 'pause_resume_enabled';
  if v_enabled is distinct from 'true'::jsonb then
    raise exception 'Pause/Resume is not enabled' using errcode = '42501';
  end if;

  -- Read only the immutable job pointer before taking the job lock.
  select job_id into v_job_id from public.job_assignments where id = p_assignment_id;
  if v_job_id is null then
    raise exception 'Assignment not found or not accessible' using errcode = '42501';
  end if;
  select * into v_job from public.jobs
  where id = v_job_id and company_id = public.current_user_company_id()
    and job_type = 'single' for update;
  if not found then
    raise exception 'Assignment not found or not accessible' using errcode = '42501';
  end if;
  select * into v_assignment from public.job_assignments
  where id = p_assignment_id and job_id = v_job.id and employee_id = v_actor
  for update;
  if not found then
    raise exception 'Assignment not found or not accessible' using errcode = '42501';
  end if;
  if v_assignment.work_revision <> p_expected_revision then
    raise exception 'Stale work revision' using errcode = '22023';
  end if;
  if p_action_at < now() - interval '12 hours'
     or p_action_at > now() + interval '5 minutes' then
    raise exception 'Action timestamp is outside the trusted window' using errcode = '22023';
  end if;

  -- Existing sessions also survive a profile deletion with employee_id NULL.
  -- Only a live owner can reach this point. The partial index and this query
  -- both use the server-derived employee identity.
  select id into v_active_other from public.work_sessions
  where employee_id = v_actor and ended_at is null limit 1;
  select max(ended_at) into v_last_end from public.work_sessions
  where employee_id = v_actor and ended_at is not null;

  if p_kind = 'start' then
    if v_assignment.time_tracking_mode <> 'legacy'
       or v_assignment.employee_started_at is not null
       or v_assignment.employee_completed_at is not null then
      raise exception 'Assignment already started' using errcode = '22023';
    end if;
    if v_job.status not in ('open','in_progress') then
      raise exception 'Job already completed' using errcode = '22023';
    end if;
    if v_job.status = 'open' and v_job.parent_job_id is not null
       and coalesce(v_job.is_active, true) = false then
      raise exception 'Paused recurring occurrence cannot start' using errcode = '22023';
    end if;
    select coalesce(nullif(btrim(timezone),''),'Europe/Berlin') into v_tz
    from public.companies where id = v_job.company_id;
    if not public.job_start_date_allowed(
      v_job.date, v_job.start_time, p_action_at at time zone coalesce(v_tz,'Europe/Berlin')) then
      raise exception 'Start is outside the scheduled business date' using errcode = '22023';
    end if;
    select exists (
      select 1 from public.job_assignments ja
      where ja.employee_id = v_actor and ja.id <> p_assignment_id
        and ja.time_tracking_mode = 'legacy'
        and ja.employee_started_at is not null
        and ja.employee_completed_at is null
    ) into v_first_legacy;
    if v_first_legacy or v_active_other is not null then
      raise exception 'Finish or pause the other active work first' using errcode = '22023';
    end if;
    if v_last_end is not null and p_action_at < v_last_end then
      raise exception 'Start overlaps previously recorded work' using errcode = '22023';
    end if;
    perform set_config('taskops.work_session_rpc','on',true);
    update public.job_assignments
      set time_tracking_mode = 'sessions', employee_started_at = p_action_at,
          attendance = case when attendance = 'assigned' then 'started' else attendance end,
          work_revision = work_revision + 1
    where id = p_assignment_id;
    insert into public.work_sessions(id, job_assignment_id, employee_id, started_at)
      values(p_session_id, p_assignment_id, v_actor, p_action_at);
    if v_job.status = 'open' then
      update public.jobs set status = 'in_progress', started_at = p_action_at,
        started_by = v_actor, completed_at = null, completed_by = null
      where id = v_job.id;
      select full_name into v_emp_name from public.profiles where id = v_actor;
      insert into public.notification_outbox
        (company_id, job_id, event_type, job_status, employee_id,
         employee_name, customer_name, service_name)
      values(v_job.company_id,v_job.id,'job_started','in_progress',v_actor,
             v_emp_name,v_job.customer_name,v_job.service_name)
      on conflict (job_id,event_type)
        where event_type in ('job_started','job_completed') do nothing;
    end if;
    v_new_state := 'active';
  elsif p_kind = 'pause' then
    if v_assignment.time_tracking_mode <> 'sessions'
       or v_assignment.employee_started_at is null
       or v_assignment.employee_completed_at is not null
       or v_job.status <> 'in_progress' then
      raise exception 'Assignment is not active' using errcode = '22023';
    end if;
    select * into v_session from public.work_sessions
      where id = p_session_id and job_assignment_id = p_assignment_id
        and employee_id = v_actor for update;
    if not found or v_session.ended_at is not null
       or v_active_other is distinct from p_session_id then
      raise exception 'The specified session is not active' using errcode = '22023';
    end if;
    if p_action_at < v_session.started_at then
      raise exception 'Pause precedes session start' using errcode = '22023';
    end if;
    perform set_config('taskops.work_session_rpc','on',true);
    update public.work_sessions set ended_at = p_action_at where id = p_session_id;
    update public.job_assignments
      set work_revision = work_revision + 1,
          work_review_required = work_review_required
            or p_action_at > employee_started_at + interval '12 hours'
      where id = p_assignment_id;
    v_new_state := 'paused';
  elsif p_kind = 'resume' then
    if v_assignment.time_tracking_mode <> 'sessions'
       or v_assignment.employee_started_at is null
       or v_assignment.employee_completed_at is not null
       or v_job.status <> 'in_progress' then
      raise exception 'Assignment cannot resume' using errcode = '22023';
    end if;
    if v_active_other is not null then
      raise exception 'Another session is active' using errcode = '22023';
    end if;
    if exists (select 1 from public.job_assignments ja
               where ja.employee_id = v_actor
                 and ja.time_tracking_mode = 'legacy'
                 and ja.employee_started_at is not null
                 and ja.employee_completed_at is null) then
      raise exception 'Finish unresolved legacy work before resuming'
        using errcode = '22023';
    end if;
    if exists (select 1 from public.work_sessions
               where job_assignment_id = p_assignment_id and ended_at is null) then
      raise exception 'Assignment already active' using errcode = '22023';
    end if;
    if p_action_at > v_assignment.employee_started_at + interval '12 hours'
       or p_action_at < v_assignment.employee_started_at
       or (v_last_end is not null and p_action_at < v_last_end) then
      raise exception 'Resume outside lifecycle or work chronology' using errcode = '22023';
    end if;
    perform set_config('taskops.work_session_rpc','on',true);
    insert into public.work_sessions(id, job_assignment_id, employee_id, started_at)
      values(p_session_id, p_assignment_id, v_actor, p_action_at);
    update public.job_assignments set work_revision = work_revision + 1
      where id = p_assignment_id;
    v_new_state := 'active';
  else
    if v_assignment.time_tracking_mode <> 'sessions'
       or v_assignment.employee_started_at is null
       or v_assignment.employee_completed_at is not null
       or v_job.status = 'open' then
      raise exception 'Assignment cannot complete' using errcode = '22023';
    end if;
    -- Chronology stays a hard rejection: a completion before the own start or
    -- before previously recorded work describes an impossible shift.
    if p_action_at < v_assignment.employee_started_at
       or (v_last_end is not null and p_action_at < v_last_end) then
      raise exception 'Completion violates work chronology' using errcode = '22023';
    end if;
    -- 20260922000000 — DURABLE REVIEW HAND-OFF (replaces a raise).
    -- The previous revision raised here. A raise aborts the transaction, so any
    -- flag written alongside it is rolled back with everything else: the case
    -- became invisible to the admin instead of discoverable. The late
    -- completion is therefore no longer an error; it commits an unresolved,
    -- explicitly flagged state that admin_review_session_assignment resolves.
    v_review_handoff := p_action_at > v_assignment.employee_started_at + interval '12 hours'
                        or v_assignment.work_review_required;
    -- An employee may complete paused A while actively working on B.
    -- Only this assignment's open session determines the active path.
    select * into v_session from public.work_sessions
      where job_assignment_id = p_assignment_id and ended_at is null
      for update;
    if found then
      if p_session_id is distinct from v_session.id
         or v_session.employee_id is distinct from v_actor
         or p_action_at < v_session.started_at then
        raise exception 'The specified active session does not match' using errcode = '22023';
      end if;
      perform set_config('taskops.work_session_rpc','on',true);
      update public.work_sessions set ended_at = p_action_at where id = p_session_id;
    elsif p_session_id is not null then
      raise exception 'Paused completion must not specify a session' using errcode = '22023';
    end if;
    perform set_config('taskops.work_session_rpc','on',true);
    if v_review_handoff then
      -- The session above is already closed at p_action_at: the employee really
      -- did press the button then, so that timestamp is raw evidence and the
      -- admin later reviews it. The assignment stays unresolved on purpose —
      -- no employee_completed_at, no attendance change, no parent completion.
      update public.job_assignments set work_review_required = true,
        work_revision = work_revision + 1
        where id = p_assignment_id;
      v_new_state := 'review_pending';
    else
      update public.job_assignments set employee_completed_at = p_action_at,
        attendance = 'completed', work_revision = work_revision + 1
        where id = p_assignment_id;
      if v_job.status = 'in_progress' then
        perform public.maybe_complete_job(v_job.id, v_actor, p_action_at, true);
      end if;
      v_new_state := 'completed';
    end if;
  end if;

  -- Effective-aware: the receipt must report the same payroll seconds the
  -- timesheet will show, never the uncorrected raw sum.
  select coalesce(sum(extract(epoch from e.effective_ended_at - e.effective_started_at))
                    filter (where e.effective_ended_at is not null), 0),
         max(e.effective_ended_at) into v_total_seconds, v_latest_end
  from public._effective_sessions(array[p_assignment_id]) e;
  select id, started_at into v_active_session, v_active_since
  from public.work_sessions where job_assignment_id = p_assignment_id
    and ended_at is null;
  select * into v_job from public.jobs where id = v_job.id;
  select * into v_assignment from public.job_assignments where id = p_assignment_id;
  v_result := jsonb_build_object(
    'operation_id',p_operation_id,'assignment_id',p_assignment_id,
    'session_id',p_session_id,'work_revision',v_assignment.work_revision,
    'assignment_state',v_new_state,'active_session_id',v_active_session,
    'active_since',v_active_since,'latest_session_end',v_latest_end,
    'closed_seconds',v_total_seconds,'review_required',v_assignment.work_review_required,
    'employee_started_at',v_assignment.employee_started_at,
    'employee_completed_at',v_assignment.employee_completed_at,
    'job_status',v_job.status,'recorded_at',clock_timestamp());
  insert into public.work_operation_receipts
    (operation_id,actor_id,job_assignment_id,operation_type,request_payload,result_payload)
  values(p_operation_id,v_actor,p_assignment_id,p_kind,v_payload,v_result);
  perform set_config('taskops.work_session_rpc','off',true);
  return v_result;
end $$;

-- ---------------------------------------------------------
-- 6. Idempotency store reused for admin reviews
-- ---------------------------------------------------------
-- The receipt table already solves exactly this problem (caller-supplied id as
-- primary key, request payload compared on replay) and is already proven under
-- concurrency. Reusing it beats a second parallel table. An admin receipt can
-- never be confused with an employee operation: _execute_work_session_operation
-- compares actor_id and job_assignment_id before returning a stored result.
alter table public.work_operation_receipts
  drop constraint work_operation_receipts_operation_type_check;
alter table public.work_operation_receipts
  add constraint work_operation_receipts_operation_type_check
  check (operation_type in ('start','pause','resume','complete','admin_review'));

-- ---------------------------------------------------------
-- 7. Admin recovery RPC
-- ---------------------------------------------------------
-- Resolves an unresolved session-mode assignment and, where required, corrects
-- the payroll-effective end of one or more of its sessions.
--
-- p_session_corrections is a jsonb array of
--   {"session_id": uuid, "operation": "reduce"|"raise", "effective_ended_at": ts}
-- An empty array approves the recorded sessions unchanged.
--
-- The operation kind is ALWAYS declared by the caller and never inferred from
-- the timestamps: a mistyped time must be rejected, not silently reclassified
-- as an upward revision.
create function public.admin_review_session_assignment(
  recovery_id_input        uuid,
  assignment_id_input      uuid,
  expected_revision_input  bigint,
  reason_input             text,
  session_corrections_input jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_reason      text;
  v_payload     jsonb;
  v_receipt     public.work_operation_receipts%rowtype;
  v_job_id      uuid;
  v_job         public.jobs%rowtype;
  v_assignment  public.job_assignments%rowtype;
  v_session     public.work_sessions%rowtype;
  v_item        jsonb;
  v_session_id  uuid;
  v_operation   text;
  v_new_end     timestamptz;
  v_current_end timestamptz;
  v_ceiling     timestamptz;
  v_raw_end     timestamptz;
  v_raw_dur     numeric;
  v_origin      text;
  v_next_rev    int;
  v_employee_recorded_end timestamptz;
  v_final_end   timestamptz;
  v_total       numeric;
  v_recorded    numeric;
  v_correction  numeric;
  v_employee    uuid;
  v_result      jsonb;
begin
  perform public.enforce_min_client_version();

  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  -- IS DISTINCT FROM, never <>: current_user_role() is NULL for a deactivated
  -- or missing profile and "NULL <> 'admin'" is NULL, which would skip the
  -- guard entirely for exactly the account that must not pass it.
  if public.current_user_role() is distinct from 'admin'
     or public.current_user_company_id() is null then
    raise exception 'Only admins can review recorded work' using errcode = '42501';
  end if;

  v_reason := btrim(coalesce(reason_input, ''));
  if length(v_reason) < 10 then
    raise exception 'A reason of at least 10 characters is required' using errcode = '23514';
  end if;
  if recovery_id_input is null or assignment_id_input is null
     or expected_revision_input is null or expected_revision_input < 0
     or session_corrections_input is null
     or jsonb_typeof(session_corrections_input) <> 'array' then
    raise exception 'Invalid recovery request' using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'kind','admin_review','assignment_id',assignment_id_input,
    'expected_revision',expected_revision_input,'reason',v_reason,
    'corrections',session_corrections_input);

  -- A receipt must survive a lost response. Checked before the lock for the
  -- cheap path and again after it, which is what closes the concurrent-replay
  -- window (same two-phase pattern as _execute_work_session_operation).
  select * into v_receipt from public.work_operation_receipts
  where operation_id = recovery_id_input;
  if found then
    if v_receipt.actor_id is distinct from v_actor
       or v_receipt.job_assignment_id is distinct from assignment_id_input then
      raise exception 'Operation ID belongs to another actor or assignment' using errcode = '42501';
    end if;
    if v_receipt.request_payload is distinct from v_payload then
      raise exception 'Operation ID reused with different request' using errcode = '22023';
    end if;
    return v_receipt.result_payload;
  end if;

  -- Lock order is identical to the employee work RPCs. The advisory lock keys
  -- on the EMPLOYEE, not on the admin, so an admin review genuinely serialises
  -- against a concurrent employee operation on the same person.
  select ja.job_id, ja.employee_id into v_job_id, v_employee
  from public.job_assignments ja where ja.id = assignment_id_input;
  if v_job_id is null then
    raise exception 'Assignment not found or not accessible' using errcode = '42501';
  end if;
  -- An anonymised assignment (account deleted) keeps no lockable owner; the
  -- job and assignment locks below still serialise it.
  if v_employee is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_employee::text, 16092026));
    perform 1 from public.profiles p where p.id = v_employee for key share;
  end if;

  select * into v_receipt from public.work_operation_receipts
  where operation_id = recovery_id_input;
  if found then
    if v_receipt.actor_id is distinct from v_actor
       or v_receipt.job_assignment_id is distinct from assignment_id_input then
      raise exception 'Operation ID belongs to another actor or assignment' using errcode = '42501';
    end if;
    if v_receipt.request_payload is distinct from v_payload then
      raise exception 'Operation ID reused with different request' using errcode = '22023';
    end if;
    return v_receipt.result_payload;
  end if;

  -- Company scoping. The message is identical for "missing" and "foreign" so
  -- the error never reveals that a cross-company assignment exists.
  select * into v_job from public.jobs
  where id = v_job_id and company_id = public.current_user_company_id()
  for update;
  if not found then
    raise exception 'Assignment not found or not accessible' using errcode = '42501';
  end if;
  select * into v_assignment from public.job_assignments
  where id = assignment_id_input and job_id = v_job.id
  for update;
  if not found then
    raise exception 'Assignment not found or not accessible' using errcode = '42501';
  end if;

  if v_assignment.time_tracking_mode <> 'sessions' then
    raise exception 'Only session-aware assignments are reviewed here; use admin_correct_assignment_time'
      using errcode = '22023';
  end if;
  if v_assignment.employee_completed_at is not null then
    raise exception 'Assignment is already resolved' using errcode = '22023';
  end if;
  if v_assignment.work_revision <> expected_revision_input then
    raise exception 'Stale work revision' using errcode = '22023';
  end if;
  if not exists (select 1 from public.work_sessions
                 where job_assignment_id = assignment_id_input) then
    raise exception 'Assignment has no recorded session to review' using errcode = '22023';
  end if;

  perform set_config('taskops.work_session_rpc','on',true);

  for v_item in select * from jsonb_array_elements(session_corrections_input)
  loop
    v_session_id := nullif(v_item->>'session_id','')::uuid;
    v_operation  := v_item->>'operation';
    v_new_end    := (v_item->>'effective_ended_at')::timestamptz;
    if v_session_id is null or v_new_end is null
       or v_operation not in ('reduce','raise') then
      raise exception 'Invalid session correction entry' using errcode = '22023';
    end if;

    -- The whole revision chain is decided under THIS lock.
    select * into v_session from public.work_sessions
    where id = v_session_id and job_assignment_id = assignment_id_input
    for update;
    if not found then
      raise exception 'Session not found on this assignment' using errcode = '42501';
    end if;

    select stc.effective_ended_at, stc.revision_no
      into v_current_end, v_next_rev
    from public.session_time_corrections stc
    where stc.work_session_id = v_session.id
    order by stc.revision_no desc limit 1;
    v_next_rev    := coalesce(v_next_rev, 0) + 1;
    v_current_end := coalesce(v_current_end, v_session.ended_at);

    -- Did the EMPLOYEE record an end? A later admin-filled ended_at must never
    -- be mistaken for one, so the chain is the source of that fact.
    if exists (select 1 from public.session_time_corrections stc
               where stc.work_session_id = v_session.id
                 and stc.revision_no = 1 and stc.origin = 'admin_closed') then
      v_employee_recorded_end := null;
    else
      v_employee_recorded_end := v_session.ended_at;
    end if;
    v_ceiling := coalesce(v_employee_recorded_end,
                          least(now(), v_session.started_at + interval '12 hours'));

    if v_new_end <= v_session.started_at then
      raise exception 'Reviewed end must be after the session start' using errcode = '23514';
    end if;
    if v_new_end > now() then
      raise exception 'Reviewed end must not be in the future' using errcode = '23514';
    end if;
    if v_new_end > v_ceiling then
      raise exception 'Reviewed end exceeds the recorded ceiling for this session'
        using errcode = '23514';
    end if;

    if v_operation = 'reduce' then
      if v_current_end is not null and v_new_end > v_current_end then
        raise exception 'A reduction must not increase recorded work time'
          using errcode = '23514';
      end if;
    else
      if v_current_end is null or v_new_end <= v_current_end then
        raise exception 'A raise must increase the reviewed work time'
          using errcode = '23514';
      end if;
      if length(v_reason) < 30 then
        raise exception 'An upward revision requires a reason of at least 30 characters'
          using errcode = '23514';
      end if;
    end if;

    v_raw_end := v_employee_recorded_end;
    v_raw_dur := case when v_raw_end is null then null
                      else extract(epoch from v_raw_end - v_session.started_at) end;
    v_origin  := case
                   when v_operation = 'raise' then 'admin_raised'
                   when v_session.ended_at is null then 'admin_closed'
                   when v_employee_recorded_end is null then 'admin_closed'
                   else 'admin_reduced'
                 end;

    -- An open session is CLOSED once, null -> value. That completes a record
    -- the employee never wrote; it does not rewrite one. Leaving it open is not
    -- an option: work_sessions_one_open_employee would block the employee from
    -- every future Start, and accounting cannot parse a null end.
    if v_session.ended_at is null then
      update public.work_sessions set ended_at = v_new_end where id = v_session.id;
    end if;

    insert into public.session_time_corrections (
      correction_id, work_session_id, job_assignment_id, job_id, employee_id,
      revision_no, origin, raw_started_at, raw_ended_at, raw_duration_seconds,
      effective_started_at, effective_ended_at, effective_duration_seconds,
      performed_by, reason
    ) values (
      gen_random_uuid(), v_session.id, assignment_id_input, v_job.id,
      v_session.employee_id, v_next_rev, v_origin,
      v_session.started_at, v_raw_end, v_raw_dur,
      null, v_new_end, extract(epoch from v_new_end - v_session.started_at),
      v_actor, v_reason
    );
  end loop;

  -- No open session may survive a resolution: guard_session_assignment refuses
  -- employee_completed_at while one exists, and accounting would read it as
  -- damaged data.
  if exists (select 1 from public.work_sessions
             where job_assignment_id = assignment_id_input and ended_at is null) then
    raise exception 'An open session must be closed by this review' using errcode = '22023';
  end if;

  -- recorded_seconds counts ONLY what the employee actually recorded. A session
  -- the admin closed has no employee-recorded end, so it contributes nothing:
  -- reporting its admin-supplied duration as "recorded" would claim the
  -- employee clocked out when they never did.
  select max(e.effective_ended_at),
         coalesce(sum(extract(epoch from e.effective_ended_at - e.effective_started_at)),0),
         coalesce(sum(extract(epoch from e.raw_ended_at - e.raw_started_at))
           filter (where not exists (
             select 1 from public.session_time_corrections stc
             where stc.work_session_id = e.session_id
               and stc.revision_no = 1 and stc.origin = 'admin_closed')),0)
           ,
         coalesce(sum(extract(epoch from e.effective_ended_at - e.effective_started_at)
                      - extract(epoch from e.raw_ended_at - e.raw_started_at))
           filter (where not exists (
             select 1 from public.session_time_corrections stc
             where stc.work_session_id = e.session_id
               and stc.revision_no = 1 and stc.origin = 'admin_closed')),0)
    into v_final_end, v_total, v_recorded, v_correction
  from public._effective_sessions(array[assignment_id_input]) e;

  -- The completion stamp is DERIVED, never supplied and never now(). Anything
  -- earlier than the final effective end would make sessionAccounting.ts mark
  -- the whole set invalid and drop the employee's payroll row.
  update public.job_assignments
    set employee_completed_at = v_final_end,
        attendance            = 'completed',
        work_review_required  = false,
        work_revision         = work_revision + 1
  where id = assignment_id_input;

  -- Parent lifecycle keeps the existing all-assignees semantics:
  -- maybe_complete_job closes the job only when no assignment is unresolved.
  -- A parent already completed by Force Complete is left untouched, so no
  -- second job_completed event can be emitted.
  if v_job.status = 'in_progress' then
    perform public.maybe_complete_job(v_job.id, v_assignment.employee_id, v_final_end, true);
  end if;

  select * into v_job from public.jobs where id = v_job.id;
  select * into v_assignment from public.job_assignments where id = assignment_id_input;

  v_result := jsonb_build_object(
    'recovery_id',recovery_id_input,'assignment_id',assignment_id_input,
    'assignment_state','completed','work_revision',v_assignment.work_revision,
    'employee_started_at',v_assignment.employee_started_at,
    'employee_completed_at',v_assignment.employee_completed_at,
    'latest_session_end',v_final_end,
    'recorded_seconds',v_recorded,'effective_seconds',v_total,
    -- Net change on the sessions the employee actually closed. A session the
    -- admin closed has no recorded counterpart, so it contributes 0 rather
    -- than appearing as invented time.
    'correction_seconds',v_correction,
    'active_session_id',null,'review_required',v_assignment.work_review_required,
    'job_status',v_job.status,'recorded_at',clock_timestamp());

  insert into public.work_operation_receipts
    (operation_id, actor_id, job_assignment_id, operation_type,
     request_payload, result_payload)
  values (recovery_id_input, v_actor, assignment_id_input, 'admin_review',
          v_payload, v_result);

  perform set_config('taskops.work_session_rpc','off',true);
  return v_result;
end $$;

revoke all on function public.admin_review_session_assignment(uuid,uuid,bigint,text,jsonb)
  from public, anon;
grant execute on function public.admin_review_session_assignment(uuid,uuid,bigint,text,jsonb)
  to authenticated;

comment on function public.admin_review_session_assignment(uuid,uuid,bigint,text,jsonb) is
'Admin recovery for session-aware work. Resolves an unresolved assignment and '
'optionally corrects the payroll-effective end of its sessions. work_sessions '
'is never rewritten except for closing an open session once (null -> value). '
'The completion stamp is derived as the final effective end, never now(). '
'reduce may only lower the active effective end; raise is a separately declared '
'and separately audited upward revision requiring a 30-character reason. No '
'operation may exceed the session ceiling.';

-- ---------------------------------------------------------
-- 8. Admin recovery queue
-- ---------------------------------------------------------
-- Company scoped, NOT employee scoped and NOT month scoped: the timesheet's
-- needsAttention list is a per-employee monthly report and cannot serve as a
-- standing queue.
--
-- The second clause is not a heuristic. Every employee self-resolution path is
-- bounded by employee_started_at + 12 hours, so once that has passed there is
-- no timestamp the employee can legally submit to finish the assignment. The
-- predicate therefore means "session work the employee can no longer finish",
-- which is why it also catches the case whose transaction rolled back and left
-- work_review_required false.
create function public.get_work_recovery_queue()
returns table (
  assignment_id           uuid,
  job_id                  uuid,
  employee_id             uuid,
  employee_name           text,
  customer_name           text,
  service_name            text,
  job_status              job_status,
  employee_started_at     timestamptz,
  first_session_start     timestamptz,
  last_session_end        timestamptz,
  open_session_id         uuid,
  open_session_started_at timestamptz,
  recorded_seconds        numeric,
  effective_seconds       numeric,
  review_required         boolean,
  reason_code             text,
  stuck_since             timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
end $$;

revoke all on function public.get_work_recovery_queue() from public, anon;
grant execute on function public.get_work_recovery_queue() to authenticated;

comment on function public.get_work_recovery_queue() is
'Admin-only standing queue of session work the employee can no longer finish. '
'Catches the late pause, the late completion, the offline completion whose '
'transaction rolled back, the forgotten open session and the abandoned paused '
'assignment; excludes healthy work still inside its 12-hour window.';

-- ---------------------------------------------------------
-- 9. Employee-safe effective read model
-- ---------------------------------------------------------
-- The single payroll source for every consumer, employee and admin alike.
-- Deliberately returns NO reason, actor, raw value, delta or correction id:
-- the correction reason may carry internal notes.
create function public.get_effective_work_sessions(assignment_ids_input uuid[])
returns table (
  session_id           uuid,
  job_assignment_id    uuid,
  effective_started_at timestamptz,
  effective_ended_at   timestamptz,
  reviewed             boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_role text := public.current_user_role();
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if v_role is distinct from 'admin' and v_role is distinct from 'employee' then
    raise exception 'Not authorised' using errcode = '42501';
  end if;

  return query
  select e.session_id, e.job_assignment_id,
         e.effective_started_at, e.effective_ended_at, e.reviewed
  from public._effective_sessions(coalesce(assignment_ids_input,'{}'::uuid[])) e
  join public.job_assignments ja on ja.id = e.job_assignment_id
  join public.jobs j on j.id = ja.job_id
  where j.company_id = public.current_user_company_id()
    and (v_role = 'admin' or ja.employee_id = auth.uid());
end $$;

revoke all on function public.get_effective_work_sessions(uuid[]) from public, anon;
grant execute on function public.get_effective_work_sessions(uuid[]) to authenticated;

comment on function public.get_effective_work_sessions(uuid[]) is
'The single payroll-effective session source for every consumer. Employees see '
'their own assignments, admins their own company. Returns the effective '
'interval and a neutral reviewed marker only — never the reason, the actor, the '
'raw values, the delta or the correction history.';

-- ---------------------------------------------------------
-- 10. Admin audit read
-- ---------------------------------------------------------
-- DISPLAY ONLY. Never use this to compute a payroll total: the totals come from
-- get_effective_work_sessions through the existing accounting, so there is
-- exactly one calculation and the admin and the employee can never disagree.
create function public.get_session_correction_audit(assignment_ids_input uuid[])
returns table (
  correction_id              uuid,
  work_session_id            uuid,
  job_assignment_id          uuid,
  revision_no                int,
  origin                     text,
  raw_started_at             timestamptz,
  raw_ended_at               timestamptz,
  raw_duration_seconds       numeric,
  effective_ended_at         timestamptz,
  effective_duration_seconds numeric,
  delta_seconds              numeric,
  reason                     text,
  performed_by               uuid,
  performed_by_name          text,
  created_at                 timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if public.current_user_role() is distinct from 'admin'
     or public.current_user_company_id() is null then
    raise exception 'Only admins can read correction audit data' using errcode = '42501';
  end if;

  return query
  select stc.correction_id, stc.work_session_id, stc.job_assignment_id,
         stc.revision_no, stc.origin,
         stc.raw_started_at, stc.raw_ended_at, stc.raw_duration_seconds,
         stc.effective_ended_at, stc.effective_duration_seconds, stc.delta_seconds,
         stc.reason, stc.performed_by,
         coalesce(nullif(btrim(p.full_name),''),'Unbekannt'),
         stc.created_at
  from public.session_time_corrections stc
  join public.jobs j on j.id = stc.job_id
  left join public.profiles p on p.id = stc.performed_by
  where stc.job_assignment_id = any(coalesce(assignment_ids_input,'{}'::uuid[]))
    and j.company_id = public.current_user_company_id()
  order by stc.work_session_id, stc.revision_no;
end $$;

revoke all on function public.get_session_correction_audit(uuid[]) from public, anon;
grant execute on function public.get_session_correction_audit(uuid[]) to authenticated;

comment on function public.get_session_correction_audit(uuid[]) is
'Admin-only correction chain for display and audit. NEVER a payroll source: '
'every worked-minute figure must come from get_effective_work_sessions.';

-- ---------------------------------------------------------
-- 11. Assignment summary: effective seconds + reviewed marker
-- ---------------------------------------------------------
create or replace function public.get_assignment_work_summary(p_assignment_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare v_ja public.job_assignments%rowtype;
  v_state text; v_active uuid; v_since timestamptz; v_end timestamptz;
  v_seconds numeric; v_reviewed boolean;
begin
  select ja.* into v_ja from public.job_assignments ja
  join public.jobs j on j.id=ja.job_id
  where ja.id=p_assignment_id and j.company_id=public.current_user_company_id()
    and ((public.current_user_role()='employee' and ja.employee_id=auth.uid())
      or public.current_user_role()='admin');
  if not found then
    raise exception 'Assignment not found or not accessible' using errcode='42501';
  end if;
  select id,started_at into v_active,v_since from public.work_sessions
    where job_assignment_id=p_assignment_id and ended_at is null;
  -- Effective, not raw: the job detail screen must show the same payroll
  -- seconds as the timesheet.
  select max(e.effective_ended_at),
         coalesce(sum(extract(epoch from e.effective_ended_at - e.effective_started_at))
                    filter (where e.effective_ended_at is not null),0),
         bool_or(e.reviewed)
    into v_end, v_seconds, v_reviewed
  from public._effective_sessions(array[p_assignment_id]) e;
  v_state := case
    when v_ja.employee_completed_at is not null then 'completed'
    when v_ja.employee_started_at is null then 'not_started'
    when v_ja.work_review_required and v_active is null then 'review_pending'
    when v_ja.time_tracking_mode='sessions' and v_active is null then 'paused'
    else 'active' end;
  return jsonb_build_object('assignment_id',p_assignment_id,
    'tracking_mode',v_ja.time_tracking_mode,'work_revision',v_ja.work_revision,
    'assignment_state',v_state,'active_session_id',v_active,
    'active_since',v_since,'latest_session_end',v_end,
    'closed_seconds',v_seconds,'review_required',v_ja.work_review_required,
    'reviewed',coalesce(v_reviewed,false),
    'employee_completed_at',v_ja.employee_completed_at);
end $$;

commit;
