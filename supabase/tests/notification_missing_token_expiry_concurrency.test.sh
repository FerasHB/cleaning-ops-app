#!/usr/bin/env bash
# =========================================================
# TEST: Parallele Claims mit Missing-Token-Verfall (Migration 20261016000000)
# =========================================================
# Zwei echte, gleichzeitige Sessions rufen claim_notification_deliveries()
# auf (wie Sofort-Trigger + Minuten-Cron + Client-Kick in Produktion).
# Erwartet:
#   * Session B blockiert NICHT (der neue Verfall-Vorlauf nutzt SKIP LOCKED),
#   * keine Delivery wird doppelt geclaimt,
#   * alte Missing-Token-Zeilen enden genau einmal als
#     failed/missing_push_token_expired, keine wird geclaimt,
#   * die junge, sendbare Zeile wird genau einmal geclaimt.
#
# Fixdaten werden committet (zwei Sessions brauchen sichtbare Zeilen) und im
# trap wieder entfernt. Eigener ID-Raum 97xxxxxx….
#
# Lokal:
#   bash supabase/tests/notification_missing_token_expiry_concurrency.test.sh
# =========================================================
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-supabase_db_cleaning-employee-app-2}"
psql_c() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

CO='97000000-0000-0000-0000-000000000001'
ADM='97100000-0000-0000-0000-000000000001'
EMP='97100000-0000-0000-0000-000000000002'

cleanup() {
  psql_c <<SQL >/dev/null || true
delete from public.notification_outbox where company_id = '$CO';
delete from public.profiles where id in ('$ADM','$EMP');
delete from public.companies where id = '$CO';
delete from auth.users where id in ('$ADM','$EMP');
SQL
}
trap cleanup EXIT
cleanup

psql_c <<SQL >/dev/null
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','$ADM','authenticated','authenticated','mtc-a@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','$EMP','authenticated','authenticated','mtc-e@x.test','{}');
insert into public.companies (id, name, slug) values ('$CO','MTC Firma','mtc-firma-test');
insert into public.profiles (id, role, company_id, is_active, expo_push_token, full_name) values
 ('$ADM','admin',   '$CO',true,'ExponentPushToken[mtcA]','Admin MTC'),
 ('$EMP','employee','$CO',true,null,'Mitarbeiter MTC')
on conflict (id) do update set role=excluded.role, company_id=excluded.company_id,
  is_active=excluded.is_active, expo_push_token=excluded.expo_push_token;

-- 2 alte zurückgestellte Missing-Token-Zeilen (Mitarbeiter) + 1 junge sendbare (Admin).
do \$\$
declare o uuid; i int;
begin
  for i in 1..2 loop
    o := public.enqueue_absence_notification('$CO', gen_random_uuid(), 'vacation_approved',
           '$EMP', 'MTC', current_date, current_date, '$EMP');
    update public.notification_deliveries
       set created_at = now() - interval '2 days', next_attempt_at = now() - interval '1 minute',
           last_error = 'missing_push_token'
     where outbox_id = o;
  end loop;
  perform public.enqueue_absence_notification('$CO', gen_random_uuid(), 'vacation_requested',
           '$EMP', 'MTC', current_date, current_date, '$ADM');
end \$\$;
SQL

# Session A: claimt und hält die Sperren 4 s.
OUT_A=$(mktemp); OUT_B=$(mktemp)
psql_c > "$OUT_A" <<SQL &
begin;
select count(*) from public.claim_notification_deliveries('$CO'::uuid, 50, 120);
select pg_sleep(4);
commit;
SQL
PID_A=$!

sleep 1
# Session B: während A die Sperren hält. Darf nicht blockieren (2 s Timeout).
START_B=$(date +%s)
psql_c > "$OUT_B" <<SQL
set statement_timeout = 2000;
select count(*) from public.claim_notification_deliveries('$CO'::uuid, 50, 120);
SQL
END_B=$(date +%s)
wait "$PID_A"

CLAIMED_A=$(grep -E '^[0-9]+$' "$OUT_A" | head -1)
CLAIMED_B=$(grep -E '^[0-9]+$' "$OUT_B" | head -1)
STATE=$(psql_c <<SQL
select concat_ws('|',
  count(*) filter (where status='failed' and last_error='missing_push_token_expired'),
  count(*) filter (where status='processing'),
  max(attempts) filter (where status='processing'),
  count(*) filter (where status='failed' and attempts > 0))
from public.notification_deliveries where company_id = '$CO';
SQL
)

PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; PASS=$((PASS+1)); else echo "FAIL  $1 erwartet=$2 ergebnis=$3"; FAIL=$((FAIL+1)); fi; }
check "Session A claimt nur die junge Zeile" "1" "$CLAIMED_A"
check "Session B claimt nichts doppelt" "0" "$CLAIMED_B"
check "Session B blockiert nicht (< 2 s)" "true" "$([ $((END_B-START_B)) -lt 2 ] && echo true || echo false)"
check "Endzustand: 2 expired | 1 processing | attempts 1 | 0 alte geclaimt" "2|1|1|0" "$STATE"

rm -f "$OUT_A" "$OUT_B"
echo "TESTRESULT notification_missing_token_expiry_concurrency: $PASS / $((PASS+FAIL)) PASS"
[ "$FAIL" -eq 0 ]
