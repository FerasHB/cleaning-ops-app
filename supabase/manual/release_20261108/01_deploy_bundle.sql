-- =========================================================
-- PRODUCTION DEPLOY BUNDLE 2026-11-08 (ivzsbspopudqgobunsdv)
-- Applies 4 migrations in ONE transaction, records them in
-- supabase_migrations.schema_migrations, then verifies the result.
-- Any mismatch raises and rolls back everything.
-- Only function bodies change: no table, data, trigger or grant change.
-- =========================================================
begin;

-- Pre-check: Production must be exactly at the expected state.
do $pre$ begin
  if (select max(version) from supabase_migrations.schema_migrations) <> '20261028000000' then
    raise exception 'PRECHECK: unexpected migration head'; end if;
  if (select md5(prosrc) from pg_proc where proname='maybe_complete_job') <> '733e7d14135b2791ce20c8918c00a906'
     or (select md5(prosrc) from pg_proc where proname='get_company_worktime_export') <> '95dd11d181b31210c8656b432ab405e4'
     or (select md5(prosrc) from pg_proc where proname='get_work_recovery_queue') <> '1aece1d361efaf30ec5a2bafd06bac18' then
    raise exception 'PRECHECK: function definitions differ from the reviewed baseline'; end if;
end $pre$;

-- >>> 20261029000000_multi_assignment_completion_rule
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

insert into supabase_migrations.schema_migrations(version,name,statements) values ('20261029000000','multi_assignment_completion_rule',array['applied via deploy bundle supabase/manual/release_20261108']);

-- >>> 20261030000000_worktime_export_no_borrowed_time
-- =========================================================
-- MIGRATION: Arbeitszeit-Export ohne geliehene Auftragszeit
-- Datum: 2026-10-30
-- =========================================================
-- PROBLEM:
--   get_company_worktime_export() (20261028000000) bildete Legacy-Zeilen
--   spaltenweise als coalesce(eigene Zeit, geteilte Job-Uhr). Folgen:
--     * Ein Zugewiesener, der NIE gestartet hat, bekam die volle
--       Auftragsdauer eines Kollegen als Arbeitszeit im Export.
--     * Ein eigener Start ohne eigenes Ende wurde mit dem geteilten Ende
--       kombiniert (gemischtes Paar, erfundene Dauer).
--   Der Export ist der Aufbewahrungsnachweis des Arbeitgebers vor der
--   Firmenloeschung. Der App-Stundenzettel (timesheet.service.ts, mapEntry)
--   schliesst genau diese Faelle seit PR #88 bewusst aus. Mit der neuen
--   Abschlussregel (20261029000000) werden Auftraege mit nie gestarteten
--   Zugewiesenen regulaer abgeschlossen — der Fehler traefe damit jeden
--   solchen Auftrag.
--
-- REGEL (identisch zu mapEntry, Cutoff = utils/jobCorrection.ts
-- PHASE1_CUTOFF_ISO = 2026-08-12T00:00:00Z):
--   1. Eigenes Paar vollstaendig            -> eigene Zeiten.
--   2. Sonst, Auftrag VOR dem Cutoff abgeschlossen und geteilte Uhr
--      vollstaendig                         -> geteilte Uhr (einzige Quelle).
--   3. Sonst                                -> nur eigene Werte, nie geliehen;
--      ohne eigenen Start keine Zeile.
--
-- UNVERAENDERT: Signatur, Spalten, Berechtigung (nur aktive Admins der
--   eigenen Firma), Sitzungszweig, Sortierung, Grants.
-- ROLLBACK: Funktion aus 20261028000000 erneut einspielen. Keine
--   Daten- oder Schemaaenderung.
-- =========================================================


create or replace function public.get_company_worktime_export()
returns table (
  record_kind text,
  employee_id uuid,
  employee_name text,
  work_date date,
  start_local text,
  end_local text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_minutes integer,
  raw_started_at timestamptz,
  raw_ended_at timestamptz,
  corrected boolean,
  correction_count integer,
  last_correction_origin text,
  last_corrected_at timestamptz,
  time_adjustment_count integer,
  job_id uuid,
  assignment_id uuid,
  timezone text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_role text;
  v_company_id uuid;
  v_is_active boolean;
  v_tz text;
begin
  if v_caller is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select p.role, p.company_id, p.is_active
    into v_role, v_company_id, v_is_active
  from public.profiles p
  where p.id = v_caller;

  if not found or v_role is distinct from 'admin' or v_company_id is null
     or v_is_active is distinct from true then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select coalesce(nullif(c.timezone, ''), 'Europe/Berlin')
    into v_tz
  from public.companies c
  where c.id = v_company_id;

  return query
  with company_assignments as (
    select ja.id, ja.job_id, ja.employee_id, ja.employee_name_snapshot,
           ja.time_tracking_mode, ja.employee_started_at, ja.employee_completed_at,
           j.started_at as job_started_at, j.completed_at as job_completed_at
    from public.job_assignments ja
    join public.jobs j on j.id = ja.job_id
    where j.company_id = v_company_id
  ),
  sessions as (
    select 'session'::text as kind, ca.employee_id as emp,
           coalesce(p.full_name, ca.employee_name_snapshot) as emp_name,
           e.effective_started_at as s, e.effective_ended_at as f,
           e.raw_started_at as rs, e.raw_ended_at as rf,
           e.reviewed as corr,
           (select count(*)::int from public.session_time_corrections stc
             where stc.work_session_id = e.session_id) as corr_count,
           lc.origin as corr_origin, lc.created_at as corr_at,
           0 as adj_count,
           ca.job_id as jid, ca.id as aid
    from public._effective_sessions(
           (select coalesce(array_agg(id), '{}') from company_assignments)) e
    join company_assignments ca on ca.id = e.job_assignment_id
    left join public.profiles p on p.id = ca.employee_id
    left join lateral (
      select stc.origin, stc.created_at
      from public.session_time_corrections stc
      where stc.work_session_id = e.session_id
      order by stc.revision_no desc
      limit 1
    ) lc on true
  ),
  legacy as (
    select 'assignment'::text as kind, ca.employee_id as emp,
           coalesce(p.full_name, ca.employee_name_snapshot) as emp_name,
           src.s, src.f,
           null::timestamptz as rs, null::timestamptz as rf,
           false as corr, 0 as corr_count,
           null::text as corr_origin, null::timestamptz as corr_at,
           (select count(*)::int from public.employee_time_adjustments eta
             where eta.assignment_id = ca.id) as adj_count,
           ca.job_id as jid, ca.id as aid
    from company_assignments ca
    left join public.profiles p on p.id = ca.employee_id
    -- Quelle pro Zeile wie mapEntry: nie eigene und geteilte Werte mischen.
    cross join lateral (
      select
        case
          when ca.employee_started_at is not null
               and ca.employee_completed_at is not null
            then ca.employee_started_at
          when ca.job_completed_at < timestamptz '2026-08-12 00:00:00+00'
               and ca.job_started_at is not null
            then ca.job_started_at
          else ca.employee_started_at
        end as s,
        case
          when ca.employee_started_at is not null
               and ca.employee_completed_at is not null
            then ca.employee_completed_at
          when ca.job_completed_at < timestamptz '2026-08-12 00:00:00+00'
               and ca.job_started_at is not null
            then ca.job_completed_at
          else null::timestamptz
        end as f
    ) src
    where ca.time_tracking_mode = 'legacy'
      and src.s is not null
  )
  select r.kind, r.emp, r.emp_name,
         (r.s at time zone v_tz)::date,
         to_char(r.s at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
         to_char(r.f at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
         r.s, r.f,
         case when r.f is null then null
              else greatest(0, round(extract(epoch from (r.f - r.s)) / 60))::int end,
         r.rs, r.rf, r.corr, r.corr_count, r.corr_origin, r.corr_at, r.adj_count,
         r.jid, r.aid, v_tz
  from (select * from sessions union all select * from legacy) r
  order by r.emp_name nulls last, r.s, r.aid;
end;
$$;

comment on function public.get_company_worktime_export() is
'Arbeitszeit-Export der eigenen Firma für aktive Admins (vor der Firmenlöschung). Nur Arbeitszeit-Fakten; keine Abwesenheiten/Gesundheitsdaten, Notizen, Kommentare, Fotos, Kundendaten.';

revoke all on function public.get_company_worktime_export() from public, anon;
grant execute on function public.get_company_worktime_export() to authenticated;

insert into supabase_migrations.schema_migrations(version,name,statements) values ('20261030000000','worktime_export_no_borrowed_time',array['applied via deploy bundle supabase/manual/release_20261108']);

-- >>> 20261030000001_job_completed_at_last_participant
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

insert into supabase_migrations.schema_migrations(version,name,statements) values ('20261030000001','job_completed_at_last_participant',array['applied via deploy bundle supabase/manual/release_20261108']);

-- >>> 20261030000002_recovery_queue_last_op_order
-- =========================================================
-- MIGRATION: Recovery-Queue — eindeutige letzte Mitarbeiteraktion
-- Datum: 2026-10-30
-- =========================================================
-- PROBLEM:
--   get_work_recovery_queue (20260922000000) bestimmt den Grund
--   late_pause/late_complete ueber die juengste Quittung, sortiert nach
--   work_operation_receipts.created_at. created_at ist now() = Beginn der
--   Transaktion. Zwei Aktionen derselben Zuweisung werden zwar ueber die
--   Job-Sperre serialisiert, aber eine FRUEHER begonnene Transaktion, die
--   auf die Sperre wartet, committet SPAETER mit kleinerem created_at. Die
--   Queue meldete dann den falschen Grund (z. B. late_pause statt
--   late_complete). Im Regressionstest (eine Transaktion) fuehrte derselbe
--   Gleichstand zu einem bekannten, sporadischen Fehlschlag.
--
-- FIX: primaer nach result_payload.recorded_at sortieren — clock_timestamp()
--   am Ende der Ausfuehrung, unter der Job-Sperre, also in echter
--   Ausfuehrungsreihenfolge. created_at bleibt Rueckfall.
--
-- UNVERAENDERT: Signatur, Spalten, Berechtigung, Grants, Kommentar.
-- ROLLBACK: Funktion aus 20260922000000 erneut einspielen.
-- =========================================================


CREATE OR REPLACE FUNCTION public.get_work_recovery_queue()
 RETURNS TABLE(assignment_id uuid, job_id uuid, employee_id uuid, employee_name text, customer_name text, service_name text, job_status job_status, employee_started_at timestamp with time zone, first_session_start timestamp with time zone, last_session_end timestamp with time zone, open_session_id uuid, open_session_started_at timestamp with time zone, recorded_seconds numeric, effective_seconds numeric, review_required boolean, reason_code text, stuck_since timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if public.current_user_role() is distinct from 'admin'
     or public.current_user_company_id() is null then
    raise exception 'Only admins can read the recovery queue' using errcode = '42501';
  end if;

  return query
  select ja.id,
         j.id,
         ja.employee_id,
         coalesce(nullif(btrim(p.full_name),''), ja.employee_name_snapshot, 'Unbekannt'),
         j.customer_name,
         j.service_name,
         j.status,
         ja.employee_started_at,
         agg.first_start,
         agg.last_end,
         agg.open_id,
         agg.open_started,
         agg.recorded_seconds,
         agg.effective_seconds,
         ja.work_review_required,
         case
           when agg.open_id is not null then 'open_session_expired'
           when ja.work_review_required and last_op.operation_type = 'pause'    then 'late_pause'
           when ja.work_review_required and last_op.operation_type = 'complete' then 'late_complete'
           when ja.work_review_required then 'review_required'
           else 'expired_unresolved'
         end,
         ja.employee_started_at + interval '12 hours'
  from public.job_assignments ja
  join public.jobs j on j.id = ja.job_id
  left join public.profiles p on p.id = ja.employee_id
  left join lateral (
    select min(e.effective_started_at)                              as first_start,
           max(e.effective_ended_at)                                as last_end,
           (array_agg(e.session_id) filter (where e.raw_ended_at is null))[1]    as open_id,
           (array_agg(e.raw_started_at) filter (where e.raw_ended_at is null))[1] as open_started,
           coalesce(sum(extract(epoch from e.raw_ended_at - e.raw_started_at))
             filter (where not exists (
               select 1 from public.session_time_corrections stc
               where stc.work_session_id = e.session_id
                 and stc.revision_no = 1 and stc.origin = 'admin_closed')),0)                 as recorded_seconds,
           coalesce(sum(extract(epoch from e.effective_ended_at - e.effective_started_at)),0) as effective_seconds
    from public._effective_sessions(array[ja.id]) e
  ) agg on true
  left join lateral (
    select r.operation_type from public.work_operation_receipts r
    where r.job_assignment_id = ja.id and r.operation_type <> 'admin_review'
    -- recorded_at = clock_timestamp() unter der Job-Sperre: eindeutige
    -- Reihenfolge auch wenn created_at (= Transaktionsstart) gleich ist oder
    -- eine frueher begonnene Transaktion spaeter committet (20261030000002).
    order by (r.result_payload->>'recorded_at')::timestamptz desc nulls last,
             r.created_at desc
    limit 1
  ) last_op on true
  where j.company_id = public.current_user_company_id()
    and ja.time_tracking_mode = 'sessions'
    and ja.employee_completed_at is null
    and ( ja.work_review_required
          or ja.employee_started_at < now() - interval '12 hours' )
  order by ja.employee_started_at;
end $function$;

insert into supabase_migrations.schema_migrations(version,name,statements) values ('20261030000002','recovery_queue_last_op_order',array['applied via deploy bundle supabase/manual/release_20261108']);

-- Post-check inside the same transaction.
do $post$ begin
  if (select md5(prosrc) from pg_proc where proname='maybe_complete_job') <> '3d4520449939c219b2523a4d229347ad'
     or (select md5(prosrc) from pg_proc where proname='get_company_worktime_export') <> 'ccf2d4925e26c51416fb2414b1d65144'
     or (select md5(prosrc) from pg_proc where proname='get_work_recovery_queue') <> 'f8ae16059f11776a4a98bc39c68a9d32' then
    raise exception 'POSTCHECK: deployed definitions differ from Staging/repo'; end if;
  if has_function_privilege('authenticated','public.maybe_complete_job(uuid,uuid,timestamptz,boolean)','execute')
     or has_function_privilege('anon','public.maybe_complete_job(uuid,uuid,timestamptz,boolean)','execute') then
    raise exception 'POSTCHECK: maybe_complete_job must not be client-callable'; end if;
  if not has_function_privilege('authenticated','public.get_company_worktime_export()','execute')
     or not has_function_privilege('authenticated','public.get_work_recovery_queue()','execute') then
    raise exception 'POSTCHECK: admin RPC grants lost'; end if;
  if (select max(version) from supabase_migrations.schema_migrations) <> '20261030000002' then
    raise exception 'POSTCHECK: bookkeeping head wrong'; end if;
end $post$;

commit;
