#!/usr/bin/env bash
# Local-only two-connection race. Fixtures are committed (the race needs two
# separate transactions) and removed again by the targeted cleanup trap below.
# The cleanup touches ONLY this test's fixture IDs and restores the previous
# pause_resume_enabled value; it never resets the whole database.
#
#   bash supabase/tests/pause_resume_concurrency.test.sh
#   DB_CONTAINER=<container> bash … (another local container)
set -euo pipefail

# Only a local Docker container is ever targeted (docker exec), never a
# remote database URL.
container="${DB_CONTAINER:-supabase_db_cleaning-employee-app-2}"
docker inspect "$container" > /dev/null
psql_local() { docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }

test_dir=$(mktemp -d)
# Capture the flag before the test flips it, so cleanup can put it back.
previous_flag=$(psql_local -Atc "select coalesce((select value::text from public.app_config where key='pause_resume_enabled'), 'false')")

remove_fixtures() {
  # taskops.company_purge is the sanctioned purge path that lets recorded
  # work sessions be deleted (see guard_work_session_write); it is
  # transaction-local and limited to the fixture rows deleted here.
  psql_local -q <<SQL
begin;
set local taskops.company_purge = 'on';
delete from public.work_sessions where employee_id='c2000000-0000-0000-0000-000000000002';
delete from public.work_operation_receipts where job_assignment_id in (
  select id from public.job_assignments
  where job_id in ('c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000002'));
delete from public.notification_deliveries where company_id='c1000000-0000-0000-0000-000000000001';
delete from public.notification_outbox where company_id='c1000000-0000-0000-0000-000000000001';
delete from public.job_assignments
  where job_id in ('c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000002');
delete from public.jobs
  where id in ('c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000002');
delete from public.profiles
  where id in ('c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002');
delete from public.companies where id='c1000000-0000-0000-0000-000000000001';
delete from auth.users
  where id in ('c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002');
update public.app_config set value='${previous_flag}'::jsonb where key='pause_resume_enabled';
commit;
SQL
}

cleanup() {
  remove_fixtures > "$test_dir/cleanup.log" 2>&1 || {
    cat "$test_dir/cleanup.log" >&2
    exit 1
  }
  rm -rf "$test_dir"
}
trap cleanup EXIT
# Leftovers from an interrupted earlier run would break the inserts below.
remove_fixtures > "$test_dir/precleanup.log" 2>&1

psql_local > "$test_dir/setup.log" <<'SQL'
insert into auth.users(instance_id,id,aud,role,email,raw_user_meta_data) values
('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000001','authenticated','authenticated','race-admin@test.invalid','{}'),
('00000000-0000-0000-0000-000000000000','c2000000-0000-0000-0000-000000000002','authenticated','authenticated','race-employee@test.invalid','{}');
insert into public.companies(id,name,slug,timezone) values
('c1000000-0000-0000-0000-000000000001','Race Company','pr-race-company','Europe/Berlin');
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001',role='admin',is_active=true
where id='c2000000-0000-0000-0000-000000000001';
update public.profiles set company_id='c1000000-0000-0000-0000-000000000001',role='employee',is_active=true
where id='c2000000-0000-0000-0000-000000000002';
insert into public.jobs(id,company_id,created_by,customer_name,service_name,location_address,
 status,job_type,date,start_time,is_active) values
('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
 'c2000000-0000-0000-0000-000000000001','Race A','Cleaning','Street','open','single',
 (now() at time zone 'Europe/Berlin')::date,'08:00',true),
('c3000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001',
 'c2000000-0000-0000-0000-000000000001','Race B','Cleaning','Street','open','single',
 (now() at time zone 'Europe/Berlin')::date,'08:00',true);
insert into public.job_assignments(job_id,employee_id,employee_name_snapshot) values
('c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002','Race employee'),
('c3000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000002','Race employee');
update public.app_config set value='true'::jsonb where key='pause_resume_enabled';
SQL

# Client A holds its transaction open after Start. Client B races on a
# different job for the same employee and must wait, then reject.
psql_local > "$test_dir/a.log" 2>&1 <<'SQL' &
begin;
select set_config('request.jwt.claims','{"sub":"c2000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select public.start_own_job_v2('c4000000-0000-0000-0000-000000000001',
 (select id from public.job_assignments where job_id='c3000000-0000-0000-0000-000000000001'),
 0,'c5000000-0000-0000-0000-000000000001',now());
select 'A_HAS_STARTED' as marker;
select pg_sleep(2);
commit;
SQL
pid_a=$!
for _ in {1..100}; do
  if grep -q A_HAS_STARTED "$test_dir/a.log"; then break; fi
  sleep 0.05
done
if ! grep -q A_HAS_STARTED "$test_dir/a.log"; then
  cat "$test_dir/a.log" >&2
  exit 1
fi

set +e
psql_local > "$test_dir/b.log" 2>&1 <<'SQL'
begin;
select set_config('request.jwt.claims','{"sub":"c2000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select public.start_own_job_v2('c4000000-0000-0000-0000-000000000002',
 (select id from public.job_assignments where job_id='c3000000-0000-0000-0000-000000000002'),
 0,'c5000000-0000-0000-0000-000000000002',now());
commit;
SQL
status_b=$?
wait "$pid_a"
status_a=$?
set -e
if [[ "$status_a" -ne 0 || "$status_b" -eq 0 ]]; then
  cat "$test_dir/a.log" "$test_dir/b.log" >&2
  exit 1
fi
if ! grep -q 'Finish or pause the other active work first' "$test_dir/b.log"; then
  cat "$test_dir/b.log" >&2
  exit 1
fi

answer=$(psql_local -Atc \
 "select count(*)::text || ':' || count(*) filter (where ended_at is null)::text from public.work_sessions where employee_id='c2000000-0000-0000-0000-000000000002'")
if [[ "$answer" != '1:1' ]]; then
  printf 'Unexpected session count: %s\n' "$answer" >&2
  exit 1
fi
printf 'PASS independent two-device Start race: one active session, second rejected\n'
