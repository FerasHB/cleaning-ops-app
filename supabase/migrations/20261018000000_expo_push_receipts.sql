-- =====================================================================
-- Expo-Push-Receipts (F2): Ticket-Persistenz, Receipt-Zustand, sichere
-- Token-Bereinigung
-- =====================================================================
--
-- PROBLEM (Notification-Audit 2026-10-15, F2):
--   notification_deliveries.status = 'sent' heißt nur "Expo hat das Ticket
--   angenommen". Die Ticket-ID (einziger Schlüssel für das Receipt) und der
--   tatsächlich verwendete Token wurden verworfen; echte Zustellfehler
--   (DeviceNotRegistered, InvalidCredentials, MessageTooBig …) blieben
--   unsichtbar. Zusätzlich löschte der Dispatcher bei DeviceNotRegistered
--   den Token per Profil-ID, ohne zu prüfen, ob noch DERSELBE Token
--   hinterlegt ist (ein altes Ergebnis konnte einen neu registrierten Token
--   löschen).
--
-- DESIGN (Produktentscheidung 2026-10-15):
--   * status bleibt unverändert (pending|processing|sent|failed) — F1, der
--     Claim und die F3-Prüfungen sehen dieselben Werte wie bisher.
--   * Eigene Receipt-Dimension: receipt_status pending|ok|error|unavailable;
--     NULL = nicht anwendbar / Altbestand ("legacy-unverified"). KEIN
--     Backfill, Bestandszeilen bleiben unverändert.
--   * Gespeichert wird nur SHA-256 des verwendeten Tokens (bytea), keine
--     zweite Klartextkopie.
--   * Receipt-Fehler lösen NIE einen erneuten Versand aus (auch nicht
--     MessageRateExceeded) — kein Doppelversand-Risiko.
--
-- RPCs (alle nur Service Role):
--   complete_notification_delivery(+ expo_ticket_id_input, push_token_sha256_input)
--     — beide neu und optional (Default NULL). Alte Aufrufer (4 Parameter,
--       z. B. die bis zum Deploy laufende Edge Function) verhalten sich exakt
--       wie zuvor. Sind beide gesetzt und outcome = 'sent': receipt_status =
--       'pending', next_receipt_check_at = sent_at + 15 min. Eine (theore-
--       tisch unmögliche) doppelte Ticket-ID darf das 'sent'-Markieren nie
--       verhindern (sonst Reclaim ⇒ Doppelversand): dann ohne Receipt-Daten.
--   claim_receipt_checks(max_rows 1000, lease_seconds 120)
--     — verfällt zuerst alles, was 6 h nach sent_at noch pending ist
--       (unavailable/max_age_exceeded), nimmt dann fällige Zeilen atomar
--       (FOR UPDATE SKIP LOCKED) und setzt eine Lease (receipt_claimed_at).
--   complete_receipt_check(delivery_id, outcome, error)
--     — outcome ok | error | missing | infra (Übergänge siehe Funktion).
--       Nur auf eine geclaimte pending-Zeile wirksam ⇒ idempotent.
--       error = DeviceNotRegistered ⇒ bedingte Token-Bereinigung.
--   clear_push_token_if_matches(recipient_id, token_sha256)
--     — leert profiles.expo_push_token NUR, wenn SHA-256 des aktuell
--       hinterlegten Tokens dem gespeicherten Hash entspricht.
--
-- Zeitplan Receipt-Abfrage (Beta):
--   1. Prüfung sent_at + 15 min; Receipt fehlt ⇒ sent_at + 30 / 60 / 120 min;
--   nach dem 4. Fehlen ⇒ unavailable/receipt_missing.
--   Infrastrukturfehler (Netz, HTTP 5xx/429, unlesbare Antwort) ⇒ pending,
--   +5 min, zählt NICHT als Fehlen. Harte Grenze: 6 h nach sent_at ⇒
--   unavailable/max_age_exceeded (Expo löscht Receipts nach 24 h).
--
-- notification_receipt_poll_requests: pg_net-Request-IDs der Receipt-
--   Poller-Aufrufe (Folgemigration), damit F3 H5 sie aus der Dispatcher-
--   Gesundheit ausschließt.
--
-- ROLLBACK: Edge Functions auf den Vorstand zurück; dann
--   drop function public.claim_receipt_checks(int, int);
--   drop function public.complete_receipt_check(uuid, text, text);
--   drop function public.clear_push_token_if_matches(uuid, bytea);
--   complete_notification_delivery mit der 4-Parameter-Definition aus
--   20261016000000 neu anlegen (vorher die 6-Parameter-Variante droppen).
--   Spalten/Tabelle können bleiben (nullable, ungenutzt).
-- =====================================================================

-- ── 1. Schema ──
alter table public.notification_deliveries
  add column if not exists expo_ticket_id        text,
  add column if not exists push_token_sha256     bytea,
  add column if not exists receipt_status        text,
  add column if not exists receipt_error         text,
  add column if not exists receipt_attempts      integer not null default 0,
  add column if not exists receipt_checked_at    timestamptz,
  add column if not exists next_receipt_check_at timestamptz,
  add column if not exists receipt_claimed_at    timestamptz;

alter table public.notification_deliveries
  drop constraint if exists chk_notification_deliveries_receipt_status;
alter table public.notification_deliveries
  add constraint chk_notification_deliveries_receipt_status
  check (receipt_status is null or receipt_status in ('pending', 'ok', 'error', 'unavailable'));

create index if not exists idx_notif_deliveries_receipt_due
  on public.notification_deliveries (next_receipt_check_at)
  where receipt_status = 'pending';

create unique index if not exists uq_notif_deliveries_expo_ticket
  on public.notification_deliveries (expo_ticket_id)
  where expo_ticket_id is not null;

comment on column public.notification_deliveries.receipt_status is
'Expo-Receipt-Zustand (F2, 20261018000000): pending | ok | error | unavailable. NULL = '
'nicht anwendbar / Altbestand (legacy-unverified). Unabhängig von status.';
comment on column public.notification_deliveries.push_token_sha256 is
'SHA-256 des beim Versand verwendeten Expo-Tokens (kein Klartext). Grundlage für '
'clear_push_token_if_matches().';

create table if not exists public.notification_receipt_poll_requests (
  request_id   bigint      primary key,
  requested_at timestamptz not null default now()
);

comment on table public.notification_receipt_poll_requests is
'pg_net-Request-IDs der Aufrufe von poll-push-receipts (kick_receipt_poller). F3 H5 '
'schließt sie aus der Dispatcher-Gesundheit aus, H15 wertet sie aus. Nur Service Role.';

alter table public.notification_receipt_poll_requests enable row level security;
revoke all on table public.notification_receipt_poll_requests from public, anon, authenticated;


-- ── 2. Bedingte Token-Bereinigung ──
create or replace function public.clear_push_token_if_matches(
  p_recipient_id  uuid,
  p_token_sha256  bytea
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_recipient_id is null or p_token_sha256 is null then
    return false;
  end if;

  update public.profiles
     set expo_push_token = null
   where id = p_recipient_id
     and expo_push_token is not null
     and extensions.digest(expo_push_token, 'sha256') = p_token_sha256;

  return found;
end;
$$;

comment on function public.clear_push_token_if_matches(uuid, bytea) is
'Leert profiles.expo_push_token nur, wenn SHA-256 des aktuell hinterlegten Tokens dem '
'übergebenen Hash entspricht — ein altes DeviceNotRegistered löscht nie einen neu '
'registrierten Token (F2, 20261018000000). Nur Service Role.';

revoke all on function public.clear_push_token_if_matches(uuid, bytea) from public, anon, authenticated;
grant execute on function public.clear_push_token_if_matches(uuid, bytea) to service_role;


-- ── 3. complete_notification_delivery: optionale Ticket-Daten ──
-- Alte 4-Parameter-Signatur muss weg: neben einer 6-Parameter-Variante mit
-- Defaults wäre jeder 4-Parameter-Aufruf mehrdeutig.
drop function if exists public.complete_notification_delivery(uuid, text, text, int);

create or replace function public.complete_notification_delivery(
  delivery_id_input       uuid,
  outcome                 text,
  error_input             text    default null,
  max_attempts            int     default 5,
  expo_ticket_id_input    text    default null,
  push_token_sha256_input bytea   default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts   int;
  v_created_at timestamptz;
  v_ticket     text := nullif(btrim(expo_ticket_id_input), '');
begin
  select attempts, created_at into v_attempts, v_created_at
  from public.notification_deliveries
  where id = delivery_id_input;

  if not found then
    return null;
  end if;

  if outcome = 'sent' then
    if v_ticket is not null and push_token_sha256_input is not null then
      begin
        update public.notification_deliveries
          set status = 'sent', sent_at = now(), last_error = null,
              expo_ticket_id        = v_ticket,
              push_token_sha256     = push_token_sha256_input,
              receipt_status        = 'pending',
              receipt_error         = null,
              receipt_attempts      = 0,
              receipt_checked_at    = null,
              receipt_claimed_at    = null,
              next_receipt_check_at = now() + interval '15 minutes'
          where id = delivery_id_input;
        return 'sent';
      exception
        when unique_violation then
          null;  -- doppelte Ticket-ID: unten ohne Receipt-Daten als sent markieren
      end;
    end if;

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
    -- Älter als die TTL: terminal verfallen, nie wieder fällig (F1).
    if v_created_at <= now() - public.notification_missing_token_ttl() then
      update public.notification_deliveries
        set status = 'failed',
            last_error = 'missing_push_token_expired',
            attempts = greatest(v_attempts - 1, 0)
        where id = delivery_id_input;
      return 'failed';
    end if;

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

comment on function public.complete_notification_delivery(uuid, text, text, int, text, bytea) is
'Zustandsübergang nach Sendeversuch: sent | permanent_fail | retry(Backoff/failed '
'bei max) | missing_token(pending, fixer Backoff 300 s — ab Alter '
'notification_missing_token_ttl() terminal failed/missing_push_token_expired). '
'Seit 20261018000000 optional expo_ticket_id_input + push_token_sha256_input: '
'bei sent ⇒ receipt_status pending, erste Receipt-Prüfung +15 min. Alte Aufrufer '
'ohne diese Parameter unverändert. sent_at NUR bei Erfolg. Nur Service Role.';

revoke all on function public.complete_notification_delivery(uuid, text, text, int, text, bytea) from public, anon, authenticated;
grant execute on function public.complete_notification_delivery(uuid, text, text, int, text, bytea) to service_role;


-- ── 4. Receipt-Prüfungen claimen ──
create or replace function public.claim_receipt_checks(
  max_rows      int default 1000,
  lease_seconds int default 120
)
returns table (
  delivery_id      uuid,
  expo_ticket_id   text,
  receipt_attempts int,
  sent_at          timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Harte Altersgrenze: 6 h nach sent_at nie mehr abfragen.
  update public.notification_deliveries d
     set receipt_status     = 'unavailable',
         receipt_error      = 'max_age_exceeded',
         receipt_checked_at = now(),
         receipt_claimed_at = null
   where d.id in (
     select x.id
     from public.notification_deliveries x
     where x.receipt_status = 'pending'
       and x.sent_at <= now() - interval '6 hours'
     for update skip locked
   );

  return query
  with due as (
    select d.id
    from public.notification_deliveries d
    where d.receipt_status = 'pending'
      and d.next_receipt_check_at <= now()
      and d.expo_ticket_id is not null
      and (d.receipt_claimed_at is null
           or d.receipt_claimed_at < now() - make_interval(secs => lease_seconds))
    order by d.next_receipt_check_at
    for update skip locked
    limit greatest(least(coalesce(max_rows, 1000), 1000), 1)
  ),
  claimed as (
    update public.notification_deliveries d
       set receipt_claimed_at = now()
      from due
     where d.id = due.id
    returning d.id, d.expo_ticket_id, d.receipt_attempts, d.sent_at
  )
  select c.id, c.expo_ticket_id, c.receipt_attempts, c.sent_at from claimed c;
end;
$$;

comment on function public.claim_receipt_checks(int, int) is
'Receipt-Poller (F2, 20261018000000): verfällt pending-Receipts 6 h nach sent_at '
'(unavailable/max_age_exceeded), nimmt dann fällige Prüfungen atomar (FOR UPDATE SKIP '
'LOCKED, max. 1000 = Expo-Limit je getReceipts) und setzt eine Lease. Nur Service Role.';

revoke all on function public.claim_receipt_checks(int, int) from public, anon, authenticated;
grant execute on function public.claim_receipt_checks(int, int) to service_role;


-- ── 5. Receipt-Ergebnis verbuchen ──
create or replace function public.complete_receipt_check(
  p_delivery_id uuid,
  p_outcome     text,
  p_error       text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row   public.notification_deliveries%rowtype;
  v_err   text;
  v_miss  int;
begin
  if p_outcome not in ('ok', 'error', 'missing', 'infra') then
    raise exception 'Unknown receipt outcome: %', p_outcome;
  end if;

  -- Nur eine geclaimte, noch offene Prüfung wird verbucht ⇒ idempotent.
  select * into v_row
  from public.notification_deliveries
  where id = p_delivery_id
    and receipt_status = 'pending'
    and receipt_claimed_at is not null
  for update;

  if not found then
    return (select receipt_status from public.notification_deliveries where id = p_delivery_id);
  end if;

  v_err := left(regexp_replace(coalesce(nullif(btrim(p_error), ''), 'unknown'),
                               'Expo(nent)?PushToken\[[^]]*\]', 'ExponentPushToken[…]', 'g'), 200);

  if p_outcome = 'ok' then
    update public.notification_deliveries
       set receipt_status = 'ok', receipt_error = null,
           receipt_checked_at = now(), receipt_claimed_at = null
     where id = p_delivery_id;
    return 'ok';

  elsif p_outcome = 'error' then
    update public.notification_deliveries
       set receipt_status = 'error', receipt_error = v_err,
           receipt_checked_at = now(), receipt_claimed_at = null
     where id = p_delivery_id;

    if v_err = 'DeviceNotRegistered' then
      perform public.clear_push_token_if_matches(v_row.recipient_id, v_row.push_token_sha256);
    end if;
    return 'error';

  elsif p_outcome = 'missing' then
    v_miss := v_row.receipt_attempts + 1;
    if v_miss >= 4 or v_row.sent_at <= now() - interval '6 hours' then
      update public.notification_deliveries
         set receipt_status = 'unavailable',
             receipt_error = case when v_miss >= 4 then 'receipt_missing' else 'max_age_exceeded' end,
             receipt_attempts = v_miss,
             receipt_checked_at = now(), receipt_claimed_at = null
       where id = p_delivery_id;
      return 'unavailable';
    end if;

    update public.notification_deliveries
       set receipt_attempts = v_miss,
           next_receipt_check_at = v_row.sent_at + case v_miss
                                                     when 1 then interval '30 minutes'
                                                     when 2 then interval '60 minutes'
                                                     else interval '120 minutes' end,
           receipt_checked_at = now(), receipt_claimed_at = null
     where id = p_delivery_id;
    return 'pending';

  else  -- infra: Netz/5xx/429/unlesbar — kein Fehlen, nur +5 min
    if v_row.sent_at <= now() - interval '6 hours' then
      update public.notification_deliveries
         set receipt_status = 'unavailable', receipt_error = 'max_age_exceeded',
             receipt_checked_at = now(), receipt_claimed_at = null
       where id = p_delivery_id;
      return 'unavailable';
    end if;

    update public.notification_deliveries
       set next_receipt_check_at = now() + interval '5 minutes',
           receipt_error = 'infra: ' || v_err,
           receipt_checked_at = now(), receipt_claimed_at = null
     where id = p_delivery_id;
    return 'pending';
  end if;
end;
$$;

comment on function public.complete_receipt_check(uuid, text, text) is
'Verbucht ein Expo-Receipt (F2, 20261018000000): ok | error (terminal; '
'DeviceNotRegistered ⇒ clear_push_token_if_matches) | missing (+30/60/120 min ab '
'sent_at, 4. Fehlen ⇒ unavailable) | infra (+5 min, kein Fehlen). Harte Grenze 6 h '
'nach sent_at. Nur geclaimte pending-Zeilen ⇒ idempotent. Kein erneuter Versand. '
'Nur Service Role.';

revoke all on function public.complete_receipt_check(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_receipt_check(uuid, text, text) to service_role;
