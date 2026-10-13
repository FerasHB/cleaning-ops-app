-- =====================================================================
-- Recurring horizon extension (self-maintaining Daueraufträge)
-- =====================================================================
--
-- PROBLEM (verifiziert 2026-10-12, Prod read-only):
--   generate_job_occurrences materialisiert Termine nur, wenn ein Admin eine
--   Regel anlegt, bearbeitet oder umschaltet — für offene Regeln (ohne
--   recurrence_end_date) genau "heute + 3 Monate". Nichts verlängert dieses
--   Fenster danach. Unberührte Regeln laufen still aus: Regel bleibt aktiv,
--   Mitarbeiter bekommen schlicht keine Termine mehr.
--
-- LÖSUNG (freigegebene Produktentscheidungen):
--   1. Rollierender 90-Tage-Horizont für offene, AKTIVE Regeln — automatisch,
--      serverseitig, täglich per pg_cron.
--   2. Einzeln gelöschte Termine bleiben gelöscht (Tombstones), auch für den
--      Generator.
--   3. Pausierte Regeln (is_active = false) erzeugen KEINE neuen Termine —
--      weder per Cron noch per Admin-Pfad. Beim Reaktivieren füllt der
--      normale Toggle-/Edit-Pfad (update_job_occurrences) sofort auf.
--   4. Historie (Vergangenheit, gestartet, abgeschlossen) bleibt unberührt.
--      Bestehende, zeitzonenverschobene scheduled_start-Werte werden NICHT
--      bereinigt; NEU erzeugte Termine nutzen die Firmen-Zeitzone
--      (unverändert seit 20260921000000).
--
-- OBJEKTE:
--   * public.job_occurrence_skips          — Tombstones je (Regel, Slot)
--   * public.recurring_rule_horizons       — "lückenlos erzeugt bis" je Regel
--   * public.recurring_horizon_runs        — Protokoll jedes Worker-Laufs
--   * public._materialize_recurring_occurrences(uuid, date)
--                                          — interner Kern, OHNE Client-Auth,
--                                            sperrt die Regel (FOR UPDATE)
--   * public.generate_job_occurrences(uuid) — Admin-RPC, Auth unverändert,
--                                            delegiert an den Kern
--   * public.record_occurrence_skip()      — AFTER-DELETE-Trigger auf jobs
--   * public.recurring_horizon_health      — Health-View (nur Server)
--   * public.extend_recurring_horizons()   — Cron-Worker (nur Server)
--   * public.compat_sync_assignments_from_legacy()
--                                          — assigned_by im Worker-Kontext NULL
--                                            statt jobs.created_by
--   * pg_cron-Job 'recurring-horizon-extension', täglich 02:17 UTC
--     (nachts in Europa; ruft public.extend_recurring_horizons()).
--
-- HORIZONT-ARITHMETIK:
--   Ziel ("desired_through")  = min(recurrence_end_date, heute_firma + 90)
--   Verlängert wird, sobald    generated_through < min(recurrence_end_date,
--                                                     heute_firma + 83)
--   Die 7 Tage Spielraum entsprechen genau einer Wochentag-Periode: jede
--   ausgelöste Verlängerung erzeugt damit mindestens einen neuen Slot
--   (sofern nicht per Tombstone gesperrt) und übersteht bis zu ~83 Tage
--   Cron-Ausfall, bevor Mitarbeiter eine Lücke sehen.
--   Der Admin-Pfad bleibt bei "+3 Monate" (bzw. Regel-Ende, 730-Tage-Deckel),
--   damit die Client-Vorschau utils/recurringOccurrencePreview.ts exakt
--   bleibt; 3 Monate >= 89 Tage liegen immer über der 83-Tage-Schwelle.
--
-- NEBENLÄUFIGKEIT / IDEMPOTENZ:
--   * Kern sperrt die Parent-Zeile FOR UPDATE (Admin-Edit und Worker
--     serialisieren je Regel).
--   * Slot-Eindeutigkeit: idx_jobs_occurrence_slot_unique + ON CONFLICT DO
--     NOTHING (unverändert). Zuweisungen: uq_job_assignments_job_employee +
--     ON CONFLICT DO NOTHING (unverändert, inherit_occurrence_assignments).
--   * Worker nimmt zusätzlich ein transaktionales Advisory-Lock; ein zweiter,
--     gleichzeitiger Lauf protokolliert "skipped_concurrent" und endet.
--   * Jede Regel läuft in einem eigenen Subtransaktions-Block: ein Fehler
--     rollt nur diese Regel zurück, wird in recurring_horizon_runs
--     protokolliert und beim nächsten Tageslauf automatisch erneut versucht.
--
-- BENACHRICHTIGUNGEN:
--   Weder jobs- noch job_assignments-Trigger schreiben in die
--   notification_outbox (job_assigned entsteht nur in set_job_assignments).
--   Der Worker verschickt daher — wie der bisherige Admin-Pfad — KEINE Pushes.
--
-- ROLLBACK (manuell, falls nötig):
--   select cron.unschedule('recurring-horizon-extension');
--   drop trigger trg_jobs_record_occurrence_skip on public.jobs;
--   generate_job_occurrences / compat_sync_assignments_from_legacy aus
--   20260921000000 bzw. 20260918000000 erneut anwenden; danach die neuen
--   Funktionen, die View und die drei Tabellen droppen. Erzeugte Termine
--   sind reguläre Occurrences und dürfen bleiben.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Tombstones: bewusst gelöschte Einzeltermine
-- ---------------------------------------------------------------------
create table if not exists public.job_occurrence_skips (
  parent_job_id   uuid        not null references public.jobs(id) on delete cascade,
  occurrence_date date        not null,
  skipped_at      timestamptz not null default now(),
  -- Wer gelöscht hat, sofern ein angemeldeter Nutzer (sonst NULL).
  skipped_by      uuid        references public.profiles(id) on delete set null,
  -- id der gelöschten Occurrence (nur Nachvollziehbarkeit, kein FK — die
  -- Zeile existiert nicht mehr).
  source_job_id   uuid,
  primary key (parent_job_id, occurrence_date)
);

comment on table public.job_occurrence_skips is
'Tombstones: ein Admin hat diesen Slot (Regel, occurrence_date) bewusst gelöscht. '
'Der Generator (_materialize_recurring_occurrences) erzeugt ihn nie wieder. '
'Geschrieben ausschließlich vom AFTER-DELETE-Trigger record_occurrence_skip; '
'interne Wartung (update_job_occurrences PRUNE, app.series_sync=on) und das '
'Löschen der ganzen Regel (CASCADE) erzeugen KEINE Tombstones.';

alter table public.job_occurrence_skips enable row level security;
revoke all on table public.job_occurrence_skips from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. Horizont je Regel: bis wann ist lückenlos materialisiert?
-- ---------------------------------------------------------------------
-- Eigene Tabelle statt Spalte auf jobs: ein Update hier löst weder
-- trg_jobs_updated_at noch Realtime-Events auf der jobs-Tabelle aus.
create table if not exists public.recurring_rule_horizons (
  parent_job_id     uuid        primary key references public.jobs(id) on delete cascade,
  generated_through date        not null,
  last_extended_at  timestamptz not null default now()
);

comment on table public.recurring_rule_horizons is
'Je Dauerauftrags-Regel: alle Slots von heute bis generated_through sind '
'materialisiert (abzüglich Tombstones). Wird bei JEDER Generierung (Admin-Pfad '
'und Worker) mit dem gerade erzeugten Fensterende ÜBERSCHRIEBEN. Fehlt die '
'Zeile (Bestandsregeln vor dieser Migration), gilt max(occurrence_date).';

alter table public.recurring_rule_horizons enable row level security;
revoke all on table public.recurring_rule_horizons from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. Lauf-Protokoll des Workers (Monitoring)
-- ---------------------------------------------------------------------
create table if not exists public.recurring_horizon_runs (
  id                   bigint      generated always as identity primary key,
  started_at           timestamptz not null,
  finished_at          timestamptz not null,
  skipped_concurrent   boolean     not null default false,
  rules_due            int         not null default 0,
  rules_extended       int         not null default 0,
  occurrences_inserted int         not null default 0,
  errors               int         not null default 0,
  error_details        jsonb       not null default '[]'::jsonb
);

comment on table public.recurring_horizon_runs is
'Ein Eintrag je Aufruf von extend_recurring_horizons() (Cron oder manuell). '
'errors > 0 oder ein fehlender Eintrag der letzten 24 h = Alarm.';

alter table public.recurring_horizon_runs enable row level security;
revoke all on table public.recurring_horizon_runs from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. Interner Kern: Termine einer Regel bis p_through materialisieren
-- ---------------------------------------------------------------------
-- Inhaltlich die Schleife aus 20260921000000 (Wochentage, Firmen-Zeitzone
-- für scheduled_start, Legacy-Zeiger nur bei aktivem Mitarbeiter,
-- ON CONFLICT auf den Slot, Zuweisungs-Vererbung), ergänzt um:
--   * FOR UPDATE auf die Parent-Zeile (Serialisierung je Regel),
--   * pausierte Regel ⇒ 0, nichts wird erzeugt,
--   * Tombstones werden übersprungen,
--   * recurring_rule_horizons wird gepflegt.
-- KEINE Client-Autorisierung: nur für generate_job_occurrences (prüft
-- Admin + Firma) und extend_recurring_horizons (nur Server) gedacht;
-- EXECUTE ist für anon/authenticated entzogen.
--
-- p_through ist das gewünschte Fensterende. Gedeckelt wird wie bisher auf
-- recurrence_end_date und generation_start + 730 Tage.
create or replace function public._materialize_recurring_occurrences(
  p_parent_job_id uuid,
  p_through       date
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent                public.jobs%rowtype;
  company_timezone      text;
  generation_start      date;
  generation_end        date;
  check_date            date;
  day_code              text;
  inserted_count        int := 0;
  rows_affected         int;
  effective_assigned_to uuid;
begin
  select * into parent
  from public.jobs
  where id            = p_parent_job_id
    and job_type      = 'recurring'
    and parent_job_id is null
  for update;

  if not found then
    raise exception 'Recurring parent job not found';
  end if;

  -- Pausierte Regeln erzeugen keine neuen Termine (Produktentscheidung).
  -- NULL gilt wie im Client (mapJob: is_active ?? true) als aktiv.
  if parent.is_active is false then
    return 0;
  end if;

  select coalesce(tz.name, 'Europe/Berlin') into company_timezone
  from public.companies c
  left join pg_catalog.pg_timezone_names tz on tz.name = btrim(c.timezone)
  where c.id = parent.company_id;

  perform set_config('app.series_sync', 'on', true);

  select case
    when parent.assigned_to is not null
      and exists (
        select 1 from public.profiles p
        where p.id = parent.assigned_to
          and p.is_active = true
      )
    then parent.assigned_to
    else null
  end
  into effective_assigned_to;

  generation_start := greatest(
    coalesce(parent.recurrence_start_date, current_date),
    current_date
  );

  generation_end := least(
    p_through,
    coalesce(parent.recurrence_end_date, p_through),
    generation_start + 730
  );

  check_date := generation_start;
  while check_date <= generation_end loop

    day_code := case extract(isodow from check_date)::int
      when 1 then 'mon'
      when 2 then 'tue'
      when 3 then 'wed'
      when 4 then 'thu'
      when 5 then 'fri'
      when 6 then 'sat'
      when 7 then 'sun'
    end;

    if parent.recurring_days @> array[day_code]
       and not exists (
         select 1 from public.job_occurrence_skips s
         where s.parent_job_id   = parent.id
           and s.occurrence_date = check_date
       )
    then
      insert into public.jobs (
        company_id, parent_job_id, customer_name, service_name,
        location_address, notes, status, assigned_to,
        job_type, date, occurrence_date, start_time, planned_duration_minutes,
        scheduled_start, is_active, created_by
      )
      values (
        parent.company_id, parent.id, parent.customer_name, parent.service_name,
        parent.location_address, parent.notes, 'open', effective_assigned_to,
        'single', check_date, check_date, parent.start_time, parent.planned_duration_minutes,
        case
          when parent.start_time is not null
          then (check_date + parent.start_time) at time zone company_timezone
          else null
        end,
        parent.is_active, parent.created_by
      )
      on conflict (parent_job_id, occurrence_date)
        where parent_job_id is not null
      do nothing;

      get diagnostics rows_affected = row_count;
      inserted_count := inserted_count + rows_affected;
    end if;

    check_date := check_date + 1;
  end loop;

  -- Vollständige Zuweisungsmenge der Regel auf die nicht angepassten
  -- Termine übertragen (unverändert seit Phase 4, idempotent).
  perform public.inherit_occurrence_assignments(p_parent_job_id);

  -- Fensterende ÜBERSCHREIBEN (nicht greatest): ein späteres Kürzen des
  -- Regel-Endes (PRUNE) und anschließendes Entfernen des Endes darf keinen
  -- zu weit in der Zukunft liegenden Stand zurücklassen.
  insert into public.recurring_rule_horizons as h
    (parent_job_id, generated_through, last_extended_at)
  values (parent.id, generation_end, now())
  on conflict (parent_job_id) do update
    set generated_through = excluded.generated_through,
        last_extended_at  = excluded.last_extended_at;

  perform set_config('app.series_sync', 'off', true);

  return inserted_count;
end;
$$;

comment on function public._materialize_recurring_occurrences(uuid, date) is
'Interner Kern der Termin-Materialisierung (ohne Client-Auth). Sperrt die Regel, '
'überspringt pausierte Regeln und Tombstones, deckelt auf recurrence_end_date und '
'+730 Tage, schreibt recurring_rule_horizons. Nur über generate_job_occurrences '
'(Admin) und extend_recurring_horizons (Cron) aufrufen.';

revoke all on function public._materialize_recurring_occurrences(uuid, date) from public;
revoke all on function public._materialize_recurring_occurrences(uuid, date) from anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. Admin-RPC: Autorisierung unverändert, Erzeugung über den Kern
-- ---------------------------------------------------------------------
-- Fensterende wie bisher: Regel-Ende, sonst generation_start + 3 Monate
-- (730-Tage-Deckel wendet der Kern an). Signatur, Rückgabe und Grants
-- bleiben identisch (create or replace erhält die bestehenden Grants).
create or replace function public.generate_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent           public.jobs%rowtype;
  generation_start date;
  window_end       date;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can generate occurrences';
  end if;

  select * into parent
  from public.jobs
  where id          = parent_job_id_input
    and company_id  = public.current_user_company_id()
    and job_type    = 'recurring'
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found or not accessible';
  end if;

  generation_start := greatest(
    coalesce(parent.recurrence_start_date, current_date),
    current_date
  );

  window_end := case
    when parent.recurrence_end_date is not null
      then parent.recurrence_end_date
    else (generation_start + interval '3 months')::date
  end;

  return public._materialize_recurring_occurrences(parent_job_id_input, window_end);
end;
$$;


-- ---------------------------------------------------------------------
-- 6. Tombstone-Trigger: Einzeltermin gelöscht ⇒ Slot dauerhaft sperren
-- ---------------------------------------------------------------------
-- Datenbankseitig, damit JEDER Löschpfad abgedeckt ist (EditJobScreen,
-- künftige Screens, SQL). Keine Tombstones für:
--   * Zeilen ohne parent_job_id (normale Einzel-Jobs, Regeln selbst),
--   * interne Wartung: update_job_occurrences PRUNE läuft mit
--     app.series_sync = 'on',
--   * Löschen der ganzen Regel: im CASCADE ist die Parent-Zeile beim
--     AFTER-Trigger bereits weg ⇒ EXISTS-Prüfung schlägt fehl (und der FK
--     würde den Insert ohnehin verbieten),
--   * vergangene Slots (der Generator beginnt nie vor current_date; ein
--     Tag Puffer für Zeitzonen westlich von UTC).
create or replace function public.record_occurrence_skip()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_slot date;
begin
  if old.parent_job_id is null then
    return null;
  end if;

  if coalesce(current_setting('app.series_sync', true), '') = 'on' then
    return null;
  end if;

  v_slot := coalesce(old.occurrence_date, old.date);
  if v_slot is null or v_slot < current_date - 1 then
    return null;
  end if;

  insert into public.job_occurrence_skips
    (parent_job_id, occurrence_date, skipped_by, source_job_id)
  select
    old.parent_job_id,
    v_slot,
    (select p.id from public.profiles p where p.id = auth.uid()),
    old.id
  where exists (select 1 from public.jobs j where j.id = old.parent_job_id)
  on conflict (parent_job_id, occurrence_date) do nothing;

  return null;
end;
$$;

comment on function public.record_occurrence_skip() is
'AFTER-DELETE-Trigger auf jobs: bewusst gelöschte, zukünftige Dauerauftrags-'
'Termine als Tombstone in job_occurrence_skips festhalten. Ignoriert interne '
'Wartung (app.series_sync=on) und das Löschen der ganzen Regel (CASCADE).';

revoke all on function public.record_occurrence_skip() from public;
revoke all on function public.record_occurrence_skip() from anon, authenticated;

drop trigger if exists trg_jobs_record_occurrence_skip on public.jobs;
create trigger trg_jobs_record_occurrence_skip
  after delete on public.jobs
  for each row
  when (old.parent_job_id is not null)
  execute function public.record_occurrence_skip();


-- ---------------------------------------------------------------------
-- 7. Health-View (nur Server; keine Kunden-/Personendaten)
-- ---------------------------------------------------------------------
-- status:
--   paused          — is_active = false, wird bewusst nicht verlängert
--   ended           — recurrence_end_date < heute (Firmen-Zeitzone)
--   needs_extension — Abdeckung unter der 83-Tage-Schwelle
--   ok              — ausreichend erzeugt
-- critical = aktive, nicht beendete Regel mit < 30 Tagen Abdeckung, obwohl
-- das Regel-Ende (falls vorhanden) weiter entfernt ist. Nach einem
-- erfolgreichen Worker-Lauf muss die Menge "critical" leer sein.
create or replace view public.recurring_horizon_health
with (security_invoker = true)
as
with company_tz as (
  select c.id as company_id,
         coalesce(tz.name, 'Europe/Berlin') as timezone
  from public.companies c
  left join pg_catalog.pg_timezone_names tz on tz.name = btrim(c.timezone)
),
rules as (
  select
    r.id                                  as parent_job_id,
    r.company_id,
    coalesce(r.is_active, true)           as is_active,
    r.recurring_days,
    r.recurrence_start_date,
    r.recurrence_end_date,
    (now() at time zone ct.timezone)::date as today_local,
    o.latest_occurrence_date,
    h.generated_through                   as recorded_generated_through,
    h.last_extended_at,
    coalesce(h.generated_through, o.latest_occurrence_date) as generated_through
  from public.jobs r
  join company_tz ct on ct.company_id = r.company_id
  left join public.recurring_rule_horizons h on h.parent_job_id = r.id
  left join lateral (
    select max(c.occurrence_date) as latest_occurrence_date
    from public.jobs c
    where c.parent_job_id = r.id
  ) o on true
  where r.job_type = 'recurring'
    and r.parent_job_id is null
),
calc as (
  select
    rules.*,
    least(coalesce(recurrence_end_date, today_local + 90), today_local + 90) as desired_through,
    least(coalesce(recurrence_end_date, today_local + 83), today_local + 83) as extend_below,
    least(coalesce(recurrence_end_date, today_local + 30), today_local + 30) as critical_below,
    (recurrence_end_date is not null and recurrence_end_date < today_local)  as is_ended
  from rules
)
select
  parent_job_id,
  company_id,
  is_active,
  recurring_days,
  recurrence_start_date,
  recurrence_end_date,
  today_local,
  latest_occurrence_date,
  recorded_generated_through,
  generated_through,
  desired_through,
  generated_through - today_local                          as coverage_days,
  last_extended_at,
  (is_active and not is_ended
     and coalesce(generated_through, today_local - 1) < extend_below)   as needs_extension,
  (is_active and not is_ended
     and coalesce(generated_through, today_local - 1) < critical_below) as critical,
  case
    when not is_active then 'paused'
    when is_ended then 'ended'
    when coalesce(generated_through, today_local - 1) < extend_below then 'needs_extension'
    else 'ok'
  end                                                      as status
from calc;

comment on view public.recurring_horizon_health is
'Monitoring der Dauerauftrags-Horizonte (eine Zeile je Regel, nur IDs/Datumswerte). '
'Gesund: keine Zeile mit critical = true; nach dem Worker-Lauf auch keine mit '
'needs_extension = true (außer bei Fehlern, siehe recurring_horizon_runs).';

revoke all on table public.recurring_horizon_health from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 8. Worker: alle fälligen aktiven Regeln auf heute + 90 auffüllen
-- ---------------------------------------------------------------------
-- Läuft ohne JWT (pg_cron als postgres). auth.uid() ist dort NULL;
-- app.horizon_worker = 'on' sorgt dafür, dass der Legacy-Kompatibilitäts-
-- trigger assigned_by NULL setzt statt jobs.created_by (keine erfundene
-- handelnde Person). inherit_occurrence_assignments setzt assigned_by
-- ohnehin aus auth.uid() ⇒ NULL.
create or replace function public.extend_recurring_horizons()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r                record;
  v_started        timestamptz := clock_timestamp();
  v_due            int   := 0;
  v_extended       int   := 0;
  v_inserted       int   := 0;
  v_errors         int   := 0;
  v_error_details  jsonb := '[]'::jsonb;
  v_rows           int;
  v_result         jsonb;
begin
  -- Nur ein Lauf gleichzeitig (Cron + manueller Aufruf o. ä.). Der zweite
  -- endet sofort; Korrektheit hinge davon nicht ab (Kern sperrt je Regel,
  -- Slots/Zuweisungen sind eindeutig), es spart nur doppelte Arbeit.
  if not pg_try_advisory_xact_lock(hashtext('public.extend_recurring_horizons')) then
    insert into public.recurring_horizon_runs (started_at, finished_at, skipped_concurrent)
    values (v_started, clock_timestamp(), true);
    return jsonb_build_object('skipped_concurrent', true);
  end if;

  perform set_config('app.horizon_worker', 'on', true);

  for r in
    select parent_job_id, desired_through
    from public.recurring_horizon_health
    where needs_extension
    order by generated_through nulls first, parent_job_id
  loop
    v_due := v_due + 1;
    begin
      v_rows := public._materialize_recurring_occurrences(r.parent_job_id, r.desired_through);
      v_inserted := v_inserted + v_rows;
      v_extended := v_extended + 1;
    exception when others then
      v_errors := v_errors + 1;
      v_error_details := v_error_details || jsonb_build_object(
        'parent_job_id', r.parent_job_id,
        'sqlstate',      sqlstate,
        'message',       sqlerrm
      );
    end;
  end loop;

  perform set_config('app.horizon_worker', '', true);

  insert into public.recurring_horizon_runs (
    started_at, finished_at, rules_due, rules_extended,
    occurrences_inserted, errors, error_details
  )
  values (
    v_started, clock_timestamp(), v_due, v_extended,
    v_inserted, v_errors, v_error_details
  );

  v_result := jsonb_build_object(
    'rules_due',            v_due,
    'rules_extended',       v_extended,
    'occurrences_inserted', v_inserted,
    'errors',               v_errors
  );

  if v_errors > 0 then
    raise warning 'extend_recurring_horizons: % Regel(n) fehlgeschlagen: %',
      v_errors, v_error_details;
  end if;

  return v_result;
end;
$$;

comment on function public.extend_recurring_horizons() is
'Cron-Worker (täglich, Job recurring-horizon-extension): füllt alle aktiven, nicht '
'beendeten Dauerauftrags-Regeln mit needs_extension auf min(Regel-Ende, heute+90) '
'auf. Idempotent, je Regel fehlerisoliert, protokolliert in recurring_horizon_runs.';

revoke all on function public.extend_recurring_horizons() from public;
revoke all on function public.extend_recurring_horizons() from anon, authenticated;


-- ---------------------------------------------------------------------
-- 9. Legacy-Kompatibilitätstrigger: keine erfundene handelnde Person
-- ---------------------------------------------------------------------
-- Unverändert gegenüber 20260918000000 bis auf die Bestimmung von
-- v_actor: im Worker-Kontext (app.horizon_worker = 'on', kein JWT) bleibt
-- assigned_by NULL, statt auf jobs.created_by zurückzufallen. Für
-- angemeldete Aufrufer (auth.uid() gesetzt) und alle übrigen Pfade ohne
-- JWT ändert sich nichts.
create or replace function public.compat_sync_assignments_from_legacy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor           uuid;
  v_anonymisierung  boolean;
begin
  -- Wir stecken bereits in der Gegenrichtung -> nichts tun.
  if public.compat_assignment_sync_active() then
    return null;
  end if;

  perform set_config('app.jobs_assignment_sync', '1', true);

  begin
    -- ── Menge auf den neuen Legacy-Wert reduzieren ─────────────────
    -- Ein alter Client kann keine Menge ausdruecken; sein Schreibvorgang
    -- bedeutet "ab jetzt genau dieser eine Mitarbeiter". Deshalb werden
    -- ALLE spurenfreien Zuweisungen entfernt, die nicht dem neuen Wert
    -- entsprechen — nicht nur die des bisherigen Primaers (20260729000000).
    --
    -- Geschuetzt bleiben: Anwesenheit, Review, Zeitstempel (Nachweise)
    -- sowie anonymisierte Zeilen aus Konto-Loeschungen.
    --
    -- AUSNAHME: der Anonymisierungspfad einer Konto-Loeschung. Wird ein
    -- Profil geloescht, setzt der Fremdschluessel jobs_assigned_to_fkey
    -- (ON DELETE SET NULL) assigned_to auf NULL — sieht auf Trigger-Ebene
    -- aus wie ein alter Client, der niemandem mehr zuweist, ist es aber
    -- nicht. Ohne diese Unterscheidung wuerde eine Konto-Loeschung die
    -- Zuweisungen ALLER UEBRIGEN, unbeteiligten Mitarbeiter mit entfernen.
    v_anonymisierung :=
      tg_op = 'UPDATE'
      and new.assigned_to is null
      and old.assigned_to is not null
      and not exists (select 1 from public.profiles p where p.id = old.assigned_to);

    if tg_op = 'UPDATE' and not v_anonymisierung then
      delete from public.job_assignments ja
      where ja.job_id                 = new.id
        and ja.employee_id           is not null
        and ja.employee_id           is distinct from new.assigned_to
        and ja.attendance             = 'assigned'
        and ja.review                is null
        and ja.employee_started_at   is null
        and ja.employee_completed_at is null;
    end if;

    -- ── Neuen Zeiger spiegeln ──────────────────────────────────────
    if new.assigned_to is not null then

      -- Handelnde Person, sofern verlässlich bestimmbar: der
      -- authentifizierte Aufrufer, sonst der Ersteller des Auftrags —
      -- außer im Cron-Worker (app.horizon_worker), dort bleibt sie NULL.
      select p.id into v_actor
      from public.profiles p
      where p.id = coalesce(
        auth.uid(),
        case
          when coalesce(current_setting('app.horizon_worker', true), '') = 'on'
            then null
          else new.created_by
        end
      );

      -- PATCH 20260918 (Befund 1): weder attendance noch employee_started_at/
      -- employee_completed_at werden noch aus new.status/new.started_at/
      -- new.completed_at abgeleitet. Diese Zeile entsteht ausschliesslich
      -- als Kompatibilitäts-Zeiger fuer Alt-Clients, die nur assigned_to
      -- kennen — sie ist kein Nachweis dafuer, dass DIESER Mitarbeiter
      -- irgendetwas selbst getan hat, und darf deshalb nie mit Werten
      -- starten, die das behaupten. Ein spaeterer echter start_own_job/
      -- complete_own_job-Aufruf desselben Mitarbeiters schreibt diese
      -- Spalten weiterhin ganz regulaer (COALESCE-Semantik dort bleibt
      -- unveraendert). Vorher: attendance wurde aus new.status abgeleitet
      -- ('completed'/'in_progress'/'assigned') und employee_started_at/
      -- employee_completed_at aus new.started_at/new.completed_at, sobald
      -- new.status entsprechend stand — genau das liess sich vom
      -- Stundenzettel (services/timesheets/timesheet.service.ts, mapEntry
      -- Regel 1) ununterscheidbar von echter eigener Arbeitszeit lesen.
      insert into public.job_assignments (
        job_id, employee_id, employee_name_snapshot,
        assigned_at, assigned_by,
        attendance, employee_started_at, employee_completed_at
      )
      select
        new.id,
        new.assigned_to,
        -- Schnappschuss immer aus dem LEBENDEN Profilnamen, nie leer.
        coalesce(nullif(btrim(p.full_name), ''), 'Unbekannt'),
        now(),
        v_actor,
        'assigned'::public.attendance_state,
        null,
        null
      from public.profiles p
      where p.id = new.assigned_to
      -- Idempotenz: existiert die Zuweisung bereits, bleibt sie
      -- unveraendert. Insbesondere werden vorhandene Anwesenheits- und
      -- Review-Daten NICHT überschrieben.
      on conflict (job_id, employee_id) do nothing;
    end if;

    perform set_config('app.jobs_assignment_sync', '', true);

  exception when others then
    -- Flag auch im Fehlerfall zurücksetzen, damit ein von außen
    -- abgefangener Fehler den Rest der Transaktion nicht stumm schaltet.
    perform set_config('app.jobs_assignment_sync', '', true);
    raise;
  end;

  return null;
end;
$$;


-- ---------------------------------------------------------------------
-- 10. pg_cron: täglich 02:17 UTC
-- ---------------------------------------------------------------------
-- Name deterministisch; bei erneutem Anwenden erst entfernen, dann neu
-- anlegen (kein doppelter Job).
create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'recurring-horizon-extension') then
    perform cron.unschedule('recurring-horizon-extension');
  end if;
end $$;

select cron.schedule(
  'recurring-horizon-extension',
  '17 2 * * *',
  $cron$select public.extend_recurring_horizons();$cron$
);
