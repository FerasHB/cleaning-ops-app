#!/usr/bin/env bash
# =========================================================
# TEST: Zuweisungs-Abgleich gegen gleichzeitige Fall-Anlage + Sperr-Vertrag
# (Migration 20261122000000, Phase 3 / S1.6)
# =========================================================
# Echte parallele Sessions.
#   Race 1 (compat): Fall-INSERT auf Emils Zuweisung laeuft (uncommittet,
#          haelt ueber den FK FOR KEY SHARE auf der Zuweisung). Ein
#          Alt-Client setzt assigned_to → der Abgleich wartet auf seiner
#          Kandidaten-Sperre (FOR UPDATE), sieht danach den Fall und
#          UEBERSPRINGT Emil. Kein 22023-Abbruch, Fall + Zuweisung bleiben.
#   Race 2 (compat): Abgleich laeuft (uncommittet, hat Emils Zuweisung
#          geloescht), Fall-INSERT startet → wartet, scheitert nach dem
#          Commit am FK (23503). Kein verwaister Fall.
#   Race 3 (PRUNE): Fall-INSERT auf einen Termin laeuft (uncommittet), Admin
#          entfernt den Wochentag → update_job_occurrences wartet, laesst den
#          Fall-Termin stehen und loescht die uebrigen Termine des Wochentags.
#   Race 4 (Sperr-Vertrag): _lock_company_for_recovery_write haelt die
#          Firma (FOR KEY SHARE). Ein normales Firmen-Update laeuft trotzdem
#          sofort durch (lock_timeout 2s); der Firmen-Purge wartet und gelingt
#          erst nach dem Commit.
#
# Fixdaten werden committet und im trap entfernt. ID-Raum 72xxxxxx….
#
# Lokal:
#   bash supabase/tests/work_recovery_sync_guards_concurrency.test.sh
#   DB_CONTAINER=<container> bash … (anderer lokaler Container)
# =========================================================
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-supabase_db_cleaning-employee-app-2}"
psql_c() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

CA='72000000-0000-0000-0000-00000000000a'   # Firma A (Races 1–3)
CD='72000000-0000-0000-0000-00000000000d'   # Firma D (Race 4, wird geloescht)
AA='72000000-0000-0000-0000-0000000000a1'
E1='72000000-0000-0000-0000-0000000000a2'   # Emil
E2='72000000-0000-0000-0000-0000000000a3'   # Zora
E3='72000000-0000-0000-0000-0000000000a4'   # Ida
AD='72000000-0000-0000-0000-0000000000d1'
J1='72000000-0000-0000-0001-000000000001'   # Einzelauftrag Race 1
J2='72000000-0000-0000-0001-000000000002'   # Einzelauftrag Race 2
RR='72000000-0000-0000-0001-000000000010'   # Regel Race 3
K1='72000000-0000-0000-0003-000000000001'
K2='72000000-0000-0000-0003-000000000002'
K3='72000000-0000-0000-0003-000000000003'
USERS="'$AA','$E1','$E2','$E3','$AD'"
COS="'$CA','$CD'"
CLAIMS_A="{\"sub\":\"$AA\",\"role\":\"authenticated\"}"

cleanup() {
  psql_c <<SQL >/dev/null 2>&1 || true
begin;
select set_config('taskops.company_purge', 'on', true);
select set_config('app.series_sync', 'on', true);
delete from public.work_recovery_events where company_id in ($COS);
delete from public.work_recovery_cases where company_id in ($COS);
delete from public.notification_deliveries where company_id in ($COS);
delete from public.notification_outbox where company_id in ($COS);
delete from public.jobs where company_id in ($COS) and parent_job_id is not null;
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
 ('00000000-0000-0000-0000-000000000000','$AA','authenticated','authenticated','sgc-aa@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$E1','authenticated','authenticated','sgc-e1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$E2','authenticated','authenticated','sgc-e2@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$E3','authenticated','authenticated','sgc-e3@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$AD','authenticated','authenticated','sgc-ad@x.test','{}');
insert into public.companies (id, name, slug) values ('$CA','SGC A','sgc-a'), ('$CD','SGC D','sgc-d');
insert into public.profiles (id, full_name, role, company_id, is_active) values
 ('$AA','SGC Admin','admin','$CA',true), ('$E1','Emil','employee','$CA',true),
 ('$E2','Zora','employee','$CA',true),   ('$E3','Ida','employee','$CA',true),
 ('$AD','SGC Admin D','admin','$CD',true)
on conflict (id) do update set full_name=excluded.full_name, role=excluded.role,
  company_id=excluded.company_id, is_active=excluded.is_active;
insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                         status, job_type, date, start_time, is_active) values
 ('$J1','$CA','$AA','K','Reinigung','Weg 1','open','single',current_date + 7,'08:00',true),
 ('$J2','$CA','$AA','K','Reinigung','Weg 2','open','single',current_date + 7,'08:00',true);
insert into public.jobs (id, company_id, created_by, customer_name, service_name, location_address,
                         status, job_type, recurring_days, start_time, recurrence_start_date, is_active)
values ('$RR','$CA','$AA','K','Reinigung','Weg 3','open','recurring',
        array['mon','tue','wed','thu','fri','sat','sun'],'08:00',current_date + 7,true);
select set_config('request.jwt.claims', '$CLAIMS_A', false);
select public.set_job_assignments('$J1', array['$E1','$E2']::uuid[]);
select public.set_job_assignments('$J2', array['$E1','$E2']::uuid[]);
select public.set_job_assignments('$RR', array['$E1','$E2']::uuid[]);
select public.generate_job_occurrences('$RR');
-- Wochentag des ersten Termins (heute+7) aus der Regel nehmen; der Abgleich
-- laeuft erst in Race 3.
update public.jobs
   set recurring_days = array_remove(recurring_days,
         (array['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from current_date + 7)::int])
 where id = '$RR';
SQL

GA1=$(psql_c -c "select id from public.job_assignments where job_id='$J1' and employee_id='$E1'")
GA2=$(psql_c -c "select id from public.job_assignments where job_id='$J2' and employee_id='$E1'")
OCC=$(psql_c -c "select id from public.jobs where parent_job_id='$RR' and occurrence_date=current_date + 7")
GA3=$(psql_c -c "select id from public.job_assignments where job_id='$OCC' and employee_id='$E1'")

PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; PASS=$((PASS+1)); else echo "FAIL  $1 erwartet=$2 ergebnis=$3"; FAIL=$((FAIL+1)); fi; }
wait_marker() { for _ in $(seq 1 100); do grep -q "$2" "$1" && return 0; sleep 0.1; done; return 1; }
lock_waiter() {
  for _ in $(seq 1 50); do
    n=$(psql_c -c "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid() and query ilike '%$1%'")
    [ "$n" -ge 1 ] && { echo true; return; }
    sleep 0.1
  done
  echo false
}

check "Vorbedingung: Zuweisungen + Termin vorhanden" "true" \
  "$([ -n "$GA1" ] && [ -n "$GA2" ] && [ -n "$OCC" ] && [ -n "$GA3" ] && echo true || echo false)"

# ---------------- Race 1: Fall zuerst, dann Alt-Client-Abgleich ----------------
OUT_1=$(mktemp); OUT_2=$(mktemp)
psql_c > "$OUT_1" 2>&1 <<SQL &
begin;
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source)
values ('$K1','$CA','$J1','$GA1','$E1','legacy_queue');
select 'R1_INSERTED';
select pg_sleep(3);
commit;
SQL
PID=$!
check "1: Session 1 haelt den uncommitteten Fall" "true" "$(wait_marker "$OUT_1" R1_INSERTED && echo true || echo false)"
psql_c > "$OUT_2" 2>&1 <<SQL &
update public.jobs set assigned_to = '$E3' where id = '$J1';
select 'R1_SYNC_OK';
SQL
PID2=$!
check "1: Abgleich wartet auf eine Zeilensperre" "true" "$(lock_waiter "update public.jobs set assigned_to")"
wait "$PID2" || true
wait "$PID"
check "1: Abgleich ohne Fehler (Emil uebersprungen statt 22023)" "1|0" \
  "$(grep -c 'R1_SYNC_OK' "$OUT_2" || true)|$(grep -c 'ERROR' "$OUT_2" || true)"
check "1: Emil (Fall) bleibt, Zora entfernt, Ida neu; Fall vorhanden" "Emil,Ida|1" "$(psql_c -c "select concat_ws('|',
  (select string_agg(p.full_name, ',' order by p.full_name) from public.job_assignments ja
     join public.profiles p on p.id = ja.employee_id where ja.job_id = '$J1'),
  (select count(*) from public.work_recovery_cases where id = '$K1' and assignment_id = '$GA1'))")"
[ "$FAIL" -gt 0 ] && { echo "--- 1"; cat "$OUT_1"; echo "--- 2"; cat "$OUT_2"; }
rm -f "$OUT_1" "$OUT_2"

# ---------------- Race 2: Abgleich zuerst, dann Fall-INSERT ----------------
OUT_1=$(mktemp); OUT_2=$(mktemp)
psql_c > "$OUT_1" 2>&1 <<SQL &
begin;
update public.jobs set assigned_to = '$E3' where id = '$J2';
select 'R2_SYNCED', count(*) from public.job_assignments where id = '$GA2';
select pg_sleep(3);
commit;
SQL
PID=$!
check "2: Abgleich hat Emil (ohne Fall) uncommittet entfernt" "true" "$(wait_marker "$OUT_1" 'R2_SYNCED|0' && echo true || echo false)"
psql_c > "$OUT_2" 2>&1 <<SQL &
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source)
values ('$K2','$CA','$J2','$GA2','$E1','legacy_queue');
SQL
PID2=$!
check "2: Fall-INSERT wartet auf eine Zeilensperre" "true" "$(lock_waiter 'insert into public.work_recovery_cases')"
wait "$PID2" || true
wait "$PID"
check "2: Fall-INSERT scheitert am FK" "1" "$(grep -c 'violates foreign key constraint' "$OUT_2" || true)"
check "2: kein verwaister Fall, Menge Ida,Zora->Ida" "0|Ida" "$(psql_c -c "select concat_ws('|',
  (select count(*) from public.work_recovery_cases where id = '$K2'),
  (select string_agg(p.full_name, ',' order by p.full_name) from public.job_assignments ja
     join public.profiles p on p.id = ja.employee_id where ja.job_id = '$J2'))")"
[ "$FAIL" -gt 0 ] && { echo "--- 1"; cat "$OUT_1"; echo "--- 2"; cat "$OUT_2"; }
rm -f "$OUT_1" "$OUT_2"

# ---------------- Race 3: Fall-INSERT auf Termin, dann PRUNE ----------------
BEFORE_DOW=$(psql_c -c "select count(*) from public.jobs where parent_job_id='$RR'
  and extract(isodow from occurrence_date) = extract(isodow from current_date + 7)")
OUT_1=$(mktemp); OUT_2=$(mktemp)
psql_c > "$OUT_1" 2>&1 <<SQL &
begin;
insert into public.work_recovery_cases (id, company_id, job_id, assignment_id, employee_id, source)
values ('$K3','$CA','$OCC','$GA3','$E1','legacy_queue');
select 'R3_INSERTED';
select pg_sleep(3);
commit;
SQL
PID=$!
check "3: Session 1 haelt den uncommitteten Fall" "true" "$(wait_marker "$OUT_1" R3_INSERTED && echo true || echo false)"
psql_c > "$OUT_2" 2>&1 <<SQL &
select set_config('request.jwt.claims', '$CLAIMS_A', false);
select 'R3_PRUNE_OK', public.update_job_occurrences('$RR') >= 0;
SQL
PID2=$!
check "3: PRUNE wartet auf eine Zeilensperre" "true" "$(lock_waiter update_job_occurrences)"
wait "$PID2" || true
wait "$PID"
check "3: PRUNE ohne Fehler" "1|0" "$(grep -c 'R3_PRUNE_OK|t' "$OUT_2" || true)|$(grep -c 'ERROR' "$OUT_2" || true)"
check "3: vorher mehrere Termine des Wochentags" "true" "$([ "$BEFORE_DOW" -gt 1 ] && echo true || echo false)"
check "3: nur der Fall-Termin bleibt, Fall + Zuweisung vorhanden" "1|1|1" "$(psql_c -c "select concat_ws('|',
  (select count(*) from public.jobs where parent_job_id='$RR'
     and extract(isodow from occurrence_date) = extract(isodow from current_date + 7)),
  (select count(*) from public.work_recovery_cases where id = '$K3'),
  (select count(*) from public.job_assignments where id = '$GA3'))")"
[ "$FAIL" -gt 0 ] && { echo "--- 1"; cat "$OUT_1"; echo "--- 2"; cat "$OUT_2"; }
rm -f "$OUT_1" "$OUT_2"

# ---------------- Race 4: Sperr-Vertrag (FOR KEY SHARE) ----------------
OUT_1=$(mktemp); OUT_2=$(mktemp); OUT_3=$(mktemp)
psql_c > "$OUT_1" 2>&1 <<SQL &
begin;
select public._lock_company_for_recovery_write('$CD');
select 'R4_LOCKED';
select pg_sleep(3);
commit;
SQL
PID=$!
check "4: Session 1 haelt die Firmen-Sperre" "true" "$(wait_marker "$OUT_1" R4_LOCKED && echo true || echo false)"
psql_c > "$OUT_3" 2>&1 <<SQL || true
set lock_timeout = '2s';
update public.companies set name = 'SGC D umbenannt' where id = '$CD';
select 'R4_UPDATE_OK';
SQL
check "4: normales Firmen-Update blockiert NICHT" "1" "$(grep -c 'R4_UPDATE_OK' "$OUT_3" || true)"
psql_c > "$OUT_2" 2>&1 <<SQL &
select 'R4_PURGED', (public.purge_company_for_last_admin('$AD','$CD') ->> 'company_id') = '$CD';
SQL
PID2=$!
check "4: Purge wartet auf die Firmen-Sperre" "true" "$(lock_waiter purge_company_for_last_admin)"
wait "$PID2" || true
wait "$PID"
check "4: Purge gelingt nach dem Commit (Firma ohne Recovery-Daten)" "1|0" \
  "$(grep -c 'R4_PURGED|t' "$OUT_2" || true)|$(psql_c -c "select count(*) from public.companies where id='$CD'")"
[ "$FAIL" -gt 0 ] && { echo "--- 1"; cat "$OUT_1"; echo "--- 2"; cat "$OUT_2"; echo "--- 3"; cat "$OUT_3"; }
rm -f "$OUT_1" "$OUT_2" "$OUT_3"

echo "TESTRESULT work_recovery_sync_guards_concurrency: $PASS / $((PASS+FAIL)) PASS"
[ "$FAIL" -eq 0 ]
