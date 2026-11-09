-- =========================================================
-- MIGRATION: jobs.completed_at = letzter echter Teilnehmer-Abschluss
-- Datum: 2026-10-30
-- =========================================================
-- PROBLEM:
--   maybe_complete_job (20261029000000) setzte completed_at = p_at, also den
--   Zeitpunkt des AUSLOESENDEN Aufrufs. jobs.completed_at ist aber die
--   offizielle geteilte Auftragsuhr (completed_at - started_at). Zwei Pfade
--   verfaelschten sie:
--     * Offline-Sync in falscher Reihenfolge: A schliesst um 10:00 ab, B
--       synchronisiert spaeter einen Offline-Abschluss von 09:50 -> die
--       Auftragsuhr endete um 09:50, vor A's eigenem Abschluss.
--     * set_job_assignments ruft mit p_at = now(): ein Admin-Speichern auf
--       einem haengenden Auftrag (13 solche Auftraege auf Produktion) setzte
--       den Speicherzeitpunkt — ggf. Tage nach der letzten Arbeit.
--
-- FIX: completed_at = max(employee_completed_at) ueber alle GESTARTETEN
--   Zuweisungen (dieselbe Startbeweis-Definition wie die Abschlussregel).
--   Zum Zeitpunkt des Abschlusses hat jeder Gestartete einen Abschluss,
--   der Wert ist also immer gesetzt; p_at bleibt nur als Rueckfall.
--   Fuer den Normalfall (letzter Abschliessender loest aus) ist der Wert
--   identisch mit p_at. completed_by bleibt der ausloesende Akteur.
--
-- UNVERAENDERT: Abschlussregel, Signatur, Sperrdisziplin, Events, Grants.
--   admin_force_complete_job setzt weiterhin bewusst now() (eigener Pfad).
-- ROLLBACK: Funktion aus 20261029000000 erneut einspielen.
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
  v_last_completion    timestamptz;
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
         coalesce(bool_or(s.started and ja.employee_completed_at is null), false),
         max(ja.employee_completed_at) filter (where s.started)
    into v_has_started, v_has_open_started, v_last_completion
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

  -- Offizielle Auftragsuhr = letzter echter Teilnehmer-Abschluss, nicht der
  -- Aufrufzeitpunkt (20261030000001). p_at nur als Rueckfall.
  update public.jobs
  set status       = 'completed',
      completed_at = coalesce(v_last_completion, p_at),
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
'blockieren nicht (20261029000000). completed_at = spaetester '
'employee_completed_at der Gestarteten, Rueckfall p_at (20261030000001). Ein '
'beendetes Sitzungsintervall gilt NICHT als Abschluss. Der Aufrufer MUSS die '
'jobs-Zeile bereits FOR UPDATE halten. p_emit_event=false unterdrueckt das '
'job_completed-Event fuer administrativ verursachte Abschluesse. Gibt true '
'zurueck, wenn der Auftrag in diesem Aufruf geschlossen wurde.';

revoke all on function public.maybe_complete_job(uuid, uuid, timestamptz, boolean) from public, anon, authenticated;

commit;
