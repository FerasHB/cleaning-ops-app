-- =========================================================
-- TEST: Missing-Token-Verfall (Migration 20261016000000)
-- =========================================================
-- Prüft die 24-h-Regel für Deliveries ohne Push-Token:
--   * jung + kein Token  ⇒ zurückgestellt (pending, +300 s), nicht failed
--   * alt  + kein Token  ⇒ terminal failed / missing_push_token_expired
--   * jung + später Token (update_my_push_token) ⇒ fällig, claimbar, sendbar
--   * alt  + später Token ⇒ bleibt terminal, nie re-armed, nie geclaimt
--   * alt  + Token per direktem profiles-Update (ohne RPC) ⇒ Claim verfällt
--     die Zeile, statt sie zu senden
--   * retry/permanent_fail/sent unverändert
--   * update_my_push_token fasst nur Zeilen des Aufrufers an
--
-- Deliveries entstehen über den echten Helper enqueue_absence_notification
-- (Produktionspfad für Mitarbeiter-gerichtete Events). Alter wird durch
-- Zurückdatieren von created_at simuliert. Claims laufen firmengefiltert,
-- damit fremde Zeilen der DB den Test nicht beeinflussen.
-- Transaktional (BEGIN … ROLLBACK), keine Rückstände.
-- Concurrency (parallele Claims): notification_missing_token_expiry_concurrency.test.sh
--
-- Lokal:
--   docker exec -i supabase_db_cleaning-employee-app-2 psql -U postgres \
--     -d postgres -v ON_ERROR_STOP=1 < supabase/tests/notification_missing_token_expiry.test.sql
-- =========================================================

begin;

-- ── Fixdaten (eigener ID-Raum 98xxxxxx…) ──
-- Firma MTE = 98000000…0001
-- Admin A    = 98100000…0001 (Token vorhanden)
-- Employee E1 = 98100000…0002 (KEIN Token)
-- Employee E2 = 98100000…0003 (KEIN Token, Kontrollperson für Fremdzeilen)
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','98100000-0000-0000-0000-000000000001','authenticated','authenticated','mte-a1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','98100000-0000-0000-0000-000000000002','authenticated','authenticated','mte-e1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','98100000-0000-0000-0000-000000000003','authenticated','authenticated','mte-e2@x.test','{}');

insert into public.companies (id, name, slug) values
 ('98000000-0000-0000-0000-000000000001','MTE Firma','mte-firma-test');

insert into public.profiles (id, role, company_id, is_active, expo_push_token, full_name, locale) values
 ('98100000-0000-0000-0000-000000000001','admin',   '98000000-0000-0000-0000-000000000001',true,'ExponentPushToken[mteA]', 'Admin MTE','de'),
 ('98100000-0000-0000-0000-000000000002','employee','98000000-0000-0000-0000-000000000001',true,null,'Erste MTE','de'),
 ('98100000-0000-0000-0000-000000000003','employee','98000000-0000-0000-0000-000000000001',true,null,'Zweiter MTE','de')
on conflict (id) do update set
  role=excluded.role, company_id=excluded.company_id, is_active=excluded.is_active,
  expo_push_token=excluded.expo_push_token, full_name=excluded.full_name, locale=excluded.locale;

create temporary table _r (case_no text, beschreibung text, erwartet text, ergebnis text) on commit drop;
create temporary table _d (k text primary key, id uuid) on commit drop;

-- Hilfsfunktion: eine Mitarbeiter-gerichtete Delivery über den echten Helper anlegen.
create function pg_temp.mk(p_key text, p_recipient uuid, p_age interval) returns uuid
language plpgsql as $$
declare v_outbox uuid; v_del uuid;
begin
  v_outbox := public.enqueue_absence_notification(
    '98000000-0000-0000-0000-000000000001', gen_random_uuid(), 'vacation_approved',
    p_recipient, 'MTE', current_date, current_date, p_recipient);
  select id into v_del from public.notification_deliveries where outbox_id = v_outbox;
  update public.notification_deliveries
     set created_at = now() - p_age, next_attempt_at = now() - p_age
   where id = v_del;
  insert into _d values (p_key, v_del);
  return v_del;
end $$;

-- Hilfsfunktion: alle fälligen Zeilen der Testfirma claimen; liefert claimte IDs.
create function pg_temp.claim() returns setof uuid
language sql as $$
  select c.delivery_id from public.claim_notification_deliveries(
    '98000000-0000-0000-0000-000000000001'::uuid, 50, 120) c;
$$;

-- Simuliert den Dispatcher-Zweig für claimte Zeilen ohne Token.
create function pg_temp.defer_claimed(p_ids uuid[]) returns void
language plpgsql as $$
declare v uuid;
begin
  foreach v in array coalesce(p_ids, '{}') loop
    perform public.complete_notification_delivery(v, 'missing_token', 'missing_push_token', 5);
  end loop;
end $$;

-- =========================================================
-- 1 — Junge Delivery ohne Token: zurückgestellt, nicht failed
-- =========================================================
do $$
declare v uuid; v_ids uuid[]; d record;
begin
  v := pg_temp.mk('fresh', '98100000-0000-0000-0000-000000000002', interval '1 hour');
  select array_agg(x) into v_ids from pg_temp.claim() x;
  perform pg_temp.defer_claimed(v_ids);
  select * into d from public.notification_deliveries where id = v;
  insert into _r values ('1','jung + kein Token: pending/missing_push_token, attempts 0, Retry +~300 s',
    'pending|missing_push_token|0|true',
    concat_ws('|', d.status, d.last_error, d.attempts,
      (d.next_attempt_at between now() + interval '290 seconds' and now() + interval '310 seconds')::text));
end $$;

-- 1b — Grenzfall knapp unter der TTL (23 h 59 min): noch zurückgestellt
do $$
declare v uuid; v_ids uuid[]; d record;
begin
  v := pg_temp.mk('edge', '98100000-0000-0000-0000-000000000002', interval '23 hours 59 minutes');
  select array_agg(x) into v_ids from pg_temp.claim() x;
  perform pg_temp.defer_claimed(v_ids);
  select * into d from public.notification_deliveries where id = v;
  insert into _r values ('1b','23 h 59 min + kein Token: noch pending', 'pending|missing_push_token',
    concat_ws('|', d.status, d.last_error));
end $$;

-- =========================================================
-- 2 — Alte Delivery ohne Token (Dispatcher-Zweig): terminal failed
-- =========================================================
-- Direkt über complete_notification_delivery (der Claim-Vorlauf greift erst
-- bei Zeilen, die schon als missing_push_token markiert sind; eine NEU
-- fällige alte Zeile ohne Marker erreicht diesen Zweig).
do $$
declare v uuid; v_ids uuid[]; d record; r text; v_again int;
begin
  v := pg_temp.mk('old', '98100000-0000-0000-0000-000000000002', interval '25 hours');
  select array_agg(x) into v_ids from pg_temp.claim() x where x = v;
  r := public.complete_notification_delivery(v, 'missing_token', 'missing_push_token', 5);
  select * into d from public.notification_deliveries where id = v;
  update public.notification_deliveries set next_attempt_at = now() - interval '1 minute' where id = v;
  select count(*) into v_again from pg_temp.claim() x where x = v;
  insert into _r values ('2','alt + kein Token: failed/missing_push_token_expired, Rückgabe failed, nie wieder geclaimt',
    'failed|missing_push_token_expired|failed|claimed_once|0',
    concat_ws('|', d.status, d.last_error, r,
      case when v = any(v_ids) then 'claimed_once' else 'not_claimed' end, v_again));
end $$;

-- 2b — Bereits zurückgestellte Zeile altert über die TTL: Claim-Vorlauf verfällt sie
do $$
declare v uuid; d record; v_claimed int;
begin
  v := pg_temp.mk('aged', '98100000-0000-0000-0000-000000000002', interval '25 hours');
  update public.notification_deliveries
     set last_error = 'missing_push_token', next_attempt_at = now() - interval '1 minute'
   where id = v;
  select count(*) into v_claimed from pg_temp.claim() x where x = v;
  select * into d from public.notification_deliveries where id = v;
  insert into _r values ('2b','zurückgestellt + über TTL: Claim verfällt statt claimt',
    'failed|missing_push_token_expired|0', concat_ws('|', d.status, d.last_error, v_claimed));
end $$;

-- =========================================================
-- 2c — Alte zurückgestellte Zeile + Token per DIREKTEM profiles-Update
--      (ohne update_my_push_token): darf NICHT gesendet werden
-- =========================================================
do $$
declare v uuid; d record; v_claimed int;
begin
  v := pg_temp.mk('direct', '98100000-0000-0000-0000-000000000003', interval '30 hours');
  update public.notification_deliveries
     set last_error = 'missing_push_token', next_attempt_at = now() + interval '2 minutes'
   where id = v;
  update public.profiles set expo_push_token = 'ExponentPushToken[mteE2direct]'
   where id = '98100000-0000-0000-0000-000000000003';
  -- Zeit "vergeht": nächster regulärer Versuch wäre jetzt fällig.
  update public.notification_deliveries set next_attempt_at = now() - interval '1 second' where id = v;
  select count(*) into v_claimed from pg_temp.claim() x where x = v;
  select * into d from public.notification_deliveries where id = v;
  insert into _r values ('2c','alt + Token direkt gesetzt: nicht geclaimt, failed/expired',
    '0|failed|missing_push_token_expired', concat_ws('|', v_claimed, d.status, d.last_error));
  update public.profiles set expo_push_token = null where id = '98100000-0000-0000-0000-000000000003';
end $$;

-- =========================================================
-- 3 + 4 — Token-Registrierung: jung wird fällig, alt bleibt terminal
-- =========================================================
-- Zusätzliche Fälle für E1: eine junge und eine alte zurückgestellte Zeile;
-- dazu eine junge zurückgestellte Zeile für E2 (Fremdzeile).
do $$
declare v_young uuid; v_old uuid; v_foreign uuid;
begin
  v_young   := pg_temp.mk('reg_young',   '98100000-0000-0000-0000-000000000002', interval '2 hours');
  v_old     := pg_temp.mk('reg_old',     '98100000-0000-0000-0000-000000000002', interval '3 days');
  v_foreign := pg_temp.mk('reg_foreign', '98100000-0000-0000-0000-000000000003', interval '2 hours');
  update public.notification_deliveries
     set status = 'pending', last_error = 'missing_push_token', next_attempt_at = now() + interval '4 minutes'
   where id in (v_young, v_old, v_foreign);
end $$;

-- E1 registriert einen Token über den echten RPC (als authenticated).
select set_config('request.jwt.claims',
  '{"sub":"98100000-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select public.update_my_push_token('ExponentPushToken[mteE1]', 42, 'android');
reset role;

do $$
declare dy record; dold record; df record; dfresh record; v_ids uuid[];
begin
  select * into dy    from public.notification_deliveries where id = (select id from _d where k='reg_young');
  select * into dold  from public.notification_deliveries where id = (select id from _d where k='reg_old');
  select * into df    from public.notification_deliveries where id = (select id from _d where k='reg_foreign');
  select * into dfresh from public.notification_deliveries where id = (select id from _d where k='fresh');

  insert into _r values ('3a','Token-Registrierung: junge Zeile fällig, last_error null',
    'pending|<null>|true', concat_ws('|', dy.status, coalesce(dy.last_error,'<null>'), (dy.next_attempt_at <= now())::text));
  insert into _r values ('4a','Token-Registrierung: alte Zeile terminal failed/expired',
    'failed|missing_push_token_expired', concat_ws('|', dold.status, dold.last_error));
  insert into _r values ('3c','Token-Registrierung: Zeile aus Fall 1 (jung) ebenfalls fällig',
    'pending|<null>|true', concat_ws('|', dfresh.status, coalesce(dfresh.last_error,'<null>'), (dfresh.next_attempt_at <= now())::text));
  insert into _r values ('X','Fremdzeile (E2) durch E1-Registrierung unberührt',
    'pending|missing_push_token|false', concat_ws('|', df.status, df.last_error, (df.next_attempt_at <= now())::text));

  -- Claim nach Registrierung: junge Zeilen kommen MIT Token, alte nie.
  select array_agg(c.delivery_id) into v_ids
  from public.claim_notification_deliveries('98000000-0000-0000-0000-000000000001'::uuid, 50, 120) c
  where c.recipient_id = '98100000-0000-0000-0000-000000000002'
    and c.expo_push_token = 'ExponentPushToken[mteE1]';
  insert into _r values ('3b','Claim nach Registrierung: jung mit Token geclaimt, alt nicht',
    'true|false', concat_ws('|', (dy.id = any(v_ids))::text, (dold.id = any(coalesce(v_ids,'{}')))::text));

  -- 8 — Erfolgspfad unverändert: sent + sent_at
  perform public.complete_notification_delivery(dy.id, 'sent', null, 5);
  select * into dy from public.notification_deliveries where id = dy.id;
  insert into _r values ('8','Erfolgspfad: sent, sent_at gesetzt, last_error null',
    'sent|true|<null>', concat_ws('|', dy.status, (dy.sent_at is not null)::text, coalesce(dy.last_error,'<null>')));

  -- 4b — alte Zeile auch nach weiterer Zeit nie claimbar
  update public.notification_deliveries set next_attempt_at = now() - interval '1 hour' where id = dold.id;
  insert into _r values ('4b','alte Zeile nach Registrierung nie wieder claimbar', '0',
    (select count(*)::text from pg_temp.claim() x where x = dold.id));
end $$;

-- =========================================================
-- 5 — Provider-/Netzwerkfehler: Retry/Backoff unverändert
-- =========================================================
do $$
declare v uuid; d record; r text;
begin
  -- alt (> TTL) MIT Token: der Retry-Zweig kennt keine TTL — unverändert.
  v := pg_temp.mk('retry', '98100000-0000-0000-0000-000000000001', interval '30 hours');
  update public.notification_deliveries set attempts = 1, status = 'processing', claimed_at = now() where id = v;
  r := public.complete_notification_delivery(v, 'retry', 'Expo push HTTP 503', 5);
  select * into d from public.notification_deliveries where id = v;
  insert into _r values ('5a','retry attempts=1: pending, Backoff 60 s, Fehlertext erhalten',
    'pending|pending|Expo push HTTP 503|true', concat_ws('|', r, d.status, d.last_error,
      (d.next_attempt_at between now() + interval '55 seconds' and now() + interval '65 seconds')::text));

  update public.notification_deliveries set attempts = 3, status = 'processing' where id = v;
  r := public.complete_notification_delivery(v, 'retry', 'Expo push HTTP 503', 5);
  select * into d from public.notification_deliveries where id = v;
  insert into _r values ('5b','retry attempts=3: Backoff 240 s', 'pending|true', concat_ws('|', r,
      (d.next_attempt_at between now() + interval '235 seconds' and now() + interval '245 seconds')::text));

  update public.notification_deliveries set attempts = 5, status = 'processing' where id = v;
  r := public.complete_notification_delivery(v, 'retry', 'Expo push HTTP 503', 5);
  select * into d from public.notification_deliveries where id = v;
  insert into _r values ('5c','retry attempts=max: failed mit Fehlertext', 'failed|failed|Expo push HTTP 503',
    concat_ws('|', r, d.status, d.last_error));
end $$;

-- =========================================================
-- 6 — permanent_fail (DeviceNotRegistered-Zweig) unverändert
-- =========================================================
do $$
declare v uuid; d record; r text;
begin
  v := pg_temp.mk('dnr', '98100000-0000-0000-0000-000000000001', interval '1 minute');
  r := public.complete_notification_delivery(v, 'permanent_fail', 'DeviceNotRegistered', 5);
  select * into d from public.notification_deliveries where id = v;
  insert into _r values ('6','permanent_fail: failed/DeviceNotRegistered', 'failed|failed|DeviceNotRegistered',
    concat_ws('|', r, d.status, d.last_error));
end $$;

-- =========================================================
-- 9 — Claim-Vertrag unverändert (Spaltenliste) + TTL = 24 h
-- =========================================================
insert into _r values ('9a','Claim-Rückgabespalten unverändert (20 Spalten, Locale + Entity)',
  'delivery_id,outbox_id,recipient_id,attempts,event_type,job_id,company_id,job_status,employee_id,employee_name,customer_name,service_name,expo_push_token,recipient_active,recipient_role,recipient_locale,entity_type,entity_id,absence_start_date,absence_end_date',
  (select array_to_string(proargnames[4:23], ',') from pg_proc
    where oid = 'public.claim_notification_deliveries(uuid,int,int)'::regprocedure));
insert into _r values ('9b','TTL = 24 h', '24:00:00', public.notification_missing_token_ttl()::text);
insert into _r values ('9c','Grants: claim/complete nur service_role, update_my_push_token authenticated',
  'false|false|true|true',
  concat_ws('|',
    has_function_privilege('authenticated','public.claim_notification_deliveries(uuid,int,int)','execute')::text,
    has_function_privilege('authenticated','public.complete_notification_delivery(uuid,text,text,int,text,bytea)','execute')::text,
    has_function_privilege('authenticated','public.update_my_push_token(text,integer,text)','execute')::text,
    has_function_privilege('service_role','public.claim_notification_deliveries(uuid,int,int)','execute')::text));

-- ── Ergebnis ──
select case_no, beschreibung, erwartet, ergebnis,
       case when erwartet = ergebnis then 'PASS' else 'FAIL' end as verdict
from _r order by case_no;

do $$
declare v_fail int; v_total int;
begin
  select count(*) filter (where erwartet is distinct from ergebnis), count(*) into v_fail, v_total from _r;
  raise notice 'TESTRESULT notification_missing_token_expiry: % / % PASS', v_total - v_fail, v_total;
  if v_fail > 0 then
    raise exception 'TESTRESULT notification_missing_token_expiry: % FAIL', v_fail;
  end if;
end $$;

rollback;
