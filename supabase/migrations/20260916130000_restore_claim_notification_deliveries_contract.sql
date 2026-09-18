-- =========================================================
-- Notification-Integrität: claim_notification_deliveries-Vertrag reparieren
-- =========================================================
-- REGRESSION (gefunden per Production-Audit, read-only): 20260915000000
-- (Phase E, Server-Locale) hat claim_notification_deliveries() per DROP +
-- CREATE neu gefasst, um recipient_locale zu ergänzen — dabei aber vier
-- Spalten VERLOREN, die 20260821000000 (Abwesenheits-Events) bereits
-- eingeführt hatte: entity_type, entity_id, absence_start_date,
-- absence_end_date. Der Dispatcher (dispatch-notifications) erwartet diese
-- Felder unverändert (buildContent() liest row.entity_type, um Kommentar-/
-- Abwesenheits-Events von Job-Events zu unterscheiden) — ohne sie fällt JEDES
-- comment_added/vacation_*/sickness_*-Event auf den generischen
-- Job-gestartet/abgeschlossen-Zweig zurück, weil entity_type dort undefined
-- ankommt und weder "comment" noch "absence" matcht.
--
-- FIX: DROP + CREATE erneut (Rückgabetyp wächst wieder), diesmal mit BEIDEN
-- Spaltengruppen gleichzeitig — recipient_locale (Phase E) UND
-- entity_type/entity_id/absence_start_date/absence_end_date (Abwesenheiten,
-- seit 20260822000000 auch von comment_added genutzt). Body/Semantik sind
-- ansonsten BYTE-IDENTISCH zu 20260915000000: FOR UPDATE SKIP LOCKED,
-- Stale-Processing-Reclaim per processing_timeout_seconds, attempts++ beim
-- Claim, company-Scoping, Token-/Rollen-Lookup über profiles. Reine
-- Projektions-Erweiterung, keine Verhaltensänderung an Locking/Retry/Scoping.
--
-- NICHT Teil dieser Migration: Phase-16-Jobausführung, Pause/Resume,
-- work_sessions, App-Erzwingungs-Konfiguration, Zeiterfassung — siehe
-- Aufgabenstellung dieses Fixes (nur Notification-Integrität + -Latenz).
--
-- ZEITSTEMPEL BEWUSST GEWÄHLT (nicht der tatsächliche Autoringtag): diese
-- Migration soll auf Production VOR Phase 16 laufen (20260917000000/
-- 20260917000001/20260918000000), aber NACH 20260916120000_client_
-- compatibility_foundation, dem aktuellen Production-Stand. Mit einem
-- späteren Zeitstempel würde `supabase db push`/`migration up` beim
-- SPÄTEREN Phase-16-Rollout hart mit "Found local migration files to be
-- inserted before the last migration on remote database" abbrechen und
-- zwingend --include-all verlangen — empirisch gegen die tatsächlich
-- installierte Supabase-CLI verifiziert (lokale Simulation, kein Staging/
-- Production berührt). Staging hat Phase 16 bereits — dort ist genau EINMAL
-- --include-all nötig, wenn diese beiden Notification-Migrationen dort
-- ankommen (ebenfalls lokal verifiziert: wendet idempotent/sauber an).
-- Zwischen den beiden Umgebungen war keine Reihenfolge moeglich, die fuer
-- BEIDE ohne Sonderbehandlung auskommt — diese Wahl haelt den Sonderfall
-- auf der kleinen, bereits lokal verifizierten Notification-Aenderung
-- (Staging) statt auf dem großen, geschäftskritischen Phase-16-Bundle
-- (Production).

drop function if exists public.claim_notification_deliveries(uuid, int, int);

create or replace function public.claim_notification_deliveries(
  company_id_filter uuid default null,
  max_rows int default 50,
  processing_timeout_seconds int default 120
)
returns table (
  delivery_id uuid, outbox_id uuid, recipient_id uuid, attempts int,
  event_type text, job_id uuid, company_id uuid, job_status text,
  employee_id uuid, employee_name text, customer_name text, service_name text,
  expo_push_token text, recipient_active boolean, recipient_role text,
  recipient_locale text,
  entity_type text, entity_id uuid,
  absence_start_date date, absence_end_date date
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select d.id
    from public.notification_deliveries d
    where (company_id_filter is null or d.company_id = company_id_filter)
      and (
        (d.status = 'pending' and d.next_attempt_at <= now())
        or (d.status = 'processing'
            and d.claimed_at < now() - make_interval(secs => processing_timeout_seconds))
      )
    order by d.next_attempt_at
    for update skip locked
    limit max_rows
  ),
  claimed as (
    update public.notification_deliveries d
    set status = 'processing', claimed_at = now(), attempts = d.attempts + 1
    from due
    where d.id = due.id
    returning d.id, d.outbox_id, d.recipient_id, d.attempts
  )
  select
    c.id, c.outbox_id, c.recipient_id, c.attempts,
    o.event_type, o.job_id, o.company_id, o.job_status,
    o.employee_id, o.employee_name, o.customer_name, o.service_name,
    p.expo_push_token, p.is_active, p.role::text,
    p.locale,
    o.entity_type, o.entity_id, o.absence_start_date, o.absence_end_date
  from claimed c
  join public.notification_outbox o on o.id = c.outbox_id
  left join public.profiles p on p.id = c.recipient_id;
end;
$$;

comment on function public.claim_notification_deliveries(uuid, int, int) is
'Nimmt fällige/hängende Deliveries atomar (FOR UPDATE SKIP LOCKED), setzt '
'processing + attempts, liefert Empfänger-Token/Status/Locale UND die '
'generische Entitätsidentität (entity_type/entity_id) + Abwesenheits-'
'Schnappschüsse (absence_start_date/end_date). Seit 20260916130000: stellt '
'die vier bei 20260915000000 versehentlich entfernten Spalten wieder her — '
'ohne sie routet der Dispatcher comment_added/Abwesenheits-Events fälschlich '
'auf die Job-gestartet-Vorlage. Nur Service Role.';

-- DROP FUNCTION entfernt ALLE Grants des alten Objekts (siehe bereits
-- dokumentierte Lehre bei update_my_push_token, 20260917000001) — deshalb
-- hier wie schon in 20260821000000/20260915000000 explizit restauriert,
-- nicht auf einen Datenbank-Default verlassen.
revoke all on function public.claim_notification_deliveries(uuid, int, int) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(uuid, int, int) to service_role;
