-- =========================================================
-- REMEDIATION 2026-11-08: close jobs stuck by the old completion rule
-- Run ONLY after 01_deploy_bundle.sql (checks the new function hash).
-- Scope: the 19 in_progress occurrences found by the read-only preflight
-- (one company, one recurring rule). Jobs dated today (Europe/Berlin) are
-- skipped so a colleague can still start today; re-run tomorrow for them.
-- Per job: maybe_complete_job with p_emit_event=false (no stale push),
-- actor = the started assignee with the latest own completion,
-- completed_at = that completion (20261030000001), not now().
-- Aborts the whole transaction if any job is no longer eligible.
-- Backup: public._multi_assignment_completion_fix_20261108 (RLS on,
-- no client grants), same pattern as _scheduled_start_fix_20261014.
-- =========================================================
begin;

do $pre$ begin
  if (select md5(prosrc) from pg_proc where proname='maybe_complete_job') <> '3d4520449939c219b2523a4d229347ad' then
    raise exception 'PRECHECK: deploy bundle not applied'; end if;
end $pre$;

create table if not exists public._multi_assignment_completion_fix_20261108 (
  job_id uuid primary key, status public.job_status, started_at timestamptz,
  completed_at timestamptz, completed_by uuid, backed_up_at timestamptz not null default now());
alter table public._multi_assignment_completion_fix_20261108 enable row level security;
revoke all on table public._multi_assignment_completion_fix_20261108 from public, anon, authenticated;

do $fix$
declare
  v_ids    uuid[] := array['f74c9e76-7fa4-466f-a1d3-d94fb029722a','21b279ea-6502-408b-8854-9a5d76961e61','3c7f425a-9205-4c60-a440-629e78f77f72','b8e51bfe-6965-46e0-988b-6b34ecae957c','1371756c-2bd6-4c34-b516-ef7dfe02478a','1d68ae6b-f4b1-4ac7-a323-9a905ce797b9','fe703a1d-b3ac-416b-b385-6aa6ab5cfc8d','f9ff247d-e0d3-47f3-938d-fcf01b345448','a44a2655-bd2c-4ac4-8a47-190fa621cccc','398caeb9-8c12-4df9-bd85-e7ce86a6d906','027927e3-6d53-4adc-96cc-fc333204ee6d','2c13ef48-9201-4711-8d08-676e6f5c668a','1f52390c-b816-4e43-b806-28c6b98768d1','e97c81ec-bd70-4bbf-968e-8bca0ad5719e','eeae8587-1099-4555-b324-ccf78d56ba07','bf1d960a-6191-4b1f-ae21-6c15eeb12dde','bf550f0d-fe8f-43d7-8af7-b1d35cd24405','94ea5373-faca-43c2-872f-28474591decb','347273ed-0bf2-4121-8ce2-c3e911f2b541']::uuid[];
  v_today  date := (now() at time zone 'Europe/Berlin')::date;
  v_target uuid[];
  v_id     uuid;
  v_actor  uuid;
  v_done   int := 0;
begin
  select coalesce(array_agg(id order by id), '{}') into v_target
  from public.jobs where id = any(v_ids) and status = 'in_progress' and date < v_today;

  -- maybe_complete_job expects the caller to hold the row lock.
  perform 1 from public.jobs where id = any(v_target) order by id for update;

  insert into public._multi_assignment_completion_fix_20261108(job_id, status, started_at, completed_at, completed_by)
  select id, status, started_at, completed_at, completed_by from public.jobs where id = any(v_target)
  on conflict (job_id) do nothing;

  foreach v_id in array v_target loop
    select ja.employee_id into v_actor
    from public.job_assignments ja
    where ja.job_id = v_id and ja.employee_completed_at is not null
    order by ja.employee_completed_at desc limit 1;
    if not public.maybe_complete_job(v_id, v_actor, now(), false) then
      raise exception 'job % is no longer eligible - nothing was changed', v_id;
    end if;
    v_done := v_done + 1;
  end loop;

  raise notice 'REMEDIATION: completed % job(s); skipped (today or no longer in_progress): %',
    v_done, cardinality(v_ids) - v_done;
end $fix$;

commit;
