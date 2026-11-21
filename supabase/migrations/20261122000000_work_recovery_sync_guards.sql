-- =========================================================
-- Work Recovery S1.6 — Recovery-Guards & Zuweisungs-Synchronisierung
-- =========================================================
-- Ziel: automatische Abgleichspfade dürfen Zuweisungen bzw. Termine, an
-- denen ein Prüffall (work_recovery_cases, JEDER Zustand) hängt, weder
-- löschen noch an ihnen scheitern. Geschützte Zeilen werden übersprungen,
-- alle übrigen Zeilen (andere Mitarbeiter, andere Termine, andere Firmen)
-- werden unverändert weiter abgeglichen.
--
-- Vorher (S1): eine Zuweisung mit offenem Fall ließ den Abgleich am Guard
-- (22023) scheitern, eine mit abgeschlossenem Fall am RESTRICT-FK (23503).
-- Weil jeder Abgleich EIN DELETE-Statement ist, brach damit der gesamte
-- Abgleich ab — Regel-Bearbeitung (update_job_occurrences →
-- PartialUpdateError), Horizont-Worker (die Regel scheitert jede Nacht) oder
-- der Schreibvorgang eines Alt-Clients (assigned_to).
--
-- Geändert:
--   1) Index work_recovery_cases (assignment_id) — der bisherige Index ist
--      partiell (nur offene Fälle) und dient weder dem zustandsfreien
--      NOT EXISTS noch der RESTRICT-Prüfung beim Löschen einer Zuweisung.
--   2) inherit_occurrence_assignments — Lösch-Schritt 1.
--   3) compat_sync_assignments_from_legacy — Mengen-Reduktion.
--   4) update_job_occurrences — Schritt PRUNE.
--   5) guard_assignment_open_recovery_case — deckt jetzt auch abgeschlossene
--      Fälle ab (klare Meldung statt des generischen FK-Fehlers 23503).
--      Offene Fälle: Meldung wörtlich unverändert.
--   6) _lock_company_for_recovery_write(uuid) — Sperr-Vertrag für S2.
--
-- NICHT geändert: set_job_assignments (expliziter Admin-Eingriff: scheitert
-- weiterhin sichtbar, jetzt mit klarer Meldung auch bei abgeschlossenen
-- Fällen — ein stilles Überspringen würde dem Admin eine Entfernung
-- vortäuschen), Auftrags-Abschluss, Arbeitszeit, Stundenzettel, Export,
-- Purge, Fall-Zustände. Keine neue Aufbewahrungs- oder Löschregel.
--
-- Muster gegen das Wettlauf-Fenster (alle drei Pfade):
--   Schritt a) Kandidaten mit SELECT … FOR UPDATE sperren (ohne Fall-Filter).
--   Schritt b) DELETE mit NOT EXISTS (Fall) als EIGENES Statement.
-- Grund (READ COMMITTED): ein gleichzeitig angelegter Fall hält über seinen
-- FK FOR KEY SHARE auf Zuweisung/Auftrag. Ein einzelnes DELETE würde darauf
-- warten und danach mit seinem ALTEN Snapshot weiterlaufen (die Zeile selbst
-- ist unverändert → keine Neuauswertung) — der neue Fall bliebe unsichtbar,
-- erst der Guard bräche den ganzen Abgleich ab. Mit a) wartet die Sperre,
-- b) nimmt danach einen NEUEN Snapshot, sieht den Fall und überspringt die
-- Zeile. Umgekehrt wartet ein Fall-INSERT, der nach a) kommt, auf die
-- FOR-UPDATE-Sperre (FOR KEY SHARE kollidiert mit FOR UPDATE) und scheitert
-- nach dem Löschen am FK (23503) bzw. läuft durch, wenn die Zeile blieb.
-- Der Guard bleibt als Rückfallebene bestehen.

-- =========================================================
-- 1) Index
-- =========================================================
create index if not exists work_recovery_cases_assignment_idx
  on public.work_recovery_cases (assignment_id);

-- =========================================================
-- 2) inherit_occurrence_assignments
-- =========================================================
-- Fassung aus 20260728000000; einzige Änderung: Schritt 1 sperrt zuerst die
-- Kandidaten und überspringt dann Zuweisungen mit Prüffall.
create or replace function public.inherit_occurrence_assignments(
  p_parent_job_id uuid,
  p_only_job_id   uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid;
  v_inserted int := 0;
begin
  select p.id into v_actor
  from public.profiles p
  where p.id = auth.uid();

  -- ── 1) Ueberzaehlige SAUBERE Zuweisungen entfernen ──────────────
  -- 1a) Kandidaten sperren (siehe Kopf: Wettlauf mit Fall-Anlage).
  perform 1
  from public.job_assignments d
  where d.employee_id           is not null
    and d.attendance             = 'assigned'
    and d.review                is null
    and d.employee_started_at   is null
    and d.employee_completed_at is null
    and d.job_id in (
      select c.id
      from public.jobs c
      where c.parent_job_id = p_parent_job_id
        and (p_only_job_id is null or c.id = p_only_job_id)
        and c.date        >= current_date
        and c.status       = 'open'
        and c.started_at  is null
        and c.completed_at is null
        and not exists (
          select 1 from public.job_occurrence_assignment_overrides o
          where o.job_id = c.id
        )
    )
    and not exists (
      select 1
      from public.job_assignments pa
      join public.profiles pp on pp.id = pa.employee_id
      join public.jobs      pj on pj.id = pa.job_id
      where pa.job_id       = p_parent_job_id
        and pa.employee_id  = d.employee_id
        and pp.is_active    = true
        and pp.role         = 'employee'
        and pp.company_id   = pj.company_id
    )
  order by d.id
  for update of d;

  -- 1b) Löschen — Zuweisungen mit Prüffall (jeder Zustand) bleiben.
  delete from public.job_assignments d
  where d.employee_id           is not null
    and d.attendance             = 'assigned'
    and d.review                is null
    and d.employee_started_at   is null
    and d.employee_completed_at is null
    and d.job_id in (
      select c.id
      from public.jobs c
      where c.parent_job_id = p_parent_job_id
        and (p_only_job_id is null or c.id = p_only_job_id)
        and c.date        >= current_date
        and c.status       = 'open'
        and c.started_at  is null
        and c.completed_at is null
        and not exists (
          select 1 from public.job_occurrence_assignment_overrides o
          where o.job_id = c.id
        )
    )
    and not exists (
      -- gehoert nicht (mehr) zur aktiven Zuweisungsmenge der Regel
      select 1
      from public.job_assignments pa
      join public.profiles pp on pp.id = pa.employee_id
      join public.jobs      pj on pj.id = pa.job_id
      where pa.job_id       = p_parent_job_id
        and pa.employee_id  = d.employee_id
        and pp.is_active    = true
        and pp.role         = 'employee'
        and pp.company_id   = pj.company_id
    )
    and not exists (
      -- S1.6: Nachweis-Zuweisung — nie durch den Abgleich entfernen
      select 1 from public.work_recovery_cases w
      where w.assignment_id = d.id
    );

  -- ── 2) Fehlende Zuweisungen ergaenzen ───────────────────────────
  insert into public.job_assignments (
    job_id, employee_id, employee_name_snapshot, assigned_by
  )
  select
    c.id,
    pa.employee_id,
    coalesce(nullif(btrim(pp.full_name), ''), 'Unbekannt'),
    v_actor
  from public.jobs c
  join public.job_assignments pa on pa.job_id = p_parent_job_id
  join public.profiles       pp on pp.id      = pa.employee_id
  join public.jobs           pj on pj.id      = pa.job_id
  where c.parent_job_id = p_parent_job_id
    and (p_only_job_id is null or c.id = p_only_job_id)
    and c.date        >= current_date
    and c.status       = 'open'
    and c.started_at  is null
    and c.completed_at is null
    and not exists (
      select 1 from public.job_occurrence_assignment_overrides o
      where o.job_id = c.id
    )
    and pa.employee_id is not null
    and pp.is_active   = true
    and pp.role        = 'employee'
    and pp.company_id  = pj.company_id
  -- Doppelte Zuweisungszeilen sind damit strukturell ausgeschlossen.
  on conflict (job_id, employee_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- =========================================================
-- 3) compat_sync_assignments_from_legacy
-- =========================================================
-- Fassung aus 20261012000000; einzige Änderung: die Mengen-Reduktion sperrt
-- zuerst die Kandidaten und überspringt dann Zuweisungen mit Prüffall. Der
-- neue Legacy-Zeiger wird unverändert gespiegelt; eine geschützte Zeile
-- bleibt zusätzlich in der Menge (Mehrfachzuweisung ist erlaubt).
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
    -- Geschuetzt bleiben: Anwesenheit, Review, Zeitstempel (Nachweise),
    -- anonymisierte Zeilen aus Konto-Loeschungen sowie (S1.6) Zuweisungen
    -- mit Prüffall.
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
      -- S1.6: Kandidaten zuerst sperren (Wettlauf mit Fall-Anlage).
      perform 1
      from public.job_assignments ja
      where ja.job_id                 = new.id
        and ja.employee_id           is not null
        and ja.employee_id           is distinct from new.assigned_to
        and ja.attendance             = 'assigned'
        and ja.review                is null
        and ja.employee_started_at   is null
        and ja.employee_completed_at is null
      order by ja.id
      for update of ja;

      delete from public.job_assignments ja
      where ja.job_id                 = new.id
        and ja.employee_id           is not null
        and ja.employee_id           is distinct from new.assigned_to
        and ja.attendance             = 'assigned'
        and ja.review                is null
        and ja.employee_started_at   is null
        and ja.employee_completed_at is null
        and not exists (
          select 1 from public.work_recovery_cases w
          where w.assignment_id = ja.id
        );
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
      -- employee_completed_at werden aus new.status/new.started_at/
      -- new.completed_at abgeleitet. Diese Zeile entsteht ausschliesslich
      -- als Kompatibilitäts-Zeiger fuer Alt-Clients, die nur assigned_to
      -- kennen — sie ist kein Nachweis dafuer, dass DIESER Mitarbeiter
      -- irgendetwas selbst getan hat.
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

-- =========================================================
-- 4) update_job_occurrences — PRUNE
-- =========================================================
-- Fassung aus 20260921000000; einzige Änderung: PRUNE sperrt zuerst die
-- Kandidaten-Termine und überspringt dann Termine mit Prüffall (jeder
-- Zustand). Der Fall verweist per Insert-Trigger immer auf den Termin SEINER
-- Zuweisung, der Termin-Filter deckt also auch alle Zuweisungen ab. Ein
-- übersprungener Termin bleibt als Rest-Historie stehen (wie Termine mit
-- Kommentaren/Fotos): RESCHEDULE fasst ihn nicht an, SYNC hält weiterhin
-- die Inhaltsfelder aktuell.
create or replace function public.update_job_occurrences(parent_job_id_input uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent    public.jobs%rowtype;
  company_timezone text;
  new_count int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can update occurrences';
  end if;

  select * into parent
  from public.jobs
  where id         = parent_job_id_input
    and company_id = public.current_user_company_id()
    and job_type   = 'recurring'
    and parent_job_id is null
  for update;

  if not found then
    raise exception 'Recurring parent job not found';
  end if;

  select coalesce(tz.name, 'Europe/Berlin') into company_timezone
  from public.companies c
  left join pg_catalog.pg_timezone_names tz on tz.name = btrim(c.timezone)
  where c.id = parent.company_id;

  perform set_config('app.series_sync', 'on', true);

  -- ── 1) PRUNE ──────────────────────────────────────────────────────
  -- Nur noch ein Löschgrund: der SLOT gehört nicht mehr zur Regel
  -- (Wochentag entfernt oder außerhalb des Gültigkeitszeitraums). Eine
  -- geänderte Uhrzeit ist KEIN Löschgrund mehr — dafür gibt es Schritt 2.
  -- Schutz wie bisher: nichts Vergangenes, nichts Gestartetes/Abgeschlossenes,
  -- nichts mit Kommentaren/Fotos/Lesestatus. Zusätzlich ausgenommen: einzeln
  -- angepasste Termine (die hat ein Admin bewusst so gelegt) und (S1.6)
  -- Termine mit Prüffall.
  --
  -- 1a) Kandidaten sperren (siehe Kopf: Wettlauf mit Fall-Anlage).
  perform 1
  from public.jobs c
  where c.parent_job_id = parent_job_id_input
    and c.schedule_overridden = false
    and c.date >= current_date
    and coalesce(c.occurrence_date, c.date) >= current_date
    and c.status = 'open'
    and c.started_at is null
    and c.completed_at is null
    and not exists (select 1 from public.job_comments      x where x.job_id = c.id)
    and not exists (select 1 from public.job_photos        x where x.job_id = c.id)
    and not exists (select 1 from public.job_comment_reads x where x.job_id = c.id)
    and (
          not (parent.recurring_days @> array[
            case extract(isodow from coalesce(c.occurrence_date, c.date))::int
              when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
              when 4 then 'thu' when 5 then 'fri' when 6 then 'sat'
              when 7 then 'sun'
            end
          ])
          or (parent.recurrence_end_date   is not null and coalesce(c.occurrence_date, c.date) > parent.recurrence_end_date)
          or (parent.recurrence_start_date is not null and coalesce(c.occurrence_date, c.date) < parent.recurrence_start_date)
        )
  order by c.id
  for update of c;

  -- 1b) Löschen.
  delete from public.jobs c
  where c.parent_job_id = parent_job_id_input
    and c.schedule_overridden = false
    and c.date >= current_date
    and coalesce(c.occurrence_date, c.date) >= current_date
    and c.status = 'open'
    and c.started_at is null
    and c.completed_at is null
    and not exists (select 1 from public.job_comments      x where x.job_id = c.id)
    and not exists (select 1 from public.job_photos        x where x.job_id = c.id)
    and not exists (select 1 from public.job_comment_reads x where x.job_id = c.id)
    and not exists (select 1 from public.work_recovery_cases x where x.job_id = c.id)
    and (
          not (parent.recurring_days @> array[
            case extract(isodow from coalesce(c.occurrence_date, c.date))::int
              when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
              when 4 then 'thu' when 5 then 'fri' when 6 then 'sat'
              when 7 then 'sun'
            end
          ])
          or (parent.recurrence_end_date   is not null and coalesce(c.occurrence_date, c.date) > parent.recurrence_end_date)
          or (parent.recurrence_start_date is not null and coalesce(c.occurrence_date, c.date) < parent.recurrence_start_date)
        );

  -- ── 2) RESCHEDULE ─────────────────────────────────────────────────
  -- Termine, die weiterhin zur Regel gehören, werden auf den aktuellen
  -- Regelstand VERSCHOBEN statt gelöscht und neu erzeugt. Gleiche id ⇒
  -- Zuweisungen, Kommentare, Fotos, Lesestatus, Benachrichtigungen und jede
  -- andere Verknüpfung bleiben erhalten.
  --
  -- Nicht angefasst: Vergangenheit, in_progress/completed, gestartete oder
  -- abgeschlossene Zeilen, einzeln angepasste Termine.
  update public.jobs c
  set
    date            = coalesce(c.occurrence_date, c.date),
    start_time      = parent.start_time,
    scheduled_start = case
                        when parent.start_time is not null
                        then (coalesce(c.occurrence_date, c.date) + parent.start_time) at time zone company_timezone
                        else null
                      end
  where c.parent_job_id = parent_job_id_input
    and c.schedule_overridden = false
    and c.date >= current_date
    and coalesce(c.occurrence_date, c.date) >= current_date
    and c.status = 'open'
    and c.started_at is null
    and c.completed_at is null
    -- nur Slots, die weiterhin zur Regel gehören (der Rest ist in PRUNE
    -- gelandet oder absichtlich als Rest-Historie stehen geblieben)
    and parent.recurring_days @> array[
          case extract(isodow from coalesce(c.occurrence_date, c.date))::int
            when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
            when 4 then 'thu' when 5 then 'fri' when 6 then 'sat'
            when 7 then 'sun'
          end
        ]
    and (parent.recurrence_end_date   is null or coalesce(c.occurrence_date, c.date) <= parent.recurrence_end_date)
    and (parent.recurrence_start_date is null or coalesce(c.occurrence_date, c.date) >= parent.recurrence_start_date)
    and (
         c.date       is distinct from coalesce(c.occurrence_date, c.date)
      or c.start_time is distinct from parent.start_time
    );

  -- ── 3) SYNC ───────────────────────────────────────────────────────
  -- Inhaltsfelder (OHNE assigned_to, OHNE Terminfelder) — unverändert
  -- gegenüber 20260813000000. Bewusst OHNE schedule_overridden-Filter.
  update public.jobs c
  set
    customer_name             = parent.customer_name,
    service_name              = parent.service_name,
    location_address          = parent.location_address,
    notes                     = parent.notes,
    is_active                 = parent.is_active,
    planned_duration_minutes  = parent.planned_duration_minutes
  where c.parent_job_id = parent_job_id_input
    and c.date >= current_date
    and c.status = 'open'
    and c.started_at is null
    and c.completed_at is null
    and (
         c.customer_name             is distinct from parent.customer_name
      or c.service_name              is distinct from parent.service_name
      or c.location_address          is distinct from parent.location_address
      or c.notes                     is distinct from parent.notes
      or c.is_active                 is distinct from parent.is_active
      or c.planned_duration_minutes  is distinct from parent.planned_duration_minutes
    );

  -- ── 4) GENERATE ───────────────────────────────────────────────────
  -- Füllt nur noch LEERE Slots (setzt app.series_sync selbst).
  select public.generate_job_occurrences(parent_job_id_input)
  into new_count;

  perform set_config('app.series_sync', 'off', true);

  return new_count;
end;
$$;

-- =========================================================
-- 5) Guard: auch abgeschlossene Fälle mit klarer Meldung
-- =========================================================
-- Vorher fing der Guard nur offene Fälle ab; eine Zuweisung mit
-- abgeschlossenem Fall scheiterte erst am RESTRICT-FK mit der generischen
-- Meldung (23503). Jetzt dieselbe Fehlerklasse wie bei offenen Fällen
-- (22023), damit set_job_assignments, eine Auftragslöschung oder das Löschen
-- einer Regel dem Admin sagen, WARUM. Die Meldung für offene Fälle bleibt
-- wörtlich gleich. Der RESTRICT-FK bleibt als zweite Ebene. Der Purge-Bypass
-- bleibt unverändert.
create or replace function public.guard_assignment_open_recovery_case()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if public.company_purge_active() then
    return old;
  end if;
  if exists (
    select 1 from public.work_recovery_cases c
     where c.assignment_id = old.id
       and c.state in ('open', 'under_review')
  ) then
    raise exception 'Zuweisung hat eine offene Nacharbeitung (Prüffall) und kann nicht entfernt werden.'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from public.work_recovery_cases c
     where c.assignment_id = old.id
  ) then
    raise exception 'Zuweisung hat einen abgeschlossenen Prüffall (Nachweis) und kann nicht entfernt werden.'
      using errcode = '22023';
  end if;
  return old;
end;
$$;

-- =========================================================
-- 6) Sperr-Vertrag für Recovery-Schreiber (S2 und später)
-- =========================================================
-- Jede Funktion, die work_recovery_* schreibt (Fall anlegen, Zustand ändern,
-- Einreichung/Ereignis anhängen), ruft ALS ERSTES diese Funktion auf.
--
-- FOR KEY SHARE (nicht FOR SHARE): kollidiert nur mit FOR UPDATE, also genau
-- mit dem Firmen-Purge (purge_company_for_last_admin sperrt companies FOR
-- UPDATE), aber nicht mit gewöhnlichen Firmen-Updates (update_own_company,
-- FOR NO KEY UPDATE). FOR SHARE würde diese unnötig blockieren.
--
-- Reihenfolge: Firma → Auftrag → Zuweisung → Fall (FOR UPDATE) → INSERTs
-- (Auftrag vor Zuweisung wie PRUNE und wie die FK-Prüfungen eines Fall-INSERTs).
-- Nie einen Fall, ein Profil oder einen Auftrag vor der Firma sperren: der
-- Purge sperrt Firma → Admin-Profile → alle work_recovery_*-Zeilen; ein
-- Schreiber in umgekehrter Reihenfolge erzeugt einen Deadlock.
--
-- Warum ein expliziter Aufruf, obwohl der FK beim INSERT ohnehin FOR KEY
-- SHARE nimmt: (1) der FK sperrt erst am Statement-Ende, also NACH Sperren,
-- die die Funktion vorher auf Fall-Zeilen genommen hat; (2) reine UPDATEs auf
-- Fälle berühren die Firmenzeile gar nicht; (3) eine klare Meldung statt
-- 23503, wenn die Firma gerade gelöscht wurde.
create or replace function public._lock_company_for_recovery_write(p_company_id uuid)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform 1 from public.companies where id = p_company_id for key share;
  if not found then
    raise exception 'recovery_company_not_found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public._lock_company_for_recovery_write(uuid)
  from public, anon, authenticated, service_role;

comment on function public._lock_company_for_recovery_write(uuid) is
'Work Recovery S1.6: Sperr-Vertrag. Jeder Recovery-Schreiber ruft dies zuerst auf (companies FOR KEY SHARE; Reihenfolge Firma → Auftrag → Zuweisung → Fall). Kein Client-Zugriff.';
