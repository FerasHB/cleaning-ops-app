# dispatch-notifications — Deployment & serverseitige Auslösung

Admin-Push bei Job-Statuswechsel. Der **Versand** ist vollständig serverseitig
(Edge Function + RPCs). Es fehlt nur noch die **Auslösung** des Dispatchers —
die muss **unabhängig vom Mitarbeitergerät** laufen. Empfohlen: Webhook (zeitnah)
**plus** pg_cron-Sweeper (Fallback).

## 1. Migration anwenden

`supabase/migrations/20260717000000_admin_status_notifications.sql` **manuell im
Supabase SQL Editor** ausführen (Tabellen `notification_outbox` /
`notification_deliveries`, angepasste `start_own_job`/`complete_own_job`,
Dispatcher-RPCs `fanout_notification_events` / `claim_notification_deliveries` /
`complete_notification_delivery`).

## 2. Edge Function deployen

```bash
supabase functions deploy dispatch-notifications
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` werden für
deployte Functions automatisch injiziert. Die Function prüft die Authorization
selbst (`verify_jwt = false` in `config.toml`):

- **Server-Modus** – `Authorization: Bearer <SERVICE_ROLE_KEY>` → verarbeitet
  **alle** Firmen (Webhook/Cron).
- **Client-Modus** – normales User-JWT → nur die Firma des aktiven Aufrufers
  (optionaler Kick zur Beschleunigung; bereits im Client verdrahtet).

## 3a. Database Webhook (zeitnah, EMPFOHLEN)

Feuert bei jedem neuen Event sofort. Webhooks werden im Dashboard verwaltet
(intern via `pg_net`) und lassen sich **nicht sauber als Migration** abbilden —
daher hier die exakten Schritte:

**Dashboard → Database → Webhooks → „Create a new hook"**
- **Name:** `dispatch-admin-notifications`
- **Table:** `public.notification_outbox`
- **Events:** ☑ Insert (nur Insert)
- **Type:** *Supabase Edge Functions* → `dispatch-notifications`
  (oder *HTTP Request* → `POST https://<PROJECT_REF>.functions.supabase.co/dispatch-notifications`)
- **HTTP Headers:**
  - `Content-Type: application/json`
  - `Authorization: Bearer <SERVICE_ROLE_KEY>`  ← löst den Server-Modus aus
- **Payload:** Standard belassen — die Function ignoriert den Body und leert die
  gesamte offene Outbox (Idempotenz über den Delivery-Status).

### Alternative als reines SQL (migrierbar, benötigt `pg_net` + Vault)

Wenn kein Dashboard-Zugriff gewünscht ist, denselben Effekt per Trigger. Läuft
`pg_net`-asynchron (blockiert die Job-Transaktion nicht; bei Rollback des
Statuswechsels wird auch der Request verworfen). Voraussetzung: Abschnitt 3b
(Extensions + Vault-Secrets) ist eingerichtet.

```sql
create or replace function public.tg_dispatch_notifications()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/dispatch-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  return null;
end $$;

drop trigger if exists dispatch_notifications_after_insert on public.notification_outbox;
create trigger dispatch_notifications_after_insert
after insert on public.notification_outbox
for each row execute function public.tg_dispatch_notifications();
```

## 3b. pg_cron-Sweeper (Fallback, jede Minute)

Fängt alles ab, was der Webhook verpasst (temporäre Fehler → Backoff-Retries,
hängende `processing`-Zeilen nach Crash, Webhook-Ausfall). **Nicht öfter als
1×/Minute.**

Falls `pg_cron`/`pg_net` auf der Instanz **verfügbar und erlaubt** sind:

```sql
-- Extensions (Dashboard → Database → Extensions, oder als Superuser):
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Secrets in Vault (Werte einsetzen; NICHT im Client/Repo ablegen):
select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'project_url');
select vault.create_secret('<SERVICE_ROLE_KEY>',                'service_role_key');

-- Sweeper: jede Minute die Function im Server-Modus anstoßen.
select cron.schedule(
  'dispatch-admin-notifications',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
             || '/functions/v1/dispatch-notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      ),
      body := '{}'::jsonb
    );
  $$
);

-- Entfernen: select cron.unschedule('dispatch-admin-notifications');
```

Ist `pg_cron` **nicht** erlaubt: allein der Webhook (3a) deckt den Normalfall ab;
Retries/Timeout-Recovery greifen dann erst beim nächsten Event derselben Firma
oder beim optionalen Client-Kick. Für die Beta akzeptabel, hier ehrlich vermerkt.

## Bekannte Einschränkung: Push Receipts

Die Function wertet die **Tickets** der Expo-Push-API aus (Annahme durch Expo).
Die **Receipts** (endgültige Zustellbestätigung, u. a. spät gemeldetes
`DeviceNotRegistered`) werden für die erste Beta **nicht** gepollt.
`DeviceNotRegistered` wird nur behandelt, wenn es bereits im Ticket erscheint.
Receipt-Polling ist eine sinnvolle spätere Erweiterung (eigener Cron-Job gegen
`/push/getReceipts`).
