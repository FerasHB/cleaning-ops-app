-- 20260829000000_block_start_of_paused_recurring_occurrence.sql
-- ---------------------------------------------------------------------------
-- PHASE 8 BLOCKER FIX — ein deaktivierter Dauerauftrag darf keine
-- aktionierbare Arbeit mehr sein.
--
-- Ausgangslage (auf Staging reproduziert):
--   setRecurringRuleActive(rule, false) setzt jobs.is_active = false auf der
--   Parent-Regel; update_job_occurrences() propagiert das über den SYNC-
--   Schritt auf die zukünftigen, sauberen, OFFENEN Occurrences
--   (status = 'open', started_at/completed_at IS NULL). start_own_job() prüfte
--   is_active bislang NICHT — ein zugewiesener Mitarbeiter konnte einen so
--   pausierten Termin trotzdem starten und Arbeitszeit dagegen erfassen.
--
-- Operative Regel (bewusst eng gefasst):
--   Eine Zeile ist ein PAUSIERTER Dauerauftrags-Termin gdw.
--       parent_job_id IS NOT NULL     -- eine generierte Occurrence
--   AND is_active = false             -- Regel deaktiviert, per SYNC vererbt
--   AND status   = 'open'             -- noch nicht begonnen
--   Solche Zeilen sind KEINE aktionierbare Arbeit.
--
--   * Gewöhnliche Einzelaufträge (parent_job_id IS NULL) sind strukturell
--     ausgenommen — buildSchedulePayload() in services/jobs/jobs.service.ts
--     schreibt sie IMMER mit is_active = true; der Aktiv/Inaktiv-Schalter im
--     Formular existiert nur für den recurring-Zweig.
--   * Historische Termine (status IN ('in_progress','completed')) sind NIE
--     betroffen — die Bedingung greift nur bei status = 'open'. Der SYNC-
--     Schritt fasst gestartete/abgeschlossene Occurrences ohnehin nicht an,
--     d. h. deren is_active bleibt so, wie es beim Start war.
--   * Reaktivierung: setRecurringRuleActive(rule, true) → update_job_occurrences
--     → SYNC setzt is_active der in Frage kommenden zukünftigen, sauberen,
--     offenen Occurrences zurück auf true; sie werden damit automatisch wieder
--     startbar. Kein zusätzlicher Code nötig.
--
-- Diese Migration ändert AUSSCHLIESSLICH public.start_own_job:
--   1. Der eigentliche Übergang open -> in_progress schließt pausierte
--      Occurrences aus.
--   2. Der idempotente Rückfall-Pfad (für den geteilten Arbeits-Timer:
--      ein weiterer Zugewiesener „startet" einen bereits laufenden Auftrag)
--      greift nur noch, wenn der Auftrag NICHT MEHR offen ist
--      (status <> 'open'). Ohne diese zweite Schranke hätte der Rückfall für
--      einen pausierten (offenen) Termin employee_started_at/attendance auf
--      der Zuweisungszeile gestempelt und einen Zeitstempel zurückgegeben —
--      ein „Scheinerfolg", obwohl der Auftrag nie in_progress wurde.
--
-- public.complete_own_job bleibt UNVERÄNDERT: dessen Rückfall-Pfad prüft
-- bereits `existing_row.status = 'completed'` und lehnt einen offenen
-- (pausierten) Termin mit „Job not in progress (cannot complete)" ab. Ein
-- bereits GESTARTETER Termin (in_progress) bleibt abschließbar, auch wenn die
-- Regel danach deaktiviert wurde — der SYNC hat seine is_active-Spalte nicht
-- angefasst.
-- ---------------------------------------------------------------------------

create or replace function public.start_own_job(
  job_id_input uuid,
  started_at_input timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_row  public.jobs%rowtype;
  existing_row public.jobs%rowtype;
  emp_name     text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.jobs
  set
    status = 'in_progress',
    started_at = started_at_input,
    started_by = auth.uid(),
    completed_at = null,
    completed_by = null
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and status = 'open'
    -- PAUSIERTE Dauerauftrags-Occurrence ausschließen (siehe Kopfkommentar).
    -- Gewöhnliche Einzelaufträge: parent_job_id IS NULL -> Bedingung erfüllt.
    and (parent_job_id is null or coalesce(is_active, true))
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    )
  returning * into updated_row;

  if found then
    select full_name into emp_name from public.profiles where id = auth.uid();

    insert into public.notification_outbox (
      company_id, job_id, event_type, job_status,
      employee_id, employee_name, customer_name, service_name
    )
    values (
      updated_row.company_id, updated_row.id, 'job_started', 'in_progress',
      auth.uid(), emp_name, updated_row.customer_name, updated_row.service_name
    )
    on conflict (job_id, event_type) where event_type in ('job_started', 'job_completed')
    do nothing;

    update public.job_assignments
    set
      employee_started_at = coalesce(employee_started_at, started_at_input),
      attendance = case when attendance = 'assigned' then 'started' else attendance end
    where job_id = job_id_input
      and employee_id = auth.uid();

    return started_at_input;
  end if;

  -- Idempotenter Rückfall (geteilter Arbeits-Timer): NUR wenn der Auftrag
  -- bereits NICHT MEHR offen ist. Ein pausierter (offener) Termin fällt damit
  -- durch bis zur Ausnahme unten — kein Scheinerfolg, keine Stempel auf der
  -- Zuweisungszeile.
  select * into existing_row
  from public.jobs
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and status <> 'open'
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    );

  if found then
    update public.job_assignments
    set
      employee_started_at = coalesce(employee_started_at, started_at_input),
      attendance = case when attendance = 'assigned' then 'started' else attendance end
    where job_id = job_id_input
      and employee_id = auth.uid();

    return coalesce(existing_row.started_at, started_at_input);
  end if;

  raise exception 'Job not found or not allowed';
end;
$$;

-- Ausführungsrechte unverändert bestätigen (idempotent — gleiche GRANTs wie
-- in 20260723000002_harden_rpc_execute_grants.sql / 20260731000000).
revoke all on function public.start_own_job(uuid, timestamptz) from public;
grant execute on function public.start_own_job(uuid, timestamptz) to authenticated;

comment on function public.start_own_job(uuid, timestamptz) is
  'Employee-Start eines Einzeltermins (open -> in_progress). Schließt seit '
  '20260829000000 pausierte Dauerauftrags-Occurrences aus '
  '(parent_job_id IS NOT NULL AND is_active = false AND status = ''open''). '
  'Der idempotente Rückfall greift nur bei status <> ''open''.';
