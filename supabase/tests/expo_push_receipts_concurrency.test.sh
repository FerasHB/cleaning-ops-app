#!/usr/bin/env bash
# =========================================================
# TEST: Parallele Receipt-Poller (Migration 20261018000000)
# =========================================================
# Zwei echte, gleichzeitige Sessions rufen claim_receipt_checks() auf (wie
# zwei überlappende poll-push-receipts-Läufe). Erwartet:
#   * Session B blockiert NICHT (FOR UPDATE SKIP LOCKED, auch im 6-h-Vorlauf),
#   * keine Delivery wird von beiden geclaimt,
#   * nach Commit von A verhindert die Lease einen sofortigen Zweit-Claim,
#   * die über 6 h alte Zeile endet genau einmal als unavailable.
#
# Fixdaten werden committet und im trap entfernt. ID-Raum 92xxxxxx….
#
# Lokal:
#   bash supabase/tests/expo_push_receipts_concurrency.test.sh
# =========================================================
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-supabase_db_cleaning-employee-app-2}"
psql_c() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

CO='92000000-0000-0000-0000-000000000001'
EMP='92100000-0000-0000-0000-000000000002'

cleanup() {
  psql_c <<SQL >/dev/null || true
delete from public.notification_outbox where company_id = '$CO';
delete from public.profiles where id = '$EMP';
delete from public.companies where id = '$CO';
delete from auth.users where id = '$EMP';
SQL
}
trap cleanup EXIT
cleanup

psql_c <<SQL >/dev/null
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','$EMP','authenticated','authenticated','eprc-e@x.test','{}');
insert into public.companies (id, name, slug) values ('$CO','EPRC Firma','eprc-firma-test');
insert into public.profiles (id, role, company_id, is_active, expo_push_token, full_name) values
 ('$EMP','employee','$CO',true,'ExponentPushToken[eprc]','Mitarbeiter EPRC')
on conflict (id) do update set role=excluded.role, company_id=excluded.company_id,
  is_active=excluded.is_active, expo_push_token=excluded.expo_push_token;

-- 5 fällige Receipt-Prüfungen + 1 über 6 h alte.
do \$\$
declare o uuid; i int;
begin
  for i in 1..6 loop
    insert into public.notification_outbox (company_id, event_type, employee_id, employee_name, entity_type, entity_id, fanned_out_at)
    values ('$CO', 'vacation_approved', '$EMP', 'EPRC', 'absence', gen_random_uuid(), now())
    returning id into o;
    insert into public.notification_deliveries (outbox_id, company_id, recipient_id, status, attempts, sent_at,
                                                expo_ticket_id, push_token_sha256, receipt_status, next_receipt_check_at)
    values (o, '$CO', '$EMP', 'sent', 1,
            case when i = 6 then now() - interval '7 hours' else now() - interval '20 minutes' end,
            'eprc-ticket-' || i, extensions.digest('ExponentPushToken[eprc]', 'sha256'), 'pending',
            now() - interval '1 minute');
  end loop;
end \$\$;
SQL

OUT_A=$(mktemp); OUT_B=$(mktemp)
psql_c > "$OUT_A" <<SQL &
begin;
select string_agg(c.expo_ticket_id, ',' order by c.expo_ticket_id)
from public.claim_receipt_checks(1000, 120) c
join public.notification_deliveries d on d.id = c.delivery_id
where d.company_id = '$CO';
select pg_sleep(4);
commit;
SQL
PID_A=$!

sleep 1
START_B=$(date +%s)
psql_c > "$OUT_B" <<SQL
set statement_timeout = 2000;
select count(*) from public.claim_receipt_checks(1000, 120) c
join public.notification_deliveries d on d.id = c.delivery_id
where d.company_id = '$CO';
SQL
END_B=$(date +%s)
wait "$PID_A"

CLAIMED_A=$(grep -E '^eprc' "$OUT_A" | head -1)
CLAIMED_B=$(grep -E '^[0-9]+$' "$OUT_B" | head -1)
AFTER=$(psql_c <<SQL
select count(*) from public.claim_receipt_checks(1000, 120) c
join public.notification_deliveries d on d.id = c.delivery_id
where d.company_id = '$CO';
SQL
)
STATE=$(psql_c <<SQL
select concat_ws('|',
  count(*) filter (where receipt_status = 'pending' and receipt_claimed_at is not null),
  count(*) filter (where receipt_status = 'unavailable' and receipt_error = 'max_age_exceeded'),
  count(*) filter (where status = 'sent'))
from public.notification_deliveries where company_id = '$CO';
SQL
)

PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; PASS=$((PASS+1)); else echo "FAIL  $1 erwartet=$2 ergebnis=$3"; FAIL=$((FAIL+1)); fi; }
check "Session A claimt die 5 fälligen" "eprc-ticket-1,eprc-ticket-2,eprc-ticket-3,eprc-ticket-4,eprc-ticket-5" "$CLAIMED_A"
check "Session B claimt nichts doppelt" "0" "$CLAIMED_B"
check "Session B blockiert nicht (< 2 s)" "true" "$([ $((END_B-START_B)) -lt 2 ] && echo true || echo false)"
check "Lease nach Commit: kein sofortiger Zweit-Claim" "0" "$AFTER"
check "Endzustand: 5 geleast | 1 unavailable | 6 status sent" "5|1|6" "$STATE"

rm -f "$OUT_A" "$OUT_B"
echo "TESTRESULT expo_push_receipts_concurrency: $PASS / $((PASS+FAIL)) PASS"
[ "$FAIL" -eq 0 ]
