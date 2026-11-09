-- =========================================================
-- MIGRATION: Mehrfachzuweisung — sichere Abschlussregel
-- Datum: 2026-10-29
-- =========================================================
-- PROBLEM (Produktions-Audit 2026-10-27, Spray Out):
--   16 Auftraege haengen dauerhaft auf 'in_progress'. 13 davon folgen
--   demselben Muster: eine Mitarbeiterin hat gestartet UND abgeschlossen,
--   ein weiterer Zugewiesener hat NIE gestartet, keine offene Sitzung.
--   Ursache: maybe_complete_job (20260917000000) wertete JEDE lebende
--   Zuweisungszeile ohne employee_completed_at als ungeloest
--   (job_assignment_unresolved). Wer zugewiesen war, aber nie gearbeitet
--   hat, blockierte den Auftrag damit fuer immer — set_job_assignments kann
--   ihn zwar entfernen, aber niemand bemerkt den Fall.
--
-- FREIGEGEBENE REGEL (Produktentscheidung 2026-10-27):
--   Ein Auftrag wird 'completed' GENAU DANN, wenn
--     (1) mindestens ein Zugewiesener tatsaechlich GESTARTET hat,
--     (2) jeder, der gestartet hat, seine Teilnahme ABGESCHLOSSEN hat, und
--     (3) KEINE offene Arbeitssitzung (work_sessions.ended_at IS NULL) fuer
--         den Auftrag existiert.
--   Nie gestartete Zuweisungen blockieren nicht mehr.
--
-- GESTARTET (Beweis echter Arbeit, nie die blosse Zuweisung):
--     employee_started_at IS NOT NULL
--  OR attendance = 'started'                       (Alt-Selbsterfassung)
--  OR employee_id = jobs.started_by                (Alt-Akteur des Starts)
--  OR es existiert eine work_sessions-Zeile fuer diese Zuweisung
--   Bewusst weit gefasst: jeder zusaetzliche Startbeweis macht die Zeile nur
--   zu einem weiteren BLOCKIERER, solange kein eigener Abschluss vorliegt.
--   Ein Abschluss allein (employee_completed_at ohne Startbeweis) zaehlt
--   NICHT als Start — eine solche inkonsistente Zeile kann den Auftrag also
--   weder blockieren noch allein schliessen.
--
-- ABGESCHLOSSEN: ausschliesslich employee_completed_at IS NOT NULL.
--   Ein beendetes Sitzungsintervall (ended_at) ist KEIN Abschluss — Pause
--   und Pruefungsuebergabe (work_review_required) beenden die Sitzung, ohne
--   die Teilnahme abzuschliessen.
--
-- OFFENE SITZUNG: weicher Abbruch (return false) VOR dem UPDATE. Der Trigger
--   guard_job_completion_with_active_session wuerde sonst eine Exception
--   werfen und damit die Abschlussaktion des aufrufenden Mitarbeiters
--   zuruecksetzen. Der Trigger bleibt als Rueckfallebene unveraendert.
--
-- KEINE RUECKWIRKENDE MUTATION:
--   Diese Migration ersetzt nur den Funktionskoerper. Es gibt keinen
--   Trigger, Cron oder Backfill, der maybe_complete_job aufruft — sie laeuft
--   ausschliesslich innerhalb der bestehenden Ereignis-RPCs
--   (complete_own_job, _execute_work_session_operation 'complete',
--   admin_review_session_assignment, set_job_assignments). Bestehende
--   haengende Auftraege bleiben unveraendert, bis eines dieser Ereignisse fuer
--   genau diesen Auftrag eintritt; ihre Bereinigung ist ein separater,
--   ausdruecklich freizugebender Schritt.
--
-- UNVERAENDERT: Signatur, Rueckgabetyp, Sperrdisziplin (Aufrufer haelt die
--   jobs-Zeile FOR UPDATE), Event-Verhalten (p_emit_event), Grants, alle
--   Aufrufer, Stundenzettel, Terminierung, admin_force_complete_job.
--   job_assignment_unresolved bleibt bestehen (nur noch Referenz/Rollback).
--
-- ROLLBACK: Funktionskoerper aus 20260917000000 (Abschnitt 3) erneut
--   einspielen. Keine Daten- oder Schemaaenderung.
-- =========================================================

begin;

create or replace function public.maybe_complete_job(
  p_job_id     uuid,
  p_actor      uuid,
  p_at         timestamptz,
  p_emit_event boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job                public.jobs%rowtype;
  v_has_started        boolean;
  v_has_open_started   boolean;
  v_emp_name           text;
begin
  -- Kein FOR UPDATE: der Aufrufer haelt die Sperre bereits (siehe 20260917000000).
  select * into v_job from public.jobs where id = p_job_id;

  if not found or v_job.status <> 'in_progress' then
    return false;
  end if;

  -- (3) Offene Sitzung blockiert — unabhaengig von den Zeitstempeln der
  -- Zuweisungszeilen, auch wenn diese widerspruechlich wirken.
  if exists (
    select 1
    from public.job_assignments ja
    join public.work_sessions ws on ws.job_assignment_id = ja.id
    where ja.job_id = p_job_id
      and ws.ended_at is null
  ) then
    return false;
  end if;

  -- (1) + (2) in einem Durchlauf ueber die Zuweisungsmenge.
  select coalesce(bool_or(s.started), false),
         coalesce(bool_or(s.started and ja.employee_completed_at is null), false)
    into v_has_started, v_has_open_started
  from public.job_assignments ja
  cross join lateral (
    select (
         ja.employee_started_at is not null
      or ja.attendance = 'started'
      or (v_job.started_by is not null and ja.employee_id = v_job.started_by)
      or exists (select 1 from public.work_sessions ws
                 where ws.job_assignment_id = ja.id)
    ) as started
  ) s
  where ja.job_id = p_job_id;

  -- Niemand hat nachweislich gearbeitet -> nie automatisch schliessen.
  if not v_has_started then
    return false;
  end if;

  -- Jemand hat gestartet, aber (noch) nicht abgeschlossen.
  if v_has_open_started then
    return false;
  end if;

  update public.jobs
  set status       = 'completed',
      completed_at = p_at,
      completed_by = p_actor
  where id = p_job_id
    and status = 'in_progress';

  if not found then
    return false;
  end if;

  if p_emit_event then
    select full_name into v_emp_name from public.profiles where id = p_actor;

    insert into public.notification_outbox (
      company_id, job_id, event_type, job_status,
      employee_id, employee_name, customer_name, service_name
    )
    values (
      v_job.company_id, v_job.id, 'job_completed', 'completed',
      p_actor, v_emp_name, v_job.customer_name, v_job.service_name
    )
    on conflict (job_id, event_type) where event_type in ('job_started', 'job_completed')
    do nothing;
  end if;

  return true;
end;
$$;

comment on function public.maybe_complete_job(uuid, uuid, timestamptz, boolean) is
'INTERN, nicht fuer Clients. Schliesst den Auftrag genau dann, wenn (1) '
'mindestens ein Zugewiesener nachweislich GESTARTET hat (employee_started_at, '
'attendance=''started'', employee_id=jobs.started_by oder eine work_sessions-'
'Zeile), (2) jeder Gestartete employee_completed_at traegt und (3) keine '
'offene Arbeitssitzung zum Auftrag existiert. Nie gestartete Zuweisungen '
'blockieren nicht (20261029000000; vorher blockierte jede lebende Zeile ohne '
'Abschluss). Ein beendetes Sitzungsintervall gilt NICHT als Abschluss. Der '
'Aufrufer MUSS die jobs-Zeile bereits FOR UPDATE halten. p_emit_event=false '
'unterdrueckt das job_completed-Event fuer administrativ verursachte '
'Abschluesse. Gibt true zurueck, wenn der Auftrag in diesem Aufruf geschlossen '
'wurde.';

revoke all on function public.maybe_complete_job(uuid, uuid, timestamptz, boolean) from public, anon, authenticated;

comment on function public.job_assignment_unresolved(uuid, timestamptz, timestamptz) is
'ABGELOEST durch 20261029000000: maybe_complete_job wertet nie gestartete '
'Zuweisungen nicht mehr als ungeloest. Nur noch fuer Referenz/Rollback '
'erhalten; kein Aufrufer im Schema. Urspruenglich (Phase 16): ungeloest = kein '
'eigener Abschluss UND (Konto lebt ODER es wurde selbst gestartet).';

commit;
