-- =====================================================================
-- Expo-Push-Receipts (F2): F3-Monitoring-Erweiterung H10–H15
-- =====================================================================
--
-- Erst anwenden, wenn poll-push-receipts deployt und der Poller-Cron
-- (20261018000001) aktiv ist — sonst meldet H15 sofort critical.
--
-- notification_health(p_as_of) — unverändert H1–H9, außer:
--   H5 schließt zusätzlich die Receipt-Poller-Requests
--      (notification_receipt_poll_requests) aus der Dispatcher-Gesundheit aus.
-- NEU (Fehlerklassen getrennt):
--   H10 h10_receipt_backlog              pending-Receipt überfällig >15 min ⇒ warning, >60 min ⇒ critical  [Infrastruktur]
--   H11 h11_receipt_unavailable          unavailable in 24 h ≥1 ⇒ warning, ≥5 ⇒ critical                  [Provider]
--   H12 h12_receipt_device_not_registered Receipt-DeviceNotRegistered in 24 h ≥3 ⇒ warning, ≥10 ⇒ critical [Token]
--   H13 h13_push_credentials             InvalidCredentials/MismatchSenderId in 24 h ≥1 ⇒ critical        [Konfiguration]
--   H14 h14_receipt_other_errors         sonstige Receipt-Fehler ≥1/24 h ⇒ warning, ≥5/1 h ⇒ critical      [Provider]
--   H15 h15_receipt_poller               letzte Poller-HTTP-200 >15 min ⇒ warning, >30 min/keine ⇒ critical [Infrastruktur]
--   Zeitbasis H11–H14: receipt_checked_at (Zeitpunkt der Verbuchung).
--
-- purge_monitoring_history(): zusätzlich notification_receipt_poll_requests
--   älter als 7 Tage (pg_net hält Antworten ohnehin nur 6 h).
--
-- ROLLBACK: notification_health und purge_monitoring_history mit den
--   Definitionen aus 20261017000000 neu anlegen.
-- =====================================================================

create or replace function public.notification_health(p_as_of timestamptz default now())
returns table (check_key text, level text, value numeric, detail jsonb)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_a        int;
  v_b        int;
  v_c        int;
  v_ts       timestamptz;
  v_jobid    bigint;
  v_active   boolean;
  v_last3    int[];
  v_by_error jsonb;
begin
  -- H1a — überfällige pending-Zeilen (Dispatcher holt fällige Zeilen nicht ab)
  select count(*) filter (where d.next_attempt_at <= p_as_of - interval '3 minutes'),
         count(*) filter (where d.next_attempt_at <= p_as_of - interval '10 minutes'),
         min(d.next_attempt_at)
    into v_a, v_b, v_ts
  from public.notification_deliveries d
  where d.status = 'pending'
    and d.created_at <= p_as_of;

  check_key := 'h1_pending_overdue';
  level     := case when v_b > 0 then 'critical' when v_a > 0 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object(
                 'overdue_3m', v_a, 'overdue_10m', v_b,
                 'max_overdue_min',
                 round((extract(epoch from greatest(p_as_of - v_ts, interval '0')) / 60)::numeric, 1));
  return next;

  -- H1b — ältestes pending OHNE Missing-Token-Zurückstellung
  select count(*), min(d.created_at) into v_a, v_ts
  from public.notification_deliveries d
  where d.status = 'pending'
    and d.last_error is distinct from 'missing_push_token'
    and d.created_at <= p_as_of;

  check_key := 'h1_pending_oldest';
  level     := case
                 when v_ts <= p_as_of - interval '60 minutes' then 'critical'
                 when v_ts <= p_as_of - interval '20 minutes' then 'warning'
                 else 'ok' end;
  value     := round((extract(epoch from (p_as_of - v_ts)) / 60)::numeric, 1);
  detail    := jsonb_build_object('pending', v_a, 'oldest_age_min', value);
  return next;

  -- H2a — wartet auf Push-Token (verfällt nach 24 h, F1)
  select count(*), min(d.created_at) into v_a, v_ts
  from public.notification_deliveries d
  where d.status = 'pending'
    and d.last_error = 'missing_push_token'
    and d.created_at <= p_as_of;

  check_key := 'h2_missing_token_waiting';
  level     := case when v_ts <= p_as_of - interval '20 hours' then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object(
                 'waiting', v_a,
                 'oldest_age_h', round((extract(epoch from (p_as_of - v_ts)) / 3600)::numeric, 1));
  return next;

  -- H2b — verfallene Missing-Token-Zeilen (Verfall ≈ created_at + 24 h)
  select count(*) into v_a
  from public.notification_deliveries d
  where d.status = 'failed'
    and d.last_error = 'missing_push_token_expired'
    and d.created_at >  p_as_of - interval '48 hours'
    and d.created_at <= p_as_of;

  check_key := 'h2_missing_token_expired';
  level     := case when v_a >= 3 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object('expired_recent', v_a);
  return next;

  -- H3a — DeviceNotRegistered (Token ungültig, App deinstalliert)
  select count(*) into v_a
  from public.notification_deliveries d
  where d.status = 'failed'
    and d.last_error = 'DeviceNotRegistered'
    and coalesce(d.claimed_at, d.created_at) >  p_as_of - interval '24 hours'
    and coalesce(d.claimed_at, d.created_at) <= p_as_of;

  check_key := 'h3_device_not_registered';
  level     := case when v_a >= 10 then 'critical' when v_a >= 3 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object('failed_24h', v_a);
  return next;

  -- H3b — alle anderen Fehlschläge (max attempts, Provider, nicht routbar …)
  select count(*),
         count(*) filter (where coalesce(d.claimed_at, d.created_at) > p_as_of - interval '1 hour')
    into v_a, v_b
  from public.notification_deliveries d
  where d.status = 'failed'
    and d.last_error is distinct from 'DeviceNotRegistered'
    and d.last_error is distinct from 'missing_push_token_expired'
    and coalesce(d.claimed_at, d.created_at) >  p_as_of - interval '24 hours'
    and coalesce(d.claimed_at, d.created_at) <= p_as_of;

  select coalesce(jsonb_object_agg(e.err, e.n), '{}'::jsonb) into v_by_error
  from (
    select left(regexp_replace(coalesce(d.last_error, '<null>'),
                               'Expo(nent)?PushToken\[[^]]*\]', 'ExponentPushToken[…]', 'g'), 80) as err,
           count(*) as n
    from public.notification_deliveries d
    where d.status = 'failed'
      and d.last_error is distinct from 'DeviceNotRegistered'
      and d.last_error is distinct from 'missing_push_token_expired'
      and coalesce(d.claimed_at, d.created_at) >  p_as_of - interval '24 hours'
      and coalesce(d.claimed_at, d.created_at) <= p_as_of
    group by 1
    order by 2 desc
    limit 5
  ) e;

  check_key := 'h3_other_failures';
  level     := case when v_b >= 5 then 'critical' when v_a >= 1 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object('failed_24h', v_a, 'failed_1h', v_b, 'by_error', v_by_error);
  return next;

  -- H4 — hängende processing-Zeilen (Reclaim nach 120 s greift nicht)
  select count(*) filter (where d.claimed_at <= p_as_of - interval '5 minutes'),
         count(*) filter (where d.claimed_at <= p_as_of - interval '15 minutes'),
         min(d.claimed_at)
    into v_a, v_b, v_ts
  from public.notification_deliveries d
  where d.status = 'processing'
    and d.claimed_at <= p_as_of;

  check_key := 'h4_processing_stuck';
  level     := case when v_b > 0 then 'critical' when v_a > 0 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object(
                 'stuck_5m', v_a, 'stuck_15m', v_b,
                 'oldest_claim_age_min', round((extract(epoch from (p_as_of - v_ts)) / 60)::numeric, 1));
  return next;

  -- H5 — echte Dispatcher-Antworten (pg_net), ohne eigene Heartbeat-Pings
  select max(h.created) filter (where h.status_code = 200) into v_ts
  from net._http_response h
  where h.created <= p_as_of
    and not exists (
      select 1 from public.notification_health_checks c
      where c.ping_request_id = h.id)
    and not exists (
      select 1 from public.notification_receipt_poll_requests rp
      where rp.request_id = h.id);

  select array_agg(coalesce(x.status_code, 0) order by x.created desc) into v_last3
  from (
    select h.status_code, h.created
    from net._http_response h
    where h.created <= p_as_of
      and not exists (
        select 1 from public.notification_health_checks c
        where c.ping_request_id = h.id)
      and not exists (
        select 1 from public.notification_receipt_poll_requests rp
        where rp.request_id = h.id)
    order by h.created desc
    limit 3
  ) x;

  check_key := 'h5_dispatcher_http';
  level     := case
                 when v_ts is null or v_ts <= p_as_of - interval '10 minutes' then 'critical'
                 when cardinality(v_last3) = 3 and 200 <> all (v_last3) then 'critical'
                 when v_ts <= p_as_of - interval '3 minutes' then 'warning'
                 else 'ok' end;
  value     := round((extract(epoch from (p_as_of - v_ts)) / 60)::numeric, 1);
  detail    := jsonb_build_object('last_200_age_min', value, 'last3_status', to_jsonb(v_last3));
  return next;

  -- H6 — Sweeper-Cron läuft
  select j.jobid, j.active into v_jobid, v_active
  from cron.job j
  where j.jobname = 'notification-dispatch-sweeper';

  v_ts := null;
  if v_jobid is not null then
    select max(r.start_time) into v_ts
    from cron.job_run_details r
    where r.jobid = v_jobid
      and r.status = 'succeeded'
      and r.start_time <= p_as_of;
  end if;

  check_key := 'h6_sweeper_cron';
  level     := case
                 when v_jobid is null or v_active is not true then 'critical'
                 when v_ts is null or v_ts <= p_as_of - interval '10 minutes' then 'critical'
                 when v_ts <= p_as_of - interval '3 minutes' then 'warning'
                 else 'ok' end;
  value     := round((extract(epoch from (p_as_of - v_ts)) / 60)::numeric, 1);
  detail    := jsonb_build_object('job_exists', v_jobid is not null, 'job_active', coalesce(v_active, false),
                                  'last_success_age_min', value);
  return next;

  -- H7 — Outbox-Events ohne vollständige Auffächerung
  select count(*) filter (where o.created_at <= p_as_of - interval '3 minutes'),
         count(*) filter (where o.created_at <= p_as_of - interval '10 minutes'),
         min(o.created_at)
    into v_a, v_b, v_ts
  from public.notification_outbox o
  where o.fanned_out_at is null
    and o.created_at <= p_as_of;

  check_key := 'h7_outbox_unfanned';
  level     := case when v_b > 0 then 'critical' when v_a > 0 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object(
                 'unfanned_3m', v_a, 'unfanned_10m', v_b,
                 'oldest_age_min', round((extract(epoch from (p_as_of - v_ts)) / 60)::numeric, 1));
  return next;

  -- H8 — aktive Profile ohne Push-Token
  select count(*) filter (where p.role = 'employee'),
         count(*) filter (where p.role = 'admin')
    into v_a, v_b
  from public.profiles p
  where p.is_active = true
    and p.expo_push_token is null;

  check_key := 'h8_employees_without_token';
  level     := 'ok';   -- rein informativ
  value     := v_a;
  detail    := jsonb_build_object('employees_without_token', v_a);
  return next;

  check_key := 'h8_admins_without_token';
  level     := case when v_b >= 1 then 'warning' else 'ok' end;
  value     := v_b;
  detail    := jsonb_build_object('admins_without_token', v_b);
  return next;

  -- H9 — mögliche Doppelversände (sent nach mehr als einem Claim)
  select count(*) into v_a
  from public.notification_deliveries d
  where d.status = 'sent'
    and d.attempts > 1
    and d.sent_at >  p_as_of - interval '24 hours'
    and d.sent_at <= p_as_of;

  check_key := 'h9_possible_duplicates';
  level     := case when v_a >= 5 then 'critical' when v_a >= 1 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object('sent_multi_attempt_24h', v_a);
  return next;

  -- H10 — Receipt-Backlog (Poller holt fällige Receipt-Prüfungen nicht ab)
  select count(*) filter (where d.next_receipt_check_at <= p_as_of - interval '15 minutes'),
         count(*) filter (where d.next_receipt_check_at <= p_as_of - interval '60 minutes'),
         count(*)
    into v_a, v_b, v_c
  from public.notification_deliveries d
  where d.receipt_status = 'pending'
    and d.sent_at <= p_as_of;

  check_key := 'h10_receipt_backlog';
  level     := case when v_b > 0 then 'critical' when v_a > 0 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object('pending', v_c, 'overdue_15m', v_a, 'overdue_60m', v_b);
  return next;

  -- H11 — Receipts nie erhalten (receipt_missing / max_age_exceeded)
  select count(*) into v_a
  from public.notification_deliveries d
  where d.receipt_status = 'unavailable'
    and d.receipt_checked_at >  p_as_of - interval '24 hours'
    and d.receipt_checked_at <= p_as_of;

  check_key := 'h11_receipt_unavailable';
  level     := case when v_a >= 5 then 'critical' when v_a >= 1 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object('unavailable_24h', v_a);
  return next;

  -- H12 — Token-Fehler laut Receipt (DeviceNotRegistered)
  select count(*) into v_a
  from public.notification_deliveries d
  where d.receipt_status = 'error'
    and d.receipt_error = 'DeviceNotRegistered'
    and d.receipt_checked_at >  p_as_of - interval '24 hours'
    and d.receipt_checked_at <= p_as_of;

  check_key := 'h12_receipt_device_not_registered';
  level     := case when v_a >= 10 then 'critical' when v_a >= 3 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object('receipt_dnr_24h', v_a);
  return next;

  -- H13 — Push-Zugangsdaten (APNs/FCM) ungültig: Konfigurationsfehler
  select count(*) into v_a
  from public.notification_deliveries d
  where d.receipt_status = 'error'
    and d.receipt_error in ('InvalidCredentials', 'MismatchSenderId')
    and d.receipt_checked_at >  p_as_of - interval '24 hours'
    and d.receipt_checked_at <= p_as_of;

  check_key := 'h13_push_credentials';
  level     := case when v_a >= 1 then 'critical' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object('credential_errors_24h', v_a);
  return next;

  -- H14 — sonstige Receipt-Fehler (MessageTooBig, MessageRateExceeded, unbekannt)
  select count(*),
         count(*) filter (where d.receipt_checked_at > p_as_of - interval '1 hour')
    into v_a, v_b
  from public.notification_deliveries d
  where d.receipt_status = 'error'
    and d.receipt_error is distinct from 'DeviceNotRegistered'
    and d.receipt_error is distinct from 'InvalidCredentials'
    and d.receipt_error is distinct from 'MismatchSenderId'
    and d.receipt_checked_at >  p_as_of - interval '24 hours'
    and d.receipt_checked_at <= p_as_of;

  select coalesce(jsonb_object_agg(e.err, e.n), '{}'::jsonb) into v_by_error
  from (
    select left(coalesce(d.receipt_error, '<null>'), 80) as err, count(*) as n
    from public.notification_deliveries d
    where d.receipt_status = 'error'
      and d.receipt_error is distinct from 'DeviceNotRegistered'
      and d.receipt_error is distinct from 'InvalidCredentials'
      and d.receipt_error is distinct from 'MismatchSenderId'
      and d.receipt_checked_at >  p_as_of - interval '24 hours'
      and d.receipt_checked_at <= p_as_of
    group by 1
    order by 2 desc
    limit 5
  ) e;

  check_key := 'h14_receipt_other_errors';
  level     := case when v_b >= 5 then 'critical' when v_a >= 1 then 'warning' else 'ok' end;
  value     := v_a;
  detail    := jsonb_build_object('errors_24h', v_a, 'errors_1h', v_b, 'by_error', v_by_error);
  return next;

  -- H15 — Receipt-Poller antwortet (nur eigene Poller-Requests)
  select max(h.created) filter (where h.status_code = 200) into v_ts
  from net._http_response h
  join public.notification_receipt_poll_requests rp on rp.request_id = h.id
  where h.created <= p_as_of;

  check_key := 'h15_receipt_poller';
  level     := case
                 when v_ts is null or v_ts <= p_as_of - interval '30 minutes' then 'critical'
                 when v_ts <= p_as_of - interval '15 minutes' then 'warning'
                 else 'ok' end;
  value     := round((extract(epoch from (p_as_of - v_ts)) / 60)::numeric, 1);
  detail    := jsonb_build_object('last_200_age_min', value);
  return next;
end;
$$;

comment on function public.notification_health(timestamptz) is
'Notification-Health (F3 20261017000000, F2-Erweiterung 20261018000002): eine Zeile je '
'Prüfung H1–H15 (check_key, level ok|warning|critical, value, detail ohne '
'personenbezogene Daten). Rein lesend; p_as_of verschiebt den Auswertungszeitpunkt. '
'H5 ohne Heartbeat- und Receipt-Poller-Requests. Nur Service Role.';

revoke all on function public.notification_health(timestamptz) from public, anon, authenticated;
grant execute on function public.notification_health(timestamptz) to service_role;


create or replace function public.purge_monitoring_history(
  p_cron_keep   interval default interval '14 days',
  p_health_keep interval default interval '30 days'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_cron   int;
  v_health int;
begin
  delete from cron.job_run_details r
  where coalesce(r.end_time, r.start_time) < now() - p_cron_keep;
  get diagnostics v_cron = row_count;

  delete from public.notification_health_checks c
  where c.checked_at < now() - p_health_keep;
  get diagnostics v_health = row_count;

  -- Poller-Request-IDs: pg_net hält Antworten nur 6 h, 7 Tage reichen.
  delete from public.notification_receipt_poll_requests rp
  where rp.requested_at < now() - interval '7 days';

  return jsonb_build_object('cron_job_run_details_deleted', v_cron,
                            'notification_health_checks_deleted', v_health);
end;
$$;

comment on function public.purge_monitoring_history(interval, interval) is
'Aufbewahrung (Cron monitoring-history-retention, täglich 03:30 UTC): '
'cron.job_run_details älter als 14 Tage, notification_health_checks älter als 30 Tage, '
'notification_receipt_poll_requests älter als 7 Tage (seit 20261018000002). Nur Service Role.';

revoke all on function public.purge_monitoring_history(interval, interval) from public, anon, authenticated;
grant execute on function public.purge_monitoring_history(interval, interval) to service_role;
