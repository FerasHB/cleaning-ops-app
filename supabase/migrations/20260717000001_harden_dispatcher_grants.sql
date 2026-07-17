-- =========================================================
-- SICHERHEITS-FIX: EXECUTE der Dispatcher-RPCs von anon/authenticated entziehen
-- (Nachtrag zu 20260717000000)
-- =========================================================
--
-- Grund: 20260717000000 entzog EXECUTE auf fanout_notification_events /
-- claim_notification_deliveries / complete_notification_delivery nur von PUBLIC.
-- Supabase vergibt EXECUTE auf neue Funktionen jedoch per Default-Privileges
-- DIREKT an anon/authenticated/service_role. Diese Direkt-Grants blieben daher
-- bestehen — ein anon-/authenticated-Client konnte die Dispatcher-RPCs über
-- PostgREST aufrufen (u. a. claim_notification_deliveries(null,…), das
-- firmenübergreifend Push-Tokens, Kunden- und Mitarbeiternamen zurückgibt und
-- Deliveries auf 'processing' setzt).
--
-- Diese Migration existiert als eigenständiger Nachtrag, weil eine frühere
-- Revision von 20260717000000 bereits auf einer laufenden Umgebung angewandt
-- war. Sie ist idempotent und auf Frischinstallationen ein reiner No-Op
-- (dort entzieht bereits die korrigierte 20260717000000 die Rechte).
--
-- Betrifft NICHT start_own_job/complete_own_job (bewusst weiterhin an
-- authenticated gegrantet — Employees rufen sie company-scoped via auth.uid() auf).

revoke all on function public.fanout_notification_events(uuid, int) from public, anon, authenticated;
revoke all on function public.claim_notification_deliveries(uuid, int, int) from public, anon, authenticated;
revoke all on function public.complete_notification_delivery(uuid, text, text, int) from public, anon, authenticated;

grant execute on function public.fanout_notification_events(uuid, int) to service_role;
grant execute on function public.claim_notification_deliveries(uuid, int, int) to service_role;
grant execute on function public.complete_notification_delivery(uuid, text, text, int) to service_role;
