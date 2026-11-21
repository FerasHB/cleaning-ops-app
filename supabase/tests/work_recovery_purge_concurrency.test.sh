#!/usr/bin/env bash
# =========================================================
# TEST: Firmen-Purge gegen gleichzeitige Recovery-Schreibzugriffe
# (Migration 20261121000000, Phase 3 / S1.5)
# =========================================================
# Echte parallele Sessions. Der Purge sperrt companies FOR UPDATE; jedes
# INSERT in work_recovery_* nimmt ueber den FK company_id FOR KEY SHARE auf
# dieselbe Zeile (PostgreSQL-Doku "Conflicting Row-Level Locks").
#   Race A: Fall-INSERT laeuft (uncommittet), Purge startet → Purge wartet,
#           sieht danach den committeten offenen Fall → open_recovery_cases,
#           nichts geloescht.
#   Race B: Purge laeuft (uncommittet), Fall-INSERT startet → INSERT
#           wartet, scheitert nach dem Commit des Purge am FK (23503); keine
#           verwaisten Recovery-Zeilen.
#   Race C: Export bestaetigt, Event-INSERT laeuft (uncommittet), Purge
#           startet → Purge wartet, sieht danach das neue Event →
#           recovery_export_stale, nichts geloescht.
#
# Fixdaten werden committet und im trap entfernt. ID-Raum 7cxxxxxx….
#
# Lokal:
#   bash supabase/tests/work_recovery_purge_concurrency.test.sh
#   DB_CONTAINER=<container> bash … (anderer lokaler Container)
# =========================================================
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-supabase_db_cleaning-employee-app-2}"
psql_c() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

# Firma A (Race A), Firma B (Race B), Firma C (Race C)
CA='7c000000-0000-0000-0000-00000000000a'
CB='7c000000-0000-0000-0000-00000000000b'
CC='7c000000-0000-0000-0000-00000000000c'
AA='7c000000-0000-0000-0000-0000000000a1'; EA='7c000000-0000-0000-0000-0000000000a2'
AB='7c000000-0000-0000-0000-0000000000b1'; EB='7c000000-0000-0000-0000-0000000000b2'
AC='7c000000-0000-0000-0000-0000000000c1'; EC='7c000000-0000-0000-0000-0000000000c2'
JA='7c000000-0000-0000-0001-00000000000a'; JB='7c000000-0000-0000-0001-00000000000b'; JC='7c000000-0000-0000-0001-00000000000c'
GA='7c000000-0000-0000-0002-00000000000a'; GB='7c000000-0000-0000-0002-00000000000b'; GC='7c000000-0000-0000-0002-00000000000c'
KA='7c000000-0000-0000-0003-00000000000a'; KB='7c000000-0000-0000-0003-00000000000b'; KC='7c000000-0000-0000-0003-00000000000c'
USERS="'$AA','$EA','$AB','$EB','$AC','$EC'"
COS="'$CA','$CB','$CC'"

cleanup() {
  psql_c <<SQL >/dev/null 2>&1 || true
begin;
select set_config('taskops.company_purge', 'on', true);
select set_config('app.series_sync', 'on', true);
delete from public.company_deletion_exports where company_id in ($COS);
delete from public.work_recovery_events where company_id in ($COS);
delete from public.work_recovery_action_refs where company_id in ($COS);
delete from public.work_recovery_submissions where company_id in ($COS);
delete from public.work_recovery_cases where company_id in ($COS);
delete from public.notification_deliveries where company_id in ($COS);
delete from public.notification_outbox where company_id in ($COS);
delete from public.jobs where company_id in ($COS);
delete from public.profiles where id in ($USERS);
delete from public.companies where id in ($COS);
delete from auth.users where id in ($USERS);
commit;
SQL
}
trap cleanup EXIT
cleanup

psql_c <<SQL >/dev/null
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','$AA','authenticated','authenticated','wrpc-aa@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$EA','authenticated','authenticated','wrpc-ea@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$AB','authenticated','authenticated','wrpc-ab@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$EB','authenticated','authenticated','wrpc-eb@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$AC','authenticated','authenticated','wrpc-ac@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$EC','authenticated','authenticated','wrpc-ec@x.test','{}');
insert into public.companies (id, name, slug) values
 ('$CA','WRPC A','wrpc-a'), ('$CB','WRPC B','wrpc-b'), ('$CC','WRPC C','wrpc-c');
insert into public.profiles (id, full_name, role, company_id, is_active) values
 ('$AA','WRPC Admin A','admin','$CA',true), ('$EA','WRPC Emp A','employee','$CA',true),
 ('$AB','WRPC Admin B','admin','$CB',true), ('$EB','WRPC Emp B','employee','$CB',true),
 ('$AC','WRPC Admin C','admin','$CC',true), ('$EC','WRPC Emp C','employee','$CC',true)
on conflict (id) do update set full_name=excluded.full_name, role=excluded.role,
  company_id=excluded.company_id, is_active=excluded.is_active;
insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                         status, job_type, date, start_time, is_active) values
 ('$JA','$CA','$AA','K','Reinigung','Weg 1','open','single',current_date,'08:00',true),
 ('$JB','$CB','$AB','K','Reinigung','Weg 2','open','single',current_date,'08:00',true),
 ('$JC','$CC','$AC','K','Reinigung','Weg 3','open','single',current_date,'08:00',true);
insert into public.job_assignments (id, job_id, employee_id, employee_name_snapshot) values
 ('$GA','$JA','$EA','WRPC Emp A'), ('$GB','$JB','$EB','WRPC Emp B'), ('$GC','$JC','$EC','WRPC Emp C');
-- Firma C: entschiedener Fall + aktuelle, bestaetigte Export-Bestaetigung
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source)
values ('$KC','$CC','$JC','$GC','$EC','legacy_queue');
select set_config('taskops.work_recovery_rpc', 'on', false);
update public.work_recovery_cases set state='approved', decided_at=now(), revision=revision+1 where id='$KC';
select set_config('taskops.work_recovery_rpc', '', false);
select set_config('request.jwt.claims', json_build_object('sub','$AC','role','authenticated')::text, false);
select public.acknowledge_company_recovery_export(
  (public.get_company_recovery_export() ->> 'export_id')::uuid);
SQL

PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; PASS=$((PASS+1)); else echo "FAIL  $1 erwartet=$2 ergebnis=$3"; FAIL=$((FAIL+1)); fi; }
# Wartet, bis Session 1 ihren Marker ausgegeben hat (haelt dann die Sperre).
wait_marker() { for _ in $(seq 1 100); do grep -q "$2" "$1" && return 0; sleep 0.1; done; return 1; }
# Beweist eine echte Sperr-Wartezeit: eine andere Session mit passender
# Anfrage steht in pg_stat_activity auf wait_event_type = 'Lock'.
lock_waiter() {
  for _ in $(seq 1 50); do
    n=$(psql_c -c "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid() and query ilike '%$1%'")
    [ "$n" -ge 1 ] && { echo true; return; }
    sleep 0.1
  done
  echo false
}

# Vorbedingung: Firma C waere jetzt loeschbar (Probe im zurueckgerollten Block).
PRE_C=$(psql_c <<SQL 2>&1 || true
begin;
select 'PRE_OK', (public.purge_company_for_last_admin('$AC','$CC') ->> 'company_id') = '$CC';
rollback;
SQL
)
check "Vorbedingung: Firma C mit aktueller Bestaetigung loeschbar" "1" "$(grep -c 'PRE_OK|t' <<<"$PRE_C" || true)"

# ---------------- Race A ----------------
OUT_1=$(mktemp); OUT_2=$(mktemp)
psql_c > "$OUT_1" 2>&1 <<SQL &
begin;
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source)
values ('$KA','$CA','$JA','$GA','$EA','legacy_queue');
select 'A_INSERTED';
select pg_sleep(3);
commit;
SQL
PID=$!
check "A: Session 1 haelt den uncommitteten Fall" "true" "$(wait_marker "$OUT_1" A_INSERTED && echo true || echo false)"
psql_c > "$OUT_2" 2>&1 <<SQL &
select public.purge_company_for_last_admin('$AA','$CA');
SQL
PID2=$!
check "A: Purge wartet auf eine Zeilensperre" "true" "$(lock_waiter purge_company_for_last_admin)"
wait "$PID2" || true
wait "$PID"
check "A: Purge sieht den neuen offenen Fall" "1" "$(grep -c 'open_recovery_cases' "$OUT_2" || true)"
check "A: Firma + Fall + Konten bestehen" "1|1|2" "$(psql_c -c "select concat_ws('|',
  (select count(*) from public.companies where id='$CA'),
  (select count(*) from public.work_recovery_cases where company_id='$CA'),
  (select count(*) from auth.users where id in ('$AA','$EA')))")"
[ "$FAIL" -gt 0 ] && { echo "--- 1"; cat "$OUT_1"; echo "--- 2"; cat "$OUT_2"; }
rm -f "$OUT_1" "$OUT_2"

# ---------------- Race B ----------------
OUT_1=$(mktemp); OUT_2=$(mktemp)
psql_c > "$OUT_1" 2>&1 <<SQL &
begin;
select 'B_PURGED', (public.purge_company_for_last_admin('$AB','$CB') ->> 'company_id') = '$CB';
select pg_sleep(3);
commit;
SQL
PID=$!
check "B: Purge ohne Recovery-Zeilen gelingt (unveraendertes Verhalten)" "true" "$(wait_marker "$OUT_1" 'B_PURGED|t' && echo true || echo false)"
psql_c > "$OUT_2" 2>&1 <<SQL &
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source)
values ('$KB','$CB','$JB','$GB','$EB','legacy_queue');
SQL
PID2=$!
check "B: Fall-INSERT wartet auf eine Zeilensperre" "true" "$(lock_waiter 'insert into public.work_recovery_cases')"
wait "$PID2" || true
wait "$PID"
check "B: Fall-INSERT scheitert am FK" "1" "$(grep -c 'violates foreign key constraint' "$OUT_2" || true)"
check "B: keine verwaisten Recovery-Zeilen, Firma weg" "0|0" "$(psql_c -c "select concat_ws('|',
  (select count(*) from public.work_recovery_cases where company_id='$CB' or id='$KB'),
  (select count(*) from public.companies where id='$CB'))")"
[ "$FAIL" -gt 0 ] && { echo "--- 1"; cat "$OUT_1"; echo "--- 2"; cat "$OUT_2"; }
rm -f "$OUT_1" "$OUT_2"

# ---------------- Race C ----------------
OUT_1=$(mktemp); OUT_2=$(mktemp)
psql_c > "$OUT_1" 2>&1 <<SQL &
begin;
insert into public.work_recovery_events (case_id, company_id, event_type, detail)
values ('$KC','$CC','note_added','{"note":"waehrend des Exports"}');
select 'C_EVENT';
select pg_sleep(3);
commit;
SQL
PID=$!
check "C: Session 1 haelt das uncommittete Event" "true" "$(wait_marker "$OUT_1" C_EVENT && echo true || echo false)"
psql_c > "$OUT_2" 2>&1 <<SQL &
select public.purge_company_for_last_admin('$AC','$CC');
SQL
PID2=$!
check "C: Purge wartet auf eine Zeilensperre" "true" "$(lock_waiter purge_company_for_last_admin)"
wait "$PID2" || true
wait "$PID"
check "C: Purge erkennt veraltete Bestaetigung" "1" "$(grep -c 'recovery_export_stale' "$OUT_2" || true)"
check "C: Firma + Fall + neues Event + Export-Nachweis bestehen" "1|1|1|1" "$(psql_c -c "select concat_ws('|',
  (select count(*) from public.companies where id='$CC'),
  (select count(*) from public.work_recovery_cases where company_id='$CC'),
  (select count(*) from public.work_recovery_events where company_id='$CC'),
  (select count(*) from public.company_deletion_exports where company_id='$CC'))")"
[ "$FAIL" -gt 0 ] && { echo "--- 1"; cat "$OUT_1"; echo "--- 2"; cat "$OUT_2"; }
rm -f "$OUT_1" "$OUT_2"

echo "TESTRESULT work_recovery_purge_concurrency: $PASS / $((PASS+FAIL)) PASS"
[ "$FAIL" -eq 0 ]
