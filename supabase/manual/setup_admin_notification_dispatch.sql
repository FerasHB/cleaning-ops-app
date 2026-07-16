-- =========================================================
-- MANUELLE Einrichtung: serverseitiger Dispatch des Admin-Push
-- (gehört NICHT zu den automatischen Migrationen)
-- =========================================================
--
-- Diese Datei richtet die INFRASTRUKTUR ein, die sich NICHT sicher über eine
-- normale Migration deployen lässt, weil sie projektspezifische Secrets
-- (Project-URL, Service-Role-Key) und die Extensions pg_cron/pg_net braucht.
-- Die eigentliche Dispatch-LOGIK (Tabellen + RPCs) liegt weiterhin in
-- supabase/migrations/20260717000000_admin_status_notifications.sql, die Edge
-- Function in supabase/functions/dispatch-notifications/.
--
-- AUSFÜHREN: manuell im Supabase SQL Editor (als postgres). Vorher unbedingt die
-- <<PLATZHALTER>> unten ersetzen. KEINE echten Secrets in diese Datei committen.
--
-- Voraussetzungen:
--   1. Migration 20260717000000 ist angewandt.
--   2. Edge Function 'dispatch-notifications' ist deployed.
--
-- Diese Datei ist IDEMPOTENT: mehrfaches Ausführen legt weder doppelte
-- Cron-Jobs noch doppelte Trigger/Secrets an.
--
-- ─────────────────────────────────────────────────────────────────────────
-- EMPFOHLENE KONFIGURATION (genau EINE zeitnahe Primärauslösung + Cron):
--   Variante A (empfohlen): Dashboard Database Webhook  +  Cron-Sweeper (Teil 3)
--   Variante B (reines SQL): pg_net-Trigger (Teil 4)     +  Cron-Sweeper (Teil 3)
--   -> Richte NUR EINE der beiden Primärauslösungen (Webhook ODER Trigger) ein.
--
-- Warum kein doppelter Push, selbst wenn zwei Auslöser gleichzeitig feuern:
--   Der Versand ist NICHT an die Auslösung gekoppelt. Jede einzelne Delivery
--   wird in claim_notification_deliveries() ATOMAR per FOR UPDATE SKIP LOCKED
--   von pending -> processing überführt; nur der Gewinner sendet. sent_at wird
--   erst NACH erfolgreichem Expo-Ticket gesetzt. Eine bereits sent/processing
--   Delivery wird nicht erneut gesendet. Mehrfache Auslösung erzeugt daher
--   höchstens redundante (leere) Funktionsaufrufe, aber KEINEN doppelten Push.
--   Trotzdem: nur EINE Primärauslösung konfigurieren, um unnötige Last zu sparen.
-- ─────────────────────────────────────────────────────────────────────────

-- =========================================================
-- TEIL 1 — Extensions (idempotent)
-- =========================================================
-- Auf Supabase ggf. zuerst im Dashboard (Database -> Extensions) aktivieren.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- =========================================================
-- TEIL 2 — Vault-Secrets (Platzhalter ersetzen, idempotent)
-- =========================================================
-- Legt die von Cron/Trigger benötigten Secrets an, OHNE ein bestehendes Secret
-- zu überschreiben. Werte NUR hier zur Laufzeit einsetzen, NICHT committen.
--   project_url      = https://<PROJECT_REF>.supabase.co   (ohne Slash am Ende)
--   service_role_key = der Service-Role-Key des Projekts
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret('<<PROJECT_URL>>', 'project_url');
  end if;
  if not exists (select 1 from vault.secrets where name = 'service_role_key') then
    perform vault.create_secret('<<SERVICE_ROLE_KEY>>', 'service_role_key');
  end if;
end $$;

-- Falls ein Secret AKTUALISIERT werden muss (z. B. Key rotiert), bewusst manuell:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'service_role_key'),
--     '<<NEW_SERVICE_ROLE_KEY>>'
--   );

-- =========================================================
-- TEIL 3 — Cron-Sweeper (Fallback, genau 1x pro Minute, idempotent)
-- =========================================================
-- Stößt die Edge Function im SERVER-Modus an (Authorization: Bearer <service_role>).
-- Fängt ab, was die Primärauslösung verpasst: Backoff-Retries, hängende
-- processing-Deliveries nach Crash, Ausfall der Primärauslösung.
-- Idempotent: vorhandenen gleichnamigen Job zuerst entfernen.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dispatch-admin-notifications') then
    perform cron.unschedule('dispatch-admin-notifications');
  end if;
end $$;

select cron.schedule(
  'dispatch-admin-notifications',
  '* * * * *',                       -- jede Minute, NICHT häufiger
  $CRON$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
             || '/functions/v1/dispatch-notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      ),
      body := '{}'::jsonb
    );
  $CRON$
);

-- =========================================================
-- TEIL 4 — OPTIONAL: pg_net-Trigger als Primärauslösung
-- (Alternative zum Dashboard-Webhook; NUR EINE der beiden verwenden)
-- =========================================================
-- Feuert bei jedem neuen Event sofort. pg_net.http_post ist asynchron (blockiert
-- die Job-Transaktion nicht; bei Rollback des Statuswechsels wird der Request
-- mit zurückgerollt -> kein Dispatch für einen nicht-committeten Übergang).
-- IDEMPOTENT: create or replace + drop trigger if exists.
--
-- >>> Nur einkommentieren, wenn KEIN Dashboard-Webhook genutzt wird. <<<
--
-- create or replace function public.tg_dispatch_notifications()
-- returns trigger language plpgsql security definer set search_path = public as $FN$
-- begin
--   perform net.http_post(
--     url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
--            || '/functions/v1/dispatch-notifications',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
--     ),
--     body := '{}'::jsonb
--   );
--   return null;
-- end $FN$;
--
-- drop trigger if exists dispatch_notifications_after_insert on public.notification_outbox;
-- create trigger dispatch_notifications_after_insert
-- after insert on public.notification_outbox
-- for each row execute function public.tg_dispatch_notifications();

-- =========================================================
-- KONTROLLE (read-only)
-- =========================================================
-- Cron-Job vorhanden?
--   select jobid, jobname, schedule, active from cron.job where jobname = 'dispatch-admin-notifications';
-- Letzte Cron-Läufe?
--   select runid, status, return_message, start_time
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'dispatch-admin-notifications')
--   order by start_time desc limit 10;
-- Offene Deliveries?
--   select status, count(*) from public.notification_deliveries group by status;

-- =========================================================
-- UNINSTALL / ROLLBACK
-- =========================================================
-- Cron-Job entfernen (idempotent):
--   do $$ begin
--     if exists (select 1 from cron.job where jobname = 'dispatch-admin-notifications') then
--       perform cron.unschedule('dispatch-admin-notifications');
--     end if;
--   end $$;
--
-- Optionalen pg_net-Trigger entfernen:
--   drop trigger if exists dispatch_notifications_after_insert on public.notification_outbox;
--   drop function if exists public.tg_dispatch_notifications();
--
-- Vault-Secrets werden BEWUSST NICHT automatisch gelöscht (könnten anderweitig
-- genutzt werden). Bei Bedarf manuell:
--   select vault.delete_secret((select id from vault.secrets where name = 'project_url'));
--   select vault.delete_secret((select id from vault.secrets where name = 'service_role_key'));
--
-- Die Extensions pg_cron/pg_net werden NICHT entfernt (projektweit genutzt).
