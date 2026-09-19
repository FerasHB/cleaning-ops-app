-- Legacy correction still works; session accounting cannot be rewritten by it.
begin;

insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
('00000000-0000-0000-0000-000000000000','d2000000-0000-0000-0000-0000000000a1','authenticated','authenticated','pr-accounting-admin@example.test','{"full_name":"Admin"}'),
('00000000-0000-0000-0000-000000000000','d2000000-0000-0000-0000-0000000000a2','authenticated','authenticated','pr-accounting-employee@example.test','{"full_name":"Employee"}');
insert into public.profiles (id,full_name) values
('d2000000-0000-0000-0000-0000000000a1','Admin'),
('d2000000-0000-0000-0000-0000000000a2','Employee')
on conflict (id) do nothing;
insert into public.companies (id,name,slug,timezone) values
('d1000000-0000-0000-0000-0000000000a1','Accounting guard test','pr-accounting-guard-test','Europe/Berlin');
update public.profiles set company_id='d1000000-0000-0000-0000-0000000000a1', role='admin',is_active=true
where id='d2000000-0000-0000-0000-0000000000a1';
update public.profiles set company_id='d1000000-0000-0000-0000-0000000000a1', role='employee',is_active=true
where id='d2000000-0000-0000-0000-0000000000a2';

insert into public.jobs (id,company_id,assigned_to,created_by,customer_name,service_name,
  location_address,status,job_type,date,start_time,is_active) values
('d4000000-0000-0000-0000-0000000000a1','d1000000-0000-0000-0000-0000000000a1',null,'d2000000-0000-0000-0000-0000000000a1','Legacy','Cleaning','Street 1','open','single',(now() at time zone 'Europe/Berlin')::date,'08:00',true),
('d4000000-0000-0000-0000-0000000000a2','d1000000-0000-0000-0000-0000000000a1',null,'d2000000-0000-0000-0000-0000000000a1','Sessions','Cleaning','Street 2','open','single',(now() at time zone 'Europe/Berlin')::date,'08:00',true);
insert into public.job_assignments (id,job_id,employee_id,employee_name_snapshot) values
('d5000000-0000-0000-0000-0000000000a1','d4000000-0000-0000-0000-0000000000a1','d2000000-0000-0000-0000-0000000000a2','Employee'),
('d5000000-0000-0000-0000-0000000000a2','d4000000-0000-0000-0000-0000000000a2','d2000000-0000-0000-0000-0000000000a2','Employee');
update public.jobs set status='completed',started_at='2026-09-15 08:00+00',completed_at='2026-09-15 12:00+00'
where id='d4000000-0000-0000-0000-0000000000a1';

do $$ begin
  perform set_config('taskops.work_session_rpc','on',true);
  update public.job_assignments set time_tracking_mode='sessions'
  where id='d5000000-0000-0000-0000-0000000000a2';
  perform set_config('taskops.work_session_rpc','off',true);
end $$;

do $$
declare rejected boolean := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub','d2000000-0000-0000-0000-0000000000a1','role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.admin_correct_assignment_time(
    'd5000000-0000-0000-0000-0000000000a1',
    '2026-09-15 08:30+00','2026-09-15 11:30+00','Verified legacy correction');
  begin
    perform public.admin_correct_assignment_time(
      'd5000000-0000-0000-0000-0000000000a2',
      '2026-09-15 08:30+00','2026-09-15 11:30+00','Must reject');
  exception when sqlstate '22023' then
    rejected := position('reviewed session-recovery' in sqlerrm) > 0;
  end;
  execute 'reset role';
  if not rejected then raise exception 'Session correction did not return controlled rejection'; end if;
  if (select employee_started_at from public.job_assignments where id='d5000000-0000-0000-0000-0000000000a1')
       is distinct from timestamptz '2026-09-15 08:30+00' then
    raise exception 'Legacy correction changed behavior';
  end if;
  if (select employee_started_at from public.job_assignments where id='d5000000-0000-0000-0000-0000000000a2')
       is not null then raise exception 'Session assignment was rewritten'; end if;
  if (select count(*) from public.employee_time_adjustments where assignment_id='d5000000-0000-0000-0000-0000000000a1') <> 1
     or (select count(*) from public.employee_time_adjustments where assignment_id='d5000000-0000-0000-0000-0000000000a2') <> 0 then
    raise exception 'Correction audit behavior changed';
  end if;
  if has_function_privilege('authenticated',
       'public.admin_correct_assignment_time_legacy_impl(uuid,timestamptz,timestamptz,text)', 'EXECUTE') then
    raise exception 'Legacy implementation is directly callable';
  end if;
end $$;

rollback;
