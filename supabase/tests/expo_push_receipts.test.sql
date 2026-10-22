-- =========================================================
-- TEST: Expo-Push-Receipts (Migrationen 20261018000000/01/02)
-- =========================================================
-- Prüft:
--   * complete_notification_delivery: alte Aufrufer unverändert, Ticket +
--     SHA-256 ⇒ receipt_status pending (+15 min), doppelte Ticket-ID blockiert
--     'sent' nie
--   * claim_receipt_checks: Fälligkeit, Lease, kein Doppel-Claim, 6-h-Grenze
--   * complete_receipt_check: ok / alle Fehlercodes / missing-Zeitplan /
--     4. Fehlen / infra / Idempotenz
--   * clear_push_token_if_matches: nur bei Hash-Gleichheit; altes
--     DeviceNotRegistered nach Token-Wechsel lässt den neuen Token stehen
--   * Monitoring H10–H15 + H5 ohne Poller-Requests
--   * kick_receipt_poller, Cron, Aufbewahrung, Grants
-- F1/F3 laufen unverändert in ihren eigenen Testdateien.
-- Transaktional (BEGIN … ROLLBACK). Der in K2 eingereihte pg_net-Request wird
-- mit zurückgerollt (pg_net liest nur committete Queue-Zeilen).
--
-- Lokal:
--   docker exec -i supabase_db_cleaning-employee-app-2 psql -U postgres \
--     -d postgres -v ON_ERROR_STOP=1 < supabase/tests/expo_push_receipts.test.sql
-- =========================================================

begin;

create temporary table _r (case_no text, beschreibung text, erwartet text, ergebnis text) on commit drop;
create function pg_temp.r(p_no text, p_desc text, p_exp text, p_got text) returns void language sql as $$
  insert into _r values (p_no, p_desc, p_exp, coalesce(p_got, '<null>'));
$$;

-- ── Fixdaten (ID-Raum 93xxxxxx…) ──
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','93100000-0000-0000-0000-000000000001','authenticated','authenticated','epr-a@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','93100000-0000-0000-0000-000000000002','authenticated','authenticated','epr-e@x.test','{}');
insert into public.companies (id, name, slug) values
 ('93000000-0000-0000-0000-000000000001','EPR Firma','epr-firma-test');
insert into public.profiles (id, role, company_id, is_active, expo_push_token, full_name) values
 ('93100000-0000-0000-0000-000000000001','admin',   '93000000-0000-0000-0000-000000000001',true,'ExponentPushToken[eprAdmin]','Admin EPR'),
 ('93100000-0000-0000-0000-000000000002','employee','93000000-0000-0000-0000-000000000001',true,'ExponentPushToken[eprOld]','Mitarbeiter EPR')
on conflict (id) do update set role=excluded.role, company_id=excluded.company_id,
  is_active=excluded.is_active, expo_push_token=excluded.expo_push_token;

-- Delivery im Zustand processing (wie direkt nach dem Claim des Dispatchers).
create function pg_temp.d(p_recipient uuid default '93100000-0000-0000-0000-000000000002') returns uuid
language plpgsql as $$
declare v_o uuid; v_d uuid;
begin
  insert into public.notification_outbox (company_id, event_type, employee_id, employee_name, entity_type, entity_id, fanned_out_at)
  values ('93000000-0000-0000-0000-000000000001', 'vacation_approved', p_recipient, 'EPR', 'absence', gen_random_uuid(), now())
  returning id into v_o;
  insert into public.notification_deliveries (outbox_id, company_id, recipient_id, status, attempts, claimed_at)
  values (v_o, '93000000-0000-0000-0000-000000000001', p_recipient, 'processing', 1, now())
  returning id into v_d;
  return v_d;
end $$;

-- Ticket-Versand wie der neue Dispatcher (Ticket-ID + SHA-256 des Tokens).
create function pg_temp.sent(p_id uuid, p_ticket text, p_token text) returns text language sql as $$
  select public.complete_notification_delivery(p_id, 'sent', null, 5, p_ticket, extensions.digest(p_token, 'sha256'));
$$;

-- Receipt-Prüfung sofort fällig machen und genau diese Zeile claimen.
create function pg_temp.claim_one(p_id uuid) returns int language plpgsql as $$
declare n int;
begin
  update public.notification_deliveries set next_receipt_check_at = now() - interval '1 second' where id = p_id;
  select count(*) into n from public.claim_receipt_checks(1000, 120) c where c.delivery_id = p_id;
  return n;
end $$;

create function pg_temp.st(p_id uuid) returns text language sql as $$
  select concat_ws('|', status, coalesce(receipt_status, '<null>'), coalesce(receipt_error, '<null>'))
  from public.notification_deliveries where id = p_id;
$$;

-- =========================================================
-- A — complete_notification_delivery
-- =========================================================
do $$
declare v uuid; d record;
begin
  -- A1: alter Aufrufer (4 Parameter, positional) ⇒ exakt wie vor F2
  v := pg_temp.d();
  perform public.complete_notification_delivery(v, 'sent', null, 5);
  select * into d from public.notification_deliveries where id = v;
  perform pg_temp.r('A1', 'alter Aufruf (4 Param.): sent, keine Receipt-Daten',
    'sent|<null>|<null>|<null>|0', concat_ws('|', d.status, coalesce(d.receipt_status,'<null>'),
      coalesce(d.expo_ticket_id,'<null>'), coalesce(encode(d.push_token_sha256,'hex'),'<null>'), d.receipt_attempts));

  -- A1b: alter Aufruf mit 2 Parametern + retry-Pfad unverändert
  v := pg_temp.d();
  perform public.complete_notification_delivery(v, 'retry', 'Expo push HTTP 503');
  select * into d from public.notification_deliveries where id = v;
  perform pg_temp.r('A1b', 'retry ohne neue Param.: pending, Backoff 60 s, keine Receipt-Daten',
    'pending|<null>|true', concat_ws('|', d.status, coalesce(d.receipt_status,'<null>'),
      (d.next_attempt_at between now() + interval '55 seconds' and now() + interval '65 seconds')::text));

  -- A2: Ticket + Hash ⇒ Receipt pending, +15 min, Hash = SHA-256 des Tokens
  v := pg_temp.d();
  perform pg_temp.sent(v, 'epr-ticket-A2', 'ExponentPushToken[eprOld]');
  select * into d from public.notification_deliveries where id = v;
  perform pg_temp.r('A2', 'sent mit Ticket: status sent, receipt pending, Ticket + Hash, +15 min',
    'sent|pending|epr-ticket-A2|true|true|<null>',
    concat_ws('|', d.status, d.receipt_status, d.expo_ticket_id,
      (d.push_token_sha256 = extensions.digest('ExponentPushToken[eprOld]', 'sha256'))::text,
      (d.next_receipt_check_at between now() + interval '14 minutes' and now() + interval '16 minutes')::text,
      coalesce(d.last_error,'<null>')));
  perform pg_temp.r('A2b', 'kein Klartext-Token gespeichert (bytea, 32 Byte)', '32', length(d.push_token_sha256)::text);

  -- A3: nur Ticket ohne Hash ⇒ keine Receipt-Daten
  v := pg_temp.d();
  perform public.complete_notification_delivery(v, 'sent', null, 5, 'epr-ticket-A3', null);
  perform pg_temp.r('A3', 'Ticket ohne Hash: sent ohne Receipt', 'sent|<null>|<null>', pg_temp.st(v));

  -- A4: doppelte Ticket-ID ⇒ trotzdem sent (sonst Reclaim ⇒ Doppelversand)
  v := pg_temp.d();
  perform pg_temp.r('A4', 'doppelte Ticket-ID: Rückgabe sent, Zeile sent ohne Receipt', 'sent|sent|<null>|<null>',
    concat_ws('|', pg_temp.sent(v, 'epr-ticket-A2', 'ExponentPushToken[eprOld]'), pg_temp.st(v)));

  -- A5: andere Outcomes ignorieren Ticket-Parameter
  v := pg_temp.d();
  perform public.complete_notification_delivery(v, 'permanent_fail', 'DeviceNotRegistered', 5, 'epr-ticket-A5',
                                               extensions.digest('x', 'sha256'));
  select * into d from public.notification_deliveries where id = v;
  perform pg_temp.r('A5', 'permanent_fail mit Ticket-Param.: failed, keine Receipt-Daten', 'failed|<null>|<null>',
    concat_ws('|', d.status, coalesce(d.receipt_status,'<null>'), coalesce(d.expo_ticket_id,'<null>')));
end $$;

-- =========================================================
-- B — claim_receipt_checks
-- =========================================================
do $$
declare v uuid; n int; d record;
begin
  v := pg_temp.d();
  perform pg_temp.sent(v, 'epr-ticket-B', 'ExponentPushToken[eprOld]');
  select count(*) into n from public.claim_receipt_checks(1000, 120) c where c.delivery_id = v;
  perform pg_temp.r('B1', 'noch nicht fällig (+15 min) ⇒ nicht geclaimt', '0', n::text);

  perform pg_temp.r('B2', 'fällig ⇒ geclaimt', '1', pg_temp.claim_one(v)::text);
  select * into d from public.notification_deliveries where id = v;
  perform pg_temp.r('B3', 'Lease gesetzt, weiterhin pending', 'pending|true',
    concat_ws('|', d.receipt_status, (d.receipt_claimed_at is not null)::text));
  select count(*) into n from public.claim_receipt_checks(1000, 120) c where c.delivery_id = v;
  perform pg_temp.r('B4', 'zweiter Claim während Lease ⇒ nichts', '0', n::text);
  update public.notification_deliveries set receipt_claimed_at = now() - interval '121 seconds' where id = v;
  select count(*) into n from public.claim_receipt_checks(1000, 120) c where c.delivery_id = v;
  perform pg_temp.r('B5', 'Lease abgelaufen (Poller abgestürzt) ⇒ erneut claimbar', '1', n::text);

  -- B6: Altbestand (sent ohne Ticket) wird nie geclaimt
  v := pg_temp.d();
  perform public.complete_notification_delivery(v, 'sent');
  select count(*) into n from public.claim_receipt_checks(1000, 120) c where c.delivery_id = v;
  perform pg_temp.r('B6', 'Altbestand ohne Ticket: nicht geclaimt, receipt null', '0|sent|<null>|<null>',
    n::text || '|' || pg_temp.st(v));

  -- B7: 6-h-Grenze im Claim-Vorlauf
  v := pg_temp.d();
  perform pg_temp.sent(v, 'epr-ticket-B7', 'ExponentPushToken[eprOld]');
  update public.notification_deliveries
     set sent_at = now() - interval '7 hours', next_receipt_check_at = now() - interval '1 minute'
   where id = v;
  select count(*) into n from public.claim_receipt_checks(1000, 120) c where c.delivery_id = v;
  perform pg_temp.r('B7', 'pending 7 h nach sent_at ⇒ unavailable/max_age_exceeded, nicht geclaimt',
    '0|sent|unavailable|max_age_exceeded', n::text || '|' || pg_temp.st(v));
end $$;

-- =========================================================
-- C — complete_receipt_check: Ergebnisse
-- =========================================================
do $$
declare v uuid; r text; code text; i int := 0;
begin
  -- C1: ok
  v := pg_temp.d();
  perform pg_temp.sent(v, 'epr-ticket-C1', 'ExponentPushToken[eprOld]');
  perform pg_temp.claim_one(v);
  r := public.complete_receipt_check(v, 'ok', null);
  perform pg_temp.r('C1', 'ok ⇒ receipt ok, status bleibt sent, Lease frei', 'ok|sent|ok|<null>|true',
    r || '|' || pg_temp.st(v) || '|' ||
    (select (receipt_claimed_at is null and receipt_checked_at is not null)::text from public.notification_deliveries where id = v));

  -- C2: Fehlercodes ⇒ terminal error, status sent, Token unverändert
  foreach code in array array['MessageTooBig','MessageRateExceeded','InvalidCredentials','MismatchSenderId','SomethingNew'] loop
    i := i + 1;
    v := pg_temp.d();
    perform pg_temp.sent(v, 'epr-ticket-C2-' || i, 'ExponentPushToken[eprOld]');
    perform pg_temp.claim_one(v);
    r := public.complete_receipt_check(v, 'error', code);
    perform pg_temp.r('C2.' || i, code || ' ⇒ terminal error, Token bleibt, kein erneuter Versand (status sent)',
      'error|sent|error|' || code || '|ExponentPushToken[eprOld]|0',
      concat_ws('|', r, pg_temp.st(v),
        (select expo_push_token from public.profiles where id = '93100000-0000-0000-0000-000000000002'),
        (select count(*) from public.claim_receipt_checks(1000, 120) c where c.delivery_id = v)));
  end loop;

  -- C3: Fehlertext mit Token wird maskiert
  v := pg_temp.d();
  perform pg_temp.sent(v, 'epr-ticket-C3', 'ExponentPushToken[eprOld]');
  perform pg_temp.claim_one(v);
  perform public.complete_receipt_check(v, 'error', '"ExponentPushToken[secretXYZ]" broken');
  perform pg_temp.r('C3', 'Token im Fehlertext maskiert', 'false',
    (select (receipt_error like '%secretXYZ%')::text from public.notification_deliveries where id = v));

  -- C4: Idempotenz — erneutes Verbuchen ohne Claim ist No-op
  r := public.complete_receipt_check(v, 'ok', null);
  perform pg_temp.r('C4', 'zweites Verbuchen (nicht geclaimt) ⇒ No-op, bleibt error', 'error|sent|error',
    r || '|' || split_part(pg_temp.st(v), '|', 1) || '|' || split_part(pg_temp.st(v), '|', 2));

  -- C5: unbekanntes outcome ⇒ Exception
  begin
    perform public.complete_receipt_check(v, 'resend', null);
    perform pg_temp.r('C5', 'unbekanntes outcome wirft', 'raised', 'no_raise');
  exception when others then
    perform pg_temp.r('C5', 'unbekanntes outcome wirft', 'raised', 'raised');
  end;
end $$;

-- =========================================================
-- D — DeviceNotRegistered + bedingte Token-Bereinigung
-- =========================================================
do $$
declare v uuid; r text;
begin
  -- D1: derselbe Token noch hinterlegt ⇒ wird geleert
  v := pg_temp.d();
  perform pg_temp.sent(v, 'epr-ticket-D1', 'ExponentPushToken[eprOld]');
  perform pg_temp.claim_one(v);
  r := public.complete_receipt_check(v, 'error', 'DeviceNotRegistered');
  perform pg_temp.r('D1', 'DNR, Token unverändert ⇒ error, Token geleert, status sent', 'error|sent|error|DeviceNotRegistered|<null>',
    concat_ws('|', r, pg_temp.st(v),
      coalesce((select expo_push_token from public.profiles where id = '93100000-0000-0000-0000-000000000002'), '<null>')));

  -- D2: Token-Wechsel-Race — altes DNR nach neuer Registrierung
  update public.profiles set expo_push_token = 'ExponentPushToken[eprOld]' where id = '93100000-0000-0000-0000-000000000002';
  v := pg_temp.d();
  perform pg_temp.sent(v, 'epr-ticket-D2', 'ExponentPushToken[eprOld]');
  -- Nutzer installiert neu ⇒ neuer Token über den echten RPC
  perform set_config('request.jwt.claims', '{"sub":"93100000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  set local role authenticated;
  perform public.update_my_push_token('ExponentPushToken[eprNew]', null, null);
  reset role;
  perform pg_temp.claim_one(v);
  r := public.complete_receipt_check(v, 'error', 'DeviceNotRegistered');
  perform pg_temp.r('D2', 'altes DNR nach Token-Wechsel ⇒ error verbucht, NEUER Token bleibt', 'error|ExponentPushToken[eprNew]',
    r || '|' || coalesce((select expo_push_token from public.profiles where id = '93100000-0000-0000-0000-000000000002'), '<null>'));

  -- D3: clear_push_token_if_matches direkt
  perform pg_temp.r('D3', 'falscher Hash ⇒ false, Token bleibt', 'false|ExponentPushToken[eprNew]',
    public.clear_push_token_if_matches('93100000-0000-0000-0000-000000000002', extensions.digest('ExponentPushToken[eprOld]', 'sha256'))::text
    || '|' || (select expo_push_token from public.profiles where id = '93100000-0000-0000-0000-000000000002'));
  -- eigene Anweisung: dieselbe Anweisung sähe das Update der Funktion nicht (Snapshot)
  r := public.clear_push_token_if_matches('93100000-0000-0000-0000-000000000002', extensions.digest('ExponentPushToken[eprNew]', 'sha256'))::text;
  perform pg_temp.r('D4', 'passender Hash ⇒ true, Token geleert', 'true|<null>',
    r || '|' || coalesce((select expo_push_token from public.profiles where id = '93100000-0000-0000-0000-000000000002'), '<null>'));
  perform pg_temp.r('D5', 'NULL-Hash/fremdes Profil ⇒ false', 'false|false',
    public.clear_push_token_if_matches('93100000-0000-0000-0000-000000000001', null)::text || '|' ||
    public.clear_push_token_if_matches('93100000-0000-0000-0000-000000000001', extensions.digest('ExponentPushToken[eprNew]', 'sha256'))::text);
  update public.profiles set expo_push_token = 'ExponentPushToken[eprOld]' where id = '93100000-0000-0000-0000-000000000002';
end $$;

-- =========================================================
-- E — fehlendes Receipt: Zeitplan + 4. Fehlen; infra; 6 h
-- =========================================================
do $$
declare v uuid; r text; d record; v_sent timestamptz;
begin
  v := pg_temp.d();
  perform pg_temp.sent(v, 'epr-ticket-E', 'ExponentPushToken[eprOld]');
  select sent_at into v_sent from public.notification_deliveries where id = v;

  perform pg_temp.claim_one(v);
  r := public.complete_receipt_check(v, 'missing', null);
  select * into d from public.notification_deliveries where id = v;
  perform pg_temp.r('E1', '1. Fehlen ⇒ pending, attempts 1, nächste Prüfung sent+30 min', 'pending|1|true',
    concat_ws('|', r, d.receipt_attempts, (d.next_receipt_check_at = v_sent + interval '30 minutes')::text));

  perform pg_temp.claim_one(v);
  perform public.complete_receipt_check(v, 'missing', null);
  select * into d from public.notification_deliveries where id = v;
  perform pg_temp.r('E2', '2. Fehlen ⇒ sent+60 min', '2|true',
    concat_ws('|', d.receipt_attempts, (d.next_receipt_check_at = v_sent + interval '60 minutes')::text));

  -- infra dazwischen: zählt NICHT als Fehlen, +5 min
  perform pg_temp.claim_one(v);
  r := public.complete_receipt_check(v, 'infra', 'Expo getReceipts HTTP 503');
  select * into d from public.notification_deliveries where id = v;
  perform pg_temp.r('E3', 'infra ⇒ pending, attempts unverändert 2, +5 min, Fehler notiert',
    'pending|2|true|infra: Expo getReceipts HTTP 503',
    concat_ws('|', r, d.receipt_attempts,
      (d.next_receipt_check_at between now() + interval '290 seconds' and now() + interval '310 seconds')::text,
      d.receipt_error));

  perform pg_temp.claim_one(v);
  perform public.complete_receipt_check(v, 'missing', null);
  select * into d from public.notification_deliveries where id = v;
  perform pg_temp.r('E4', '3. Fehlen ⇒ sent+120 min', '3|true',
    concat_ws('|', d.receipt_attempts, (d.next_receipt_check_at = v_sent + interval '120 minutes')::text));

  perform pg_temp.claim_one(v);
  r := public.complete_receipt_check(v, 'missing', null);
  perform pg_temp.r('E5', '4. Fehlen ⇒ unavailable/receipt_missing, nie wieder geclaimt',
    'unavailable|sent|unavailable|receipt_missing|0',
    concat_ws('|', r, pg_temp.st(v), pg_temp.claim_one(v)));

  -- E6: infra kurz vor der 6-h-Grenze überschritten ⇒ unavailable
  v := pg_temp.d();
  perform pg_temp.sent(v, 'epr-ticket-E6', 'ExponentPushToken[eprOld]');
  perform pg_temp.claim_one(v);
  update public.notification_deliveries set sent_at = now() - interval '6 hours 1 minute' where id = v;
  r := public.complete_receipt_check(v, 'infra', 'network');
  perform pg_temp.r('E6', 'infra nach 6 h ⇒ unavailable/max_age_exceeded', 'unavailable|sent|unavailable|max_age_exceeded',
    r || '|' || pg_temp.st(v));
end $$;

-- =========================================================
-- M — Monitoring H10–H15 und H5 ohne Poller-Requests
-- =========================================================
create temporary table _t (t timestamptz) on commit drop;
insert into _t values (now() + interval '1 day');
create sequence pg_temp.hid start 9200000001;
create function pg_temp.lvl(p_key text) returns text language sql as $$
  select h.level from public.notification_health((select t from _t)) h where h.check_key = p_key;
$$;
create function pg_temp.mrow(p_rs text, p_err text, p_checked interval, p_next interval default null) returns void
language plpgsql as $$
declare v uuid := pg_temp.d(); v_t timestamptz := (select t from _t);
begin
  update public.notification_deliveries
     set status = 'sent', sent_at = v_t - interval '2 hours', receipt_status = p_rs, receipt_error = p_err,
         receipt_checked_at = v_t - p_checked, next_receipt_check_at = v_t - coalesce(p_next, interval '-1 hour'),
         expo_ticket_id = 'epr-m-' || v::text
   where id = v;
end $$;
create function pg_temp.reset_m() returns void language sql as $$
  delete from public.notification_deliveries
   where company_id = '93000000-0000-0000-0000-000000000001';
$$;
create function pg_temp.resp(p_code int, p_ago interval, p_poller boolean) returns void language plpgsql as $$
declare v_id bigint := nextval('pg_temp.hid');
begin
  insert into net._http_response (id, status_code, content, timed_out, created)
  values (v_id, p_code, '{}', false, (select t from _t) - p_ago);
  if p_poller then
    insert into public.notification_receipt_poll_requests (request_id, requested_at) values (v_id, (select t from _t) - p_ago);
  end if;
end $$;

-- Sauberer Zustand für die Fixfirma (die Prüfungen sind global, daher nur
-- Delta-freie Fälle mit eindeutigen Schwellen) — fremde Receipt-Zeilen leeren:
update public.notification_deliveries set receipt_status = null where company_id <> '93000000-0000-0000-0000-000000000001';
select pg_temp.reset_m();

select pg_temp.mrow('pending', null, '1 hour', '16 minutes');
select pg_temp.r('M10a', 'Receipt-Prüfung 16 min überfällig ⇒ warning', 'warning', pg_temp.lvl('h10_receipt_backlog'));
select pg_temp.reset_m();
select pg_temp.mrow('pending', null, '1 hour', '61 minutes');
select pg_temp.r('M10b', '61 min überfällig ⇒ critical', 'critical', pg_temp.lvl('h10_receipt_backlog'));
select pg_temp.reset_m();
select pg_temp.mrow('pending', null, '1 hour', '10 minutes');
select pg_temp.r('M10c', '10 min überfällig ⇒ ok', 'ok', pg_temp.lvl('h10_receipt_backlog'));
select pg_temp.reset_m();

select pg_temp.mrow('unavailable', 'receipt_missing', '1 hour');
select pg_temp.r('M11a', '1 unavailable ⇒ warning', 'warning', pg_temp.lvl('h11_receipt_unavailable'));
select pg_temp.mrow('unavailable', 'max_age_exceeded', '1 hour') from generate_series(1, 4);
select pg_temp.r('M11b', '5 unavailable ⇒ critical', 'critical', pg_temp.lvl('h11_receipt_unavailable'));
select pg_temp.reset_m();

select pg_temp.mrow('error', 'DeviceNotRegistered', '1 hour') from generate_series(1, 2);
select pg_temp.r('M12a', '2 Receipt-DNR ⇒ ok', 'ok', pg_temp.lvl('h12_receipt_device_not_registered'));
select pg_temp.mrow('error', 'DeviceNotRegistered', '1 hour');
select pg_temp.r('M12b', '3 Receipt-DNR ⇒ warning', 'warning', pg_temp.lvl('h12_receipt_device_not_registered'));
select pg_temp.mrow('error', 'DeviceNotRegistered', '1 hour') from generate_series(1, 7);
select pg_temp.r('M12c', '10 Receipt-DNR ⇒ critical', 'critical', pg_temp.lvl('h12_receipt_device_not_registered'));
select pg_temp.r('M12d', 'DNR zählt nicht als sonstiger Fehler', 'ok', pg_temp.lvl('h14_receipt_other_errors'));
select pg_temp.reset_m();

select pg_temp.mrow('error', 'InvalidCredentials', '2 hours');
select pg_temp.r('M13a', 'InvalidCredentials ⇒ critical', 'critical', pg_temp.lvl('h13_push_credentials'));
select pg_temp.reset_m();
select pg_temp.mrow('error', 'MismatchSenderId', '2 hours');
select pg_temp.r('M13b', 'MismatchSenderId ⇒ critical, nicht in H14', 'critical|ok',
  pg_temp.lvl('h13_push_credentials') || '|' || pg_temp.lvl('h14_receipt_other_errors'));
select pg_temp.reset_m();

select pg_temp.mrow('error', 'MessageRateExceeded', '3 hours');
select pg_temp.r('M14a', '1 sonstiger Receipt-Fehler/24 h ⇒ warning', 'warning', pg_temp.lvl('h14_receipt_other_errors'));
select pg_temp.mrow('error', 'MessageTooBig', '10 minutes') from generate_series(1, 5);
select pg_temp.r('M14b', '5 sonstige in 1 h ⇒ critical', 'critical', pg_temp.lvl('h14_receipt_other_errors'));
select pg_temp.reset_m();
select pg_temp.mrow('error', 'MessageTooBig', '25 hours') from generate_series(1, 5);
select pg_temp.r('M14c', 'Fehler älter als 24 h ⇒ ok', 'ok', pg_temp.lvl('h14_receipt_other_errors'));
select pg_temp.reset_m();

select pg_temp.resp(200, '1 minute', true);
select pg_temp.r('M15a', 'Poller-200 vor 1 min ⇒ ok', 'ok', pg_temp.lvl('h15_receipt_poller'));
delete from net._http_response where created > now() + interval '1 hour';
select pg_temp.resp(200, '16 minutes', true);
select pg_temp.resp(500, '1 minute', true);
select pg_temp.r('M15b', 'letzte Poller-200 vor 16 min (danach 500) ⇒ warning', 'warning', pg_temp.lvl('h15_receipt_poller'));
delete from net._http_response where created > now() + interval '1 hour';
select pg_temp.resp(200, '31 minutes', true);
select pg_temp.r('M15c', 'Poller-200 vor 31 min ⇒ critical', 'critical', pg_temp.lvl('h15_receipt_poller'));
-- H5: frische Poller-200 dürfen die Dispatcher-Gesundheit nicht schönen.
select pg_temp.resp(200, '11 minutes', false);   -- Dispatcher
select pg_temp.resp(200, '10 seconds', true);    -- Poller
select pg_temp.r('M5', 'H5 ignoriert Poller: Dispatcher-200 vor 11 min ⇒ critical, H15 ok', 'critical|ok',
  pg_temp.lvl('h5_dispatcher_http') || '|' || pg_temp.lvl('h15_receipt_poller'));
delete from net._http_response where created > now() + interval '1 hour';
select pg_temp.resp(200, '20 seconds', false);
select pg_temp.resp(500, '15 seconds', true);
select pg_temp.resp(500, '10 seconds', true);
select pg_temp.resp(500, '5 seconds', true);
select pg_temp.r('M5b', 'drei Poller-500 zählen nicht als Dispatcher-Fehlerserie ⇒ H5 ok', 'ok', pg_temp.lvl('h5_dispatcher_http'));
delete from net._http_response where created > now() + interval '1 hour';

-- =========================================================
-- K — kick_receipt_poller, Cron, Aufbewahrung, Grants
-- =========================================================
do $$
declare v_req bigint; v_url text;
begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret('https://example.invalid', 'project_url', 'test only');
  end if;
  if not exists (select 1 from vault.secrets where name = 'dispatch_sweeper_secret') then
    perform vault.create_secret('test-only-secret', 'dispatch_sweeper_secret', 'test only');
  end if;
  v_req := public.kick_receipt_poller();
  select q.url into v_url from net.http_request_queue q where q.id = v_req;
  perform pg_temp.r('K2', 'kick: Request auf /functions/v1/poll-push-receipts eingereiht und protokolliert', 'true|1',
    concat_ws('|', (v_url like '%/functions/v1/poll-push-receipts')::text,
      (select count(*) from public.notification_receipt_poll_requests where request_id = v_req)));

  delete from vault.secrets where name in ('project_url', 'dispatch_sweeper_secret');
  perform pg_temp.r('K1', 'kick ohne Secrets ⇒ kein Request', '<null>', public.kick_receipt_poller()::text);

  insert into public.notification_receipt_poll_requests (request_id, requested_at) values (9299999999, now() - interval '8 days');
  perform public.purge_monitoring_history(interval '10000 days', interval '10000 days');
  perform pg_temp.r('K3', 'Aufbewahrung: Poller-Request-IDs > 7 Tage entfernt, frische bleiben', '0|1',
    concat_ws('|', (select count(*) from public.notification_receipt_poll_requests where request_id = 9299999999),
                   (select count(*) from public.notification_receipt_poll_requests where request_id = v_req)));
end $$;

select pg_temp.r('K4', 'Cron notification-receipt-poller alle 5 min (versetzt)', '2-59/5 * * * *',
  (select schedule from cron.job where jobname = 'notification-receipt-poller'));
select pg_temp.r('K5', 'Grants: nur service_role', 'f|f|f|f|f|f|t|t|t|t|t',
  concat_ws('|',
    has_function_privilege('authenticated', 'public.claim_receipt_checks(int,int)', 'execute'),
    has_function_privilege('authenticated', 'public.complete_receipt_check(uuid,text,text)', 'execute'),
    has_function_privilege('authenticated', 'public.clear_push_token_if_matches(uuid,bytea)', 'execute'),
    has_function_privilege('anon', 'public.clear_push_token_if_matches(uuid,bytea)', 'execute'),
    has_function_privilege('authenticated', 'public.kick_receipt_poller()', 'execute'),
    has_table_privilege('authenticated', 'public.notification_receipt_poll_requests', 'select'),
    has_function_privilege('service_role', 'public.claim_receipt_checks(int,int)', 'execute'),
    has_function_privilege('service_role', 'public.complete_receipt_check(uuid,text,text)', 'execute'),
    has_function_privilege('service_role', 'public.clear_push_token_if_matches(uuid,bytea)', 'execute'),
    has_function_privilege('service_role', 'public.complete_notification_delivery(uuid,text,text,int,text,bytea)', 'execute'),
    has_function_privilege('service_role', 'public.kick_receipt_poller()', 'execute')));
select pg_temp.r('K6', 'alte 4-Param.-Signatur entfernt (keine Mehrdeutigkeit)', 'true',
  (to_regprocedure('public.complete_notification_delivery(uuid,text,text,int)') is null)::text);

-- ── Ergebnis ──
select case_no, beschreibung, erwartet, ergebnis,
       case when erwartet = ergebnis then 'PASS' else 'FAIL' end as verdict
from _r order by case_no;

do $$
declare v_fail int; v_total int;
begin
  select count(*) filter (where erwartet is distinct from ergebnis), count(*) into v_fail, v_total from _r;
  raise notice 'TESTRESULT expo_push_receipts: % / % PASS', v_total - v_fail, v_total;
  if v_fail > 0 then
    raise exception 'TESTRESULT expo_push_receipts: % FAIL', v_fail;
  end if;
end $$;

rollback;
