-- =========================================================
-- TEST: Notification-Monitoring (Migration 20261017000000)
-- =========================================================
-- Prüft notification_health() (H1–H9 inkl. Schwellen), das Gesamtlevel,
-- run_notification_health_check() (Levelwechsel, Heartbeat-Semantik) und
-- purge_monitoring_history().
--
-- Deterministisch, ohne echte Cron-Jobs anzuhalten:
--   * Auswertung zu T = now() + 1 Tag (p_as_of). Echte Cron-/pg_net-Zeilen
--     liegen dann ≥1 Tag zurück; die Prüfungen sehen nur die synthetischen
--     Zeilen, die relativ zu T angelegt werden.
--   * Innerhalb der Transaktion werden Outbox/Deliveries/Prüfprotokoll
--     geleert und fehlende Push-Tokens aktiver Profile aufgefüllt (sauberer
--     Grundzustand). Alles wird zurückgerollt.
--   * Heartbeat: Vault-Secret wird nur innerhalb der Transaktion angelegt;
--     der eingereihte pg_net-Request wird mit zurückgerollt (pg_net liest
--     nur committete Queue-Zeilen) — es verlässt kein Request die DB.
--
-- Lokal:
--   docker exec -i supabase_db_cleaning-employee-app-2 psql -U postgres \
--     -d postgres -v ON_ERROR_STOP=1 < supabase/tests/notification_health_monitoring.test.sql
-- =========================================================

begin;

create temporary table _t (t timestamptz) on commit drop;
insert into _t values (now() + interval '1 day');

create temporary table _r (case_no text, beschreibung text, erwartet text, ergebnis text) on commit drop;

-- ── Sauberer Grundzustand (zurückgerollt) ──
delete from public.notification_outbox;          -- kaskadiert auf notification_deliveries
delete from public.notification_deliveries;
delete from public.notification_health_checks;
delete from public.notification_receipt_poll_requests;  -- F2 (20261018000000)
delete from vault.secrets where name = 'monitoring_alert_url';
update public.profiles
   set expo_push_token = 'ExponentPushToken[hc' || left(md5(id::text), 12) || ']'
 where is_active = true and expo_push_token is null;

-- ── Fixdaten: Firma + Admin + Mitarbeiter (ID-Raum 95xxxxxx…) ──
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','95100000-0000-0000-0000-000000000001','authenticated','authenticated','hc-a1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','95100000-0000-0000-0000-000000000002','authenticated','authenticated','hc-e1@x.test','{}');
insert into public.companies (id, name, slug) values
 ('95000000-0000-0000-0000-000000000001','HC Firma','hc-firma-test');
insert into public.profiles (id, role, company_id, is_active, expo_push_token, full_name) values
 ('95100000-0000-0000-0000-000000000001','admin',   '95000000-0000-0000-0000-000000000001',true,'ExponentPushToken[hcA]','Admin HC'),
 ('95100000-0000-0000-0000-000000000002','employee','95000000-0000-0000-0000-000000000001',true,'ExponentPushToken[hcE]','Mitarbeiter HC')
on conflict (id) do update set role=excluded.role, company_id=excluded.company_id,
  is_active=excluded.is_active, expo_push_token=excluded.expo_push_token;

-- Synthetische Delivery (Absence-Event, bereits aufgefächert); Zeiten relativ zu T.
create function pg_temp.d(
  p_status text, p_created interval, p_next interval default null,
  p_claimed interval default null, p_sent interval default null,
  p_attempts int default 1, p_err text default null, p_fanned boolean default true
) returns void language plpgsql as $$
declare v_t timestamptz := (select t from _t); v_o uuid;
begin
  insert into public.notification_outbox (company_id, job_id, event_type, employee_id, employee_name,
                                          entity_type, entity_id, created_at, fanned_out_at)
  values ('95000000-0000-0000-0000-000000000001', null, 'vacation_approved',
          '95100000-0000-0000-0000-000000000002', 'HC', 'absence', gen_random_uuid(),
          v_t - p_created, case when p_fanned then v_t - p_created end)
  returning id into v_o;
  if p_status is not null then
    insert into public.notification_deliveries (outbox_id, company_id, recipient_id, status, attempts,
                                                created_at, next_attempt_at, claimed_at, sent_at, last_error)
    values (v_o, '95000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000002',
            p_status, p_attempts, v_t - p_created, v_t - coalesce(p_next, p_created),
            v_t - p_claimed, v_t - p_sent, p_err);
  end if;
end $$;

create function pg_temp.reset_d() returns void language sql as $$
  delete from public.notification_outbox where company_id = '95000000-0000-0000-0000-000000000001';
$$;

-- Synthetische Dispatcher-Antwort / Sweeper-Lauf relativ zu T.
create sequence pg_temp.http_id start 9000000001;
create function pg_temp.http(p_code int, p_ago interval) returns bigint language plpgsql as $$
declare v_id bigint := nextval('pg_temp.http_id');
begin
  insert into net._http_response (id, status_code, content, timed_out, created)
  values (v_id, p_code, case when p_code = 200 then '{"mode":"server","claimed":0}' end,
          p_code is null, (select t from _t) - p_ago);
  return v_id;
end $$;
-- F2: synthetische Receipt-Poller-Antwort (H15 gesund halten, aus H5 ausgeschlossen).
create function pg_temp.poller_ok(p_ago interval) returns void language plpgsql as $$
declare v_id bigint := nextval('pg_temp.http_id');
begin
  insert into net._http_response (id, status_code, content, timed_out, created)
  values (v_id, 200, '{"mode":"receipts","claimed":0}', false, (select t from _t) - p_ago);
  insert into public.notification_receipt_poll_requests (request_id, requested_at)
  values (v_id, (select t from _t) - p_ago);
end $$;
create function pg_temp.reset_http() returns void language sql as $$
  delete from net._http_response where created > now() + interval '1 hour';
$$;
-- runid explizit (eigener Bereich): runid_seq gehört supabase_admin.
create sequence pg_temp.cron_runid start 9100000001;
create function pg_temp.cron_ok(p_ago interval) returns void language sql as $$
  insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
  select j.jobid, nextval('pg_temp.cron_runid'), 0, current_database(), 'postgres', 'test', 'succeeded', '1 row',
         (select t from _t) - p_ago, (select t from _t) - p_ago
  from cron.job j where j.jobname = 'notification-dispatch-sweeper';
$$;
create function pg_temp.reset_cron() returns void language sql as $$
  delete from cron.job_run_details where start_time > now() + interval '1 hour';
$$;

-- Level einer Prüfung bzw. Gesamtlevel zu T (+ Offset).
create function pg_temp.lvl(p_key text, p_off interval default '0') returns text language sql as $$
  select h.level from public.notification_health((select t from _t) + p_off) h where h.check_key = p_key;
$$;
create function pg_temp.val(p_key text) returns text language sql as $$
  select coalesce(h.value::text, '<null>') from public.notification_health((select t from _t)) h where h.check_key = p_key;
$$;
create function pg_temp.overall(p_off interval default '0') returns text language sql as $$
  select case when bool_or(level = 'critical') then 'critical'
              when bool_or(level = 'warning') then 'warning' else 'ok' end
  from public.notification_health((select t from _t) + p_off);
$$;
create function pg_temp.r(p_no text, p_desc text, p_exp text, p_got text) returns void language sql as $$
  insert into _r values (p_no, p_desc, p_exp, coalesce(p_got, '<null>'));
$$;

-- Gesunder Grundzustand: Dispatcher-200 und Sweeper-Lauf vor 30 s.
select pg_temp.http(200, '30 seconds');
select pg_temp.cron_ok('30 seconds');
select pg_temp.poller_ok('30 seconds');

-- =========================================================
-- 0 — Grundzustand
-- =========================================================
select pg_temp.r('00', 'Grundzustand: alle 19 Prüfungen ok (H1–H15), Gesamt ok', '19|ok',
  (select count(*) filter (where level = 'ok') || '|' || pg_temp.overall()
     from public.notification_health((select t from _t))));
select pg_temp.r('00b', 'Prüfschlüssel vollständig',
  'h10_receipt_backlog,h11_receipt_unavailable,h12_receipt_device_not_registered,h13_push_credentials,h14_receipt_other_errors,h15_receipt_poller,h1_pending_oldest,h1_pending_overdue,h2_missing_token_expired,h2_missing_token_waiting,h3_device_not_registered,h3_other_failures,h4_processing_stuck,h5_dispatcher_http,h6_sweeper_cron,h7_outbox_unfanned,h8_admins_without_token,h8_employees_without_token,h9_possible_duplicates',
  (select string_agg(check_key, ',' order by check_key collate "C") from public.notification_health((select t from _t))));

-- =========================================================
-- H1 — pending: überfällig / ältestes
-- =========================================================
select pg_temp.d('pending', '2 minutes', p_next => '2 minutes', p_err => 'Expo push HTTP 503');
select pg_temp.r('H1a', 'überfällig 2 min ⇒ ok', 'ok', pg_temp.lvl('h1_pending_overdue'));
select pg_temp.reset_d();
select pg_temp.d('pending', '30 minutes', p_next => '5 minutes', p_err => 'Expo push HTTP 503');
select pg_temp.r('H1b', 'überfällig 5 min ⇒ warning', 'warning', pg_temp.lvl('h1_pending_overdue'));
select pg_temp.r('H1c', 'ältestes pending 30 min ⇒ warning', 'warning', pg_temp.lvl('h1_pending_oldest'));
select pg_temp.reset_d();
select pg_temp.d('pending', '70 minutes', p_next => '12 minutes', p_err => 'Expo push HTTP 503');
select pg_temp.r('H1d', 'überfällig 12 min ⇒ critical', 'critical', pg_temp.lvl('h1_pending_overdue'));
select pg_temp.r('H1e', 'ältestes pending 70 min ⇒ critical', 'critical', pg_temp.lvl('h1_pending_oldest'));
select pg_temp.reset_d();
-- Missing-Token-Zeilen zählen NICHT als "ältestes pending" (eigene Prüfung H2).
select pg_temp.d('pending', '5 hours', p_next => '-3 minutes', p_err => 'missing_push_token');
select pg_temp.r('H1f', 'Missing-Token 5 h alt, nicht überfällig ⇒ H1 ok/ok', 'ok|ok',
  pg_temp.lvl('h1_pending_overdue') || '|' || pg_temp.lvl('h1_pending_oldest'));
select pg_temp.reset_d();

-- =========================================================
-- H2 — Missing-Token
-- =========================================================
select pg_temp.d('pending', '1 hour', p_next => '-4 minutes', p_err => 'missing_push_token');
select pg_temp.r('H2a', 'frische Missing-Token-Zeile ⇒ ok, Anzahl 1', 'ok|1',
  pg_temp.lvl('h2_missing_token_waiting') || '|' || pg_temp.val('h2_missing_token_waiting'));
select pg_temp.reset_d();
select pg_temp.d('pending', '21 hours', p_next => '-4 minutes', p_err => 'missing_push_token');
select pg_temp.r('H2b', 'Missing-Token 21 h ⇒ warning', 'warning', pg_temp.lvl('h2_missing_token_waiting'));
select pg_temp.reset_d();
select pg_temp.d('failed', '30 hours', p_err => 'missing_push_token_expired') from generate_series(1, 2);
select pg_temp.r('H2c', '2 verfallene ⇒ ok', 'ok|2',
  pg_temp.lvl('h2_missing_token_expired') || '|' || pg_temp.val('h2_missing_token_expired'));
select pg_temp.d('failed', '30 hours', p_err => 'missing_push_token_expired');
select pg_temp.r('H2d', '3 verfallene ⇒ warning', 'warning|3',
  pg_temp.lvl('h2_missing_token_expired') || '|' || pg_temp.val('h2_missing_token_expired'));
select pg_temp.reset_d();
select pg_temp.d('failed', '50 hours', p_err => 'missing_push_token_expired') from generate_series(1, 3);
select pg_temp.r('H2e', '3 verfallene, aber Verfall >24 h her ⇒ ok', 'ok', pg_temp.lvl('h2_missing_token_expired'));
select pg_temp.reset_d();

-- =========================================================
-- H3 — Fehlschläge
-- =========================================================
select pg_temp.d('failed', '2 hours', p_claimed => '1 hour', p_err => 'DeviceNotRegistered') from generate_series(1, 2);
select pg_temp.r('H3a', 'DeviceNotRegistered 2/24 h ⇒ ok', 'ok', pg_temp.lvl('h3_device_not_registered'));
select pg_temp.d('failed', '2 hours', p_claimed => '1 hour', p_err => 'DeviceNotRegistered');
select pg_temp.r('H3b', 'DeviceNotRegistered 3/24 h ⇒ warning', 'warning', pg_temp.lvl('h3_device_not_registered'));
select pg_temp.d('failed', '2 hours', p_claimed => '1 hour', p_err => 'DeviceNotRegistered') from generate_series(1, 7);
select pg_temp.r('H3c', 'DeviceNotRegistered 10/24 h ⇒ critical', 'critical', pg_temp.lvl('h3_device_not_registered'));
select pg_temp.reset_d();
select pg_temp.d('failed', '30 hours', p_claimed => '25 hours', p_err => 'DeviceNotRegistered') from generate_series(1, 10);
select pg_temp.r('H3d', 'DeviceNotRegistered 10, aber >24 h her ⇒ ok', 'ok', pg_temp.lvl('h3_device_not_registered'));
select pg_temp.reset_d();
select pg_temp.d('failed', '3 hours', p_claimed => '2 hours', p_err => 'max attempts reached');
select pg_temp.r('H3e', 'sonstiger Fehlschlag 1/24 h ⇒ warning', 'warning', pg_temp.lvl('h3_other_failures'));
select pg_temp.d('failed', '20 minutes', p_claimed => '10 minutes',
                 p_err => '"ExponentPushToken[secretXYZ]" error') from generate_series(1, 5);
select pg_temp.r('H3f', 'sonstige Fehlschläge 5/1 h ⇒ critical', 'critical', pg_temp.lvl('h3_other_failures'));
select pg_temp.r('H3g', 'Push-Token in Fehlertext maskiert', 'false',
  (select (h.detail::text like '%secretXYZ%')::text
     from public.notification_health((select t from _t)) h where h.check_key = 'h3_other_failures'));
select pg_temp.reset_d();
select pg_temp.d('failed', '2 hours', p_claimed => '1 hour', p_err => 'DeviceNotRegistered');
select pg_temp.d('failed', '30 hours', p_err => 'missing_push_token_expired');
select pg_temp.r('H3i', 'nur DNR + verfallene ⇒ H3b ok', 'ok', pg_temp.lvl('h3_other_failures'));
select pg_temp.reset_d();

-- =========================================================
-- H4 — processing
-- =========================================================
select pg_temp.d('processing', '2 minutes', p_claimed => '1 minute');
select pg_temp.r('H4a', 'processing 1 min ⇒ ok', 'ok', pg_temp.lvl('h4_processing_stuck'));
select pg_temp.reset_d();
select pg_temp.d('processing', '7 minutes', p_claimed => '6 minutes');
select pg_temp.r('H4b', 'processing 6 min ⇒ warning', 'warning', pg_temp.lvl('h4_processing_stuck'));
select pg_temp.reset_d();
select pg_temp.d('processing', '17 minutes', p_claimed => '16 minutes');
select pg_temp.r('H4c', 'processing 16 min ⇒ critical', 'critical', pg_temp.lvl('h4_processing_stuck'));
select pg_temp.reset_d();

-- =========================================================
-- H5 — Dispatcher-HTTP (pg_net)
-- =========================================================
select pg_temp.reset_http();
select pg_temp.http(200, '4 minutes');
select pg_temp.r('H5a', 'letzte 200 vor 4 min ⇒ warning', 'warning', pg_temp.lvl('h5_dispatcher_http'));
select pg_temp.reset_http();
select pg_temp.http(200, '11 minutes');
select pg_temp.r('H5b', 'letzte 200 vor 11 min ⇒ critical', 'critical', pg_temp.lvl('h5_dispatcher_http'));
select pg_temp.reset_http();
select pg_temp.r('H5c', 'keine Antwort im Fenster ⇒ critical', 'critical', pg_temp.lvl('h5_dispatcher_http'));
select pg_temp.http(200, '50 seconds');
select pg_temp.http(500, '40 seconds');
select pg_temp.http(503, '30 seconds');
select pg_temp.r('H5d', '200 vor 50 s, danach 2× non-200 ⇒ ok', 'ok', pg_temp.lvl('h5_dispatcher_http'));
select pg_temp.http(null, '10 seconds');   -- Timeout
select pg_temp.r('H5e', '3 jüngste Antworten non-200 (500/503/Timeout) ⇒ critical', 'critical',
  pg_temp.lvl('h5_dispatcher_http'));
select pg_temp.reset_http();
-- Heartbeat-Antworten (eigene Pings) zählen nicht als Dispatcher-Gesundheit.
select pg_temp.http(200, '11 minutes');
insert into public.notification_health_checks (checked_at, overall_level, level_changed, summary, ping_kind, ping_request_id)
values ((select t from _t) - interval '20 seconds', 'ok', false, '{}', 'ok', pg_temp.http(200, '15 seconds'));
select pg_temp.r('H5f', 'nur Heartbeat-200 frisch, Dispatcher-200 vor 11 min ⇒ critical', 'critical',
  pg_temp.lvl('h5_dispatcher_http'));
delete from public.notification_health_checks;
select pg_temp.reset_http();
select pg_temp.http(200, '30 seconds');
select pg_temp.poller_ok('30 seconds');

-- =========================================================
-- H6 — Sweeper-Cron (über p_as_of, ohne echten Cron anzuhalten)
-- =========================================================
select pg_temp.r('H6a', 'Sweeper-Lauf vor 30 s ⇒ ok', 'ok', pg_temp.lvl('h6_sweeper_cron'));
select pg_temp.r('H6b', 'derselbe Lauf, ausgewertet 4 min später ⇒ warning', 'warning',
  pg_temp.lvl('h6_sweeper_cron', interval '210 seconds'));
select pg_temp.r('H6c', 'derselbe Lauf, ausgewertet 11 min später ⇒ critical', 'critical',
  pg_temp.lvl('h6_sweeper_cron', interval '630 seconds'));
select pg_temp.reset_cron();
select pg_temp.r('H6d', 'kein erfolgreicher Lauf im Fenster ⇒ critical', 'critical', pg_temp.lvl('h6_sweeper_cron'));
select pg_temp.cron_ok('30 seconds');

-- =========================================================
-- H7 — nicht aufgefächerte Outbox
-- =========================================================
select pg_temp.d(null, '1 minute', p_fanned => false);
select pg_temp.r('H7a', 'unfanned 1 min ⇒ ok', 'ok', pg_temp.lvl('h7_outbox_unfanned'));
select pg_temp.reset_d();
select pg_temp.d(null, '4 minutes', p_fanned => false);
select pg_temp.r('H7b', 'unfanned 4 min ⇒ warning', 'warning', pg_temp.lvl('h7_outbox_unfanned'));
select pg_temp.reset_d();
select pg_temp.d(null, '11 minutes', p_fanned => false);
select pg_temp.r('H7c', 'unfanned 11 min ⇒ critical', 'critical', pg_temp.lvl('h7_outbox_unfanned'));
select pg_temp.reset_d();

-- =========================================================
-- H8 — Profile ohne Token
-- =========================================================
update public.profiles set expo_push_token = null where id = '95100000-0000-0000-0000-000000000002';
select pg_temp.r('H8a', 'Mitarbeiter ohne Token ⇒ informativ ok, Gesamt ok', 'ok|1|ok|ok',
  pg_temp.lvl('h8_employees_without_token') || '|' || pg_temp.val('h8_employees_without_token') || '|'
  || pg_temp.lvl('h8_admins_without_token') || '|' || pg_temp.overall());
update public.profiles set expo_push_token = null where id = '95100000-0000-0000-0000-000000000001';
select pg_temp.r('H8b', 'aktiver Admin ohne Token ⇒ warning, Gesamt warning', 'warning|warning',
  pg_temp.lvl('h8_admins_without_token') || '|' || pg_temp.overall());
update public.profiles set is_active = false where id = '95100000-0000-0000-0000-000000000001';
select pg_temp.r('H8c', 'inaktiver Admin ohne Token zählt nicht', 'ok', pg_temp.lvl('h8_admins_without_token'));
update public.profiles set is_active = true, expo_push_token = 'ExponentPushToken[hcA]'
 where id = '95100000-0000-0000-0000-000000000001';
update public.profiles set expo_push_token = 'ExponentPushToken[hcE]'
 where id = '95100000-0000-0000-0000-000000000002';

-- =========================================================
-- H9 — mögliche Doppelversände
-- =========================================================
select pg_temp.d('sent', '2 hours', p_claimed => '1 hour', p_sent => '1 hour', p_attempts => 1);
select pg_temp.r('H9a', 'sent mit 1 Versuch ⇒ ok', 'ok', pg_temp.lvl('h9_possible_duplicates'));
select pg_temp.d('sent', '2 hours', p_claimed => '1 hour', p_sent => '1 hour', p_attempts => 2);
select pg_temp.r('H9b', 'sent mit 2 Versuchen ⇒ warning', 'warning', pg_temp.lvl('h9_possible_duplicates'));
select pg_temp.d('sent', '2 hours', p_claimed => '1 hour', p_sent => '1 hour', p_attempts => 2) from generate_series(1, 4);
select pg_temp.r('H9c', '5 Mehrfachversuche ⇒ critical', 'critical', pg_temp.lvl('h9_possible_duplicates'));
select pg_temp.reset_d();
select pg_temp.d('sent', '30 hours', p_claimed => '25 hours', p_sent => '25 hours', p_attempts => 2) from generate_series(1, 5);
select pg_temp.r('H9d', 'Mehrfachversuche >24 h her ⇒ ok', 'ok', pg_temp.lvl('h9_possible_duplicates'));
select pg_temp.reset_d();

-- =========================================================
-- Gesamtlevel — schlechtestes Level gewinnt
-- =========================================================
update public.profiles set expo_push_token = null where id = '95100000-0000-0000-0000-000000000001';
select pg_temp.r('G1', 'nur warning (Admin ohne Token) ⇒ Gesamt warning', 'warning', pg_temp.overall());
select pg_temp.d('processing', '17 minutes', p_claimed => '16 minutes');
select pg_temp.r('G2', 'warning + critical ⇒ Gesamt critical', 'critical', pg_temp.overall());
select pg_temp.reset_d();
update public.profiles set expo_push_token = 'ExponentPushToken[hcA]' where id = '95100000-0000-0000-0000-000000000001';
select pg_temp.r('G3', 'zurück auf ok', 'ok', pg_temp.overall());

-- =========================================================
-- Prüflauf: Levelwechsel + Heartbeat
-- =========================================================
do $$
declare v_t timestamptz := (select t from _t); j jsonb; v_q bigint;
begin
  -- L1: erster Lauf ok ⇒ kein Wechsel, kein Ping (kein Secret)
  j := public.run_notification_health_check(v_t);
  perform pg_temp.r('L1', 'erster Lauf ok: changed false, kein Ping, Zeile geschrieben', 'ok|false|<null>|1',
    concat_ws('|', j->>'overall', j->>'changed', coalesce(j->>'ping_kind','<null>'),
              (select count(*) from public.notification_health_checks)));

  -- L2: critical (processing 16 min) ⇒ Wechsel
  perform pg_temp.d('processing', '17 minutes', p_claimed => '16 minutes');
  -- Dispatcher/Sweeper für T+1 min frisch halten
  perform pg_temp.http(200, '-50 seconds'); perform pg_temp.cron_ok('-50 seconds');
  j := public.run_notification_health_check(v_t + interval '1 minute');
  perform pg_temp.r('L2', 'ok ⇒ critical: changed true, previous ok', 'critical|true|ok',
    concat_ws('|', j->>'overall', j->>'changed', j->>'previous'));

  -- L3: weiterhin critical ⇒ kein Wechsel
  perform pg_temp.http(200, '-110 seconds'); perform pg_temp.cron_ok('-110 seconds');
  j := public.run_notification_health_check(v_t + interval '2 minutes');
  perform pg_temp.r('L3', 'critical ⇒ critical: changed false', 'critical|false',
    concat_ws('|', j->>'overall', j->>'changed'));

  -- L4: Wiederherstellung ⇒ Wechsel
  perform pg_temp.reset_d();
  perform pg_temp.http(200, '-170 seconds'); perform pg_temp.cron_ok('-170 seconds');
  j := public.run_notification_health_check(v_t + interval '3 minutes');
  perform pg_temp.r('L4', 'critical ⇒ ok: changed true (Wiederherstellung)', 'ok|true|critical',
    concat_ws('|', j->>'overall', j->>'changed', j->>'previous'));

  -- L5: Heartbeat mit Secret (nur in dieser Transaktion), ok ⇒ <url>
  perform vault.create_secret('https://hc.example.invalid/ping/abc/', 'monitoring_alert_url', 'test only');
  perform pg_temp.http(200, '-230 seconds'); perform pg_temp.cron_ok('-230 seconds');
  j := public.run_notification_health_check(v_t + interval '4 minutes');
  select c.ping_request_id into v_q from public.notification_health_checks c order by c.id desc limit 1;
  perform pg_temp.r('L5', 'Secret vorhanden, ok ⇒ Ping ok an <url> ohne /fail', 'ok|https://hc.example.invalid/ping/abc|POST',
    concat_ws('|', j->>'ping_kind',
      (select q.url from net.http_request_queue q where q.id = v_q),
      (select q.method::text from net.http_request_queue q where q.id = v_q)));

  -- L6: critical ⇒ <url>/fail, Body ohne Tokens
  perform pg_temp.d('processing', '20 minutes', p_claimed => '16 minutes');
  perform pg_temp.http(200, '-290 seconds'); perform pg_temp.cron_ok('-290 seconds');
  j := public.run_notification_health_check(v_t + interval '5 minutes');
  select c.ping_request_id into v_q from public.notification_health_checks c order by c.id desc limit 1;
  perform pg_temp.r('L6', 'critical ⇒ Ping fail an <url>/fail, Body overall=critical', 'fail|https://hc.example.invalid/ping/abc/fail|critical|true',
    concat_ws('|', j->>'ping_kind',
      (select q.url from net.http_request_queue q where q.id = v_q),
      (select convert_from(q.body, 'UTF8')::jsonb->>'overall' from net.http_request_queue q where q.id = v_q),
      (select (convert_from(q.body, 'UTF8')::jsonb->>'changed') from net.http_request_queue q where q.id = v_q)));

  -- L7: warning ⇒ Erfolgs-Ping (warning hält den Heartbeat-Check nicht dauerhaft "down")
  perform pg_temp.reset_d();
  update public.profiles set expo_push_token = null where id = '95100000-0000-0000-0000-000000000001';
  perform pg_temp.http(200, '-350 seconds'); perform pg_temp.cron_ok('-350 seconds');
  j := public.run_notification_health_check(v_t + interval '6 minutes');
  perform pg_temp.r('L7', 'warning ⇒ Ping ok, changed true', 'warning|ok|true',
    concat_ws('|', j->>'overall', j->>'ping_kind', j->>'changed'));
  update public.profiles set expo_push_token = 'ExponentPushToken[hcA]' where id = '95100000-0000-0000-0000-000000000001';

  -- L8: Zusammenfassung kompakt, Prüfprotokoll vollständig
  perform pg_temp.r('L8', '7 Läufe protokolliert, Wechsel bei L2/L4/L6/L7', '7|4',
    concat_ws('|', (select count(*) from public.notification_health_checks),
                   (select count(*) from public.notification_health_checks where level_changed)));
end $$;

-- =========================================================
-- Aufbewahrung — mit langen Fristen, damit keine echten Zeilen betroffen sind
-- =========================================================
do $$
declare j jsonb; v_cron_before int; v_hc_before int;
begin
  insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, start_time, end_time)
  select j2.jobid, nextval('pg_temp.cron_runid'), 0, current_database(), 'postgres', 'purge-test', 'succeeded',
         now() - interval '20000 days', now() - interval '20000 days'
  from cron.job j2 where j2.jobname = 'notification-dispatch-sweeper';
  insert into public.notification_health_checks (checked_at, overall_level, level_changed, summary)
  values (now() - interval '20000 days', 'ok', false, '{}');
  select count(*) into v_cron_before from cron.job_run_details;
  select count(*) into v_hc_before from public.notification_health_checks;

  j := public.purge_monitoring_history(interval '10000 days', interval '10000 days');
  perform pg_temp.r('R1', 'Purge entfernt genau die alten Zeilen (je 1)', '1|1|1|1',
    concat_ws('|', j->>'cron_job_run_details_deleted', j->>'notification_health_checks_deleted',
              v_cron_before - (select count(*) from cron.job_run_details),
              v_hc_before - (select count(*) from public.notification_health_checks)));
end $$;

-- =========================================================
-- Zugriff / Cron-Definition
-- =========================================================
select pg_temp.r('S1', 'anon/authenticated ohne EXECUTE, service_role mit', 'f|f|f|f|f|f|t|t',
  concat_ws('|',
    has_function_privilege('anon', 'public.notification_health(timestamptz)', 'execute'),
    has_function_privilege('authenticated', 'public.notification_health(timestamptz)', 'execute'),
    has_function_privilege('authenticated', 'public.run_notification_health_check(timestamptz)', 'execute'),
    has_function_privilege('authenticated', 'public.purge_monitoring_history(interval,interval)', 'execute'),
    has_table_privilege('authenticated', 'public.notification_health_checks', 'select'),
    has_table_privilege('anon', 'public.notification_health_checks', 'select'),
    has_function_privilege('service_role', 'public.notification_health(timestamptz)', 'execute'),
    has_function_privilege('service_role', 'public.run_notification_health_check(timestamptz)', 'execute')));
select pg_temp.r('S2', 'SECURITY DEFINER + fester search_path', 't|t',
  concat_ws('|',
    (select prosecdef from pg_proc where oid = 'public.notification_health(timestamptz)'::regprocedure),
    (select proconfig::text like '%search_path=public, pg_temp%' from pg_proc where oid = 'public.notification_health(timestamptz)'::regprocedure)));
select pg_temp.r('S3', 'Cron-Jobs: Health alle 5 min, Retention 03:30', '*/5 * * * *|30 3 * * *',
  concat_ws('|',
    (select schedule from cron.job where jobname = 'notification-health-check'),
    (select schedule from cron.job where jobname = 'monitoring-history-retention')));

-- ── Ergebnis ──
select case_no, beschreibung, erwartet, ergebnis,
       case when erwartet = ergebnis then 'PASS' else 'FAIL' end as verdict
from _r order by case_no;

do $$
declare v_fail int; v_total int;
begin
  select count(*) filter (where erwartet is distinct from ergebnis), count(*) into v_fail, v_total from _r;
  raise notice 'TESTRESULT notification_health_monitoring: % / % PASS', v_total - v_fail, v_total;
  if v_fail > 0 then
    raise exception 'TESTRESULT notification_health_monitoring: % FAIL', v_fail;
  end if;
end $$;

rollback;
