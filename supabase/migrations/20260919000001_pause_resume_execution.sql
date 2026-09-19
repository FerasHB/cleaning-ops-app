-- Session-aware execution. The client capability remains OFF by default.
-- All operations acquire locks in this order: employee advisory, job,
-- assignment, then session. Receipt lookup is repeated after the employee lock.
create function public._execute_work_session_operation(
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
    if p_action_at < v_assignment.employee_started_at
       or p_action_at > v_assignment.employee_started_at + interval '12 hours'
       or (v_last_end is not null and p_action_at < v_last_end)
       or v_assignment.work_review_required then
      raise exception 'Completion requires review or violates lifecycle window' using errcode = '22023';
    end if;
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
    update public.job_assignments set employee_completed_at = p_action_at,
      attendance = 'completed', work_revision = work_revision + 1
      where id = p_assignment_id;
    if v_job.status = 'in_progress' then
      perform public.maybe_complete_job(v_job.id, v_actor, p_action_at, true);
    end if;
    v_new_state := 'completed';
  end if;

  select coalesce(sum(extract(epoch from ended_at - started_at)),0),
         max(ended_at) into v_total_seconds, v_latest_end
  from public.work_sessions where job_assignment_id = p_assignment_id;
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
revoke all on function public._execute_work_session_operation(text,uuid,uuid,bigint,uuid,timestamptz)
  from public, anon, authenticated;

create function public.start_own_job_v2(
  operation_id_input uuid, assignment_id_input uuid,
  expected_revision_input bigint, session_id_input uuid,
  started_at_input timestamptz
) returns jsonb language sql security definer
set search_path = public, pg_temp as $$
  select public._execute_work_session_operation('start',operation_id_input,
    assignment_id_input,expected_revision_input,session_id_input,started_at_input);
$$;
create function public.pause_own_job(
  operation_id_input uuid, assignment_id_input uuid,
  expected_revision_input bigint, session_id_input uuid,
  paused_at_input timestamptz
) returns jsonb language sql security definer
set search_path = public, pg_temp as $$
  select public._execute_work_session_operation('pause',operation_id_input,
    assignment_id_input,expected_revision_input,session_id_input,paused_at_input);
$$;
create function public.resume_own_job(
  operation_id_input uuid, assignment_id_input uuid,
  expected_revision_input bigint, session_id_input uuid,
  resumed_at_input timestamptz
) returns jsonb language sql security definer
set search_path = public, pg_temp as $$
  select public._execute_work_session_operation('resume',operation_id_input,
    assignment_id_input,expected_revision_input,session_id_input,resumed_at_input);
$$;
create function public.complete_own_job_v2(
  operation_id_input uuid, assignment_id_input uuid,
  expected_revision_input bigint, session_id_input uuid,
  completed_at_input timestamptz
) returns jsonb language sql security definer
set search_path = public, pg_temp as $$
  select public._execute_work_session_operation('complete',operation_id_input,
    assignment_id_input,expected_revision_input,session_id_input,completed_at_input);
$$;
revoke all on function public.start_own_job_v2(uuid,uuid,bigint,uuid,timestamptz)
  from public, anon;
revoke all on function public.pause_own_job(uuid,uuid,bigint,uuid,timestamptz)
  from public, anon;
revoke all on function public.resume_own_job(uuid,uuid,bigint,uuid,timestamptz)
  from public, anon;
revoke all on function public.complete_own_job_v2(uuid,uuid,bigint,uuid,timestamptz)
  from public, anon;
grant execute on function public.start_own_job_v2(uuid,uuid,bigint,uuid,timestamptz)
  to authenticated;
grant execute on function public.pause_own_job(uuid,uuid,bigint,uuid,timestamptz)
  to authenticated;
grant execute on function public.resume_own_job(uuid,uuid,bigint,uuid,timestamptz)
  to authenticated;
grant execute on function public.complete_own_job_v2(uuid,uuid,bigint,uuid,timestamptz)
  to authenticated;

-- Assignment-scoped summary; future timesheets can finalize each employee's
-- own completed assignment independently of the parent lifecycle.
create function public.get_assignment_work_summary(p_assignment_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare v_ja public.job_assignments%rowtype;
  v_state text; v_active uuid; v_since timestamptz; v_end timestamptz;
  v_seconds numeric;
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
  select max(ended_at),coalesce(sum(extract(epoch from ended_at-started_at)),0)
    into v_end,v_seconds from public.work_sessions
    where job_assignment_id=p_assignment_id;
  v_state := case
    when v_ja.employee_completed_at is not null then 'completed'
    when v_ja.employee_started_at is null then 'not_started'
    when v_ja.time_tracking_mode='sessions' and v_active is null then 'paused'
    else 'active' end;
  return jsonb_build_object('assignment_id',p_assignment_id,
    'tracking_mode',v_ja.time_tracking_mode,'work_revision',v_ja.work_revision,
    'assignment_state',v_state,'active_session_id',v_active,
    'active_since',v_since,'latest_session_end',v_end,
    'closed_seconds',v_seconds,'review_required',v_ja.work_review_required,
    'employee_completed_at',v_ja.employee_completed_at);
end $$;
revoke all on function public.get_assignment_work_summary(uuid) from public, anon;
grant execute on function public.get_assignment_work_summary(uuid) to authenticated;

-- Compatibility guards: preserve legacy behavior for legacy rows.
create or replace function public.start_own_job(
  job_id_input uuid,
  started_at_input timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job      public.jobs%rowtype;
  v_tz       text;
  v_local    timestamp;
  v_bdate    date;
  v_allowed  boolean;
  v_emp_name text;
begin
  -- Kompatibilitäts-Fundament (20260916120000): dieselbe Wächter-Klausel,
  -- unverändert fortgeführt, damit diese Migration die serverseitige
  -- Mindestversions-Durchsetzung nicht versehentlich entfernt.
  perform public.enforce_min_client_version();

  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- ── (a) Zeitstempel-Vertrauensfenster ────────────────────────────
  if started_at_input > now() + interval '5 minutes' then
    raise exception
      'Die Uhrzeit deines Geräts liegt in der Zukunft. Bitte prüfe die Zeiteinstellung.'
      using errcode = '22023';
  end if;

  if started_at_input < now() - interval '12 hours' then
    raise exception
      'Diese Aktion ist älter als 12 Stunden und kann nicht mehr übertragen werden. Bitte wende dich an deinen Administrator.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 16092026));
  perform 1 from public.profiles p where p.id = auth.uid()
    and p.is_active and p.role = 'employee' for key share;
  if not found then
    raise exception 'Employee account is no longer active' using errcode = '42501';
  end if;

  -- ── Auftrag sperren und Berechtigung pruefen ─────────────────────
  select * into v_job
  from public.jobs
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    )
  for update;

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  if exists (select 1 from public.job_assignments ja
             where ja.job_id = job_id_input and ja.employee_id = auth.uid()
               and ja.time_tracking_mode = 'sessions') then
    raise exception 'Session-aware assignment requires the new execution RPC'
      using errcode = '22023';
  end if;
  if exists (select 1 from public.work_sessions ws
             where ws.employee_id = auth.uid() and ws.ended_at is null) then
    raise exception 'Pause or complete your active session first'
      using errcode = '22023';
  end if;

  -- ── (b) Terminpruefung in der Zeitzone der Firma ─────────────────
  select coalesce(nullif(btrim(c.timezone), ''), 'Europe/Berlin')
    into v_tz
  from public.companies c
  where c.id = v_job.company_id;

  v_tz    := coalesce(v_tz, 'Europe/Berlin');
  v_local := started_at_input at time zone v_tz;
  v_bdate := v_local::date;

  -- Regel bewusst ausgelagert (siehe job_start_date_allowed): eine Definition,
  -- deterministisch testbar.
  v_allowed := public.job_start_date_allowed(v_job.date, v_job.start_time, v_local);

  if not v_allowed then
    if v_job.date is null then
      raise exception
        'Für diesen Auftrag ist kein Termin hinterlegt. Bitte wende dich an deinen Administrator.'
        using errcode = '22023';
    elsif v_job.date > v_bdate then
      raise exception
        'Dieser Einsatz ist für den % geplant und kann noch nicht gestartet werden.',
        to_char(v_job.date, 'DD.MM.YYYY')
        using errcode = '22023';
    else
      raise exception
        'Dieser Einsatz war für den % geplant und kann nicht mehr gestartet werden.',
        to_char(v_job.date, 'DD.MM.YYYY')
        using errcode = '22023';
    end if;
  end if;

  -- ── (c) PATCH 20260918 (Astra-Audit Befund 2): expliziter Drei-Wege-
  -- Zweig statt `status <> 'open'`. Vorher fiel `completed` mit unter den
  -- Nachzuegler-Zweig fuer `in_progress` — ein Start-Aufruf, der (Offline-
  -- Queue, Wettlauf mit Force Complete oder einer regulaeren Fremd-
  -- Fertigstellung) erst NACH dem Abschluss beim Server ankam, wurde
  -- klaglos als spaeter Beitritt behandelt: eigene employee_started_at
  -- gestempelt, attendance auf 'started' gehoben, kein Fehler. Das ist ein
  -- dauerhafter Geschaeftszustands-Konflikt, kein Nachzuegler-Fall, und
  -- muss abgelehnt werden, OHNE irgendeine Zeile zu schreiben.
  if v_job.status = 'in_progress' then
    -- Unveraendert: idempotenter Nachzuegler-Zweig. Stempelt die EIGENE
    -- Startzeit (COALESCE: der erste Wert gewinnt, ein Doppel-Tap
    -- verschiebt nichts) und hebt attendance genau einmal von 'assigned'
    -- auf 'started'.
    update public.job_assignments
    set employee_started_at = coalesce(employee_started_at, started_at_input),
        attendance = case when attendance = 'assigned' then 'started' else attendance end
    where job_id = job_id_input
      and employee_id = auth.uid();

    return coalesce(v_job.started_at, started_at_input);

  elsif v_job.status <> 'open' then
    -- completed (oder ein zukuenftiger, heute nicht existierender
    -- Terminalstatus): harte Ablehnung, KEINE Mutation an job_assignments
    -- oder jobs. Deutscher, nutzerseitig sicherer Text im Stil der
    -- uebrigen Ablehnungen dieser Funktion, derselbe Fehlercode (22023),
    -- damit der bestehende Client-Fehler-Klassifizierer ihn unveraendert
    -- als reguläre Ablehnung erkennt (kein neuer Fehlercode noetig).
    raise exception
      'Dieser Auftrag ist bereits abgeschlossen und kann nicht mehr gestartet werden.'
      using errcode = '22023';
  end if;

  -- ── Echter Uebergang open -> in_progress ─────────────────────────
  -- PAUSIERTE Dauerauftrags-Occurrence ausschliessen (20260829000000):
  -- eine generierte Occurrence, deren Parent-Regel deaktiviert wurde, ist
  -- keine aktionierbare Arbeit. Gewoehnliche Einzelauftraege haben
  -- parent_job_id IS NULL und sind strukturell ausgenommen.
  if v_job.parent_job_id is not null and coalesce(v_job.is_active, true) = false then
    raise exception 'Job not found or not allowed';
  end if;

  update public.jobs
  set status       = 'in_progress',
      started_at   = started_at_input,
      started_by   = auth.uid(),
      completed_at = null,
      completed_by = null
  where id = job_id_input;

  select full_name into v_emp_name from public.profiles where id = auth.uid();

  insert into public.notification_outbox (
    company_id, job_id, event_type, job_status,
    employee_id, employee_name, customer_name, service_name
  )
  values (
    v_job.company_id, v_job.id, 'job_started', 'in_progress',
    auth.uid(), v_emp_name, v_job.customer_name, v_job.service_name
  )
  on conflict (job_id, event_type) where event_type in ('job_started', 'job_completed')
  do nothing;

  update public.job_assignments
  set employee_started_at = coalesce(employee_started_at, started_at_input),
      attendance = case when attendance = 'assigned' then 'started' else attendance end
  where job_id = job_id_input
    and employee_id = auth.uid();

  return started_at_input;
end;
$$;
create or replace function public.complete_own_job(
  job_id_input uuid,
  completed_at_input timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job          public.jobs%rowtype;
  v_assignment   public.job_assignments%rowtype;
  v_own_complete timestamptz;
begin
  -- Kompatibilitäts-Fundament (20260916120000): siehe start_own_job oben.
  perform public.enforce_min_client_version();

  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- ── (a) Zeitstempel-Vertrauensfenster ────────────────────────────
  if completed_at_input > now() + interval '5 minutes' then
    raise exception
      'Die Uhrzeit deines Geräts liegt in der Zukunft. Bitte prüfe die Zeiteinstellung.'
      using errcode = '22023';
  end if;

  if completed_at_input < now() - interval '12 hours' then
    raise exception
      'Diese Aktion ist älter als 12 Stunden und kann nicht mehr übertragen werden. Bitte wende dich an deinen Administrator.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 16092026));
  perform 1 from public.profiles p where p.id = auth.uid()
    and p.is_active and p.role = 'employee' for key share;
  if not found then
    raise exception 'Employee account is no longer active' using errcode = '42501';
  end if;

  -- ── Auftrag sperren und Berechtigung pruefen ─────────────────────
  select * into v_job
  from public.jobs
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    )
  for update;

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  if v_job.status = 'open' then
    raise exception 'Job not in progress (cannot complete)';
  end if;

  if exists (select 1 from public.job_assignments ja
             where ja.job_id = job_id_input and ja.employee_id = auth.uid()
               and ja.time_tracking_mode = 'sessions') then
    raise exception 'Session-aware assignment requires the new execution RPC'
      using errcode = '22023';
  end if;

  -- ── (b) Eigener Start erforderlich ───────────────────────────────
  select * into v_assignment
  from public.job_assignments
  where job_id = job_id_input
    and employee_id = auth.uid();

  if not found or v_assignment.employee_started_at is null then
    raise exception
      'Du musst diesen Auftrag zuerst selbst starten, bevor du ihn abschließen kannst.'
      using errcode = '22023';
  end if;

  -- ── (c) Abschluss nicht vor dem eigenen Start ────────────────────
  if completed_at_input < v_assignment.employee_started_at then
    raise exception
      'Der Abschluss liegt vor deinem eigenen Start. Bitte prüfe die Zeiteinstellung deines Geräts.'
      using errcode = '22023';
  end if;

  -- ── (d) Plausible Sitzungslaenge ─────────────────────────────────
  if completed_at_input - v_assignment.employee_started_at > interval '12 hours' then
    raise exception
      'Die Arbeitszeit ist ungewöhnlich lang und muss durch einen Administrator geprüft werden.'
      using errcode = '22023';
  end if;

  -- ── Eigene Abschlusszeit erfassen (idempotent, der erste gewinnt) ─
  update public.job_assignments
  set employee_completed_at = coalesce(employee_completed_at, completed_at_input),
      attendance            = 'completed'
  where job_id = job_id_input
    and employee_id = auth.uid()
  returning employee_completed_at into v_own_complete;

  -- ── (f)/(g) Lebenszyklus ─────────────────────────────────────────
  -- Nur bei laufendem Auftrag. Ist er bereits 'completed' (Admin-Eingriff
  -- oder regulaerer Abschluss), bleibt die jobs-Zeile unberuehrt: keine
  -- Wiedereroeffnung, kein zweites Event, kein Eingriff in den Pruefpfad.
  if v_job.status = 'in_progress' then
    perform public.maybe_complete_job(
      job_id_input, auth.uid(), completed_at_input, true);
  end if;

  return coalesce(v_own_complete, completed_at_input);
end;
$$;
create or replace function public.admin_force_complete_job(
  job_id_input uuid,
  reason_input text
)
returns public.jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job              public.jobs%rowtype;
  v_reason           text;
  v_pending          text;
  v_force_complete_on jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- IS DISTINCT FROM statt <>: current_user_role() liefert fuer ein
  -- inaktives/fehlendes Profil NULL, und "NULL <> 'admin'" ist NULL — der
  -- Guard wuerde fuer einen deaktivierten Admin still uebersprungen.
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can force-complete a job' using errcode = '42501';
  end if;

  -- PATCH 20260918 (Astra-Audit Befund 3): app_config.force_complete_enabled
  -- wurde bisher NIE serverseitig gelesen — der Schalter war ausschliesslich
  -- ein UI-Gate (JobDetailScreen.tsx). Solange die RPC auf einer Umgebung
  -- gar nicht existierte, war das folgenlos; sobald sie deployt ist, koennte
  -- jeder Admin per direktem RPC-Aufruf (REST/Postman, an der App-UI vorbei)
  -- zwangsabschliessen, unabhaengig vom Schalterstand. Gleiches Muster wie
  -- enforce_min_client_version() (app_config-gestuetzt), aber ueber einen
  -- direkten jsonb-Vergleich statt eines Boolean-Casts: `value` koennte
  -- fehlen (kein Konfigurationszeile), ungueltig sein (kein valider
  -- boolescher JSON-Wert) oder explizit false sein — in ALLEN drei Faellen
  -- muss abgelehnt werden, und ein Cast-Fehler bei ungueltigem Inhalt darf
  -- nicht als unklassifizierte Postgres-Exception durchschlagen. IS
  -- DISTINCT FROM ist dafuer NULL-sicher und wirft nie: fehlt die Zeile,
  -- ist v_force_complete_on NULL, COALESCE liefert 'false'::jsonb, und der
  -- Vergleich mit 'true'::jsonb ist schlicht TRUE (abgelehnt). Nur der exakte
  -- JSON-Wert `true` laesst die Funktion weiterlaufen.
  select value into v_force_complete_on
  from public.app_config
  where key = 'force_complete_enabled';

  if coalesce(v_force_complete_on, 'false'::jsonb) is distinct from 'true'::jsonb then
    raise exception
      'Die administrative Abschlussfunktion ist derzeit nicht aktiviert.'
      using errcode = '42501';
  end if;

  v_reason := btrim(coalesce(reason_input, ''));
  if v_reason = '' then
    raise exception
      'Bitte gib einen Grund für den Abschluss durch den Administrator an.'
      using errcode = '23514';
  end if;

  select * into v_job
  from public.jobs
  where id         = job_id_input
    and company_id = public.current_user_company_id()
  for update;

  if not found then
    raise exception 'Job not found or not accessible' using errcode = '42501';
  end if;

  if v_job.status is distinct from 'in_progress' then
    raise exception
      'Nur laufende Aufträge können durch einen Administrator abgeschlossen werden.'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.job_assignments ja
             join public.work_sessions ws on ws.job_assignment_id = ja.id
             where ja.job_id = job_id_input and ws.ended_at is null) then
    raise exception 'Active work sessions must be paused or completed before force completion'
      using errcode = '22023';
  end if;

  -- Nie gestartete, LEBENDE Zuweisungen zuerst regulaer entfernen.
  select coalesce(string_agg(
           coalesce(nullif(btrim(p.full_name), ''), ja.employee_name_snapshot, 'Unbekannt'),
           ', ' order by ja.assigned_at), '')
    into v_pending
  from public.job_assignments ja
  left join public.profiles p on p.id = ja.employee_id
  where ja.job_id             = job_id_input
    and ja.employee_id       is not null
    and ja.employee_started_at is null;

  if v_pending <> '' then
    raise exception
      'Bitte entferne zuerst die Mitarbeiter, die nicht teilgenommen haben: %', v_pending
      using errcode = '22023';
  end if;

  -- Pruefpfad in DERSELBEN Transaktion wie der Statuswechsel.
  insert into public.job_completion_overrides (
    job_id, previous_status, overridden_by, reason
  )
  values (v_job.id, v_job.status, auth.uid(), v_reason);

  -- completed_by = der eingreifende Admin. Die Spalte bedeutet seit Phase 7
  -- ausdruecklich "wer hat diesen Uebergang ausgeloest" und ist KEINE
  -- Abrechnungsgrundlage — ein Admin ist hier die wahrheitsgemaesse Antwort.
  -- KEIN job_completed-Event: die bestehende Push-Kopie wuerde faelschlich
  -- behaupten, diese Person habe den Auftrag persoenlich abgeschlossen.
  update public.jobs
  set status       = 'completed',
      completed_at = now(),
      completed_by = auth.uid()
  where id = job_id_input
  returning * into v_job;

  return v_job;
end;
$$;
revoke all on function public.start_own_job(uuid,timestamptz) from public, anon;
grant execute on function public.start_own_job(uuid,timestamptz) to authenticated;
revoke all on function public.complete_own_job(uuid,timestamptz) from public, anon;
grant execute on function public.complete_own_job(uuid,timestamptz) to authenticated;
revoke all on function public.admin_force_complete_job(uuid,text) from public, anon;
grant execute on function public.admin_force_complete_job(uuid,text) to authenticated;
