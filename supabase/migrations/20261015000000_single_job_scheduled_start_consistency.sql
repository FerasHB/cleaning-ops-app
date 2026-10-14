-- =====================================================================
-- scheduled_start konsistent aus date + start_time + Firmen-Zeitzone
-- =====================================================================
--
-- PROBLEM (Audit 2026-10-14, Prod read-only):
--   Admin-Anlegen/-Bearbeiten (AdminScreen/EditJobScreen → jobs.service)
--   schreibt date/start_time als Wanduhr des gewählten Picker-Datums und
--   scheduled_start als dessen Date.toISOString(). Damit hängt
--   scheduled_start an der GERÄTE-Zeitzone statt an companies.timezone
--   (Prod: Admin-Gerät in UTC+3 ⇒ −1 h gegenüber Berlin), und iOS/Web
--   übernehmen zusätzlich die Sekunden des Picker-Startwerts (+3..59 s).
--   Maßgeblich ist laut CLAUDE.md date + start_time (Wanduhr der Firma);
--   scheduled_start ist eine abgeleitete Kopie.
--
-- LÖSUNG:
--   BEFORE-Trigger auf jobs, der scheduled_start serverseitig ableitet:
--     scheduled_start := (date + start_time) at time zone <Firmen-Zeitzone>
--   sobald date UND start_time gesetzt sind. Firmen-Zeitzone exakt wie im
--   Recurring-Generator: companies.timezone (getrimmt), bei ungültigem/
--   leerem Wert 'Europe/Berlin'. Fehlt date oder start_time, bleibt der
--   gelieferte bzw. bestehende Wert unverändert (Altzeilen).
--   Schützt jeden Schreibpfad gleichermaßen: neue und ALTE App-Builds,
--   Bearbeiten generierter Termine über die gemeinsame Edit-Maske,
--   künftige Pfade. Für den Recurring-Generator ist er ein No-op, weil der
--   bereits denselben Wert schreibt.
--
-- BEWUSST ENG GESCHNITTEN:
--   Feuert nur bei INSERT und bei UPDATE OF date, start_time,
--   scheduled_start, company_id. Statuswechsel (start_own_job,
--   _execute_work_session_operation, maybe_complete_job,
--   admin_force_complete_job), Zuweisungen (assigned_to,
--   compat_sync_legacy_from_assignments), touch_job_on_assignment_change
--   (updated_at) und Konto-Löschungen (ON DELETE SET NULL auf assigned_to/
--   created_by/started_by/completed_by) lösen ihn NICHT aus — bestehende
--   Altzeilen werden also nicht nebenbei umgeschrieben. Erst eine bewusste
--   Termin-Bearbeitung leitet den Wert neu ab.
--
-- KEINE DATENBEREINIGUNG: Bestandszeilen werden durch diese Migration nicht
--   angefasst (Audit: ein Teil der Altzeilen ist nicht sicher
--   rekonstruierbar).
--
-- NICHT GEÄNDERT: schedule_overridden (trg_jobs_mark_schedule_override
--   beobachtet nur date/start_time), Status-/Work-Session-Logik,
--   Zuweisungen, Benachrichtigungen, Recurring-Regelsemantik (Parent-Regeln
--   haben date = null ⇒ No-op).
--
-- HINWEIS ROLLBACK 20261014000000: Dessen dokumentierter Rollback setzt
--   scheduled_start direkt zurück; dieser Trigger würde das sofort wieder
--   auf den kanonischen Wert ziehen. Ein solcher Rollback muss den Trigger
--   in derselben Transaktion deaktivieren:
--     alter table public.jobs disable trigger trg_jobs_sync_scheduled_start;
--     ... Rollback-UPDATE ...
--     alter table public.jobs enable trigger trg_jobs_sync_scheduled_start;
--
-- ROLLBACK dieser Migration:
--   drop trigger if exists trg_jobs_sync_scheduled_start on public.jobs;
--   drop function if exists public.sync_job_scheduled_start();
-- =====================================================================

create or replace function public.sync_job_scheduled_start()
returns trigger
language plpgsql
-- SECURITY DEFINER: die Zeitzonen-Auflösung darf nicht an der RLS des
-- Aufrufers scheitern (sonst stiller Fallback auf Europe/Berlin).
security definer
set search_path = public, pg_temp
as $$
declare
  company_timezone text;
begin
  if new.date is null or new.start_time is null then
    return new;
  end if;

  select coalesce(
    (select tz.name
     from public.companies c
     join pg_catalog.pg_timezone_names tz on tz.name = btrim(c.timezone)
     where c.id = new.company_id),
    'Europe/Berlin'
  )
  into company_timezone;

  new.scheduled_start := (new.date + new.start_time) at time zone company_timezone;
  return new;
end;
$$;

comment on function public.sync_job_scheduled_start() is
'BEFORE-Trigger: leitet jobs.scheduled_start aus date + start_time in der '
'Firmen-Zeitzone ab, sobald beide gesetzt sind (Migration 20261015000000).';

revoke all on function public.sync_job_scheduled_start() from public;
revoke all on function public.sync_job_scheduled_start() from anon, authenticated;

drop trigger if exists trg_jobs_sync_scheduled_start on public.jobs;

create trigger trg_jobs_sync_scheduled_start
  before insert or update of date, start_time, scheduled_start, company_id
  on public.jobs
  for each row
  execute function public.sync_job_scheduled_start();
