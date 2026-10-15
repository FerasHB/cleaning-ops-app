-- =====================================================================
-- Notification-Monitoring (F3): Health-Funktion, Prüfprotokoll, Heartbeat,
-- Aufbewahrung von Cron-/Monitoring-Historie
-- =====================================================================
--
-- PROBLEM (Notification-Audit 2026-10-15, F3):
--   Kein einziges Notification-Signal alarmiert. cron.job_run_details meldet
--   nur, dass net.http_post eingereiht wurde ("succeeded"), nicht ob die
--   Edge Function lief; das einzige echte Dispatcher-Signal liegt 6 h in
--   net._http_response (pg_net.ttl). Edge-Logs sind nicht skriptbar.
--   Zusätzlich wächst cron.job_run_details unbegrenzt (Prod ~130k Zeilen).
--
-- BAUSTEINE:
--   1. notification_health(p_as_of) — eine Zeile je Prüfung
--      (check_key, level ok|warning|critical, value, detail jsonb).
--      Rein lesend. p_as_of macht jede Prüfung zeitlich verschiebbar, damit
--      Tests "in 10 Minuten" auswerten können, ohne echte Cron-Jobs zu stoppen.
--      detail enthält nur Zähler/Alter (Minuten/Stunden) — keine IDs, Namen
--      oder Tokens (Push-Tokens in Fehlertexten werden maskiert).
--   2. notification_health_checks — ein Eintrag je Prüflauf (Gesamtlevel,
--      Vorgänger-Level, Levelwechsel ja/nein, kompakte Zusammenfassung,
--      Heartbeat-Art + pg_net-Request-ID).
--   3. run_notification_health_check(p_as_of) — schreibt den Eintrag und
--      pingt optional einen Heartbeat-Dienst (siehe 5). Cron
--      'notification-health-check' alle 5 Minuten.
--   4. purge_monitoring_history() — Cron 'monitoring-history-retention'
--      täglich 03:30 UTC: cron.job_run_details 14 Tage, notification_health_
--      checks 30 Tage.
--   5. Externer Aufruf NUR, wenn das Vault-Secret 'monitoring_alert_url'
--      existiert (sonst kein einziger externer Request). Semantik eines
--      Heartbeat-Dienstes mit E-Mail (healthchecks.io-kompatibel):
--        * JEDER Lauf pingt genau einmal (Dead-Man-Switch: bleibt der Ping
--          aus, weil pg_cron/pg_net steht, alarmiert der Dienst selbst).
--        * Gesamtlevel critical ⇒ POST <url>/fail, sonst POST <url>.
--        * Der Dienst mailt nur bei Zustandswechsel (up→down, down→up) —
--          kein Alarm alle 5 Minuten, Wiederherstellungsmail bei Rückkehr.
--        * BEWUSST: warning pingt als Erfolg. Ein dauerhaftes warning (z. B.
--          aktiver Admin ohne Token, Produktentscheidung = warning) würde den
--          Check sonst dauerhaft "down" halten und einen späteren echten
--          Ausfall (Dispatcher/Cron) verschlucken. warning-Wechsel stehen
--          in notification_health_checks (level_changed) und im Ping-Body.
--      Die pg_net-Request-ID jedes Pings wird gespeichert und in H5
--      ausgeschlossen — Heartbeat-Antworten verfälschen die Dispatcher-
--      Gesundheit nicht.
--
-- PRÜFUNGEN / SCHWELLEN (Beta, abgeleitet aus Sofort-Trigger, 1-Minuten-
-- Sweeper, Retry-Backoff 60/120/240/480 s, Missing-Token-Verfall 24 h):
--   H1a h1_pending_overdue        pending mit next_attempt_at ≥3 min überfällig ⇒ warning, ≥10 min ⇒ critical
--   H1b h1_pending_oldest         ältestes pending ohne Missing-Token ≥20 min ⇒ warning, ≥60 min ⇒ critical
--   H2a h2_missing_token_waiting  Anzahl (Info); ältestes ≥20 h ⇒ warning
--   H2b h2_missing_token_expired  verfallene Zeilen (created_at in den letzten 48 h ⇒ Verfall in den
--                                 letzten ~24 h) ≥3 ⇒ warning
--   H3a h3_device_not_registered  DeviceNotRegistered in 24 h ≥3 ⇒ warning, ≥10 ⇒ critical
--   H3b h3_other_failures         sonstige failed in 24 h ≥1 ⇒ warning, in 1 h ≥5 ⇒ critical
--                                 (Fehlerzeitpunkt = letzter Claim, claimed_at)
--   H4  h4_processing_stuck       processing seit ≥5 min ⇒ warning, ≥15 min ⇒ critical
--   H5  h5_dispatcher_http        letzte HTTP-200-Antwort ≥3 min ⇒ warning, ≥10 min/keine ⇒ critical;
--                                 die 3 jüngsten Antworten alle ≠200 ⇒ critical
--   H6  h6_sweeper_cron           letzter erfolgreicher Sweeper-Lauf ≥3 min ⇒ warning, ≥10 min ⇒ critical;
--                                 Job fehlt/inaktiv ⇒ critical
--   H7  h7_outbox_unfanned        fanned_out_at null seit ≥3 min ⇒ warning, ≥10 min ⇒ critical
--   H8a h8_employees_without_token aktive Mitarbeiter ohne Token (Info, immer ok)
--   H8b h8_admins_without_token   ≥1 aktiver Admin ohne Token ⇒ warning
--   H9  h9_possible_duplicates    sent mit attempts >1 in 24 h ≥1 ⇒ warning, ≥5 ⇒ critical
--                                 (Hinweis: 'sent' setzt last_error = null, ein legitimer Retry nach
--                                 Netzwerkfehler ist daher nicht von einem Reclaim nach Timeout zu
--                                 unterscheiden — "möglich", nicht "bewiesen". Missing-Token-
--                                 Zurückstellungen zählen nicht, sie setzen attempts zurück.)
--   Gesamt = schlechtestes Level aller Prüfungen. Expo-Receipts (F2) fehlen bewusst.
--
-- KEINE Änderung am Zustellverhalten: alle Notification-Funktionen/-Tabellen
--   bleiben unverändert; neue Objekte lesen nur (Ausnahme: eigene Tabelle,
--   Cron-Log-Aufbewahrung).
--
-- ROLLBACK:
--   select cron.unschedule('notification-health-check');
--   select cron.unschedule('monitoring-history-retention');
--   drop function public.run_notification_health_check(timestamptz);
--   drop function public.purge_monitoring_history(interval, interval);
--   drop function public.notification_health(timestamptz);
--   drop table public.notification_health_checks;
--   (optional) delete from vault.secrets where name = 'monitoring_alert_url';
--   Bereits gelöschte Cron-Log-Zeilen sind nicht wiederherstellbar (Logdaten).
-- =====================================================================


-- ── 1. Prüfprotokoll ──
create table if not exists public.notification_health_checks (
  id               bigint      generated always as identity primary key,
  checked_at       timestamptz not null,
  overall_level    text        not null,
  previous_level   text,
  level_changed    boolean     not null,
  summary          jsonb       not null,
  ping_kind        text,
  ping_request_id  bigint,
  constraint chk_notification_health_checks_level
    check (overall_level in ('ok', 'warning', 'critical')),
  constraint chk_notification_health_checks_ping_kind
    check (ping_kind is null or ping_kind in ('ok', 'fail', 'error'))
);

create index if not exists idx_notification_health_checks_checked_at
  on public.notification_health_checks (checked_at desc);
create index if not exists idx_notification_health_checks_ping_request
  on public.notification_health_checks (ping_request_id)
  where ping_request_id is not null;

comment on table public.notification_health_checks is
'Ein Eintrag je run_notification_health_check() (Cron alle 5 min). overall_level = '
'schlechtestes Level aus notification_health(); level_changed = Wechsel gegenüber dem '
'Vorlauf (erster Lauf mit ok zählt nicht). ping_kind/ping_request_id: optionaler '
'Heartbeat (nur mit Vault-Secret monitoring_alert_url). Aufbewahrung 30 Tage. '
'Nur Service Role (20261017000000).';

alter table public.notification_health_checks enable row level security;
revoke all on table public.notification_health_checks from public, anon, authenticated;


-- ── 2. Health-Prüfungen ──
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
      where c.ping_request_id = h.id);

  select array_agg(coalesce(x.status_code, 0) order by x.created desc) into v_last3
  from (
    select h.status_code, h.created
    from net._http_response h
    where h.created <= p_as_of
      and not exists (
        select 1 from public.notification_health_checks c
        where c.ping_request_id = h.id)
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
end;
$$;

comment on function public.notification_health(timestamptz) is
'Notification-Health (F3, 20261017000000): eine Zeile je Prüfung (check_key, level '
'ok|warning|critical, value, detail ohne personenbezogene Daten). Rein lesend; p_as_of '
'verschiebt den Auswertungszeitpunkt (Tests). Schwellen siehe Migrationskopf. Nur Service Role.';

revoke all on function public.notification_health(timestamptz) from public, anon, authenticated;
grant execute on function public.notification_health(timestamptz) to service_role;


-- ── 3. Prüflauf + optionaler Heartbeat ──
create or replace function public.run_notification_health_check(p_as_of timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_checks   jsonb;
  v_non_ok   jsonb;
  v_overall  text;
  v_prev     text;
  v_changed  boolean;
  v_url      text;
  v_kind     text;
  v_req      bigint;
  v_summary  jsonb;
begin
  select
    jsonb_object_agg(h.check_key, jsonb_build_array(h.level, h.value)),
    coalesce(jsonb_agg(jsonb_build_object('check', h.check_key, 'level', h.level,
                                          'value', h.value, 'detail', h.detail)
                       order by h.check_key)
             filter (where h.level <> 'ok'), '[]'::jsonb),
    case
      when bool_or(h.level = 'critical') then 'critical'
      when bool_or(h.level = 'warning')  then 'warning'
      else 'ok' end
    into v_checks, v_non_ok, v_overall
  from public.notification_health(p_as_of) h;

  select c.overall_level into v_prev
  from public.notification_health_checks c
  where c.checked_at <= p_as_of
  order by c.checked_at desc, c.id desc
  limit 1;

  -- Erster Lauf mit ok ist kein Wechsel (kein "Wiederherstellung"-Rauschen).
  v_changed := v_prev is distinct from v_overall
               and not (v_prev is null and v_overall = 'ok');

  v_summary := jsonb_build_object('overall', v_overall, 'checks', v_checks, 'non_ok', v_non_ok);

  -- Optionaler Heartbeat — ohne Secret kein externer Request.
  select nullif(btrim(s.decrypted_secret), '') into v_url
  from vault.decrypted_secrets s
  where s.name = 'monitoring_alert_url'
  limit 1;

  if v_url is not null then
    v_kind := case when v_overall = 'critical' then 'fail' else 'ok' end;
    begin
      select net.http_post(
        url := rtrim(v_url, '/') || case when v_kind = 'fail' then '/fail' else '' end,
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
                  'source', 'taskops-notification-health',
                  'checked_at', p_as_of,
                  'overall', v_overall,
                  'previous', v_prev,
                  'changed', v_changed,
                  'non_ok', v_non_ok),
        timeout_milliseconds := 5000
      ) into v_req;
    exception
      when others then
        v_kind := 'error';
        v_req  := null;
    end;
  end if;

  insert into public.notification_health_checks (
    checked_at, overall_level, previous_level, level_changed, summary, ping_kind, ping_request_id
  )
  values (p_as_of, v_overall, v_prev, v_changed, v_summary, v_kind, v_req);

  return v_summary || jsonb_build_object('previous', v_prev, 'changed', v_changed, 'ping_kind', v_kind);
end;
$$;

comment on function public.run_notification_health_check(timestamptz) is
'Ein Prüflauf (Cron notification-health-check, alle 5 min): wertet notification_health() '
'aus, protokolliert in notification_health_checks und pingt — nur wenn Vault-Secret '
'monitoring_alert_url existiert — einen Heartbeat-Dienst: critical ⇒ <url>/fail, sonst '
'<url>. Nur Service Role (20261017000000).';

revoke all on function public.run_notification_health_check(timestamptz) from public, anon, authenticated;
grant execute on function public.run_notification_health_check(timestamptz) to service_role;


-- ── 4. Aufbewahrung ──
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

  return jsonb_build_object('cron_job_run_details_deleted', v_cron,
                            'notification_health_checks_deleted', v_health);
end;
$$;

comment on function public.purge_monitoring_history(interval, interval) is
'Aufbewahrung (Cron monitoring-history-retention, täglich 03:30 UTC): '
'cron.job_run_details älter als 14 Tage, notification_health_checks älter als 30 Tage. '
'Nur Service Role (20261017000000).';

revoke all on function public.purge_monitoring_history(interval, interval) from public, anon, authenticated;
grant execute on function public.purge_monitoring_history(interval, interval) to service_role;


-- ── 5. Cron-Jobs ──
do $$
begin
  if exists (select 1 from cron.job where jobname = 'notification-health-check') then
    perform cron.unschedule('notification-health-check');
  end if;
  if exists (select 1 from cron.job where jobname = 'monitoring-history-retention') then
    perform cron.unschedule('monitoring-history-retention');
  end if;
end $$;

select cron.schedule(
  'notification-health-check',
  '*/5 * * * *',
  $cron$select public.run_notification_health_check();$cron$
);

select cron.schedule(
  'monitoring-history-retention',
  '30 3 * * *',
  $cron$select public.purge_monitoring_history();$cron$
);
