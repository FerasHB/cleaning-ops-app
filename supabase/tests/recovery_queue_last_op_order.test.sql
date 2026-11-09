-- Regression: get_work_recovery_queue must classify by the employee action
-- that really ran last (migration 20261030000002).
--
-- work_operation_receipts.created_at is now() = transaction START. A complete
-- whose transaction began first but waited for the job lock commits AFTER a
-- pause, yet carries the smaller created_at. result_payload.recorded_at is
-- clock_timestamp() under the lock and reflects the real order.
--
-- Fixture: pause receipt with the LATER created_at but EARLIER recorded_at,
-- complete receipt with the EARLIER created_at but LATER recorded_at.
-- Correct reason: late_complete. The old ordering reported late_pause.
begin;

insert into auth.users(instance_id,id,aud,role,email,raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','7f000000-0000-0000-0000-0000000000a0','authenticated','authenticated','rq-admin@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','7f000000-0000-0000-0000-0000000000a1','authenticated','authenticated','rq-e1@test.invalid','{}');
insert into public.companies(id,name,slug,timezone) values
 ('7f100000-0000-0000-0000-0000000000c1','RQ Company','rq-company','Europe/Berlin');
insert into public.profiles(id,full_name,role,company_id,is_active) values
 ('7f000000-0000-0000-0000-0000000000a0','RQ Admin','admin','7f100000-0000-0000-0000-0000000000c1',true),
 ('7f000000-0000-0000-0000-0000000000a1','RQ E1','employee','7f100000-0000-0000-0000-0000000000c1',true)
on conflict (id) do update set full_name=excluded.full_name, role=excluded.role,
 company_id=excluded.company_id, is_active=excluded.is_active;

insert into public.jobs(id,company_id,created_by,customer_name,service_name,location_address,
  status,job_type,date,start_time,is_active,started_at,started_by)
values('7f200000-0000-0000-0000-000000000001','7f100000-0000-0000-0000-0000000000c1',
  '7f000000-0000-0000-0000-0000000000a0','RQ','Cleaning','Road','in_progress','single',
  current_date,'06:00',true, now()-interval '13 hours','7f000000-0000-0000-0000-0000000000a1');
insert into public.job_assignments(id,job_id,employee_id,employee_name_snapshot)
values('7f300000-0000-0000-0000-000000000001','7f200000-0000-0000-0000-000000000001',
  '7f000000-0000-0000-0000-0000000000a1','RQ E1');

select set_config('taskops.work_session_rpc','on',true);
update public.job_assignments set time_tracking_mode='sessions' where id='7f300000-0000-0000-0000-000000000001';
update public.job_assignments set employee_started_at=now()-interval '13 hours', attendance='started',
  work_review_required=true where id='7f300000-0000-0000-0000-000000000001';
insert into public.work_sessions(id,job_assignment_id,employee_id,started_at,ended_at)
values('7f400000-0000-0000-0000-000000000001','7f300000-0000-0000-0000-000000000001',
  '7f000000-0000-0000-0000-0000000000a1', now()-interval '13 hours', now()-interval '10 minutes');
select set_config('taskops.work_session_rpc','off',true);

insert into public.work_operation_receipts
  (operation_id,actor_id,job_assignment_id,operation_type,request_payload,result_payload,created_at)
values
 ('7f500000-0000-0000-0000-000000000001','7f000000-0000-0000-0000-0000000000a1',
  '7f300000-0000-0000-0000-000000000001','start','{}',
  jsonb_build_object('recorded_at', now()-interval '13 hours'), now()-interval '13 hours'),
 -- complete: transaction began first (smaller created_at), committed last
 ('7f500000-0000-0000-0000-000000000003','7f000000-0000-0000-0000-0000000000a1',
  '7f300000-0000-0000-0000-000000000001','complete','{}',
  jsonb_build_object('recorded_at', now()-interval '1 minute'), now()-interval '3 minutes'),
 -- pause: transaction began later, committed first
 ('7f500000-0000-0000-0000-000000000002','7f000000-0000-0000-0000-0000000000a1',
  '7f300000-0000-0000-0000-000000000001','pause','{}',
  jsonb_build_object('recorded_at', now()-interval '2 minutes'), now()-interval '2 minutes 30 seconds');

select set_config('request.jwt.claims',
  json_build_object('sub','7f000000-0000-0000-0000-0000000000a0','role','authenticated')::text, true);
set local role authenticated;
create temp table _q as select * from public.get_work_recovery_queue();
reset role;

do $$
declare v text;
begin
  select reason_code into v from _q where assignment_id='7f300000-0000-0000-0000-000000000001';
  if v is distinct from 'late_complete' then
    raise exception 'RECOVERY QUEUE ORDER: expected late_complete, got %', coalesce(v,'<no row>');
  end if;
  raise notice 'PASS recovery queue uses the action that committed last (late_complete)';
end $$;

rollback;
