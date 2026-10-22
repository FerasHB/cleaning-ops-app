-- =====================================================================
-- Expo-Push-Receipts (F2): Receipt-Poller-Auslösung (pg_cron + pg_net)
-- =====================================================================
--
-- Erst NACH dem Deploy der Edge Function poll-push-receipts anwenden.
--
-- kick_receipt_poller(): POST auf <project_url>/functions/v1/poll-push-receipts
--   mit x-sweeper-secret (dieselben Vault-Secrets wie Sofort-Trigger und
--   Minuten-Sweeper, keine neuen Secrets). Die pg_net-Request-ID wird in
--   notification_receipt_poll_requests protokolliert — F3 H5 schließt diese
--   Antworten aus der Dispatcher-Gesundheit aus, H15 wertet sie aus.
--   Fehlen die Secrets, passiert nichts (kein Request).
--
-- Cron 'notification-receipt-poller': alle 5 min, versetzt um 2 min zum
-- Health-Check (02, 07, 12 …), damit nicht beide in derselben Minute laufen.
-- Der Versandpfad (Sofort-Trigger, Minuten-Sweeper) bleibt unverändert.
--
-- ROLLBACK:
--   select cron.unschedule('notification-receipt-poller');
--   drop function public.kick_receipt_poller();
--   Offene Receipts verfallen spätestens 6 h nach sent_at (claim_receipt_checks),
--   sobald der Poller wieder läuft; bis dahin bleiben sie harmlos pending.
-- =====================================================================

create or replace function public.kick_receipt_poller()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project_url text;
  v_secret      text;
  v_request_id  bigint;
begin
  select decrypted_secret into v_project_url
  from vault.decrypted_secrets where name = 'project_url';

  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'dispatch_sweeper_secret';

  if v_project_url is null or v_secret is null then
    return null;
  end if;

  select net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/poll-push-receipts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweeper-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) into v_request_id;

  insert into public.notification_receipt_poll_requests (request_id)
  values (v_request_id)
  on conflict (request_id) do nothing;

  return v_request_id;
end;
$$;

comment on function public.kick_receipt_poller() is
'Stößt die Edge Function poll-push-receipts an (x-sweeper-secret aus Vault) und '
'protokolliert die pg_net-Request-ID in notification_receipt_poll_requests (F2, '
'20261018000001). Ohne Secrets kein Request. Nur Service Role / Cron.';

revoke all on function public.kick_receipt_poller() from public, anon, authenticated;
grant execute on function public.kick_receipt_poller() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'notification-receipt-poller') then
    perform cron.unschedule('notification-receipt-poller');
  end if;
end $$;

select cron.schedule(
  'notification-receipt-poller',
  '2-59/5 * * * *',
  $cron$select public.kick_receipt_poller();$cron$
);
