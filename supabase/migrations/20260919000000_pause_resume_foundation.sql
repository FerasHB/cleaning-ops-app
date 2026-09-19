-- Pause / Resume foundation. All existing assignments retain legacy accounting.
-- The capability is deliberately OFF until a session-aware client is released.
insert into public.app_config (key, value)
values ('pause_resume_enabled', 'false'::jsonb)
on conflict (key) do nothing;

alter table public.job_assignments
  add column time_tracking_mode text not null default 'legacy',
  add column work_revision bigint not null default 0,
  add column work_review_required boolean not null default false;
alter table public.job_assignments
  add constraint job_assignments_time_tracking_mode_chk
    check (time_tracking_mode in ('legacy', 'sessions')),
  add constraint job_assignments_work_revision_chk check (work_revision >= 0),
  add constraint job_assignments_review_mode_chk
    check (not work_review_required or time_tracking_mode = 'sessions');

create table public.work_sessions (
  id uuid primary key,
  job_assignment_id uuid not null references public.job_assignments(id) on delete restrict,
  employee_id uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint work_sessions_end_chk check (ended_at is null or ended_at >= started_at)
);
create unique index work_sessions_one_open_employee
  on public.work_sessions(employee_id) where ended_at is null and employee_id is not null;
create unique index work_sessions_one_open_assignment
  on public.work_sessions(job_assignment_id) where ended_at is null;
create index work_sessions_assignment_history
  on public.work_sessions(job_assignment_id, started_at, id);
create index work_sessions_employee_history
  on public.work_sessions(employee_id, started_at) where employee_id is not null;

create table public.work_operation_receipts (
  operation_id uuid primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  job_assignment_id uuid not null references public.job_assignments(id) on delete restrict,
  operation_type text not null check (operation_type in ('start', 'pause', 'resume', 'complete')),
  request_payload jsonb not null,
  result_payload jsonb not null,
  created_at timestamptz not null default now()
);
create index work_operation_receipts_assignment
  on public.work_operation_receipts(job_assignment_id, created_at);

-- Supabase public-schema default privileges can otherwise expose new tables.
alter table public.work_sessions enable row level security;
alter table public.work_operation_receipts enable row level security;
revoke all on public.work_sessions from public, anon, authenticated, service_role;
revoke all on public.work_operation_receipts from public, anon, authenticated, service_role;
grant select on public.work_sessions to authenticated, service_role;
grant select on public.work_operation_receipts to service_role;

create policy work_sessions_employee_read on public.work_sessions
  for select to authenticated
  using (public.current_user_role() = 'employee'
         and employee_id = auth.uid()
         and exists (select 1 from public.job_assignments ja
                     where ja.id = job_assignment_id
                       and public.job_in_current_company(ja.job_id)));
create policy work_sessions_admin_read on public.work_sessions
  for select to authenticated
  using (public.current_user_role() = 'admin'
         and exists (select 1 from public.job_assignments ja
                     where ja.id = job_assignment_id
                       and public.job_in_current_company(ja.job_id)));

-- Normal employee operations may only create a session or close it once.
-- Session identity and start are immutable; account deletion alone may
-- anonymize employee_id through its FK. No authenticated table writes exist.
create function public.guard_work_session_write()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_employee uuid; v_mode text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Recorded work sessions cannot be deleted' using errcode = '23503';
  end if;
  if tg_op = 'INSERT' then
    if current_setting('taskops.work_session_rpc', true) is distinct from 'on' then
      raise exception 'Work sessions are written only by execution RPCs' using errcode = '42501';
    end if;
    select employee_id, time_tracking_mode into v_employee, v_mode
    from public.job_assignments where id = new.job_assignment_id;
    if not found or v_mode <> 'sessions' or v_employee is null
       or new.employee_id is distinct from v_employee then
      raise exception 'Session owner does not match assignment' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.job_assignment_id is distinct from old.job_assignment_id
     or new.started_at is distinct from old.started_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Session identity and start are immutable' using errcode = '23514';
  end if;
  -- FK ON DELETE SET NULL is the sole ordinary non-RPC identity change.
  if new.employee_id is distinct from old.employee_id then
    if not (old.employee_id is not null and new.employee_id is null) then
      raise exception 'Session employee identity is immutable' using errcode = '23514';
    end if;
  end if;
  if new.ended_at is distinct from old.ended_at then
    if current_setting('taskops.work_session_rpc', true) is distinct from 'on'
       or old.ended_at is not null or new.ended_at is null then
      raise exception 'Session end can only be set once by an execution RPC' using errcode = '42501';
    end if;
    select employee_id into v_employee from public.job_assignments
    where id = old.job_assignment_id;
    if new.employee_id is distinct from v_employee then
      raise exception 'Session owner does not match assignment' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger guard_work_session_write_trg
before insert or update or delete on public.work_sessions
for each row execute function public.guard_work_session_write();
revoke all on function public.guard_work_session_write() from public, anon, authenticated;

create function public.guard_session_assignment()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.time_tracking_mode = 'sessions' or exists
      (select 1 from public.work_sessions where job_assignment_id = old.id) then
      raise exception 'Recorded work assignment cannot be deleted' using errcode = '23503';
    end if;
    return old;
  end if;
  if new.time_tracking_mode = 'legacy' and old.time_tracking_mode = 'sessions' then
    raise exception 'Session tracking cannot revert to legacy' using errcode = '23514';
  end if;
  if new.time_tracking_mode = 'sessions' and old.time_tracking_mode = 'legacy' then
    if current_setting('taskops.work_session_rpc', true) is distinct from 'on'
       or old.employee_started_at is not null or old.employee_completed_at is not null
       or new.employee_id is null then
      raise exception 'Only a fresh assignment may enter session mode' using errcode = '23514';
    end if;
  end if;
  if old.time_tracking_mode = 'sessions' then
    if new.employee_completed_at is not null
       and old.employee_completed_at is null
       and exists (select 1 from public.work_sessions
                   where job_assignment_id = old.id and ended_at is null) then
      raise exception 'Completed assignment cannot retain an active session'
        using errcode = '23514';
    end if;
    if new.job_id is distinct from old.job_id or
       (new.employee_id is distinct from old.employee_id and new.employee_id is not null) then
      raise exception 'Recorded work assignment cannot be reassigned' using errcode = '23514';
    end if;
    if (new.employee_started_at is distinct from old.employee_started_at
        or new.employee_completed_at is distinct from old.employee_completed_at
        or new.work_revision is distinct from old.work_revision
        or new.work_review_required is distinct from old.work_review_required
        or new.attendance is distinct from old.attendance)
       and current_setting('taskops.work_session_rpc', true) is distinct from 'on' then
      raise exception 'Session-aware assignment requires a controlled RPC' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger guard_session_assignment_trg
before update or delete on public.job_assignments
for each row execute function public.guard_session_assignment();
revoke all on function public.guard_session_assignment() from public, anon, authenticated;

-- Jobs with session evidence cannot silently cascade-delete their assignments.
create function public.guard_job_with_work_sessions()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.job_assignments ja
             join public.work_sessions ws on ws.job_assignment_id = ja.id
             where ja.job_id = old.id) then
    raise exception 'Job has recorded work sessions' using errcode = '23503';
  end if;
  return old;
end $$;
create trigger guard_job_with_work_sessions_trg
before delete on public.jobs for each row execute function public.guard_job_with_work_sessions();
revoke all on function public.guard_job_with_work_sessions() from public, anon, authenticated;

-- Prevent direct/admin status changes from stranding an active session.
create function public.guard_job_completion_with_active_session()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed'
     and exists (select 1 from public.job_assignments ja
                 join public.work_sessions ws on ws.job_assignment_id = ja.id
                 where ja.job_id = new.id and ws.ended_at is null) then
    raise exception 'Active work session blocks job completion' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger guard_job_completion_with_active_session_trg
before update of status on public.jobs
for each row execute function public.guard_job_completion_with_active_session();
revoke all on function public.guard_job_completion_with_active_session() from public, anon, authenticated;

-- An active session cannot be anonymized in place: no employee would remain
-- able to close it and the global open-session index would lose its owner.
-- Close it factually (or use a future audited recovery path) before deletion.
create function public.guard_profile_delete_with_active_session()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.work_sessions
             where employee_id = old.id and ended_at is null) then
    raise exception 'Active work session must be stopped before account deletion'
      using errcode = '23503';
  end if;
  return old;
end $$;
create trigger guard_profile_delete_with_active_session_trg
before delete on public.profiles
for each row execute function public.guard_profile_delete_with_active_session();
revoke all on function public.guard_profile_delete_with_active_session()
  from public, anon, authenticated;
