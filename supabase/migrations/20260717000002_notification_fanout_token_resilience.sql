-- =========================================================
-- FIX: Admin-Push geht verloren, wenn beim Fan-out noch kein Push-Token existiert
-- (Migration 20260717000002 — Nachtrag zu 20260717000000)
-- =========================================================
--
-- ROOT CAUSE
-- ----------
-- fanout_notification_events() filterte die Empfänger mit
--     and p.expo_push_token is not null
-- UND markierte das Event danach bedingungslos als fanned_out. Hatte ein aktiver
-- Admin zum Fan-out-Zeitpunkt noch KEINEN Push-Token (App noch nicht geöffnet /
-- Token-Registrierung noch nicht durchgelaufen), wurde für ihn KEINE Delivery
-- angelegt, das Event aber trotzdem als "aufgefächert" abgehakt. Da der Sweeper
-- nur Events mit fanned_out_at IS NULL betrachtet, ging das Event danach dauerhaft
-- verloren — selbst wenn der Admin Sekunden später einen gültigen Token registrierte.
-- Sichtbar in Prod: notification_outbox enthält job_started/job_completed mit
-- gesetztem fanned_out_at, notification_deliveries ist leer.
--
-- FIX (3 Bausteine)
-- -----------------
--   1. FAN-OUT ohne Token-Filter: Deliveries werden für ALLE aktiven Admins der
--      Firma angelegt. Ob ein Token existiert, entscheidet erst der Dispatcher.
--   2. FAN-OUT-SICHERHEIT: fanned_out_at wird NUR gesetzt, wenn für jeden aktuell
--      aktiven Admin-Empfänger eine Delivery existiert (angelegt ODER bereits
--      vorhanden). Sonst bleibt das Event offen und wird erneut aufgefächert.
--   3. DISPATCH-Zustand: neues outcome 'missing_token' für
--      complete_notification_delivery — aktiver Admin ohne Token wird NICHT als
--      permanent failed markiert, sondern mit Backoff zurück auf pending gelegt
--      (last_error='missing_push_token'). Nach Token-Registrierung ist die
--      Delivery beim nächsten fälligen Claim ganz normal zustellbar.
--
-- Zusätzlich: einmaliger, idempotenter BACKFILL bereits verlorener Events.
--
-- Additiv/idempotent. Wie alle Schemaänderungen MANUELL im Supabase SQL Editor
-- anwenden (siehe CLAUDE.md). RLS/GRANT-Härtung aus 20260717000000/…001 bleibt
-- unverändert (die revoke/grant-Blöcke werden am Ende erneut angewandt).

-- =========================================================
-- RPC: FAN-OUT  (Token-Filter entfernt + Fan-out-Sicherheit)
-- =========================================================
create or replace function public.fanout_notification_events(
  company_id_filter uuid default null,
  max_events int default 100
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  evt record;
  n int := 0;
  expected_recipients int;
  actual_deliveries int;
begin
  for evt in
    select o.id, o.company_id, o.employee_id
    from public.notification_outbox o
    where o.fanned_out_at is null
      and (company_id_filter is null or o.company_id = company_id_filter)
    order by o.created_at
    for update skip locked
    limit max_events
  loop
    -- Eine Delivery je AKTIVEM Admin der Firma (ohne Auslöser). KEIN Token-Filter:
    -- ein fehlender Token darf ein Event nicht verwerfen, er wird erst beim
    -- Claim/Dispatch geprüft und führt dort nur zu einer Zurückstellung.
    insert into public.notification_deliveries (
      outbox_id, company_id, recipient_id, next_attempt_at
    )
    select evt.id, evt.company_id, p.id, now()
    from public.profiles p
    where p.company_id = evt.company_id
      and p.role = 'admin'
      and p.is_active = true
      and (evt.employee_id is null or p.id <> evt.employee_id)
    on conflict (outbox_id, recipient_id) do nothing;

    -- Fan-out-Sicherheit: Erst als aufgefächert markieren, wenn für JEDEN aktuell
    -- aktiven Admin-Empfänger eine Delivery existiert. Ist das (z. B. wegen einer
    -- Race mit gerade neu aktivierten Admins) nicht der Fall, bleibt fanned_out_at
    -- NULL und der nächste Sweep fächert erneut auf -> kein stiller Verlust.
    select count(*) into expected_recipients
    from public.profiles p
    where p.company_id = evt.company_id
      and p.role = 'admin'
      and p.is_active = true
      and (evt.employee_id is null or p.id <> evt.employee_id);

    select count(*) into actual_deliveries
    from public.notification_deliveries d
    where d.outbox_id = evt.id;

    if actual_deliveries >= expected_recipients then
      update public.notification_outbox set fanned_out_at = now() where id = evt.id;
      n := n + 1;
    end if;
  end loop;

  return n;
end;
$$;

-- =========================================================
-- RPC: COMPLETE DELIVERY  (+ outcome 'missing_token')
-- =========================================================
-- outcome:
--   'sent'           -> status=sent, sent_at=now()  (Erfolg; sent_at NUR hier)
--   'permanent_fail' -> status=failed               (z. B. DeviceNotRegistered,
--                                                     Empfänger inaktiv/kein Admin)
--   'retry'          -> attempts>=max ? failed : pending mit exp. Backoff
--   'missing_token'  -> aktiver Admin ohne Push-Token: pending mit fixem Backoff,
--                       NIE failed. Der Claim-Increment auf attempts wird
--                       zurückgenommen, damit das echte Sende-Retry-Budget erhalten
--                       bleibt. Nach Token-Registrierung ist die Delivery beim
--                       nächsten fälligen Claim normal zustellbar.
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
  v_attempts int;
begin
  select attempts into v_attempts
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
    -- Kein Fehlversuch, sondern "Empfänger aktuell nicht erreichbar". Delivery
    -- bleibt pending und wird NIE failed. Fixer Backoff (5 min), damit der Sweeper
    -- nicht heißläuft; nach Token-Registrierung greift der nächste fällige Claim.
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

comment on function public.fanout_notification_events(uuid, int) is
'Fächert offene Outbox-Events pro aktivem Admin-Empfänger in notification_deliveries auf (idempotent, FOR UPDATE SKIP LOCKED). KEIN Push-Token-Filter — der Token wird erst beim Dispatch geprüft. fanned_out_at wird erst gesetzt, wenn jeder aktive Admin eine Delivery hat. Nur Service Role.';
comment on function public.complete_notification_delivery(uuid, text, text, int) is
'Zustandsübergang nach Sendeversuch: sent | permanent_fail | retry(Backoff/failed bei max) | missing_token(pending, fixer Backoff, nie failed — aktiver Admin ohne Token). sent_at NUR bei Erfolg. Nur Service Role.';

-- =========================================================
-- BACKFILL: bereits verlorene Events reparieren (einmalig, idempotent)
-- =========================================================
-- Für Outbox-Events mit gesetztem fanned_out_at, aber OHNE jegliche Delivery
-- (die vom Token-Filter-Bug betroffenen), werden die fehlenden Deliveries für die
-- aktuell aktiven Admins der Firma nacherzeugt. Idempotent über
-- UNIQUE(outbox_id, recipient_id): erneutes Ausführen erzeugt keine Duplikate.
-- Bewusst nur Events OHNE Delivery -> teil-zugestellte Events bleiben unangetastet
-- (kein nachträglicher Push an Admins, die zum Event-Zeitpunkt inaktiv waren).
-- Der Notification-Stack wurde am 2026-07-17 eingeführt; betroffene Events sind
-- daher sehr jung -> ein nachgeholter Push ist zeitlich vertretbar.
insert into public.notification_deliveries (
  outbox_id, company_id, recipient_id, next_attempt_at
)
select o.id, o.company_id, p.id, now()
from public.notification_outbox o
join public.profiles p
  on p.company_id = o.company_id
 and p.role = 'admin'
 and p.is_active = true
 and (o.employee_id is null or p.id <> o.employee_id)
where o.fanned_out_at is not null
  and not exists (
    select 1 from public.notification_deliveries d where d.outbox_id = o.id
  )
on conflict (outbox_id, recipient_id) do nothing;

-- =========================================================
-- GRANTS / RLS-HÄRTUNG erneut anwenden (KEINE Lockerung)
-- =========================================================
-- create or replace erhält bestehende Privilegien; die Blöcke werden dennoch
-- explizit erneut angewandt, damit die Härtung aus 20260717000000/…001 garantiert
-- unverändert bleibt (Dispatcher-RPCs nur für service_role).
revoke all on function public.fanout_notification_events(uuid, int) from public, anon, authenticated;
revoke all on function public.complete_notification_delivery(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.fanout_notification_events(uuid, int) to service_role;
grant execute on function public.complete_notification_delivery(uuid, text, text, int) to service_role;
