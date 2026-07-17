-- =========================================================
-- pg_cron-Sweeper für den Notification-Dispatcher
-- (Migration 20260717000003 — Nachtrag zu 20260717000000/…002)
-- =========================================================
--
-- ZIEL
-- ----
-- Der Dispatcher (Edge Function dispatch-notifications) soll GERÄTEUNABHÄNGIG und
-- regelmäßig laufen, damit pending/retry-Deliveries auch OHNE App-Client-Kick
-- versendet werden. Ein pg_cron-Job ruft die Edge Function 1×/Minute im echten
-- SERVER-/Sweeper-Modus auf (kein eingeloggter Nutzer, alle Firmen).
--
-- AUTHENTIFIZIERUNG (bewusst OHNE Service-Role-Key im SQL)
-- --------------------------------------------------------
-- Das Projekt nutzt neue sb_secret_-Keys; der Legacy-JWT wird von der Edge
-- Function NICHT als injizierter SUPABASE_SERVICE_ROLE_KEY erkannt, und das
-- Functions-Gateway lehnt den sb_secret_-Key im Authorization-Header ab. Deshalb
-- verwendet der Sweeper ein DEDIZIERTES Secret:
--   * Die Edge Function prüft den Header  x-sweeper-secret  konstantzeit gegen ihr
--     Function-Secret  DISPATCH_SWEEPER_SECRET  (Server-Modus, kein JWT nötig).
--   * Der Cron-Job liest denselben Wert aus Supabase Vault
--     (vault.decrypted_secrets, Name 'dispatch_sweeper_secret') und sendet ihn als
--     Header. Der Klartext steht NIRGENDS in SQL/Migration/Repo.
-- Das Function-JWT-Gateway ist für diese Function deaktiviert (verify_jwt=false),
-- daher ist KEIN zusätzlicher API-Key im Aufruf nötig. Das Sweeper-Secret ist ein
-- reines Trigger-Token mit minimalen Rechten (kein DB-Zugriff, nur „Dispatch
-- anstoßen") und jederzeit rotierbar.
--
-- EINMALIGE VORAUSSETZUNGEN (siehe README/Deploy-Notiz, NICHT in dieser Migration,
-- da secretbehaftet):
--   1. Function-Secret setzen:   supabase secrets set DISPATCH_SWEEPER_SECRET=<wert>
--   2. Vault-Eintrag anlegen (SQL Editor), MIT DEMSELBEN <wert>:
--        select vault.create_secret('<wert>', 'dispatch_sweeper_secret',
--          'Trigger-Secret fuer den Notification-Sweeper (pg_cron -> Edge Function)');
-- Fehlt (2) beim ersten Lauf, sendet der Sweeper einen leeren Header -> die Edge
-- Function antwortet 401; sobald der Vault-Eintrag existiert, greift der nächste
-- Lauf automatisch. Kein Datenverlust (Deliveries bleiben pending).
--
-- Idempotent: ein vorhandener gleichnamiger Job wird zuerst entfernt und neu
-- geplant -> niemals Duplikate. Ändert KEINE Grants/RLS.

-- Extensions sicherstellen (bereits installiert; idempotent).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Vorhandenen gleichnamigen Job sicher entfernen (kein Duplikat bei Re-Run).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'notification-dispatch-sweeper') then
    perform cron.unschedule('notification-dispatch-sweeper');
  end if;
end $$;

-- 1×/Minute: Dispatcher im Server-/Sweeper-Modus anstoßen. Das Sweeper-Secret
-- kommt zur LAUFZEIT aus Vault (kein Klartext hier). Die Projekt-URL ist öffentlich
-- (steckt bereits im App-Bundle) und daher unbedenklich.
select cron.schedule(
  'notification-dispatch-sweeper',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://ivzsbspopudqgobunsdv.supabase.co/functions/v1/dispatch-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweeper-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_sweeper_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
  $cron$
);
