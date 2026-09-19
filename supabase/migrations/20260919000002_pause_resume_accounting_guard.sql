-- Keep the legacy correction implementation intact while preventing its
-- assignment-level timestamps from being mistaken for session worked time.
begin;

alter function public.admin_correct_assignment_time(uuid,timestamptz,timestamptz,text)
  rename to admin_correct_assignment_time_legacy_impl;
revoke all on function public.admin_correct_assignment_time_legacy_impl(uuid,timestamptz,timestamptz,text)
  from public, anon, authenticated, service_role;

create function public.admin_correct_assignment_time(
  assignment_id_input uuid,
  new_started_at timestamptz,
  new_completed_at timestamptz,
  reason_input text
) returns setof public.job_assignments
language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  -- Match the legacy implementation's authorization boundary before
  -- revealing whether an assignment uses session accounting.
  if public.current_user_role() = 'admin' and exists (
    select 1 from public.job_assignments ja
    join public.jobs j on j.id = ja.job_id
    where ja.id = assignment_id_input
      and j.company_id = public.current_user_company_id()
      and ja.time_tracking_mode = 'sessions'
  ) then
    raise exception
      'Session-aware work requires the reviewed session-recovery correction workflow'
      using errcode = '22023';
  end if;

  return query select * from public.admin_correct_assignment_time_legacy_impl(
    assignment_id_input, new_started_at, new_completed_at, reason_input);
end $$;

revoke all on function public.admin_correct_assignment_time(uuid,timestamptz,timestamptz,text)
  from public, anon;
grant execute on function public.admin_correct_assignment_time(uuid,timestamptz,timestamptz,text)
  to authenticated;

comment on function public.admin_correct_assignment_time(uuid,timestamptz,timestamptz,text) is
  'Legacy assignment correction only. Session-aware assignments require a future reviewed session-recovery workflow.';

commit;
