-- =====================================================================
-- Legacy recurring scheduled_start cleanup (einmalige Datenbereinigung)
-- =====================================================================
--
-- PROBLEM (verifiziert 2026-10-14, Prod read-only):
--   Vor 20260921000000 haben generate_job_occurrences / update_job_occurrences
--   scheduled_start als (date + start_time) in der Session-Zeitzone der DB
--   (UTC) geschrieben. Gemeint war aber die Wanduhrzeit der Firma: aus
--   14:30 Europe/Berlin wurde 14:30Z (= 16:30 MESZ / 15:30 MEZ).
--   20260921000000 hat nur NEU erzeugte Termine korrigiert. Bestandstermine
--   tragen weiterhin den verschobenen Wert (Prod: 1341 Zeilen, 0 mehrdeutig).
--   Maßgeblich bleiben date + start_time (CLAUDE.md); scheduled_start wird
--   heute nur als Fallback / Sortierschlüssel gelesen. Diese Migration stellt
--   die Konsistenz der Spalte her, damit künftige Leser nicht falsch rechnen.
--
-- UMFANG — eine Zeile wird NUR korrigiert, wenn ALLE Bedingungen gelten:
--   * parent_job_id is not null, Parent ist Regel (job_type='recurring',
--     parent_job_id is null)
--   * date, start_time, scheduled_start sind nicht null
--   * date = occurrence_date (Slot nie verschoben)
--   * schedule_overridden = false
--   * scheduled_start = (date + start_time) at time zone 'UTC'   (Legacy-Muster)
--   * scheduled_start <> (date + start_time) at time zone <Firmen-Zeitzone>
--   Firmen-Zeitzone exakt wie im Generator: companies.timezone (getrimmt),
--   falls ungültig/leer 'Europe/Berlin'.
--   NICHT angefasst: Parent-Regeln, normale Einzel-Jobs, null/ungültige
--   Zeilen, einzeln angepasste Termine, alles außerhalb des exakten Musters.
--
-- GEÄNDERT WIRD AUSSCHLIESSLICH jobs.scheduled_start.
--   Trigger-Nebenwirkungen (geprüft):
--   * trg_jobs_updated_at                → updated_at = now() (einzige
--                                          Nebenwirkung)
--   * trg_jobs_mark_schedule_override    → reagiert nur auf date/start_time;
--                                          schedule_overridden bleibt
--   * enforce_active_assignee_on_jobs    → prüft nur bei Änderung von
--                                          assigned_to/company_id
--   * guard_job_completion_*             → nur UPDATE OF status
--   * compat_sync_assignments_*_upd      → nur UPDATE OF assigned_to
--   Keine Audit-/History-Tabelle auf jobs, kein Outbox-Trigger auf jobs.
--   Realtime: jobs ist in supabase_realtime — jede korrigierte Zeile erzeugt
--   ein UPDATE-Event (Clients refetchen). Deshalb nachts ausführen, nicht im
--   Fenster des Cron-Jobs 'recurring-horizon-extension' (02:17 UTC).
--
-- ABBRUCHBEDINGUNGEN (Exception ⇒ komplette Transaktion zurückgerollt):
--   * optional: app.scheduled_start_fix_expected gesetzt und Kandidatenzahl
--     weicht ab (Prod-Rollout: vorher gemessene Zahl per SET LOCAL setzen)
--   * Anzahl aktualisierter Zeilen ≠ Anzahl gesicherter Zeilen
--   * nach dem Update existiert noch ein Kandidat
--   * eine korrigierte Zeile entspricht nicht dem erwarteten Wert oder trägt
--     schedule_overridden = true
--
-- BACKUP / ROLLBACK:
--   public._scheduled_start_fix_20261014 hält je Zeile alten und neuen Wert.
--   Rollback (stellt nur Zeilen zurück, die seitdem NICHT erneut geändert
--   wurden — spätere legitime Bearbeitungen bleiben erhalten):
--
--     update public.jobs j
--     set    scheduled_start = b.old_scheduled_start
--     from   public._scheduled_start_fix_20261014 b
--     where  j.id = b.job_id
--       and  j.scheduled_start = b.new_scheduled_start;
--
--   Die Backup-Tabelle nach einer Beobachtungsphase per eigener Migration
--   entfernen.
-- =====================================================================

create table public._scheduled_start_fix_20261014 (
  job_id               uuid        primary key,
  company_id           uuid        not null,
  parent_job_id        uuid        not null,
  company_timezone     text        not null,
  old_scheduled_start  timestamptz not null,
  new_scheduled_start  timestamptz not null,
  corrected_at         timestamptz not null default now()
);

comment on table public._scheduled_start_fix_20261014 is
'Backup der einmaligen Korrektur verschobener scheduled_start-Werte '
'(Migration 20261014000000). Nur Server; Rollback siehe Migrationskopf.';

alter table public._scheduled_start_fix_20261014 enable row level security;
revoke all on table public._scheduled_start_fix_20261014 from public, anon, authenticated;

do $$
declare
  v_expected   text := nullif(current_setting('app.scheduled_start_fix_expected', true), '');
  v_backed_up  int;
  v_updated    int;
  v_remaining  int;
  v_mismatch   int;
begin
  -- 1) Kandidaten sperren und sichern (FOR UPDATE: kein paralleler
  --    Schreiber kann zwischen Sicherung und Update dazwischenfunken).
  with candidates as (
    select
      j.id,
      j.company_id,
      j.parent_job_id,
      tz.name                                  as company_timezone,
      j.scheduled_start                        as old_scheduled_start,
      (j.date + j.start_time) at time zone tz.name as new_scheduled_start
    from public.jobs j
    join public.jobs p
      on  p.id            = j.parent_job_id
      and p.job_type      = 'recurring'
      and p.parent_job_id is null
    cross join lateral (
      select coalesce(tzn.name, 'Europe/Berlin') as name
      from public.companies c
      left join pg_catalog.pg_timezone_names tzn on tzn.name = btrim(c.timezone)
      where c.id = j.company_id
    ) tz
    where j.parent_job_id       is not null
      and j.date                is not null
      and j.start_time          is not null
      and j.scheduled_start     is not null
      and j.date                = j.occurrence_date
      and j.schedule_overridden = false
      and j.scheduled_start     =  (j.date + j.start_time) at time zone 'UTC'
      and j.scheduled_start     <> (j.date + j.start_time) at time zone tz.name
    for update of j
  )
  insert into public._scheduled_start_fix_20261014 (
    job_id, company_id, parent_job_id, company_timezone,
    old_scheduled_start, new_scheduled_start
  )
  select id, company_id, parent_job_id, company_timezone,
         old_scheduled_start, new_scheduled_start
  from candidates;

  get diagnostics v_backed_up = row_count;

  if v_expected is not null and v_backed_up <> v_expected::int then
    raise exception
      'scheduled_start fix aborted: % candidates, expected %', v_backed_up, v_expected;
  end if;

  -- 2) Nur scheduled_start setzen, und nur, solange der gesicherte alte Wert
  --    noch drinsteht.
  update public.jobs j
  set    scheduled_start = b.new_scheduled_start
  from   public._scheduled_start_fix_20261014 b
  where  j.id              = b.job_id
    and  j.scheduled_start = b.old_scheduled_start;

  get diagnostics v_updated = row_count;

  if v_updated <> v_backed_up then
    raise exception
      'scheduled_start fix aborted: updated % rows, backed up %', v_updated, v_backed_up;
  end if;

  -- 3) Nachkontrolle: kein Kandidat mehr übrig.
  select count(*) into v_remaining
  from public.jobs j
  join public.jobs p
    on  p.id = j.parent_job_id and p.job_type = 'recurring' and p.parent_job_id is null
  cross join lateral (
    select coalesce(tzn.name, 'Europe/Berlin') as name
    from public.companies c
    left join pg_catalog.pg_timezone_names tzn on tzn.name = btrim(c.timezone)
    where c.id = j.company_id
  ) tz
  where j.date is not null and j.start_time is not null and j.scheduled_start is not null
    and j.date = j.occurrence_date
    and j.schedule_overridden = false
    and j.scheduled_start =  (j.date + j.start_time) at time zone 'UTC'
    and j.scheduled_start <> (j.date + j.start_time) at time zone tz.name;

  if v_remaining <> 0 then
    raise exception 'scheduled_start fix aborted: % candidates remain', v_remaining;
  end if;

  -- 4) Jede korrigierte Zeile hat genau den erwarteten Wert und ist nicht
  --    als einzeln angepasst markiert worden.
  select count(*) into v_mismatch
  from public._scheduled_start_fix_20261014 b
  join public.jobs j on j.id = b.job_id
  where j.scheduled_start is distinct from (j.date + j.start_time) at time zone b.company_timezone
     or j.scheduled_start is distinct from b.new_scheduled_start
     or j.schedule_overridden;

  if v_mismatch <> 0 then
    raise exception 'scheduled_start fix aborted: % corrected rows failed verification', v_mismatch;
  end if;

  raise notice 'scheduled_start fix: % recurring occurrences corrected', v_updated;
end;
$$;
