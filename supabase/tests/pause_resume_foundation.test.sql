-- Transactional SQL regression for session-aware execution.
begin;
create temp table _checks(name text, ok boolean, detail text) on commit drop;
create function pg_temp.check(p_name text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  insert into _checks values(p_name,coalesce(p_ok,false),p_detail);
end $$;
create function pg_temp.call_work(
  p_actor uuid, p_kind text, p_op uuid, p_assignment uuid,
  p_revision bigint, p_session uuid, p_at timestamptz)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub',p_actor::text,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  begin
    if p_kind='start' then
      v:=public.start_own_job_v2(p_op,p_assignment,p_revision,p_session,p_at);
    elsif p_kind='pause' then
      v:=public.pause_own_job(p_op,p_assignment,p_revision,p_session,p_at);
    elsif p_kind='resume' then
      v:=public.resume_own_job(p_op,p_assignment,p_revision,p_session,p_at);
    elsif p_kind='complete' then
      v:=public.complete_own_job_v2(p_op,p_assignment,p_revision,p_session,p_at);
    else
      raise exception 'Invalid test kind';
    end if;
  exception when others then
    execute 'reset role';
    raise;
  end;
  execute 'reset role';
  return v;
end $$;
create function pg_temp.try_work(
  p_actor uuid, p_kind text, p_op uuid, p_assignment uuid,
  p_revision bigint, p_session uuid, p_at timestamptz)
returns boolean language plpgsql as $$
begin
  perform pg_temp.call_work(p_actor,p_kind,p_op,p_assignment,p_revision,p_session,p_at);
  return true;
exception when others then
  execute 'reset role';
  return false;
end $$;
create function pg_temp.mkjob(p_job uuid,p_company uuid,p_emps uuid[],p_at timestamptz)
returns void language plpgsql as $$
begin
  insert into public.jobs(id,company_id,created_by,customer_name,service_name,
    location_address,status,job_type,date,start_time,is_active)
  values(p_job,p_company,
    case when p_company='b1000000-0000-0000-0000-000000000001'::uuid
      then 'b2000000-0000-0000-0000-000000000001'::uuid
      else 'b2000000-0000-0000-0000-000000000004'::uuid end,
    'Pause test','Cleaning','Test road','open','single',
    (p_at at time zone 'Europe/Berlin')::date,'08:00',true);
  insert into public.job_assignments(job_id,employee_id,employee_name_snapshot)
  select p_job,e,'Test employee' from unnest(p_emps) e
  on conflict(job_id,employee_id) do nothing;
end $$;

insert into auth.users(instance_id,id,aud,role,email,raw_user_meta_data) values
('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000001','authenticated','authenticated','pr-admin@test.invalid','{}'),
('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000002','authenticated','authenticated','pr-e1@test.invalid','{}'),
('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000003','authenticated','authenticated','pr-e2@test.invalid','{}'),
('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000004','authenticated','authenticated','pr-admin-b@test.invalid','{}'),
('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000005','authenticated','authenticated','pr-e-b@test.invalid','{}'),
('00000000-0000-0000-0000-000000000000','b2000000-0000-0000-0000-000000000006','authenticated','authenticated','pr-delete@test.invalid','{}');
insert into public.companies(id,name,slug,timezone) values
('b1000000-0000-0000-0000-000000000001','Pause Company A','pr-company-a','Europe/Berlin'),
('b1000000-0000-0000-0000-000000000002','Pause Company B','pr-company-b','Europe/Berlin');
update public.profiles set company_id='b1000000-0000-0000-0000-000000000001',
 role='admin',is_active=true where id='b2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='b1000000-0000-0000-0000-000000000001',
 role='employee',is_active=true where id in
 ('b2000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000003','b2000000-0000-0000-0000-000000000006');
update public.profiles set company_id='b1000000-0000-0000-0000-000000000002',
 role='admin',is_active=true where id='b2000000-0000-0000-0000-000000000004';
update public.profiles set company_id='b1000000-0000-0000-0000-000000000002',
 role='employee',is_active=true where id='b2000000-0000-0000-0000-000000000005';

select pg_temp.check('capability off by default',
 (select value='false'::jsonb from public.app_config where key='pause_resume_enabled'));
update public.app_config set value='true'::jsonb where key='pause_resume_enabled';
select pg_temp.mkjob('b3000000-0000-0000-0000-000000000001',
 'b1000000-0000-0000-0000-000000000001',array[
 'b2000000-0000-0000-0000-000000000002'::uuid,
 'b2000000-0000-0000-0000-000000000003'::uuid],now()-interval '4 minutes');
select pg_temp.mkjob('b3000000-0000-0000-0000-000000000002',
 'b1000000-0000-0000-0000-000000000001',array[
 'b2000000-0000-0000-0000-000000000002'::uuid],now()-interval '4 minutes');
select pg_temp.mkjob('b3000000-0000-0000-0000-000000000003',
 'b1000000-0000-0000-0000-000000000001',array[
 'b2000000-0000-0000-0000-000000000002'::uuid],now()-interval '4 minutes');
select pg_temp.mkjob('b3000000-0000-0000-0000-000000000004',
 'b1000000-0000-0000-0000-000000000002',array[
 'b2000000-0000-0000-0000-000000000005'::uuid],now()-interval '4 minutes');
select pg_temp.mkjob('b3000000-0000-0000-0000-000000000006',
 'b1000000-0000-0000-0000-000000000001',array[
 'b2000000-0000-0000-0000-000000000003'::uuid],now()-interval '4 minutes');
select pg_temp.mkjob('b3000000-0000-0000-0000-000000000005',
 'b1000000-0000-0000-0000-000000000001',array[
 'b2000000-0000-0000-0000-000000000006'::uuid],now()-interval '4 minutes');

-- E1 starts A; E2 independently joins the already-running parent.
do $$
declare
  a uuid; b uuid; c uuid; foreign_a uuid; del_a uuid;
  e1 constant uuid := 'b2000000-0000-0000-0000-000000000002';
  e2 constant uuid := 'b2000000-0000-0000-0000-000000000003';
  eb constant uuid := 'b2000000-0000-0000-0000-000000000005';
  t timestamptz := now()-interval '4 minutes';
  r jsonb; again jsonb; n integer; x text;
begin
  select id into a from public.job_assignments where job_id='b3000000-0000-0000-0000-000000000001' and employee_id=e1;
  select id into b from public.job_assignments where job_id='b3000000-0000-0000-0000-000000000002' and employee_id=e1;
  select id into c from public.job_assignments where job_id='b3000000-0000-0000-0000-000000000001' and employee_id=e2;
  select id into foreign_a from public.job_assignments where job_id='b3000000-0000-0000-0000-000000000004' and employee_id=eb;
  select id into del_a from public.job_assignments where job_id='b3000000-0000-0000-0000-000000000005';

  perform pg_temp.check('capability default configured',
    (select value='true'::jsonb from public.app_config where key='pause_resume_enabled'));
  r:=pg_temp.call_work(e1,'start','b4000000-0000-0000-0000-000000000001',a,0,
    'b5000000-0000-0000-0000-000000000001',t);
  perform pg_temp.check('first start active and revision 1',
    r->>'assignment_state'='active' and (r->>'work_revision')::int=1);
  select count(*) into n from public.work_sessions where job_assignment_id=a;
  perform pg_temp.check('first start exactly one session',n=1,n::text);
  again:=pg_temp.call_work(e1,'start','b4000000-0000-0000-0000-000000000001',a,0,
    'b5000000-0000-0000-0000-000000000001',t);
  perform pg_temp.check('start receipt exact replay',again=r);
  perform pg_temp.check('receipt cannot be replayed by another employee',
    not pg_temp.try_work(e2,'start','b4000000-0000-0000-0000-000000000001',a,0,
      'b5000000-0000-0000-0000-000000000001',t));
  update public.app_config set value='false'::jsonb where key='pause_resume_enabled';
  again:=pg_temp.call_work(e1,'start','b4000000-0000-0000-0000-000000000001',a,0,
    'b5000000-0000-0000-0000-000000000001',t);
  perform pg_temp.check('accepted receipt replays while capability off',again=r);
  update public.app_config set value='true'::jsonb where key='pause_resume_enabled';
  perform pg_temp.check('operation ID payload mismatch rejected',
    not pg_temp.try_work(e1,'start','b4000000-0000-0000-0000-000000000001',a,0,
      'b5000000-0000-0000-0000-000000000001',t+interval '1 second'));
  begin
    delete from auth.users where id=e1;
    x:='accepted';
  exception when others then x:=sqlerrm; end;
  perform pg_temp.check('active session blocks account deletion',
    x like '%Active work session%');
  begin
    delete from public.job_assignments where id=a;
    x:='accepted';
  exception when others then x:=sqlerrm; end;
  perform pg_temp.check('session-bearing assignment deletion denied',
    x like '%Recorded work assignment%');
  begin
    delete from public.jobs where id='b3000000-0000-0000-0000-000000000001';
    x:='accepted';
  exception when others then x:=sqlerrm; end;
  perform pg_temp.check('session-bearing job deletion denied',
    x like '%recorded work sessions%');
  perform set_config('taskops.work_session_rpc','on',true);
  begin
    update public.job_assignments set employee_completed_at=t+interval '1 second'
      where id=a;
    x:='accepted';
  exception when others then x:=sqlerrm; end;
  perform set_config('taskops.work_session_rpc','off',true);
  perform pg_temp.check('completed assignment cannot retain active session',
    x like '%Completed assignment%');
  perform pg_temp.check('global active blocks second job',
    not pg_temp.try_work(e1,'start','b4000000-0000-0000-0000-000000000002',b,0,
      'b5000000-0000-0000-0000-000000000002',t+interval '1 second'));
  perform pg_temp.check('foreign employee denied',
    not pg_temp.try_work(eb,'pause','b4000000-0000-0000-0000-000000000003',a,1,
      'b5000000-0000-0000-0000-000000000001',t+interval '2 seconds'));
  perform pg_temp.check('cross-company assignment denied',
    not pg_temp.try_work(e1,'start','b4000000-0000-0000-0000-000000000004',foreign_a,0,
      'b5000000-0000-0000-0000-000000000004',t+interval '2 seconds'));

  r:=pg_temp.call_work(e2,'start','b4000000-0000-0000-0000-000000000005',c,0,
    'b5000000-0000-0000-0000-000000000005',t+interval '3 seconds');
  perform pg_temp.check('second employee independent start',r->>'assignment_state'='active');
  select count(*) into n from public.notification_outbox
    where job_id='b3000000-0000-0000-0000-000000000001' and event_type='job_started';
  perform pg_temp.check('lifecycle start notification once',n=1,n::text);
  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('b3000000-0000-0000-0000-000000000001',t+interval '4 seconds');
    x:='accepted';
  exception when others then x:='rejected'; end;
  execute 'reset role';
  perform pg_temp.check('old start rejects session mode',x='rejected');

  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  select count(*) into n from public.work_sessions
    where id='b5000000-0000-0000-0000-000000000005';
  execute 'reset role';
  perform pg_temp.check('employee cannot read colleague session',n=0,n::text);

  -- Force Complete is temporarily enabled in this rolled-back transaction.
  update public.app_config set value='true'::jsonb where key='force_complete_enabled';
  perform set_config('request.jwt.claims',
    json_build_object('sub','b2000000-0000-0000-0000-000000000001','role','authenticated')::text,true);
  execute 'set local role authenticated';
  begin
    perform public.admin_force_complete_job('b3000000-0000-0000-0000-000000000001','review');
    x:='accepted';
  exception when others then x:=sqlerrm;
  end;
  execute 'reset role';
  perform pg_temp.check('force complete blocked by active session',
    x like '%Active work sessions%');

  r:=pg_temp.call_work(e1,'pause','b4000000-0000-0000-0000-000000000007',a,1,
    'b5000000-0000-0000-0000-000000000001',t+interval '5 seconds');
  perform pg_temp.check('pause closes exact session',r->>'assignment_state'='paused'
    and r->>'active_session_id' is null and (r->>'closed_seconds')::numeric=5);
  again:=pg_temp.call_work(e1,'pause','b4000000-0000-0000-0000-000000000007',a,1,
    'b5000000-0000-0000-0000-000000000001',t+interval '5 seconds');
  perform pg_temp.check('pause duplicate receipt',again=r);
  perform pg_temp.check('pause and resume no notification',
    (select count(*)=1 from public.notification_outbox
      where job_id='b3000000-0000-0000-0000-000000000001'));

  r:=pg_temp.call_work(e1,'start','b4000000-0000-0000-0000-000000000008',b,0,
    'b5000000-0000-0000-0000-000000000008',t+interval '6 seconds');
  perform pg_temp.check('second job can start after pause',r->>'assignment_state'='active');
  r:=pg_temp.call_work(e1,'complete','b4000000-0000-0000-0000-000000000009',b,1,
    'b5000000-0000-0000-0000-000000000008',t+interval '8 seconds');
  perform pg_temp.check('complete active closes atomically',r->>'assignment_state'='completed'
    and (r->>'closed_seconds')::numeric=2 and r->>'job_status'='completed');
  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  begin
    perform public.complete_own_job('b3000000-0000-0000-0000-000000000002',t+interval '9 seconds');
    x:='accepted';
  exception when others then x:='rejected'; end;
  execute 'reset role';
  perform pg_temp.check('old complete rejects session mode',x='rejected');
  -- A changed scheduled date must not invalidate continuation.
  update public.jobs set date=(t at time zone 'Europe/Berlin')::date - 1
    where id='b3000000-0000-0000-0000-000000000001';
  r:=pg_temp.call_work(e1,'resume','b4000000-0000-0000-0000-000000000011',a,2,
    'b5000000-0000-0000-0000-000000000011',t+interval '10 seconds');
  perform pg_temp.check('resume new session and original start preserved',
    r->>'assignment_state'='active' and
    (select employee_started_at=t from public.job_assignments where id=a));
  perform pg_temp.check('stale pause cannot close newer session',
    not pg_temp.try_work(e1,'pause','b4000000-0000-0000-0000-000000000012',a,3,
      'b5000000-0000-0000-0000-000000000001',t+interval '11 seconds'));
  r:=pg_temp.call_work(e1,'pause','b4000000-0000-0000-0000-000000000013',a,3,
    'b5000000-0000-0000-0000-000000000011',t+interval '12 seconds');
  perform pg_temp.check('multiple cycles sum closed seconds',
    (r->>'closed_seconds')::numeric=7);
  r:=pg_temp.call_work(e1,'resume','b4000000-0000-0000-0000-000000000014',a,4,
    'b5000000-0000-0000-0000-000000000014',t+interval '13 seconds');
  r:=pg_temp.call_work(e1,'complete','b4000000-0000-0000-0000-000000000015',a,5,
    'b5000000-0000-0000-0000-000000000014',t+interval '15 seconds');
  perform pg_temp.check('parent waits for second employee',r->>'job_status'='in_progress'
    and (r->>'closed_seconds')::numeric=9);
  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  perform pg_temp.check('own assignment final before parent job completes',
    (public.get_assignment_work_summary(a)->>'assignment_state')='completed'
    and (select status='in_progress' from public.jobs
         where id='b3000000-0000-0000-0000-000000000001'));
  again:=pg_temp.call_work(e1,'complete','b4000000-0000-0000-0000-000000000015',a,5,
    'b5000000-0000-0000-0000-000000000014',t+interval '15 seconds');
  perform pg_temp.check('duplicate complete no duplicate mutation',again=r);

  r:=pg_temp.call_work(e2,'pause','b4000000-0000-0000-0000-000000000016',c,1,
    'b5000000-0000-0000-0000-000000000005',t+interval '16 seconds');
  r:=pg_temp.call_work(e2,'start','b4000000-0000-0000-0000-000000000020',
    (select id from public.job_assignments where job_id='b3000000-0000-0000-0000-000000000006'),0,
    'b5000000-0000-0000-0000-000000000020',t+interval '17 seconds');
  r:=pg_temp.call_work(e2,'complete','b4000000-0000-0000-0000-000000000017',c,2,
    null,t+interval '18 seconds');
  perform pg_temp.check('complete paused while other job active adds zero work',
    r->>'assignment_state'='completed' and (r->>'closed_seconds')::numeric=13
    and r->>'job_status'='completed');
  r:=pg_temp.call_work(e2,'complete','b4000000-0000-0000-0000-000000000021',
    (select id from public.job_assignments where job_id='b3000000-0000-0000-0000-000000000006'),1,
    'b5000000-0000-0000-0000-000000000020',t+interval '19 seconds');
  select count(*) into n from public.notification_outbox
   where job_id='b3000000-0000-0000-0000-000000000001' and event_type='job_completed';
  perform pg_temp.check('lifecycle completion notification once',n=1,n::text);
  perform pg_temp.check('assignment final independent of parent',
    (select employee_completed_at is not null from public.job_assignments where id=a));
  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  perform pg_temp.check('summary derives completed state',
    (public.get_assignment_work_summary(a)->>'assignment_state')='completed');

  -- Legacy RPC remains usable on an untouched assignment.
  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.start_own_job('b3000000-0000-0000-0000-000000000003',t+interval '20 seconds');
  perform public.complete_own_job('b3000000-0000-0000-0000-000000000003',t+interval '21 seconds');
  execute 'reset role';
  perform pg_temp.check('legacy start and complete preserved',
    (select ja.time_tracking_mode='legacy' and ja.employee_completed_at is not null
      from public.job_assignments ja where ja.job_id='b3000000-0000-0000-0000-000000000003'));

  -- A record remains after its owning account is deleted.
  r:=pg_temp.call_work('b2000000-0000-0000-0000-000000000006','start',
    'b4000000-0000-0000-0000-000000000018',del_a,0,
    'b5000000-0000-0000-0000-000000000018',t);
  r:=pg_temp.call_work('b2000000-0000-0000-0000-000000000006','complete',
    'b4000000-0000-0000-0000-000000000019',del_a,1,
    'b5000000-0000-0000-0000-000000000018',t+interval '1 second');
  delete from auth.users where id='b2000000-0000-0000-0000-000000000006';
  perform pg_temp.check('account deletion preserves anonymized session',
    (select count(*)=1 from public.work_sessions
      where job_assignment_id=del_a and employee_id is null));
  perform pg_temp.check('account deletion preserves assignment',
    (select employee_id is null from public.job_assignments where id=del_a));
end $$;


-- Focused boundary, access-control and recovery cases.
select pg_temp.mkjob('b3000000-0000-0000-0000-000000000007',
 'b1000000-0000-0000-0000-000000000001',array[
 'b2000000-0000-0000-0000-000000000002'::uuid],now()-interval '3 minutes');
select pg_temp.mkjob('b3000000-0000-0000-0000-000000000008',
 'b1000000-0000-0000-0000-000000000001',array[
 'b2000000-0000-0000-0000-000000000002'::uuid],now()-interval '3 minutes');
select pg_temp.mkjob('b3000000-0000-0000-0000-000000000010',
 'b1000000-0000-0000-0000-000000000001',array[
 'b2000000-0000-0000-0000-000000000002'::uuid],now()-interval '3 minutes');
select pg_temp.mkjob('b3000000-0000-0000-0000-000000000009',
 'b1000000-0000-0000-0000-000000000001',array[
 'b2000000-0000-0000-0000-000000000003'::uuid],now()-interval '13 hours');
do $$
declare
  e1 constant uuid := 'b2000000-0000-0000-0000-000000000002';
  e2 constant uuid := 'b2000000-0000-0000-0000-000000000003';
  a uuid; b uuid; overdue uuid; r jsonb; accepted boolean;
  old_start timestamptz := now()-interval '13 hours';
begin
  select id into a from public.job_assignments
    where job_id='b3000000-0000-0000-0000-000000000007';
  select id into b from public.job_assignments
    where job_id='b3000000-0000-0000-0000-000000000008';
  select id into overdue from public.job_assignments
    where job_id='b3000000-0000-0000-0000-000000000009';

  -- Existing legacy work must finish before a new session starts.
  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.start_own_job('b3000000-0000-0000-0000-000000000007',
    now()-interval '3 minutes');
  execute 'reset role';
  perform pg_temp.check('unresolved legacy work blocks new session',
    not pg_temp.try_work(e1,'start','b4000000-0000-0000-0000-000000000030',b,0,
      'b5000000-0000-0000-0000-000000000030',now()-interval '2 minutes'));
  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.complete_own_job('b3000000-0000-0000-0000-000000000007',
    now()-interval '2 minutes 30 seconds');
  execute 'reset role';
  r:=pg_temp.call_work(e1,'start','b4000000-0000-0000-0000-000000000031',b,0,
    'b5000000-0000-0000-0000-000000000031',now()-interval '2 minutes');
  perform pg_temp.check('session starts after legacy completion',r->>'assignment_state'='active');

  -- Direct client mutation is denied by grants even if it owns the session.
  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  begin
    update public.work_sessions set ended_at=now()
      where id='b5000000-0000-0000-0000-000000000031';
    accepted:=true;
  exception when others then accepted:=false; end;
  execute 'reset role';
  perform pg_temp.check('direct employee session write denied',not accepted);
  perform pg_temp.check('rejected direct write leaves session open',
    not exists (select 1 from public.work_sessions
      where id='b5000000-0000-0000-0000-000000000031' and ended_at is not null));
  update public.profiles set is_active=false where id=e1;
  perform pg_temp.check('inactive employee cannot pause',
    not pg_temp.try_work(e1,'pause','b4000000-0000-0000-0000-000000000039',b,1,
      'b5000000-0000-0000-0000-000000000031',now()-interval '1 minute'));
  update public.profiles set is_active=true where id=e1;
  r:=pg_temp.call_work(e1,'pause','b4000000-0000-0000-0000-000000000032',b,1,
    'b5000000-0000-0000-0000-000000000031',now()-interval '1 minute');

  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.start_own_job('b3000000-0000-0000-0000-000000000010',
    now()-interval '50 seconds');
  execute 'reset role';
  perform pg_temp.check('resume blocked by unresolved legacy work',
    not pg_temp.try_work(e1,'resume','b4000000-0000-0000-0000-000000000040',b,2,
      'b5000000-0000-0000-0000-000000000040',now()-interval '40 seconds'));
  perform set_config('request.jwt.claims',
    json_build_object('sub',e1::text,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.complete_own_job('b3000000-0000-0000-0000-000000000010',
    now()-interval '30 seconds');
  execute 'reset role';

  -- Build an old but factual active interval as an administrator fixture;
  -- normal Start correctly refuses timestamps older than twelve hours.
  perform set_config('taskops.work_session_rpc','on',true);
  update public.job_assignments set time_tracking_mode='sessions',
    employee_started_at=old_start,attendance='started',work_revision=1
    where id=overdue;
  insert into public.work_sessions(id,job_assignment_id,employee_id,started_at)
    values('b5000000-0000-0000-0000-000000000033',overdue,e2,old_start);
  perform set_config('taskops.work_session_rpc','off',true);
  update public.jobs set status='in_progress',started_at=old_start,
    started_by=e2 where id='b3000000-0000-0000-0000-000000000009';
  r:=pg_temp.call_work(e2,'pause','b4000000-0000-0000-0000-000000000033',overdue,1,
    'b5000000-0000-0000-0000-000000000033',now());
  perform pg_temp.check('overdue factual pause releases slot and marks review',
    r->>'assignment_state'='paused' and (r->>'review_required')::boolean
    and (select ended_at=now() from public.work_sessions
      where id='b5000000-0000-0000-0000-000000000033'));
  perform pg_temp.check('resume beyond original 12 hours rejected',
    not pg_temp.try_work(e2,'resume','b4000000-0000-0000-0000-000000000034',overdue,2,
      'b5000000-0000-0000-0000-000000000034',now()));
  -- 20260922000000 changed this contract on purpose. The overdue completion
  -- used to RAISE, which rolled back the very review flag that makes the case
  -- discoverable. It now commits a durable review hand-off instead: the
  -- assignment stays unresolved, keeps the flag and waits for
  -- admin_review_session_assignment.
  r:=pg_temp.call_work(e2,'complete','b4000000-0000-0000-0000-000000000035',overdue,2,
      null,now());
  perform pg_temp.check('overdue completion commits a durable review hand-off',
    r->>'assignment_state'='review_pending'
    and (r->>'review_required')::boolean
    and r->>'employee_completed_at' is null);
  perform pg_temp.check('overdue completion never completes the parent job',
    (select status='in_progress' from public.jobs
      where id='b3000000-0000-0000-0000-000000000009'));
  perform pg_temp.check('overdue stop frees global employee slot',
    not exists(select 1 from public.work_sessions
      where employee_id=e2 and ended_at is null));
end $$;

select name,ok,detail from _checks order by name;
do $$ declare n int; details text;
begin
  select count(*),string_agg(name||': '||coalesce(detail,''),'; ')
    into n,details from _checks where not ok;
  if n>0 then raise exception '% Pause/Resume tests failed: %',n,details; end if;
  raise notice '% Pause/Resume assertions passed',(select count(*) from _checks);
end $$;
rollback;
