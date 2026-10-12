#!/usr/bin/env bash
# Local-only two-connection races for migration 20261012000000 (recurring horizon).
# Fixtures are committed (races need separate transactions) and removed by the
# cleanup trap. The hard-coded local container prevents remote execution.
set -euo pipefail

container=supabase_db_cleaning-employee-app-2
docker inspect "$container" > /dev/null

test_dir=$(mktemp -d)
psql_local() { docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At "$@"; }

COMPANY=e9100000-0000-0000-0000-000000000001
ADMIN=e9200000-0000-0000-0000-000000000001
EMP_A=e9200000-0000-0000-0000-00000000000a
EMP_B=e9200000-0000-0000-0000-00000000000b
RULE=e9300000-0000-0000-0000-000000000001

cleanup() {
  psql_local > "$test_dir/cleanup.log" 2>&1 <<SQL || { cat "$test_dir/cleanup.log" >&2; exit 1; }
delete from public.jobs where company_id = '$COMPANY' and parent_job_id is not null;
delete from public.jobs where company_id = '$COMPANY';
delete from public.recurring_horizon_runs where started_at >= (select ts from public._rh_race_marker);
drop table if exists public._rh_race_marker;
delete from auth.users where id in ('$ADMIN','$EMP_A','$EMP_B');
delete from public.companies where id = '$COMPANY';
SQL
  rm -rf "$test_dir"
}
trap cleanup EXIT

psql_local > "$test_dir/setup.log" <<SQL
create table public._rh_race_marker as select now() - interval '1 second' as ts;
insert into auth.users(instance_id,id,aud,role,email,raw_user_meta_data) values
('00000000-0000-0000-0000-000000000000','$ADMIN','authenticated','authenticated','rh-race-admin@test.invalid','{}'),
('00000000-0000-0000-0000-000000000000','$EMP_A','authenticated','authenticated','rh-race-a@test.invalid','{}'),
('00000000-0000-0000-0000-000000000000','$EMP_B','authenticated','authenticated','rh-race-b@test.invalid','{}');
insert into public.profiles(id, full_name) values ('$ADMIN','Race Admin'),('$EMP_A','Race A'),('$EMP_B','Race B')
on conflict (id) do nothing;
insert into public.companies(id,name,slug,timezone) values ('$COMPANY','RH Race','rh-race-company','Europe/Berlin');
update public.profiles set company_id='$COMPANY', role='admin',    is_active=true where id='$ADMIN';
update public.profiles set company_id='$COMPANY', role='employee', is_active=true where id in ('$EMP_A','$EMP_B');
insert into public.jobs(id,company_id,created_by,customer_name,service_name,location_address,status,job_type,
  recurring_days,start_time,is_active,assigned_to)
values ('$RULE','$COMPANY','$ADMIN','Race','Reinigung','Straße','open','recurring',
  array['mon','tue','wed','thu','fri','sat','sun'],'06:30',true,'$EMP_A');
insert into public.job_assignments(job_id,employee_id,employee_name_snapshot) values ('$RULE','$EMP_B','Race B')
on conflict do nothing;
select public._materialize_recurring_occurrences('$RULE', current_date + 3);
SQL

reset_horizon() {
  psql_local > /dev/null <<SQL
update public.recurring_rule_horizons set generated_through = current_date + 3 where parent_job_id = '$RULE';
SQL
}

assert_clean() {
  local label=$1
  local out
  out=$(psql_local <<SQL
select
  (select count(*) from (select occurrence_date from public.jobs where parent_job_id='$RULE'
     group by 1 having count(*) > 1) d)
  || '/' ||
  (select count(*) from (select ja.job_id, ja.employee_id from public.job_assignments ja
     join public.jobs j on j.id = ja.job_id where j.parent_job_id='$RULE'
     group by 1,2 having count(*) > 1) d)
  || '/' ||
  (select count(*) from public.jobs j where j.parent_job_id='$RULE' and j.occurrence_date >= current_date
     and (select count(*) from public.job_assignments ja where ja.job_id=j.id) <> 2)
  || '/' ||
  (select count(*) from public.jobs where parent_job_id='$RULE' and occurrence_date >= current_date);
SQL
)
  local dup_slots dup_assign wrong_assign n
  IFS=/ read -r dup_slots dup_assign wrong_assign n <<< "$out"
  if [[ "$dup_slots" != 0 || "$dup_assign" != 0 || "$wrong_assign" != 0 || "$n" -lt 84 ]]; then
    echo "FAIL $label: dup_slots=$dup_slots dup_assignments=$dup_assign wrong_assignment_sets=$wrong_assign future_rows=$n" >&2
    exit 1
  fi
  echo "ok   $label: dup_slots=0 dup_assignments=0 wrong_assignment_sets=0 future_rows=$n"
}

# ── Race 1: two core calls on the same rule ─────────────────────────────
# A holds the rule lock inside an open transaction; B must wait, then add 0.
reset_horizon
psql_local > "$test_dir/r1a.log" 2>&1 <<SQL &
begin;
select set_config('app.horizon_worker','on',true);
select 'A_inserted=' || public._materialize_recurring_occurrences('$RULE', (now() at time zone 'Europe/Berlin')::date + 90);
select pg_sleep(2);
commit;
SQL
pid_a=$!
sleep 0.7
b_out=$(psql_local <<SQL
select set_config('app.horizon_worker','on',false);
select 'B_inserted=' || public._materialize_recurring_occurrences('$RULE', (now() at time zone 'Europe/Berlin')::date + 90)
    || '/waited_ms=' || (extract(epoch from clock_timestamp() - statement_timestamp()) * 1000)::int;
SQL
)
wait "$pid_a"
grep -q "A_inserted=[1-9]" "$test_dir/r1a.log" || { cat "$test_dir/r1a.log" >&2; echo "FAIL race1: A inserted nothing" >&2; exit 1; }
grep -q "B_inserted=0" <<< "$b_out" || { echo "FAIL race1: B output: $b_out" >&2; exit 1; }
waited=$(grep -o 'waited_ms=[0-9]*' <<< "$b_out" | cut -d= -f2)
(( waited >= 800 )) || { echo "FAIL race1: B did not wait for the rule lock (waited_ms=$waited)" >&2; exit 1; }
echo "ok   race1: $(grep -o 'A_inserted=[0-9]*' "$test_dir/r1a.log") B_inserted=0 waited_ms=$waited (blocked on rule lock)"
assert_clean race1

# ── Race 2: two worker runs at the same time ────────────────────────────
psql_local > /dev/null <<SQL
-- Wartungs-Löschung (wie PRUNE): keine Tombstones.
select set_config('app.series_sync','on',false);
delete from public.jobs where parent_job_id='$RULE' and occurrence_date > current_date + 3;
SQL
reset_horizon
psql_local > "$test_dir/r2a.log" 2>&1 <<SQL &
begin;
select 'A=' || public.extend_recurring_horizons()::text;
select pg_sleep(2);
commit;
SQL
pid_a=$!
sleep 0.7
b_out=$(psql_local -c "select 'B=' || public.extend_recurring_horizons()::text;")
wait "$pid_a"
grep -q '"skipped_concurrent": true' <<< "$b_out" || { echo "FAIL race2: B output: $b_out" >&2; exit 1; }
grep -q '"errors": 0' "$test_dir/r2a.log" || { cat "$test_dir/r2a.log" >&2; echo "FAIL race2: A errors" >&2; exit 1; }
echo "ok   race2: second worker run skipped_concurrent, first run errors=0"
assert_clean race2

# ── Race 3: worker vs. admin RPC (generate_job_occurrences) ─────────────
psql_local > /dev/null <<SQL
-- Wartungs-Löschung (wie PRUNE): keine Tombstones.
select set_config('app.series_sync','on',false);
delete from public.jobs where parent_job_id='$RULE' and occurrence_date > current_date + 3;
SQL
reset_horizon
psql_local > "$test_dir/r3a.log" 2>&1 <<SQL &
begin;
select 'A=' || public.extend_recurring_horizons()::text;
select pg_sleep(2);
commit;
SQL
pid_a=$!
sleep 0.7
b_out=$(psql_local <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$ADMIN","role":"authenticated"}', true);
set local role authenticated;
select 'B_inserted=' || public.generate_job_occurrences('$RULE');
commit;
SQL
)
wait "$pid_a"
grep -q "B_inserted=" <<< "$b_out" || { echo "FAIL race3: admin RPC output: $b_out" >&2; exit 1; }
grep -q '"errors": 0' "$test_dir/r3a.log" || { cat "$test_dir/r3a.log" >&2; echo "FAIL race3: worker errors" >&2; exit 1; }
echo "ok   race3: worker errors=0, admin RPC $(grep -o 'B_inserted=[0-9]*' <<< "$b_out") after waiting"
assert_clean race3

echo "RECURRING HORIZON CONCURRENCY: all races ok"
