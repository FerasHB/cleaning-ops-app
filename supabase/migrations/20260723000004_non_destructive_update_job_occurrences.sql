-- =========================================================
-- MIGRATION: Nicht-destruktives Aktualisieren wiederkehrender Aufträge
-- Datum: 2026-07-23
-- Zweck: update_job_occurrences so umbauen, dass eine Regeländerung
--        KEINE Occurrences mit Historie mehr löscht und KEINE unnötige
--        Massen-Neuerzeugung (Row-Churn) auslöst.
-- =========================================================
-- HINTERGRUND (am deployten Stand verifiziert, nicht aus Migrationen):
--   Die bisherige Funktion war:
--       delete from public.jobs
--       where parent_job_id = parent_job_id_input
--         and status = 'open' and date >= current_date;
--       select public.generate_job_occurrences(parent_job_id_input);
--   Damit löscht JEDE Regeländerung ALLE offenen zukünftigen Occurrences
--   und erzeugt sie neu. Weil job_comments/job_photos/job_comment_reads per
--   ON DELETE CASCADE an jobs(id) hängen, gehen dabei Kommentare, Fotos und
--   Lesestatus dieser Zeilen verloren. Der Client ruft die RPC bei JEDEM
--   Recurring-Edit auf (auch bei reiner Namensänderung), unabhängig davon,
--   welches Feld sich geändert hat (services/jobs/jobs.service.ts updateJob).
--   Produktions-Messung (rein lesend): bis zu 624 Zeilen pro Regel-Edit
--   gelöscht+neu erzeugt; 5 Lesestatus-Zeilen würden aktuell still verworfen.
--
-- NEUES VERHALTEN (mengenbasiert, additiv, gleiche Signatur/Rückgabe):
--   1) PRUNE  – löscht ausschließlich zukünftige Occurrences, die
--               NACHWEISLICH unberührt sind UND nicht mehr zur Regel passen.
--               "Unberührt" heißt: status='open', started_at IS NULL,
--               completed_at IS NULL, keine Kommentare, keine Fotos, kein
--               Lesestatus. "Passt nicht mehr" heißt: Wochentag nicht mehr
--               in recurring_days, ODER start_time geändert, ODER außerhalb
--               von recurrence_start_date/recurrence_end_date.
--   2) SYNC   – aktualisiert die Anzeige-/Zuweisungsfelder auf zukünftigen,
--               NOCH NICHT gestarteten Occurrences (status='open',
--               started_at IS NULL, completed_at IS NULL), damit
--               Nicht-Termin-Änderungen (Kunde/Service/Ort/Notizen/aktiv/
--               Zuweisung) weiterhin ankommen — OHNE Löschen. Rein per
--               UPDATE, kein Cascade, keine Änderung an date/start_time
--               (Terminfelder = Aufgabe von PRUNE + GENERATE).
--   3) GENERATE – ruft die unveränderte generate_job_occurrences auf, um
--               neu benötigte Termine einzufügen (idempotent via
--               ON CONFLICT DO NOTHING über idx_jobs_occurrence_unique).
--
--   Ergebnis:
--     - Vergangene Occurrences:                unverändert (date < heute)
--     - in_progress / completed:               unverändert (nie angefasst)
--     - zukünftige Occurrences mit Historie:   unverändert erhalten; passen
--                                              sie nicht mehr zur Regel,
--                                              bleiben sie als „abgekoppelte"
--                                              Termine bestehen (siehe unten)
--     - zukünftige, unberührte, nicht passende: entfernt
--     - neu benötigte Termine:                 eingefügt
--     - erneuter Aufruf:                       idempotent, keine Duplikate
--
-- BEWUSST KEINE neue Spalte/kein neuer Status:
--   Eine erhaltene Occurrence, die nicht mehr zur aktuellen Regel passt
--   (z. B. abgeschlossen zur alten Uhrzeit nach Zeitänderung), ist ein
--   realer historischer Job und über Vergleich von (Wochentag, start_time)
--   gegen die aktuelle Regel eindeutig erkennbar. Ein Flag (detached/
--   superseded/…) ist für die KORREKTHEIT dieser Funktion nicht nötig und
--   würde die spätere Trennung in job_definitions/job_occurrences zusätzlich
--   belasten. Empfehlung zur Kennzeichnung: im späteren Display-PR (siehe
--   Report), nicht hier.
--
-- KOMPATIBILITÄT mit der geplanten Trennung Zeitplan/Daueraufträge:
--   Die Funktion fasst weiterhin nur konkrete Occurrences
--   (parent_job_id IS NOT NULL, job_type='single') an und lässt die
--   Parent-Regel unberührt. Kein Feld wird umgedeutet, keine Beziehung
--   geändert. Der spätere Split kann Occurrences 1:1 in job_occurrences
--   übernehmen; „abgekoppelte" Zeilen bleiben normale Occurrences.
--
-- SECURITY DEFINER — begründet (wie schon in der Vorgängerfunktion):
--   Employees haben kein direktes DELETE/UPDATE auf jobs (RLS). Die Regel-
--   pflege ist eine Admin-Operation, die serverseitig unter definierten
--   Rechten laufen muss. Die Funktion prüft selbst auf Admin-Rolle und
--   Firmenzugehörigkeit (current_user_role/current_user_company_id) und ist
--   damit fail-closed. search_path fest gesetzt; EXECUTE bleibt wie bisher
--   auf authenticated (Admin-Check intern).
-- =========================================================

create or replace function public.update_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent                public.jobs%rowtype;
  effective_assigned_to uuid;
  new_count             int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can update occurrences';
  end if;

  -- Parent laden UND sperren: serialisiert konkurrierende Aufrufe für
  -- dieselbe Regel (Doppel-Submit, Retry nach Netzfehler, paralleler
  -- Realtime-getriggerter Aufruf). Zweiter Aufruf wartet, sieht das
  -- Ergebnis des ersten und findet dann nichts mehr zu prunen/erzeugen.
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

  -- Effektive Zuweisung: inaktiver Mitarbeiter → offen (null), analog zur
  -- Logik in generate_job_occurrences und zum Trigger enforce_active_assignee.
  select case
    when parent.assigned_to is not null
      and exists (
        select 1 from public.profiles p
        where p.id = parent.assigned_to and p.is_active = true
      )
    then parent.assigned_to
    else null
  end
  into effective_assigned_to;

  -- ── 1) PRUNE ──────────────────────────────────────────────────────
  -- Nur zukünftige, nachweislich unberührte Occurrences entfernen, die
  -- nicht mehr zur Regel passen. Historie (started/completed/Kommentare/
  -- Fotos/Lesestatus) schützt die Zeile immer vor dem Löschen.
  delete from public.jobs c
  where c.parent_job_id = parent_job_id_input
    and c.date >= current_date
    and c.status = 'open'
    and c.started_at is null
    and c.completed_at is null
    and not exists (select 1 from public.job_comments      x where x.job_id = c.id)
    and not exists (select 1 from public.job_photos        x where x.job_id = c.id)
    and not exists (select 1 from public.job_comment_reads x where x.job_id = c.id)
    and (
          -- Wochentag nicht mehr Teil der Regel
          not (parent.recurring_days @> array[
            case extract(isodow from c.date)::int
              when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
              when 4 then 'thu' when 5 then 'fri' when 6 then 'sat'
              when 7 then 'sun'
            end
          ])
          -- Uhrzeit geändert
          or c.start_time is distinct from parent.start_time
          -- außerhalb des Gültigkeitszeitraums der Regel
          or (parent.recurrence_end_date   is not null and c.date > parent.recurrence_end_date)
          or (parent.recurrence_start_date is not null and c.date < parent.recurrence_start_date)
        );

  -- ── 2) SYNC ───────────────────────────────────────────────────────
  -- Nicht-Termin-Felder auf zukünftige, noch nicht gestartete Occurrences
  -- übertragen. Kein Cascade, keine Änderung an date/start_time. Zeilen mit
  -- Historie (started/completed) bleiben als Nachweis unverändert; ein
  -- Kommentar/Foto allein verhindert das reine Feld-Update NICHT, da die
  -- Zeile noch nicht ausgeführt wurde und weiterhin den aktuellen
  -- Regelstand zeigen soll. updated_at wird vom bestehenden Trigger gesetzt.
  update public.jobs c
  set
    customer_name    = parent.customer_name,
    service_name     = parent.service_name,
    location_address = parent.location_address,
    notes            = parent.notes,
    is_active        = parent.is_active,
    assigned_to      = effective_assigned_to
  where c.parent_job_id = parent_job_id_input
    and c.date >= current_date
    and c.status = 'open'
    and c.started_at is null
    and c.completed_at is null
    and (
         c.customer_name    is distinct from parent.customer_name
      or c.service_name     is distinct from parent.service_name
      or c.location_address is distinct from parent.location_address
      or c.notes            is distinct from parent.notes
      or c.is_active        is distinct from parent.is_active
      or c.assigned_to      is distinct from effective_assigned_to
    );

  -- ── 3) GENERATE ───────────────────────────────────────────────────
  -- Neu benötigte Termine einfügen (unveränderte, idempotente Funktion).
  select public.generate_job_occurrences(parent_job_id_input)
  into new_count;

  return new_count;
end;
$$;

comment on function public.update_job_occurrences(uuid) is
'Nicht-destruktiv: prunt nur unberührte, nicht mehr passende Zukunfts-Occurrences, '
'synct Nicht-Termin-Felder auf noch nicht gestartete Zukunfts-Occurrences und '
'erzeugt fehlende Termine (idempotent). Bewahrt in_progress/completed, '
'Zeitstempel, Kommentare, Fotos und Lesestatus.';
