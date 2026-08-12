-- =========================================================
-- MIGRATION: Employee Worked Time — Grundlage (Phase 1 von N)
-- Datum: 2026-08-12
-- =========================================================
-- ZWECK
--   job_assignments traegt seit Phase 1 (20260725000000) die Spalten
--   employee_started_at / employee_completed_at / attendance /
--   counts_for_timesheet — bislang schreibt KEIN Code sie. Diese Migration
--   befuellt sie erstmals, indem start_own_job/complete_own_job zusaetzlich
--   zur bestehenden geteilten Job-Uhr (jobs.started_at/completed_at) die
--   EIGENE Zuweisungszeile des Aufrufers aktualisiert.
--
--   Der Auftrag behaelt weiterhin GENAU EINE offizielle Dauer
--   (jobs.completed_at - jobs.started_at, siehe Phase 7,
--   20260731000000) — daran aendert diese Migration NICHTS. Was neu
--   entsteht, ist ein PARALLELER, rein additiver Nachweis: wann genau
--   DIESER Mitarbeiter selbst Start/Abschluss gedrueckt hat. Zwei
--   Mitarbeiter auf demselben Auftrag koennen damit ab sofort
--   unterschiedliche eigene Zeitstempel tragen, waehrend der Auftrag
--   selbst weiterhin einen einzigen geteilten Status hat.
--
-- BEWUSST NICHT TEIL DIESER MIGRATION
--   * Keine Aenderung an jobs, an dessen Spalten oder Policies.
--   * Keine Aenderung an Autorisierung/Statusbedingungen der beiden RPCs
--     (Firma, Rolle, job_type, Zuweisungspruefung, status-Uebergaenge) —
--     ausschliesslich additive UPDATE-Anweisungen auf job_assignments.
--   * Kein Wechsel des Stundenzettels auf job_assignments/
--     counts_for_timesheet. services/timesheets/timesheet.service.ts liest
--     weiterhin ausschliesslich jobs.started_at/completed_at; das bleibt
--     unveraendert (siehe Kommentar dort, "WARUM (NOCH) NICHT
--     counts_for_timesheet").
--   * Kein Manager-Review, keine Overlap-Erkennung, keine geplante Dauer,
--     kein Timesheet-Redesign — das ist eigener Scope.
--   * Keine neuen Tabellen, keine neuen Policies, keine neuen Grants:
--     beide RPCs sind bereits SECURITY DEFINER und schreiben bereits auf
--     jobs; job_assignments bleibt fuer authenticated weiterhin nur lesbar
--     (siehe 20260727000000) — der zusaetzliche Schreibzugriff laeuft
--     ausschliesslich ueber diese beiden bestehenden RPCs, exakt wie bei
--     jobs selbst.
--
-- WARUM `WHERE employee_id = auth.uid()` GENUEGT (Sicherheit)
--   Die neue UPDATE-Anweisung ist an `job_id = job_id_input AND
--   employee_id = auth.uid()` gebunden — sie kann strukturell NIE eine
--   fremde Zuweisungszeile treffen. Es ist keine zusaetzliche
--   Firmen-/Rollenpruefung noetig, weil beide RPCs diese Pruefung bereits
--   vorher fuer die jobs-Zeile durchgefuehrt haben (bzw. im No-Op-Zweig
--   ueber dieselben Bedingungen wie zuvor). Existiert fuer den Aufrufer
--   keine passende job_assignments-Zeile (historische Bestandszeilen ohne
--   Zuweisungszeile, siehe Phase 1 Backfill-Ausnahmen), matcht das UPDATE
--   schlicht null Zeilen — kein Fehler, kein Sonderfall noetig.
--
-- WARUM AUCH IM NO-OP-ZWEIG GESCHRIEBEN WIRD (spaeter beigetretener
-- Mitarbeiter)
--   Bei Mehrfachzuweisung ist die jobs-Uhr bereits geteilt: startet Ahmad
--   zuerst, ist der Auftrag beim Start-Aufruf von Maria nicht mehr 'open'
--   — die jobs-UPDATE trifft dort strukturell nie, unabhaengig von dieser
--   Migration (No-Op-Zweig, unveraendertes Verhalten). Damit Maria
--   TROTZDEM ihre eigene Start-/Abschlusszeit erhaelt, muss die
--   job_assignments-Aktualisierung in BEIDEN Zweigen laufen (echter
--   Uebergang UND No-Op) — sie ist an die Zuweisungspruefung gebunden,
--   nicht an den jobs-Statusuebergang.
--
-- WARUM COALESCE STATT UEBERSCHREIBEN (Idempotenz)
--   employee_started_at/employee_completed_at werden nur beim JEWEILS
--   ERSTEN Aufruf gesetzt (COALESCE behaelt den vorhandenen Wert). Ein
--   Doppel-Tap oder Offline-Retry desselben Mitarbeiters kann seinen
--   eigenen Zeitstempel damit nie nachtraeglich verschieben — exakt
--   dieselbe "der Erste gewinnt"-Idempotenz wie bei jobs.started_at der
--   geteilten Uhr.
--
-- WARUM `attendance` BEIM START NICHT ZURUECKFAELLT
--   `attendance = case when attendance = 'assigned' then 'started' else
--   attendance end` hebt den Zustand nur EINMAL an (assigned -> started).
--   Ein zweiter Start-Aufruf desselben Mitarbeiters (No-Op) ueberschreibt
--   damit weder ein bereits gesetztes 'started' noch ein bereits
--   gesetztes 'completed'. Beim Abschluss ist keine Fallunterscheidung
--   noetig: 'completed' ist ein terminaler Zustand und darf immer gesetzt
--   werden, ganz gleich ob vorher 'assigned' oder 'started' (ein
--   Mitarbeiter darf laut Datenmodell abschliessen, ohne selbst gestartet
--   zu haben, siehe Kommentar auf job_assignments.employee_completed_at).
--
-- IDEMPOTENZ DER MIGRATION
--   Reine CREATE OR REPLACE FUNCTION (Signatur, Grants, Kommentare
--   unveraendert) — vollstaendig wiederholbar.
--
-- ANWENDUNG
--   Wie alle Schemaaenderungen hier MANUELL im Supabase SQL Editor
--   ausfuehren (siehe CLAUDE.md). Diese Migration wurde NICHT auf der
--   Produktionsdatenbank ausgefuehrt.
-- =========================================================


-- ---------------------------------------------------------
-- 1. RPC: START OWN JOB — zusaetzlich eigene Zuweisungszeile pflegen
-- ---------------------------------------------------------
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
    on conflict (job_id, event_type) do nothing;

    -- NEU (Phase 1 Worked Time): eigene Zuweisungszeile mitfuehren. COALESCE
    -- haelt den Zeitstempel beim spaeteren Doppel-Tap fest; attendance hebt
    -- nur EINMAL von 'assigned' auf 'started' an (siehe Migrationskopf).
    update public.job_assignments
    set
      employee_started_at = coalesce(employee_started_at, started_at_input),
      attendance = case when attendance = 'assigned' then 'started' else attendance end
    where job_id = job_id_input
      and employee_id = auth.uid();

    return started_at_input;
  end if;

  select * into existing_row
  from public.jobs
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    );

  if found then
    -- NEU (Phase 1 Worked Time): auch im No-Op-Zweig — ein spaeter
    -- beigetretener Mitarbeiter (Job bereits von einem Kollegen gestartet
    -- oder sogar abgeschlossen) erhaelt hier trotzdem seine EIGENE
    -- Startzeit (siehe Migrationskopf, "spaeter beigetretener Mitarbeiter").
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

grant execute on function public.start_own_job(uuid, timestamptz) to authenticated;

comment on function public.start_own_job(uuid, timestamptz) is
'Setzt einen Auftrag der eigenen Firma auf in_progress. Berechtigt ist JEDER ueber job_assignments Zugewiesene sowie (Bestand) der Legacy-Primaer jobs.assigned_to; nur role=employee, nur job_type=single. Schreibt started_at/started_by und ein job_started-Outbox-Event genau beim echten Uebergang open -> in_progress; bereits gestartet/abgeschlossen ist ein idempotenter No-Op und gibt die GETEILTE Startzeit zurueck. Pflegt zusaetzlich (Phase 1 Worked Time, 20260812000000) employee_started_at/attendance auf der EIGENEN job_assignments-Zeile des Aufrufers, unabhaengig davon ob dies ein echter Uebergang oder ein No-Op ist — damit erhaelt auch ein spaeter beigetretener Mitarbeiter seine eigene Startzeit. Aendert NICHT die Autorisierung, die Statusbedingungen oder die geteilte Job-Uhr.';


-- ---------------------------------------------------------
-- 2. RPC: COMPLETE OWN JOB — zusaetzlich eigene Zuweisungszeile pflegen
-- ---------------------------------------------------------
create or replace function public.complete_own_job(
  job_id_input uuid,
  completed_at_input timestamptz default now()
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
    status = 'completed',
    completed_at = completed_at_input,
    completed_by = auth.uid()
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and status = 'in_progress'
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
      updated_row.company_id, updated_row.id, 'job_completed', 'completed',
      auth.uid(), emp_name, updated_row.customer_name, updated_row.service_name
    )
    on conflict (job_id, event_type) do nothing;

    -- NEU (Phase 1 Worked Time): eigene Zuweisungszeile mitfuehren.
    -- 'completed' ist terminal und darf immer gesetzt werden (siehe
    -- Migrationskopf) — ein Mitarbeiter darf abschliessen, ohne selbst
    -- gestartet zu haben.
    update public.job_assignments
    set
      employee_completed_at = coalesce(employee_completed_at, completed_at_input),
      attendance = 'completed'
    where job_id = job_id_input
      and employee_id = auth.uid();

    return completed_at_input;
  end if;

  select * into existing_row
  from public.jobs
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    );

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  if existing_row.status = 'completed' then
    -- NEU (Phase 1 Worked Time): auch im No-Op-Zweig — ein spaeter
    -- abschliessender Mitarbeiter (Job bereits von einem Kollegen
    -- abgeschlossen) erhaelt trotzdem seine EIGENE Abschlusszeit.
    update public.job_assignments
    set
      employee_completed_at = coalesce(employee_completed_at, completed_at_input),
      attendance = 'completed'
    where job_id = job_id_input
      and employee_id = auth.uid();

    return coalesce(existing_row.completed_at, completed_at_input);
  end if;

  raise exception 'Job not in progress (cannot complete)';
end;
$$;

grant execute on function public.complete_own_job(uuid, timestamptz) to authenticated;

comment on function public.complete_own_job(uuid, timestamptz) is
'Setzt einen laufenden Auftrag der eigenen Firma auf completed. Berechtigt ist JEDER ueber job_assignments Zugewiesene sowie (Bestand) der Legacy-Primaer; nur role=employee, nur job_type=single. Schreibt completed_at/completed_by und ein job_completed-Outbox-Event genau beim echten Uebergang in_progress -> completed; bereits abgeschlossen ist ein idempotenter No-Op. Ein noch nicht gestarteter Auftrag wird abgelehnt (ohne Start gibt es keine Dauer). Pflegt zusaetzlich (Phase 1 Worked Time, 20260812000000) employee_completed_at/attendance=''completed'' auf der EIGENEN job_assignments-Zeile des Aufrufers, sowohl beim echten Uebergang als auch beim No-Op (bereits von einem Kollegen abgeschlossener Auftrag) — damit erhaelt auch ein spaeter abschliessender Mitarbeiter seine eigene Abschlusszeit. Aendert NICHT die Autorisierung, die Statusbedingungen oder die geteilte Job-Uhr.';
