-- Transactional regression for the Admin Session Recovery backend
-- (migration 20260922000000_session_work_recovery.sql).
--
-- TWO TEST CATEGORIES, KEPT APART ON PURPOSE:
--
--   LIVE   — real RPC calls with real current timestamps. The action-timestamp
--            trust window (>=now()-12h, <=now()+5min) caps a reachable session
--            at about 12h05m, so every "late" case uses start = now()-11h59m
--            and an action at now()+4min. That is a genuine >12h lifecycle.
--   FIXTURE— session rows inserted directly, because a 26-hour lifecycle cannot
--            be produced through the employee RPCs without ~14 hours of real
--            waiting. These prove arithmetic, constraints and accounting. They
--            are NOT employee RPC tests and are never described as such.
begin;

create temp table _checks(name text, ok boolean, detail text) on commit drop;
-- The suite records assertions while impersonating employees/admins, so the
-- harness table must be writable under `set local role authenticated`.
grant select, insert on _checks to authenticated;
create function pg_temp.check(p_name text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin insert into _checks values(p_name, coalesce(p_ok,false), p_detail); end $$;

create function pg_temp.act_as(p_actor uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub',p_actor::text,'role','authenticated')::text, true);
end $$;

create function pg_temp.call_work(
  p_actor uuid, p_kind text, p_op uuid, p_assignment uuid,
  p_revision bigint, p_session uuid, p_at timestamptz)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act_as(p_actor);
  execute 'set local role authenticated';
  begin
    if p_kind='start' then v:=public.start_own_job_v2(p_op,p_assignment,p_revision,p_session,p_at);
    elsif p_kind='pause' then v:=public.pause_own_job(p_op,p_assignment,p_revision,p_session,p_at);
    elsif p_kind='resume' then v:=public.resume_own_job(p_op,p_assignment,p_revision,p_session,p_at);
    else v:=public.complete_own_job_v2(p_op,p_assignment,p_revision,p_session,p_at); end if;
  exception when others then execute 'reset role'; raise; end;
  execute 'reset role';
  return v;
end $$;

create function pg_temp.review(
  p_actor uuid, p_recovery uuid, p_assignment uuid, p_revision bigint,
  p_reason text, p_corrections jsonb default '[]'::jsonb)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act_as(p_actor);
  execute 'set local role authenticated';
  begin
    v := public.admin_review_session_assignment(
           p_recovery, p_assignment, p_revision, p_reason, p_corrections);
  exception when others then execute 'reset role'; raise; end;
  execute 'reset role';
  return v;
end $$;

-- Returns the SQLSTATE/message of a rejected call instead of aborting the test.
create function pg_temp.fails(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  execute 'reset role';
  return 'NO-ERROR';
exception when others then
  execute 'reset role';
  return sqlerrm;
end $$;

-- ---------------------------------------------------------
-- Fixture: one company with an admin and four employees, one foreign company.
-- ---------------------------------------------------------
insert into auth.users(instance_id,id,aud,role,email,raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','e1000000-0000-0000-0000-0000000000a0','authenticated','authenticated','swr-admin@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','e1000000-0000-0000-0000-0000000000a1','authenticated','authenticated','swr-e1@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','e1000000-0000-0000-0000-0000000000a2','authenticated','authenticated','swr-e2@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','e1000000-0000-0000-0000-0000000000a3','authenticated','authenticated','swr-e3@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','e1000000-0000-0000-0000-0000000000a4','authenticated','authenticated','swr-e4@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','e1000000-0000-0000-0000-0000000000a5','authenticated','authenticated','swr-e5@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','e1000000-0000-0000-0000-0000000000b0','authenticated','authenticated','swr-admin-b@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','e1000000-0000-0000-0000-0000000000b1','authenticated','authenticated','swr-e-b@test.invalid','{}');

insert into public.companies(id,name,slug,timezone) values
 ('e2000000-0000-0000-0000-0000000000c1','SWR Company A','swr-company-a','Europe/Berlin'),
 ('e2000000-0000-0000-0000-0000000000c2','SWR Company B','swr-company-b','Europe/Berlin');

insert into public.profiles(id,full_name,role,company_id,is_active) values
 ('e1000000-0000-0000-0000-0000000000a0','SWR Admin','admin','e2000000-0000-0000-0000-0000000000c1',true),
 ('e1000000-0000-0000-0000-0000000000a1','SWR E1','employee','e2000000-0000-0000-0000-0000000000c1',true),
 ('e1000000-0000-0000-0000-0000000000a2','SWR E2','employee','e2000000-0000-0000-0000-0000000000c1',true),
 ('e1000000-0000-0000-0000-0000000000a3','SWR E3','employee','e2000000-0000-0000-0000-0000000000c1',true),
 ('e1000000-0000-0000-0000-0000000000a4','SWR E4','employee','e2000000-0000-0000-0000-0000000000c1',true),
 ('e1000000-0000-0000-0000-0000000000a5','SWR E5','employee','e2000000-0000-0000-0000-0000000000c1',true),
 ('e1000000-0000-0000-0000-0000000000b0','SWR Admin B','admin','e2000000-0000-0000-0000-0000000000c2',true),
 ('e1000000-0000-0000-0000-0000000000b1','SWR EB','employee','e2000000-0000-0000-0000-0000000000c2',true)
on conflict (id) do update set full_name=excluded.full_name, role=excluded.role,
 company_id=excluded.company_id, is_active=excluded.is_active;

-- FIXTURE builder: a sessions-mode assignment with directly inserted sessions.
create function pg_temp.mk_fixture(
  p_job uuid, p_assignment_out uuid, p_employee uuid, p_started timestamptz,
  p_sessions jsonb, p_company uuid default 'e2000000-0000-0000-0000-0000000000c1',
  p_admin uuid default 'e1000000-0000-0000-0000-0000000000a0')
returns uuid language plpgsql as $$
declare v_assignment uuid; v_item jsonb;
begin
  insert into public.jobs(id,company_id,created_by,customer_name,service_name,
    location_address,status,job_type,date,start_time,is_active,started_at,started_by)
  values(p_job,p_company,p_admin,'SWR Fixture','Cleaning','Fixture Road','in_progress',
    'single',(p_started at time zone 'Europe/Berlin')::date,'08:00',true,p_started,p_employee);
  insert into public.job_assignments(id,job_id,employee_id,employee_name_snapshot)
  values(p_assignment_out,p_job,p_employee,'SWR Fixture') returning id into v_assignment;

  perform set_config('taskops.work_session_rpc','on',true);
  update public.job_assignments set time_tracking_mode='sessions' where id=v_assignment;
  update public.job_assignments set employee_started_at=p_started, attendance='started'
    where id=v_assignment;
  for v_item in select * from jsonb_array_elements(p_sessions) loop
    insert into public.work_sessions(id,job_assignment_id,employee_id,started_at,ended_at)
    values((v_item->>'id')::uuid, v_assignment, p_employee,
           (v_item->>'started_at')::timestamptz,
           nullif(v_item->>'ended_at','')::timestamptz);
  end loop;
  perform set_config('taskops.work_session_rpc','off',true);
  return v_assignment;
end $$;

-- =========================================================
-- FIXTURE BLOCK 1 — the 26:00 -> 8:30 correction
-- =========================================================
do $$
declare
  v_assignment uuid;
  v_before jsonb; v_after jsonb;
  v_res jsonb; v_eff numeric; v_minutes int;
  v_admin uuid := 'e1000000-0000-0000-0000-0000000000a0';
  v_session uuid := 'e4000000-0000-0000-0000-000000000001';
  v_start timestamptz := timestamptz '2026-03-02 08:00+01';
begin
  v_assignment := pg_temp.mk_fixture(
    'e3000000-0000-0000-0000-000000000001','e5000000-0000-0000-0000-000000000001',
    'e1000000-0000-0000-0000-0000000000a1', v_start,
    jsonb_build_array(jsonb_build_object(
      'id', v_session, 'started_at', v_start,
      'ended_at', v_start + interval '26 hours')));

  select to_jsonb(ws.*) into v_before from public.work_sessions ws where ws.id=v_session;

  v_res := pg_temp.review(v_admin,'e6000000-0000-0000-0000-000000000001',v_assignment,
    (select work_revision from public.job_assignments where id=v_assignment),
    'Mitarbeiter hat vergessen, den Auftrag zu beenden.',
    jsonb_build_array(jsonb_build_object(
      'session_id', v_session, 'operation','reduce',
      'effective_ended_at', v_start + interval '8 hours 30 minutes')));

  select to_jsonb(ws.*) into v_after from public.work_sessions ws where ws.id=v_session;

  perform pg_temp.check('FIXTURE 26h raw row byte-identical after reduction',
    v_before = v_after, v_after::text);

  v_eff := (v_res->>'effective_seconds')::numeric;
  v_minutes := round(v_eff/60);
  perform pg_temp.check('FIXTURE 26:00 raw -> 8:30 effective = 510 payroll minutes',
    v_minutes = 510, 'minutes='||v_minutes::text);
  perform pg_temp.check('FIXTURE recorded_seconds still reports the raw 26 hours',
    (v_res->>'recorded_seconds')::numeric = 93600, v_res->>'recorded_seconds');
  perform pg_temp.check('FIXTURE correction_seconds = -17:30',
    (v_res->>'correction_seconds')::numeric = -63000, v_res->>'correction_seconds');
  perform pg_temp.check('FIXTURE delta_seconds stored as -63000',
    (select delta_seconds from public.session_time_corrections
      where work_session_id=v_session and revision_no=1) = -63000);
  perform pg_temp.check('FIXTURE origin admin_reduced with raw end preserved',
    (select origin='admin_reduced' and raw_ended_at = v_start + interval '26 hours'
     from public.session_time_corrections where work_session_id=v_session and revision_no=1));
  perform pg_temp.check('FIXTURE employee_completed_at = final effective end (never now())',
    (select employee_completed_at from public.job_assignments where id=v_assignment)
      = v_start + interval '8 hours 30 minutes');
  perform pg_temp.check('FIXTURE employee_started_at unchanged by review',
    (select employee_started_at from public.job_assignments where id=v_assignment) = v_start);
  perform pg_temp.check('FIXTURE review clears work_review_required and completes attendance',
    (select not work_review_required and attendance='completed' and time_tracking_mode='sessions'
     from public.job_assignments where id=v_assignment));
  perform pg_temp.check('FIXTURE parent job completed by the only assignee',
    (select status='completed' from public.jobs where id='e3000000-0000-0000-0000-000000000001'));
  perform pg_temp.check('FIXTURE exactly one job_completed event',
    (select count(*)=1 from public.notification_outbox
      where job_id='e3000000-0000-0000-0000-000000000001' and event_type='job_completed'));
  perform pg_temp.check('FIXTURE effective never exceeds recorded (no fabricated minutes)',
    (v_res->>'effective_seconds')::numeric <= (v_res->>'recorded_seconds')::numeric);
end $$;

-- =========================================================
-- FIXTURE BLOCK 2 — append-only, idempotency, reduce/raise chain
-- =========================================================
do $$
declare
  v_assignment uuid; v_res jsonb; v_msg text; v_rev bigint;
  v_admin uuid := 'e1000000-0000-0000-0000-0000000000a0';
  v_session uuid := 'e4000000-0000-0000-0000-000000000002';
  v_start timestamptz := timestamptz '2026-03-03 08:00+01';
  v_corr uuid;
begin
  v_assignment := pg_temp.mk_fixture(
    'e3000000-0000-0000-0000-000000000002','e5000000-0000-0000-0000-000000000002',
    'e1000000-0000-0000-0000-0000000000a2', v_start,
    jsonb_build_array(jsonb_build_object(
      'id', v_session, 'started_at', v_start,
      'ended_at', v_start + interval '26 hours')));
  v_rev := (select work_revision from public.job_assignments where id=v_assignment);

  -- revision 1: reduce to 16:00 (08:00 + 8h)
  v_res := pg_temp.review(v_admin,'e6000000-0000-0000-0000-000000000002',v_assignment,v_rev,
    'Kunde bestaetigt Arbeitsende 16:00 Uhr.',
    jsonb_build_array(jsonb_build_object('session_id',v_session,'operation','reduce',
      'effective_ended_at', v_start + interval '8 hours')));
  perform pg_temp.check('FIXTURE revision 1 stored',
    (select count(*)=1 from public.session_time_corrections where work_session_id=v_session));

  -- append-only: the audit event itself can never be edited or removed
  v_msg := pg_temp.fails(format(
    'update public.session_time_corrections set reason=''tampered'' where work_session_id=%L', v_session));
  perform pg_temp.check('FIXTURE correction UPDATE rejected (append-only)',
    v_msg like '%append-only%', v_msg);
  v_msg := pg_temp.fails(format(
    'delete from public.session_time_corrections where work_session_id=%L', v_session));
  perform pg_temp.check('FIXTURE correction DELETE rejected (append-only)',
    v_msg like '%append-only%', v_msg);

  -- idempotency: same id + same payload returns the same logical result
  v_res := pg_temp.review(v_admin,'e6000000-0000-0000-0000-000000000002',v_assignment,v_rev,
    'Kunde bestaetigt Arbeitsende 16:00 Uhr.',
    jsonb_build_array(jsonb_build_object('session_id',v_session,'operation','reduce',
      'effective_ended_at', v_start + interval '8 hours')));
  perform pg_temp.check('FIXTURE replay of same recovery id writes no second correction',
    (select count(*)=1 from public.session_time_corrections where work_session_id=v_session));
  perform pg_temp.check('FIXTURE replay returns the stored result',
    (v_res->>'assignment_state')='completed');

  -- same id, different payload
  v_msg := pg_temp.fails(format(
    'select pg_temp.review(%L,%L,%L,%s,%L,%L::jsonb)', v_admin,
    'e6000000-0000-0000-0000-000000000002', v_assignment, v_rev,
    'Ein voellig anderer Grund fuer dieselbe Anfrage.', '[]'));
  perform pg_temp.check('FIXTURE same recovery id + different payload rejected',
    v_msg like '%different request%', v_msg);
end $$;

-- =========================================================
-- FIXTURE BLOCK 3 — reduce may not increase; raise is explicit and capped
-- =========================================================
do $$
declare
  v_assignment uuid; v_msg text; v_rev bigint; v_res jsonb;
  v_admin uuid := 'e1000000-0000-0000-0000-0000000000a0';
  v_session uuid := 'e4000000-0000-0000-0000-000000000003';
  v_start timestamptz := timestamptz '2026-03-04 08:00+01';
begin
  v_assignment := pg_temp.mk_fixture(
    'e3000000-0000-0000-0000-000000000003','e5000000-0000-0000-0000-000000000003',
    'e1000000-0000-0000-0000-0000000000a3', v_start,
    jsonb_build_array(jsonb_build_object(
      'id', v_session, 'started_at', v_start,
      'ended_at', v_start + interval '26 hours')));
  v_rev := (select work_revision from public.job_assignments where id=v_assignment);

  -- Reduce to 16:00, then a *reduce* attempt at 16:30 must be refused even
  -- though 16:30 is still far below the raw end. This is the hole a bare
  -- "effective <= raw" ceiling would have left open.
  perform set_config('taskops.work_session_rpc','off',true);
  insert into public.session_time_corrections(
    correction_id, work_session_id, job_assignment_id, job_id, employee_id,
    revision_no, origin, raw_started_at, raw_ended_at, raw_duration_seconds,
    effective_ended_at, effective_duration_seconds, performed_by, reason)
  values(gen_random_uuid(), v_session, v_assignment,
    'e3000000-0000-0000-0000-000000000003','e1000000-0000-0000-0000-0000000000a3',
    1,'admin_reduced', v_start, v_start + interval '26 hours', 93600,
    v_start + interval '8 hours', 28800, v_admin,
    'Erste Korrektur auf 16:00 Uhr durch Administrator.');

  v_msg := pg_temp.fails(format(
    'select pg_temp.review(%L,%L,%L,%s,%L,%L::jsonb)', v_admin,
    'e6000000-0000-0000-0000-000000000003', v_assignment, v_rev,
    'Korrektur auf 16:30 Uhr nach Ruecksprache.',
    jsonb_build_array(jsonb_build_object('session_id',v_session,'operation','reduce',
      'effective_ended_at', v_start + interval '8 hours 30 minutes'))::text));
  perform pg_temp.check('FIXTURE reduce cannot increase 16:00 -> 16:30',
    v_msg like '%must not increase%', v_msg);

  -- A raise with a short reason is refused.
  v_msg := pg_temp.fails(format(
    'select pg_temp.review(%L,%L,%L,%s,%L,%L::jsonb)', v_admin,
    'e6000000-0000-0000-0000-000000000004', v_assignment, v_rev,
    'Zu niedrig.',
    jsonb_build_array(jsonb_build_object('session_id',v_session,'operation','raise',
      'effective_ended_at', v_start + interval '8 hours 30 minutes'))::text));
  perform pg_temp.check('FIXTURE raise with reason under 30 characters rejected',
    v_msg like '%at least 30 characters%' or v_msg like '%at least 10 characters%', v_msg);

  -- A raise above the employee-recorded end is refused even with a long reason.
  v_msg := pg_temp.fails(format(
    'select pg_temp.review(%L,%L,%L,%s,%L,%L::jsonb)', v_admin,
    'e6000000-0000-0000-0000-000000000005', v_assignment, v_rev,
    'Erste Korrektur war zu niedrig angesetzt; Kunde bestaetigt ein spaeteres Arbeitsende.',
    jsonb_build_array(jsonb_build_object('session_id',v_session,'operation','raise',
      'effective_ended_at', v_start + interval '27 hours'))::text));
  perform pg_temp.check('FIXTURE raise above the employee-recorded end rejected',
    v_msg like '%ceiling%', v_msg);

  -- The legitimate raise succeeds and is separately audited.
  v_res := pg_temp.review(v_admin,'e6000000-0000-0000-0000-000000000006',v_assignment,v_rev,
    'Erste Korrektur war zu niedrig angesetzt; Kunde bestaetigt Arbeitsende 16:30 Uhr.',
    jsonb_build_array(jsonb_build_object('session_id',v_session,'operation','raise',
      'effective_ended_at', v_start + interval '8 hours 30 minutes')));
  perform pg_temp.check('FIXTURE explicit raise 16:00 -> 16:30 accepted inside the ceiling',
    (select origin='admin_raised' and revision_no=2
     from public.session_time_corrections
     where work_session_id=v_session order by revision_no desc limit 1));
  perform pg_temp.check('FIXTURE raise leaves revision 1 untouched (chain intact)',
    (select count(*)=2 from public.session_time_corrections where work_session_id=v_session));
  perform pg_temp.check('FIXTURE effective total follows the highest revision',
    round(((v_res->>'effective_seconds')::numeric)/60) = 510,
    v_res->>'effective_seconds');
end $$;

-- =========================================================
-- FIXTURE BLOCK 4 — open forgotten session closed by the admin
-- =========================================================
do $$
declare
  v_assignment uuid; v_res jsonb; v_msg text;
  v_admin uuid := 'e1000000-0000-0000-0000-0000000000a0';
  v_session uuid := 'e4000000-0000-0000-0000-000000000004';
  v_start timestamptz := now() - interval '30 hours';
begin
  v_assignment := pg_temp.mk_fixture(
    'e3000000-0000-0000-0000-000000000004','e5000000-0000-0000-0000-000000000004',
    'e1000000-0000-0000-0000-0000000000a4', v_start,
    jsonb_build_array(jsonb_build_object(
      'id', v_session, 'started_at', v_start, 'ended_at', '')));

  perform pg_temp.check('FIXTURE open session is discoverable in the recovery queue with flag false',
    (select not work_review_required from public.job_assignments where id=v_assignment)
    and exists (select 1 from (
      select * from public.get_work_recovery_queue()) q
      where q.assignment_id=v_assignment and q.reason_code='open_session_expired'),
    (select reason_code from (select * from public.get_work_recovery_queue()) q
      where q.assignment_id=v_assignment));

  -- The reviewed end must stay inside least(now(), start + 12h).
  v_msg := pg_temp.fails(format(
    'select pg_temp.review(%L,%L,%L,%s,%L,%L::jsonb)', v_admin,
    'e6000000-0000-0000-0000-000000000007', v_assignment,
    (select work_revision from public.job_assignments where id=v_assignment),
    'Mitarbeiter hat den Auftrag nicht beendet.',
    jsonb_build_array(jsonb_build_object('session_id',v_session,'operation','reduce',
      'effective_ended_at', v_start + interval '13 hours'))::text));
  perform pg_temp.check('FIXTURE admin_closed ceiling = least(now, start + 12h)',
    v_msg like '%ceiling%', v_msg);

  v_res := pg_temp.review(v_admin,'e6000000-0000-0000-0000-000000000008',v_assignment,
    (select work_revision from public.job_assignments where id=v_assignment),
    'Mitarbeiter hat vergessen zu beenden; Arbeitsende laut Kunde 8:30 nach Beginn.',
    jsonb_build_array(jsonb_build_object('session_id',v_session,'operation','reduce',
      'effective_ended_at', v_start + interval '8 hours 30 minutes')));

  perform pg_temp.check('FIXTURE open session closed exactly once at the reviewed end',
    (select ended_at = v_start + interval '8 hours 30 minutes'
     from public.work_sessions where id=v_session));
  perform pg_temp.check('FIXTURE open-session started_at never rewritten',
    (select started_at = v_start from public.work_sessions where id=v_session));
  perform pg_temp.check('FIXTURE admin_closed records raw_ended_at NULL',
    (select origin='admin_closed' and raw_ended_at is null and raw_duration_seconds is null
     from public.session_time_corrections where work_session_id=v_session and revision_no=1));
  perform pg_temp.check('FIXTURE admin_closed has delta_seconds NULL (no raw duration exists)',
    (select delta_seconds is null from public.session_time_corrections
      where work_session_id=v_session and revision_no=1));
  perform pg_temp.check('FIXTURE admin_closed effective duration = 8:30',
    (select effective_duration_seconds = 30600 from public.session_time_corrections
      where work_session_id=v_session and revision_no=1));
  perform pg_temp.check('FIXTURE resolved assignment leaves no open session',
    not exists(select 1 from public.work_sessions
               where job_assignment_id=v_assignment and ended_at is null));
  perform pg_temp.check('FIXTURE resolved assignment leaves the recovery queue',
    not exists (select 1 from (select * from public.get_work_recovery_queue()) q
                where q.assignment_id=v_assignment));
end $$;

-- =========================================================
-- FIXTURE BLOCK 5 — multi-assignment parent semantics
-- =========================================================
do $$
declare
  v_a1 uuid := 'e5000000-0000-0000-0000-000000000005';
  v_a2 uuid := 'e5000000-0000-0000-0000-000000000006';
  v_job uuid := 'e3000000-0000-0000-0000-000000000005';
  v_admin uuid := 'e1000000-0000-0000-0000-0000000000a0';
  v_start timestamptz := timestamptz '2026-03-05 08:00+01';
  v_res jsonb;
begin
  insert into public.jobs(id,company_id,created_by,customer_name,service_name,
    location_address,status,job_type,date,start_time,is_active,started_at,started_by)
  values(v_job,'e2000000-0000-0000-0000-0000000000c1',v_admin,'SWR Multi','Cleaning',
    'Fixture Road','in_progress','single',(v_start at time zone 'Europe/Berlin')::date,
    '08:00',true,v_start,'e1000000-0000-0000-0000-0000000000a1');
  insert into public.job_assignments(id,job_id,employee_id,employee_name_snapshot) values
   (v_a1,v_job,'e1000000-0000-0000-0000-0000000000a1','SWR E1'),
   (v_a2,v_job,'e1000000-0000-0000-0000-0000000000a2','SWR E2');

  perform set_config('taskops.work_session_rpc','on',true);
  update public.job_assignments set time_tracking_mode='sessions' where id in (v_a1,v_a2);
  update public.job_assignments set employee_started_at=v_start, attendance='started'
    where id in (v_a1,v_a2);
  insert into public.work_sessions(id,job_assignment_id,employee_id,started_at,ended_at) values
   ('e4000000-0000-0000-0000-000000000005',v_a1,'e1000000-0000-0000-0000-0000000000a1',
    v_start, v_start + interval '20 hours'),
   ('e4000000-0000-0000-0000-000000000006',v_a2,'e1000000-0000-0000-0000-0000000000a2',
    v_start, v_start + interval '20 hours');
  perform set_config('taskops.work_session_rpc','off',true);

  v_res := pg_temp.review(v_admin,'e6000000-0000-0000-0000-000000000009',v_a1,
    (select work_revision from public.job_assignments where id=v_a1),
    'Erste Person geprueft; zweite Person noch offen.',
    jsonb_build_array(jsonb_build_object('session_id','e4000000-0000-0000-0000-000000000005',
      'operation','reduce','effective_ended_at', v_start + interval '8 hours')));
  perform pg_temp.check('FIXTURE parent stays in_progress while another assignee is unresolved',
    (select status='in_progress' from public.jobs where id=v_job), v_res->>'job_status');
  perform pg_temp.check('FIXTURE unresolved co-assignee is untouched',
    (select employee_completed_at is null and work_revision=0 from public.job_assignments where id=v_a2));

  v_res := pg_temp.review(v_admin,'e6000000-0000-0000-0000-00000000000a',v_a2,
    (select work_revision from public.job_assignments where id=v_a2),
    'Zweite Person geprueft; Auftrag kann geschlossen werden.',
    jsonb_build_array(jsonb_build_object('session_id','e4000000-0000-0000-0000-000000000006',
      'operation','reduce','effective_ended_at', v_start + interval '9 hours')));
  perform pg_temp.check('FIXTURE final resolved assignee completes the parent',
    (select status='completed' from public.jobs where id=v_job));
  perform pg_temp.check('FIXTURE exactly one job_completed event for the multi-assignment job',
    (select count(*)=1 from public.notification_outbox
      where job_id=v_job and event_type='job_completed'));
end $$;

-- =========================================================
-- FIXTURE BLOCK 6 — parent already force-completed
-- =========================================================
do $$
declare
  v_assignment uuid; v_job uuid := 'e3000000-0000-0000-0000-000000000006';
  v_admin uuid := 'e1000000-0000-0000-0000-0000000000a0';
  v_start timestamptz := timestamptz '2026-03-06 08:00+01';
  v_session uuid := 'e4000000-0000-0000-0000-000000000007';
  v_res jsonb; v_completed_at timestamptz;
begin
  v_assignment := pg_temp.mk_fixture(v_job,'e5000000-0000-0000-0000-000000000007',
    'e1000000-0000-0000-0000-0000000000a3', v_start,
    jsonb_build_array(jsonb_build_object('id',v_session,'started_at',v_start,
      'ended_at', v_start + interval '20 hours')));
  update public.jobs set status='completed', completed_at=v_start + interval '20 hours',
    completed_by=v_admin where id=v_job;
  select completed_at into v_completed_at from public.jobs where id=v_job;

  v_res := pg_temp.review(v_admin,'e6000000-0000-0000-0000-00000000000b',v_assignment,
    (select work_revision from public.job_assignments where id=v_assignment),
    'Auftrag war bereits zwangsweise abgeschlossen; Zeit wird nachtraeglich geprueft.',
    jsonb_build_array(jsonb_build_object('session_id',v_session,'operation','reduce',
      'effective_ended_at', v_start + interval '8 hours')));
  perform pg_temp.check('FIXTURE force-completed parent stays untouched by the review',
    (select status='completed' and completed_at=v_completed_at from public.jobs where id=v_job));
  perform pg_temp.check('FIXTURE no job_completed event emitted for the force-completed parent',
    (select count(*)=0 from public.notification_outbox
      where job_id=v_job and event_type='job_completed'));
  perform pg_temp.check('FIXTURE assignment resolves even on a completed parent',
    (select employee_completed_at is not null and not work_review_required
     from public.job_assignments where id=v_assignment));
end $$;

-- =========================================================
-- FIXTURE BLOCK 7 — cross-midnight and DST use real UTC elapsed time
-- =========================================================
do $$
declare
  v_assignment uuid;
  v_admin uuid := 'e1000000-0000-0000-0000-0000000000a0';
  -- CET -> CEST transition night 2026-03-29: 02:00 local jumps to 03:00.
  v_start timestamptz := timestamptz '2026-03-28 23:50+01';
  v_session uuid := 'e4000000-0000-0000-0000-000000000008';
  v_res jsonb;
begin
  v_assignment := pg_temp.mk_fixture('e3000000-0000-0000-0000-000000000007',
    'e5000000-0000-0000-0000-000000000008','e1000000-0000-0000-0000-0000000000a4', v_start,
    jsonb_build_array(jsonb_build_object('id',v_session,'started_at',v_start,
      'ended_at', v_start + interval '26 hours')));
  v_res := pg_temp.review(v_admin,'e6000000-0000-0000-0000-00000000000c',v_assignment,
    (select work_revision from public.job_assignments where id=v_assignment),
    'Nachtschicht ueber Mitternacht und Zeitumstellung geprueft.',
    jsonb_build_array(jsonb_build_object('session_id',v_session,'operation','reduce',
      'effective_ended_at', v_start + interval '4 hours')));
  -- 23:50 CET + 4h real elapsed = 04:50 CEST on the DST night. The stored
  -- duration must be the real 4 hours, not the 3 wall-clock hours.
  perform pg_temp.check('FIXTURE DST night correction uses real UTC elapsed time',
    (v_res->>'effective_seconds')::numeric = 14400, v_res->>'effective_seconds');
  perform pg_temp.check('FIXTURE cross-midnight correction needs no special case',
    (select (effective_ended_at at time zone 'Europe/Berlin')::date
            > (raw_started_at at time zone 'Europe/Berlin')::date
     from public.session_time_corrections where work_session_id=v_session));
end $$;

-- =========================================================
-- FIXTURE BLOCK 8 — authorization, company isolation, employee privacy
-- =========================================================
do $$
declare
  v_assignment uuid := 'e5000000-0000-0000-0000-000000000001';
  v_msg text;
  v_employee uuid := 'e1000000-0000-0000-0000-0000000000a1';
  v_foreign_admin uuid := 'e1000000-0000-0000-0000-0000000000b0';
  v_admin uuid := 'e1000000-0000-0000-0000-0000000000a0';
  v_admin_total numeric; v_employee_total numeric;
begin
  v_msg := pg_temp.fails(format(
    'select pg_temp.review(%L,%L,%L,0,%L,%L::jsonb)', v_employee,
    'e6000000-0000-0000-0000-00000000000d', v_assignment,
    'Mitarbeiter versucht eine Pruefung durchzufuehren.', '[]'));
  perform pg_temp.check('employee cannot call admin_review_session_assignment',
    v_msg like '%Only admins%', v_msg);

  v_msg := pg_temp.fails(format(
    'select pg_temp.review(%L,%L,%L,0,%L,%L::jsonb)', v_foreign_admin,
    'e6000000-0000-0000-0000-00000000000e', v_assignment,
    'Fremder Administrator versucht eine Pruefung.', '[]'));
  perform pg_temp.check('cross-company admin is refused without leaking existence',
    v_msg like '%not found or not accessible%', v_msg);

  perform pg_temp.act_as(v_employee);
  execute 'set local role authenticated';
  v_msg := pg_temp.fails('select 1 from public.get_session_correction_audit(array['
    || quote_literal(v_assignment) || '::uuid])');
  execute 'reset role';
  perform pg_temp.check('employee cannot call get_session_correction_audit',
    v_msg like '%Only admins%', v_msg);

  perform pg_temp.act_as(v_employee);
  execute 'set local role authenticated';
  perform pg_temp.check('employee direct SELECT on session_time_corrections returns nothing',
    (select count(*)=0 from public.session_time_corrections));
  execute 'reset role';

  perform pg_temp.act_as(v_employee);
  execute 'set local role authenticated';
  v_msg := pg_temp.fails('select 1 from public.get_work_recovery_queue()');
  execute 'reset role';
  perform pg_temp.check('employee cannot call get_work_recovery_queue',
    v_msg like '%Only admins%', v_msg);

  -- ONE payroll truth: the admin and the employee must compute the identical
  -- total from the identical source.
  perform pg_temp.act_as(v_employee);
  execute 'set local role authenticated';
  select coalesce(sum(extract(epoch from s.effective_ended_at - s.effective_started_at)),0)
    into v_employee_total
  from public.get_effective_work_sessions(array[v_assignment]) s;
  execute 'reset role';

  perform pg_temp.act_as(v_admin);
  execute 'set local role authenticated';
  select coalesce(sum(extract(epoch from s.effective_ended_at - s.effective_started_at)),0)
    into v_admin_total
  from public.get_effective_work_sessions(array[v_assignment]) s;
  execute 'reset role';

  perform pg_temp.check('admin total equals employee total for the same assignment',
    v_admin_total = v_employee_total and v_admin_total = 30600,
    'admin='||v_admin_total::text||' employee='||v_employee_total::text);

  perform pg_temp.act_as(v_employee);
  execute 'set local role authenticated';
  perform pg_temp.check('employee sees the neutral reviewed marker, nothing else',
    (select bool_and(s.reviewed) from public.get_effective_work_sessions(array[v_assignment]) s));
  execute 'reset role';

  -- A foreign employee must not reach another company's assignment at all.
  perform pg_temp.act_as('e1000000-0000-0000-0000-0000000000a2');
  execute 'set local role authenticated';
  perform pg_temp.check('employee cannot read another employee''s effective sessions',
    (select count(*)=0 from public.get_effective_work_sessions(array[v_assignment]) s));
  execute 'reset role';
end $$;

-- =========================================================
-- FIXTURE BLOCK 9 — recovery queue precision
-- =========================================================
do $$
declare
  v_healthy uuid; v_stuck_a uuid; v_stuck_b uuid;
  v_recent timestamptz := now() - interval '3 hours';
  v_old    timestamptz := now() - interval '30 hours';
  v_rows int;
begin
  -- Healthy work still inside its own 12-hour window.
  v_healthy := pg_temp.mk_fixture('e3000000-0000-0000-0000-000000000008',
    'e5000000-0000-0000-0000-000000000009','e1000000-0000-0000-0000-0000000000a1', v_recent,
    jsonb_build_array(jsonb_build_object('id','e4000000-0000-0000-0000-000000000009',
      'started_at', v_recent, 'ended_at','')));
  -- Stuck work in the admin's own company.
  v_stuck_a := pg_temp.mk_fixture('e3000000-0000-0000-0000-000000000009',
    'e5000000-0000-0000-0000-00000000000a','e1000000-0000-0000-0000-0000000000a2', v_old,
    jsonb_build_array(jsonb_build_object('id','e4000000-0000-0000-0000-00000000000a',
      'started_at', v_old, 'ended_at','')));
  -- Identically stuck work in a FOREIGN company.
  v_stuck_b := pg_temp.mk_fixture('e3000000-0000-0000-0000-00000000000c',
    'e5000000-0000-0000-0000-00000000000b','e1000000-0000-0000-0000-0000000000b1', v_old,
    jsonb_build_array(jsonb_build_object('id','e4000000-0000-0000-0000-00000000000b',
      'started_at', v_old, 'ended_at','')),
    'e2000000-0000-0000-0000-0000000000c2','e1000000-0000-0000-0000-0000000000b0');

  perform pg_temp.act_as('e1000000-0000-0000-0000-0000000000a0');
  execute 'set local role authenticated';
  select count(*) into v_rows from public.get_work_recovery_queue();
  perform pg_temp.check('healthy 3h active work does NOT appear in the recovery queue',
    not exists (select 1 from (select * from public.get_work_recovery_queue()) q
                where q.assignment_id = v_healthy));
  perform pg_temp.check('stuck own-company work DOES appear in the recovery queue',
    exists (select 1 from (select * from public.get_work_recovery_queue()) q
            where q.assignment_id = v_stuck_a), 'queue rows='||v_rows::text);
  perform pg_temp.check('recovery queue never leaks a foreign company assignment',
    not exists (select 1 from (select * from public.get_work_recovery_queue()) q
                where q.assignment_id = v_stuck_b));
  perform pg_temp.check('every recovery queue row belongs to the caller company',
    (select coalesce(bool_and(exists(select 1 from public.jobs j
       where j.id=q.job_id and j.company_id='e2000000-0000-0000-0000-0000000000c1')), false)
     from (select * from public.get_work_recovery_queue()) q), 'queue rows='||v_rows::text);
  execute 'reset role';
end $$;

-- =========================================================
-- LIVE BLOCK — real RPCs, real current timestamps, >12h lifecycle
-- =========================================================
do $$
declare
  v_job uuid := 'e3000000-0000-0000-0000-00000000000a';
  v_assignment uuid; v_res jsonb; v_msg text;
  v_emp uuid := 'e1000000-0000-0000-0000-0000000000a5';
  v_admin uuid := 'e1000000-0000-0000-0000-0000000000a0';
  v_start timestamptz := now() - interval '11 hours 59 minutes';
begin
  insert into public.jobs(id,company_id,created_by,customer_name,service_name,
    location_address,status,job_type,date,start_time,is_active)
  values(v_job,'e2000000-0000-0000-0000-0000000000c1',v_admin,'SWR Live','Cleaning',
    'Live Road','open','single',(v_start at time zone 'Europe/Berlin')::date,'08:00',true);
  insert into public.job_assignments(job_id,employee_id,employee_name_snapshot)
  values(v_job,v_emp,'SWR E5') returning id into v_assignment;

  v_res := pg_temp.call_work(v_emp,'start','e7000000-0000-0000-0000-000000000001',
    v_assignment,0,'e8000000-0000-0000-0000-000000000001', v_start);
  perform pg_temp.check('LIVE real Start accepted at now-11h59m',
    (v_res->>'assignment_state')='active');

  -- A completion 12h03m after the start no longer raises: it commits a durable
  -- review hand-off, which is what makes the case discoverable at all.
  v_res := pg_temp.call_work(v_emp,'complete','e7000000-0000-0000-0000-000000000002',
    v_assignment,(v_res->>'work_revision')::bigint,
    'e8000000-0000-0000-0000-000000000001', now() + interval '4 minutes');
  perform pg_temp.check('LIVE late Complete returns review_pending instead of raising',
    (v_res->>'assignment_state')='review_pending', v_res::text);
  perform pg_temp.check('LIVE late Complete leaves employee_completed_at NULL',
    (select employee_completed_at is null from public.job_assignments where id=v_assignment));
  perform pg_temp.check('LIVE late Complete sets work_review_required',
    (select work_review_required from public.job_assignments where id=v_assignment));
  perform pg_temp.check('LIVE late Complete does not complete the parent job',
    (select status='in_progress' from public.jobs where id=v_job));
  perform pg_temp.check('LIVE late Complete closed the session as raw evidence',
    (select ended_at is not null from public.work_sessions
      where id='e8000000-0000-0000-0000-000000000001'));
  perform pg_temp.check('LIVE late Complete wrote an operation receipt',
    (select count(*)=1 from public.work_operation_receipts
      where operation_id='e7000000-0000-0000-0000-000000000002'));

  perform pg_temp.act_as(v_admin);
  execute 'set local role authenticated';
  perform pg_temp.check('LIVE late Complete appears in the recovery queue as late_complete',
    exists (select 1 from (select * from public.get_work_recovery_queue()) q
            where q.assignment_id=v_assignment and q.reason_code='late_complete'),
    (select reason_code from (select * from public.get_work_recovery_queue()) q
      where q.assignment_id=v_assignment));
  execute 'reset role';

  -- The trust boundary is untouched: an action timestamp older than 12 hours
  -- is still a hard rejection, because the payload itself is untrusted.
  v_msg := pg_temp.fails(format(
    'select pg_temp.call_work(%L,''complete'',%L,%L,%s,null,%L::timestamptz)',
    v_emp,'e7000000-0000-0000-0000-000000000003', v_assignment,
    (select work_revision from public.job_assignments where id=v_assignment),
    (now() - interval '13 hours')::text));
  perform pg_temp.check('LIVE expired action timestamp still raises (trust boundary intact)',
    v_msg like '%outside the trusted window%', v_msg);

  -- The admin resolves the live case through the real RPC.
  v_res := pg_temp.review(v_admin,'e6000000-0000-0000-0000-00000000000f',v_assignment,
    (select work_revision from public.job_assignments where id=v_assignment),
    'Mitarbeiter hat den Abschluss vergessen; tatsaechliches Arbeitsende geprueft.',
    jsonb_build_array(jsonb_build_object(
      'session_id','e8000000-0000-0000-0000-000000000001','operation','reduce',
      'effective_ended_at', v_start + interval '8 hours')));
  perform pg_temp.check('LIVE admin review resolves the late-Complete assignment',
    (v_res->>'assignment_state')='completed' and (v_res->>'job_status')='completed',
    v_res::text);
  perform pg_temp.check('LIVE reviewed effective total is 8 hours',
    (v_res->>'effective_seconds')::numeric = 28800, v_res->>'effective_seconds');
  perform pg_temp.check('LIVE resolved assignment leaves the recovery queue',
    not exists (select 1 from (select * from public.get_work_recovery_queue()) q
                where q.assignment_id=v_assignment));

  -- A replayed employee operation carrying the pre-review revision must be a
  -- revision conflict, never a silent late success.
  v_msg := pg_temp.fails(format(
    'select pg_temp.call_work(%L,''complete'',%L,%L,0,null,%L::timestamptz)',
    v_emp,'e7000000-0000-0000-0000-000000000004', v_assignment, now()::text));
  perform pg_temp.check('LIVE stale employee replay after review is rejected',
    v_msg like '%Stale work revision%' or v_msg like '%cannot complete%', v_msg);
end $$;

-- =========================================================
-- LIVE BLOCK 2 — late Pause keeps its existing durable behaviour
-- =========================================================
do $$
declare
  v_job uuid := 'e3000000-0000-0000-0000-00000000000b';
  v_assignment uuid; v_res jsonb;
  v_emp uuid := 'e1000000-0000-0000-0000-0000000000a3';
  v_admin uuid := 'e1000000-0000-0000-0000-0000000000a0';
  v_start timestamptz := now() - interval '11 hours 59 minutes';
begin
  insert into public.jobs(id,company_id,created_by,customer_name,service_name,
    location_address,status,job_type,date,start_time,is_active)
  values(v_job,'e2000000-0000-0000-0000-0000000000c1',v_admin,'SWR Live Pause','Cleaning',
    'Live Road','open','single',(v_start at time zone 'Europe/Berlin')::date,'08:00',true);
  insert into public.job_assignments(job_id,employee_id,employee_name_snapshot)
  values(v_job,v_emp,'SWR E3') returning id into v_assignment;

  v_res := pg_temp.call_work(v_emp,'start','e7000000-0000-0000-0000-000000000005',
    v_assignment,0,'e8000000-0000-0000-0000-000000000002', v_start);
  v_res := pg_temp.call_work(v_emp,'pause','e7000000-0000-0000-0000-000000000006',
    v_assignment,(v_res->>'work_revision')::bigint,
    'e8000000-0000-0000-0000-000000000002', now() + interval '4 minutes');
  perform pg_temp.check('LIVE late Pause still sets work_review_required',
    (v_res->>'review_required')::boolean, v_res::text);
  perform pg_temp.act_as(v_admin);
  execute 'set local role authenticated';
  perform pg_temp.check('LIVE late Pause appears in the recovery queue as late_pause',
    exists (select 1 from (select * from public.get_work_recovery_queue()) q
            where q.assignment_id=v_assignment and q.reason_code='late_pause'),
    (select reason_code from (select * from public.get_work_recovery_queue()) q
      where q.assignment_id=v_assignment));
  execute 'reset role';
end $$;

-- =========================================================
-- Verdict
-- =========================================================
select name, ok, detail from _checks order by name;

do $$ declare n int; details text;
begin
  select count(*), string_agg(name||': '||coalesce(detail,''), E'\n  ')
    into n, details from _checks where not ok;
  if n > 0 then
    raise exception 'SESSION WORK RECOVERY: % check(s) FAILED:%  %', n, E'\n', details;
  end if;
  raise notice '% session-work-recovery assertions passed', (select count(*) from _checks);
end $$;

rollback;
