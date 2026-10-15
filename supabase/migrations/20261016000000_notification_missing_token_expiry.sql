-- =====================================================================
-- Notification-Deliveries ohne Push-Token: 24-h-Verfall statt Endlos-Retry
-- =====================================================================
--
-- PROBLEM (Notification-Audit 2026-10-15, F1):
--   Eine Delivery, deren Empfänger keinen Push-Token hat, ging bisher über
--   complete_notification_delivery(..., 'missing_token') IMMER zurück auf
--   'pending' (+300 s, attempts −1) — ohne Endzustand und ohne Altersgrenze.
--   update_my_push_token() machte bei der ersten Token-Registrierung ALLE
--   zurückgestellten Zeilen des Nutzers sofort fällig. Ergebnis: veraltete
--   Pushes Stunden/Tage/Wochen später (Prod-Historie: bis 21,8 h zu spät;
--   Staging: 27 hängende Zeilen, älteste vom 2026-08-26).
--
-- REGEL (eine globale Grenze, bewusst keine Pro-Event-TTL):
--   Eine Delivery, die wegen fehlendem Token zurückgestellt ist, verfällt,
--   sobald sie älter als notification_missing_token_ttl() = 24 h ist
--   (gemessen an notification_deliveries.created_at — für aufgefächerte wie
--   direkt angelegte Zeilen ≈ Zeitpunkt des Ereignisses). Verfallen heißt:
--   status = 'failed', last_error = 'missing_push_token_expired' — terminal,
--   kein weiterer Versuch, nie wieder fällig.
--   24 h passt für alle Event-Typen: job_started/job_completed sind nach
--   wenigen Stunden wertlos; job_assigned, comment_added und Abwesenheits-
--   Events sind in der App ohnehin sichtbar (Jobliste, Kommentar-Punkt,
--   Abwesenheiten) — ein Push ist dort nur der zeitnahe Hinweis.
--
-- DREI DURCHSETZUNGSPUNKTE (alle serverseitig, kein Edge-Function-/App-Change):
--   1. complete_notification_delivery 'missing_token': jünger als TTL ⇒
--      unverändertes Zurückstellen; älter ⇒ terminal 'failed'.
--   2. claim_notification_deliveries: verfällt VOR dem Claim alle fälligen
--      oder nicht fälligen Missing-Token-Zeilen über der TTL. Nötig, weil ein
--      Token auch OHNE update_my_push_token auftauchen kann (Selbst-Update auf
--      profiles erlaubt expo_push_token, siehe enforce_profile_field_guard) —
--      sonst würde eine alte, noch 'pending' stehende Zeile beim nächsten
--      Claim mit frischem Token doch noch gesendet. FOR UPDATE SKIP LOCKED:
--      parallele Claims (Sofort-Trigger, Cron, Client-Kick) blockieren sich
--      nicht und können nicht deadlocken.
--   3. update_my_push_token: macht nur Zeilen innerhalb der TTL wieder fällig;
--      ältere Zeilen desselben Nutzers werden im selben Aufruf terminal
--      verfallen (nie re-armed).
--
-- UNVERÄNDERT: 'sent', 'permanent_fail' (inkl. DeviceNotRegistered), 'retry'
--   (Backoff 60·2^n s, max 3600 s, failed nach max_attempts), Fan-out,
--   Claim-Rückgabevertrag (identische Signatur + Spalten), Grants.
--
-- MARKER: Zurückgestellte Missing-Token-Zeilen sind genau
--   status='pending' AND last_error='missing_push_token' (bzw. während eines
--   hängenden Claims status='processing' mit demselben last_error).
--
-- BESTANDSDATEN: keine eigene Datenmigration. Der erste Claim nach dem
--   Deploy (Cron ≤ 60 s) verfällt Altzeilen regelkonform über Punkt 2.
--
-- ROLLBACK: die drei Funktionen mit den Definitionen aus
--   20260717194919 (update_my_push_token, hier mit Build-/Plattform-Params
--   aus 20260916120000), 20260717000002 (complete_notification_delivery) und
--   20260916130000 (claim_notification_deliveries) neu anlegen und
--   notification_missing_token_ttl() droppen. Bereits verfallene Zeilen
--   bleiben 'failed' (gewollt — sie sind veraltet).
-- =====================================================================

-- ── TTL an genau einer Stelle ──
create or replace function public.notification_missing_token_ttl()
returns interval
language sql
immutable
set search_path = public, pg_temp
as $$
  select interval '24 hours';
$$;

comment on function public.notification_missing_token_ttl() is
'Maximales Alter (ab notification_deliveries.created_at) einer wegen fehlendem '
'Push-Token zurückgestellten Delivery. Danach terminal failed / '
'missing_push_token_expired. Einzige Quelle der TTL (20261016000000).';

revoke all on function public.notification_missing_token_ttl() from public, anon, authenticated;


-- ── 1. Zustandsübergang nach Sendeversuch ──
create or replace function public.complete_notification_delivery(
  delivery_id_input uuid,
  outcome text,
  error_input text default null,
  max_attempts int default 5
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts   int;
  v_created_at timestamptz;
begin
  select attempts, created_at into v_attempts, v_created_at
  from public.notification_deliveries
  where id = delivery_id_input;

  if not found then
    return null;
  end if;

  if outcome = 'sent' then
    update public.notification_deliveries
      set status = 'sent', sent_at = now(), last_error = null
      where id = delivery_id_input;
    return 'sent';

  elsif outcome = 'permanent_fail' then
    update public.notification_deliveries
      set status = 'failed', last_error = error_input
      where id = delivery_id_input;
    return 'failed';

  elsif outcome = 'missing_token' then
    -- Älter als die TTL: terminal verfallen, nie wieder fällig.
    if v_created_at <= now() - public.notification_missing_token_ttl() then
      update public.notification_deliveries
        set status = 'failed',
            last_error = 'missing_push_token_expired',
            attempts = greatest(v_attempts - 1, 0)
        where id = delivery_id_input;
      return 'failed';
    end if;

    -- Innerhalb der TTL: unverändert zurückstellen (aktiver Empfänger ohne Token).
    update public.notification_deliveries
      set status = 'pending',
          last_error = 'missing_push_token',
          attempts = greatest(v_attempts - 1, 0),
          next_attempt_at = now() + make_interval(secs => 300)
      where id = delivery_id_input;
    return 'pending';

  elsif outcome = 'retry' then
    if v_attempts >= max_attempts then
      update public.notification_deliveries
        set status = 'failed',
            last_error = coalesce(error_input, 'max attempts reached')
        where id = delivery_id_input;
      return 'failed';
    end if;

    update public.notification_deliveries
      set status = 'pending',
          last_error = error_input,
          next_attempt_at = now()
            + make_interval(secs => least(3600, (60 * power(2, greatest(v_attempts - 1, 0)))::int))
      where id = delivery_id_input;
    return 'pending';

  else
    raise exception 'Unknown outcome: %', outcome;
  end if;
end;
$$;

comment on function public.complete_notification_delivery(uuid, text, text, int) is
'Zustandsübergang nach Sendeversuch: sent | permanent_fail | retry(Backoff/failed '
'bei max) | missing_token(pending, fixer Backoff 300 s — ab Alter '
'notification_missing_token_ttl() terminal failed/missing_push_token_expired, '
'seit 20261016000000). sent_at NUR bei Erfolg. Nur Service Role.';

revoke all on function public.complete_notification_delivery(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.complete_notification_delivery(uuid, text, text, int) to service_role;


-- ── 2. Claim: Altzeilen VOR dem Claim verfallen lassen ──
-- Signatur und Rückgabespalten exakt wie 20260916130000 (CREATE OR REPLACE,
-- kein DROP — der Dispatcher-Vertrag bleibt unverändert).
create or replace function public.claim_notification_deliveries(
  company_id_filter uuid default null,
  max_rows int default 50,
  processing_timeout_seconds int default 120
)
returns table (
  delivery_id uuid, outbox_id uuid, recipient_id uuid, attempts int,
  event_type text, job_id uuid, company_id uuid, job_status text,
  employee_id uuid, employee_name text, customer_name text, service_name text,
  expo_push_token text, recipient_active boolean, recipient_role text,
  recipient_locale text,
  entity_type text, entity_id uuid,
  absence_start_date date, absence_end_date date
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Zurückgestellte Missing-Token-Zeilen über der TTL terminal verfallen —
  -- unabhängig davon, ob der Empfänger inzwischen einen Token hat. SKIP
  -- LOCKED: Zeilen, die ein paralleler Claim gerade hält, bleiben für den
  -- nächsten Lauf (complete_notification_delivery prüft die TTL ebenfalls).
  update public.notification_deliveries d
  set status = 'failed',
      last_error = 'missing_push_token_expired'
  where d.id in (
    select x.id
    from public.notification_deliveries x
    where (company_id_filter is null or x.company_id = company_id_filter)
      and x.last_error = 'missing_push_token'
      and x.created_at <= now() - public.notification_missing_token_ttl()
      and (
        x.status = 'pending'
        or (x.status = 'processing'
            and x.claimed_at < now() - make_interval(secs => processing_timeout_seconds))
      )
    for update skip locked
  );

  return query
  with due as (
    select d.id
    from public.notification_deliveries d
    where (company_id_filter is null or d.company_id = company_id_filter)
      and (
        (d.status = 'pending' and d.next_attempt_at <= now())
        or (d.status = 'processing'
            and d.claimed_at < now() - make_interval(secs => processing_timeout_seconds))
      )
    order by d.next_attempt_at
    for update skip locked
    limit max_rows
  ),
  claimed as (
    update public.notification_deliveries d
    set status = 'processing', claimed_at = now(), attempts = d.attempts + 1
    from due
    where d.id = due.id
    returning d.id, d.outbox_id, d.recipient_id, d.attempts
  )
  select
    c.id, c.outbox_id, c.recipient_id, c.attempts,
    o.event_type, o.job_id, o.company_id, o.job_status,
    o.employee_id, o.employee_name, o.customer_name, o.service_name,
    p.expo_push_token, p.is_active, p.role::text,
    p.locale,
    o.entity_type, o.entity_id, o.absence_start_date, o.absence_end_date
  from claimed c
  join public.notification_outbox o on o.id = c.outbox_id
  left join public.profiles p on p.id = c.recipient_id;
end;
$$;

comment on function public.claim_notification_deliveries(uuid, int, int) is
'Nimmt fällige/hängende Deliveries atomar (FOR UPDATE SKIP LOCKED), setzt '
'processing + attempts, liefert Empfänger-Token/Status/Locale UND die '
'generische Entitätsidentität (entity_type/entity_id) + Abwesenheits-'
'Schnappschüsse (absence_start_date/end_date). Seit 20261016000000: verfällt '
'vorher zurückgestellte Missing-Token-Zeilen älter als '
'notification_missing_token_ttl() terminal (failed/missing_push_token_expired), '
'damit ein später auftauchender Token keine veralteten Pushes auslöst. '
'Nur Service Role.';

revoke all on function public.claim_notification_deliveries(uuid, int, int) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(uuid, int, int) to service_role;


-- ── 3. Token-Registrierung: nur Zeilen innerhalb der TTL wieder fällig ──
-- Signatur exakt wie 20260916120000 (Build-/Plattform-Telemetrie).
create or replace function public.update_my_push_token(
  new_token text,
  app_build_number integer default null,
  app_platform text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_token text := nullif(btrim(new_token), '');
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if v_token is null then
    raise exception 'Push token is required';
  end if;

  if v_token !~ '^ExponentPushToken\[[A-Za-z0-9_-]+\]$'
     and v_token !~ '^ExpoPushToken\[[A-Za-z0-9_-]+\]$' then
    raise exception 'Invalid Expo push token';
  end if;

  if not exists (
    select 1
    from public.profiles
    where id = v_user_id
      and is_active = true
  ) then
    raise exception 'Active profile not found';
  end if;

  update public.profiles
  set expo_push_token = null
  where expo_push_token = v_token
    and id <> v_user_id;

  update public.profiles
  set expo_push_token         = v_token,
      last_seen_app_build     = coalesce(app_build_number, last_seen_app_build),
      last_seen_app_platform  = coalesce(app_platform, last_seen_app_platform)
  where id = v_user_id
    and is_active = true;

  if not found then
    raise exception 'Active profile not found';
  end if;

  -- Veraltete Missing-Token-Zeilen dieses Nutzers terminal verfallen — sie
  -- dürfen durch den neuen Token NIE fällig werden.
  update public.notification_deliveries
  set status = 'failed',
      last_error = 'missing_push_token_expired'
  where recipient_id = v_user_id
    and status = 'pending'
    and last_error = 'missing_push_token'
    and created_at <= now() - public.notification_missing_token_ttl();

  -- Nur noch gültige (jüngere) zurückgestellte Zeilen sofort fällig machen.
  update public.notification_deliveries
  set next_attempt_at = now(),
      last_error = null
  where recipient_id = v_user_id
    and status = 'pending'
    and last_error = 'missing_push_token'
    and created_at > now() - public.notification_missing_token_ttl();
end;
$$;

comment on function public.update_my_push_token(text, integer, text) is
'Updates only the current user expo push token safely via RPC. Fails if the '
'caller profile is inactive. Re-arms only missing-token deliveries younger than '
'notification_missing_token_ttl(); older ones are expired terminally '
'(failed/missing_push_token_expired, 20261016000000).';

revoke all on function public.update_my_push_token(text, integer, text) from public, anon;
grant execute on function public.update_my_push_token(text, integer, text) to authenticated;
