-- =========================================================
-- Notification-Latenz: authentifizierter Sofort-Trigger (Fallback bleibt Cron)
-- =========================================================
-- BEFUND (Production-Audit, read-only): der bestehende sofort-auslösende
-- Pfad ("dispatch-admin-notifications", Dashboard-Database-Webhook auf
-- INSERT public.notification_outbox, siehe
-- supabase/functions/dispatch-notifications/DEPLOY.md Abschnitt 3a) sendet
-- "Authorization: Bearer <SERVICE_ROLE_KEY>". Das Projekt nutzt inzwischen
-- neue sb_secret_-Service-Role-Keys; das Functions-Gateway lehnt diese im
-- Authorization-Header ab -> HTTP 401, KEIN Dispatch. Exakt dieselbe
-- Inkompatibilität, die 20260717000003_notification_sweeper_cron.sql für den
-- Minuten-Sweeper bereits dokumentiert und dort über ein dediziertes Secret
-- (x-sweeper-secret / DISPATCH_SWEEPER_SECRET, in Vault als
-- 'dispatch_sweeper_secret') gelöst hat. Bis zum nächsten Cron-Tick (bis zu
-- 60s) bleiben Kommentar-/Abwesenheits-/Zuweisungs-Events dadurch unnötig
-- liegen, obwohl Versand + Vorlagen (nach der Vertragsreparatur in
-- 20260918010000) korrekt sind.
--
-- FIX: EIN neuer, migrierbarer AFTER-INSERT-Trigger auf notification_outbox,
-- der denselben BEREITS FUNKTIONIERENDEN Auth-Mechanismus wie der Sweeper
-- wiederverwendet (kein neues Secret, kein Secret im Klartext hier) — nur der
-- Auslöser ist neu (sofort statt einmal pro Minute), NICHT der Auth-Weg.
--
-- pg_net.http_post ist asynchron: die auslösende Geschäftstransaktion wartet
-- NICHT auf die HTTP-Antwort und schlägt bei einem Push-Fehler NICHT fehl
-- (bestehendes, bereits in DEPLOY.md/supabase/manual dokumentiertes
-- Verhalten). Rollt die auslösende Transaktion zurück, wird die noch nicht
-- abgesetzte pg_net-Anfrage mit zurückgerollt — kein Dispatch für ein nie
-- committetes Event.
--
-- ENTSCHEIDUNG, DIE DIESE MIGRATION *NICHT* TRIFFT (siehe Abschlussbericht):
-- Ob der bestehende Dashboard-Webhook "dispatch-admin-notifications"
-- zusätzlich deaktiviert/umkonfiguriert werden soll, ist eine reine
-- Infrastruktur-/Dashboard-Entscheidung außerhalb von Git — diese Migration
-- trifft sie bewusst NICHT und dupliziert auch keinen Push (siehe unten:
-- claim_notification_deliveries() ist ohnehin FOR UPDATE SKIP LOCKED, ein
-- zweiter/dritter gleichzeitiger Aufruf verursacht höchstens einen
-- redundanten Leerlauf-Aufruf, NIEMALS einen doppelten Push).
--
-- FALLBACK UNVERÄNDERT: notification-dispatch-sweeper (1x/Minute,
-- 20260717000003) bleibt bestehen und unverändert — fängt Backoff-Retries,
-- hängende processing-Zeilen nach Crash und einen Ausfall dieses neuen
-- Sofort-Triggers weiterhin ab.

create or replace function public.tg_dispatch_notifications_immediate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project_url text;
  v_secret      text;
begin
  -- Beide Werte sind bereits vorhanden (der Sweeper nutzt 'dispatch_sweeper_
  -- secret' produktiv; 'project_url' wurde für den bestehenden Cron-/Webhook-
  -- Aufbau angelegt, siehe supabase/manual/setup_admin_notification_dispatch.
  -- sql). Kein neues Secret, kein Klartext in dieser Migration.
  select decrypted_secret into v_project_url
  from vault.decrypted_secrets where name = 'project_url';

  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'dispatch_sweeper_secret';

  -- Fehlt einer der beiden Vault-Einträge (noch) -> stiller No-Op, GENAU wie
  -- beim Sweeper dokumentiert ("Fehlt der Vault-Eintrag beim ersten Lauf,
  -- antwortet die Function 401 ... kein Datenverlust, Deliveries bleiben
  -- pending"). Der Minuten-Sweeper holt das Event beim nächsten Tick nach.
  if v_project_url is null or v_secret is null then
    return null;
  end if;

  perform net.http_post(
    url := v_project_url || '/functions/v1/dispatch-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweeper-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000
  );

  return null;
exception
  when others then
    -- Sofort-Auslösung ist eine best-effort BESCHLEUNIGUNG, keine
    -- Voraussetzung für Korrektheit. Ein Fehler hier (z. B. Extension
    -- vorübergehend nicht verfügbar) darf die auslösende Geschäftsaktion
    -- (der INSERT in notification_outbox, i. d. R. innerhalb von
    -- start_own_job/complete_own_job/set_job_assignments/den Kommentar- und
    -- Abwesenheits-Pfaden) NIEMALS zum Scheitern bringen. Der Minuten-
    -- Sweeper bleibt der garantierte Fallback.
    return null;
end;
$$;

comment on function public.tg_dispatch_notifications_immediate() is
'AFTER-INSERT-Trigger auf notification_outbox: stößt dispatch-notifications '
'sofort an (x-sweeper-secret aus Vault, derselbe Mechanismus wie der '
'Minuten-Sweeper) statt auf den naechsten Cron-Tick zu warten. pg_net-'
'asynchron, best-effort, rollt mit der auslösenden Transaktion zurück, '
'schlägt bei Fehlern niemals selbst fehl. Fallback (notification-dispatch-'
'sweeper, 1x/Minute) bleibt unverändert bestehen.';

drop trigger if exists trg_notification_outbox_dispatch_immediate on public.notification_outbox;
create trigger trg_notification_outbox_dispatch_immediate
  after insert on public.notification_outbox
  for each row execute function public.tg_dispatch_notifications_immediate();

revoke all on function public.tg_dispatch_notifications_immediate() from public, anon, authenticated;
