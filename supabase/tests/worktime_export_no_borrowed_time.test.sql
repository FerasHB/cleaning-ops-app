-- Regression: get_company_worktime_export() must not credit an employee with
-- a colleague's shared job time (migration 20261030000000).
--
-- The export is the employer's retention evidence before a company deletion.
-- It must follow the same per-row source rule as the in-app timesheet
-- (services/timesheets/timesheet.service.ts, mapEntry):
--   1. own pair complete            -> own times
--   2. no own pair, job finished before the Phase-1 cutoff (2026-08-12)
--                                   -> shared job clock (only data source then)
--   3. otherwise                    -> own times only, never borrowed;
--                                      no own start -> no row at all
--
-- Before the fix the legacy branch used coalesce(own, job) per column, so an
-- assignee who never started received the full job duration as work time,
-- and an own start was mixed with the shared end. The multi-assignment
-- completion rule (20261029000000) makes such jobs complete far more often.
begin;

create temp table _checks(name text, ok boolean, detail text) on commit drop;
grant select, insert on _checks to authenticated;
create function pg_temp.check(p_name text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin insert into _checks values(p_name, coalesce(p_ok,false), p_detail); end $$;

insert into auth.users(instance_id,id,aud,role,email,raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','7e000000-0000-0000-0000-0000000000a0','authenticated','authenticated','wx-admin@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','7e000000-0000-0000-0000-0000000000a1','authenticated','authenticated','wx-e1@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','7e000000-0000-0000-0000-0000000000a2','authenticated','authenticated','wx-e2@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','7e000000-0000-0000-0000-0000000000a3','authenticated','authenticated','wx-e3@test.invalid','{}');

insert into public.companies(id,name,slug,timezone) values
 ('7e100000-0000-0000-0000-0000000000c1','WX Company','wx-company','Europe/Berlin');

insert into public.profiles(id,full_name,role,company_id,is_active) values
 ('7e000000-0000-0000-0000-0000000000a0','WX Admin','admin','7e100000-0000-0000-0000-0000000000c1',true),
 ('7e000000-0000-0000-0000-0000000000a1','WX Started','employee','7e100000-0000-0000-0000-0000000000c1',true),
 ('7e000000-0000-0000-0000-0000000000a2','WX Never','employee','7e100000-0000-0000-0000-0000000000c1',true),
 ('7e000000-0000-0000-0000-0000000000a3','WX StartOnly','employee','7e100000-0000-0000-0000-0000000000c1',true)
on conflict (id) do update set full_name=excluded.full_name, role=excluded.role,
 company_id=excluded.company_id, is_active=excluded.is_active;

-- Job 1 (after cutoff, completed): E1 own pair 08:00-10:00, E2 never started,
-- E3 own start 08:30 but no own end. Shared clock 08:00-12:00.
insert into public.jobs(id,company_id,created_by,customer_name,service_name,location_address,
  status,job_type,date,start_time,is_active,started_at,started_by,completed_at,completed_by)
values('7e200000-0000-0000-0000-000000000001','7e100000-0000-0000-0000-0000000000c1',
  '7e000000-0000-0000-0000-0000000000a0','WX','Cleaning','Road','completed','single',
  current_date,'06:00',true, now()-interval '6 hours','7e000000-0000-0000-0000-0000000000a1',
  now()-interval '2 hours','7e000000-0000-0000-0000-0000000000a1');
insert into public.job_assignments(id,job_id,employee_id,employee_name_snapshot,
  attendance,employee_started_at,employee_completed_at) values
 ('7e300000-0000-0000-0000-000000000011','7e200000-0000-0000-0000-000000000001',
  '7e000000-0000-0000-0000-0000000000a1','WX Started','completed',
  now()-interval '6 hours', now()-interval '4 hours'),
 ('7e300000-0000-0000-0000-000000000012','7e200000-0000-0000-0000-000000000001',
  '7e000000-0000-0000-0000-0000000000a2','WX Never','assigned', null, null),
 ('7e300000-0000-0000-0000-000000000013','7e200000-0000-0000-0000-000000000001',
  '7e000000-0000-0000-0000-0000000000a3','WX StartOnly','started',
  now()-interval '5 hours 30 minutes', null);

-- Job 2 (before the Phase-1 cutoff): no own times exist by design, the shared
-- clock is the only source and must still be exported.
insert into public.jobs(id,company_id,created_by,customer_name,service_name,location_address,
  status,job_type,date,start_time,is_active,started_at,completed_at)
values('7e200000-0000-0000-0000-000000000002','7e100000-0000-0000-0000-0000000000c1',
  '7e000000-0000-0000-0000-0000000000a0','WX','Cleaning','Road','completed','single',
  date '2026-08-01','08:00',true, timestamptz '2026-08-01 08:00+02', timestamptz '2026-08-01 11:00+02');
insert into public.job_assignments(id,job_id,employee_id,employee_name_snapshot)
values('7e300000-0000-0000-0000-000000000021','7e200000-0000-0000-0000-000000000002',
  '7e000000-0000-0000-0000-0000000000a2','WX Never');

-- Job 3 (after cutoff, still running): E2 assigned, never started.
insert into public.jobs(id,company_id,created_by,customer_name,service_name,location_address,
  status,job_type,date,start_time,is_active,started_at,started_by)
values('7e200000-0000-0000-0000-000000000003','7e100000-0000-0000-0000-0000000000c1',
  '7e000000-0000-0000-0000-0000000000a0','WX','Cleaning','Road','in_progress','single',
  current_date,'06:00',true, now()-interval '1 hour','7e000000-0000-0000-0000-0000000000a1');
insert into public.job_assignments(id,job_id,employee_id,employee_name_snapshot)
values('7e300000-0000-0000-0000-000000000031','7e200000-0000-0000-0000-000000000003',
  '7e000000-0000-0000-0000-0000000000a2','WX Never');

select set_config('request.jwt.claims',
  json_build_object('sub','7e000000-0000-0000-0000-0000000000a0','role','authenticated')::text, true);
set local role authenticated;
create temp table _x as select * from public.get_company_worktime_export();
reset role;

select pg_temp.check('never-started assignee on completed job has no export row',
  not exists (select 1 from _x where assignment_id='7e300000-0000-0000-0000-000000000012'),
  (select string_agg(coalesce(duration_minutes::text,'null'),',') from _x
    where assignment_id='7e300000-0000-0000-0000-000000000012'));
select pg_temp.check('never-started assignee on running job has no export row',
  not exists (select 1 from _x where assignment_id='7e300000-0000-0000-0000-000000000031'));
select pg_temp.check('own complete pair is exported unchanged (120 min)',
  (select duration_minutes=120 and started_at=employee_row.s from _x,
     (select employee_started_at s from public.job_assignments
       where id='7e300000-0000-0000-0000-000000000011') employee_row
    where assignment_id='7e300000-0000-0000-0000-000000000011'));
select pg_temp.check('own start without own end does not borrow the shared end',
  (select ended_at is null and duration_minutes is null and end_local is null
     and started_at=(select employee_started_at from public.job_assignments
                      where id='7e300000-0000-0000-0000-000000000013')
   from _x where assignment_id='7e300000-0000-0000-0000-000000000013'),
  (select concat_ws('|',started_at,ended_at,duration_minutes) from _x
    where assignment_id='7e300000-0000-0000-0000-000000000013'));
select pg_temp.check('pre-cutoff job still exports the shared clock (180 min)',
  (select duration_minutes=180 from _x where assignment_id='7e300000-0000-0000-0000-000000000021'));
select pg_temp.check('exactly three assignment rows',
  (select count(*)=3 from _x where record_kind='assignment'),
  (select count(*)::text from _x where record_kind='assignment'));

do $$
declare r record; n int := 0;
begin
  for r in select * from _checks order by name loop
    raise notice '% %  %', case when r.ok then 'PASS' else 'FAIL' end, r.name, r.detail;
    if not r.ok then n := n + 1; end if;
  end loop;
  if n > 0 then raise exception '% check(s) failed', n; end if;
end $$;

rollback;
