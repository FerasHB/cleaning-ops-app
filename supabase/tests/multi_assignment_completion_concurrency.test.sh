#!/usr/bin/env bash
# =========================================================
# TEST: Gleichzeitiger Abschluss zweier Zugewiesener
# (Migrationen 20261029000000 + 20261030000001)
# =========================================================
# A und B haben denselben Auftrag gestartet. Beide druecken (fast) gleich-
# zeitig "Abschliessen" in zwei echten, parallelen Sessions. Gefahr ohne
# korrekte Sperre: jede Transaktion sieht den Kollegen noch als unfertig,
# keine schliesst den Auftrag, er haengt fuer immer auf in_progress.
# Erwartet:
#   * B wartet auf die Job-Sperre von A (FOR UPDATE in complete_own_job),
#   * danach sieht B den committeten Abschluss von A und schliesst den
#     Auftrag genau einmal,
#   * genau ein job_completed-Event,
#   * jobs.completed_at = spaetester Teilnehmer-Abschluss (hier A, obwohl B
#     den Auftrag schliesst).
#
# Fixdaten werden committet und im trap entfernt. ID-Raum 7axxxxxx….
#
# Lokal:
#   bash supabase/tests/multi_assignment_completion_concurrency.test.sh
#   DB_CONTAINER=<container> bash … (anderer lokaler Container)
# =========================================================
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-supabase_db_cleaning-employee-app-2}"
psql_c() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

CO='7a000000-0000-0000-0000-000000000001'
ADM='7a100000-0000-0000-0000-000000000001'
EA='7a100000-0000-0000-0000-000000000002'
EB='7a100000-0000-0000-0000-000000000003'
JOB='7a200000-0000-0000-0000-000000000001'

cleanup() {
  psql_c <<SQL >/dev/null 2>&1 || true
delete from public.notification_deliveries where company_id = '$CO';
delete from public.notification_outbox where company_id = '$CO';
delete from public.job_assignments where job_id = '$JOB';
delete from public.jobs where id = '$JOB';
delete from public.profiles where id in ('$ADM','$EA','$EB');
delete from public.companies where id = '$CO';
delete from auth.users where id in ('$ADM','$EA','$EB');
SQL
}
trap cleanup EXIT
cleanup

psql_c <<SQL >/dev/null
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','$ADM','authenticated','authenticated','macc-admin@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$EA','authenticated','authenticated','macc-a@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$EB','authenticated','authenticated','macc-b@x.test','{}');
insert into public.companies (id, name, slug, timezone) values ('$CO','MACC Firma','macc-firma-test','Europe/Berlin');
insert into public.profiles (id, full_name, role, company_id, is_active) values
 ('$ADM','MACC Admin','admin','$CO',true),
 ('$EA','MACC A','employee','$CO',true),
 ('$EB','MACC B','employee','$CO',true)
on conflict (id) do update set full_name=excluded.full_name, role=excluded.role,
  company_id=excluded.company_id, is_active=excluded.is_active;
insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                         status, job_type, date, start_time, is_active, started_at, started_by)
values ('$JOB','$CO','$ADM','MACC Kunde','Reinigung','Teststr. 1','in_progress','single',
        (now() at time zone 'Europe/Berlin')::date, '06:00', true, now() - interval '2 hours', '$EA');
insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, attendance, employee_started_at) values
 ('$JOB','$EA','MACC A','started', now() - interval '2 hours'),
 ('$JOB','$EB','MACC B','started', now() - interval '2 hours');
SQL

OUT_A=$(mktemp); OUT_B=$(mktemp)
# A: Abschluss um now()-5min, haelt die Sperre 3 s.
psql_c > "$OUT_A" 2>&1 <<SQL &
begin;
select set_config('request.jwt.claims', json_build_object('sub','$EA','role','authenticated')::text, true);
set local role authenticated;
select 'A_DONE', public.complete_own_job('$JOB', now() - interval '5 minutes') is not null;
reset role;
select pg_sleep(3);
commit;
SQL
PID_A=$!

sleep 1
START_B=$(date +%s)
# B: Abschluss mit FRUEHEREM Zeitstempel (Offline-Sync), laeuft parallel.
psql_c > "$OUT_B" 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', json_build_object('sub','$EB','role','authenticated')::text, true);
set local role authenticated;
select 'B_DONE', public.complete_own_job('$JOB', now() - interval '20 minutes') is not null;
reset role;
commit;
SQL
END_B=$(date +%s)
wait "$PID_A"

STATE=$(psql_c <<SQL
select concat_ws('|',
  j.status,
  j.completed_by = '$EB',
  j.completed_at = (select employee_completed_at from public.job_assignments where job_id='$JOB' and employee_id='$EA'),
  (select count(*) from public.job_assignments where job_id='$JOB' and employee_completed_at is not null),
  (select count(*) from public.notification_outbox where job_id='$JOB' and event_type='job_completed'))
from public.jobs j where j.id = '$JOB';
SQL
)

PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; PASS=$((PASS+1)); else echo "FAIL  $1 erwartet=$2 ergebnis=$3"; FAIL=$((FAIL+1)); fi; }
check "A committet ohne Fehler" "1" "$(grep -c 'A_DONE|t' "$OUT_A" || true)"
check "B committet ohne Fehler" "1" "$(grep -c 'B_DONE|t' "$OUT_B" || true)"
check "B wartet auf die Job-Sperre von A (>= 1 s)" "true" "$([ $((END_B-START_B)) -ge 1 ] && echo true || echo false)"
check "Endzustand: completed | Akteur B | completed_at = A (spaetester) | 2 Abschluesse | 1 Event" \
      "completed|t|t|2|1" "$STATE"

if [ "$FAIL" -gt 0 ]; then echo "--- A"; cat "$OUT_A"; echo "--- B"; cat "$OUT_B"; fi
rm -f "$OUT_A" "$OUT_B"
echo "TESTRESULT multi_assignment_completion_concurrency: $PASS / $((PASS+FAIL)) PASS"
[ "$FAIL" -eq 0 ]
