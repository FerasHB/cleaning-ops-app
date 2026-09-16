-- =========================================================
-- MIGRATION: Logische Identität eines generierten Termins (Occurrence-Slot)
-- Datum: 2026-09-16
-- Zweck: Eine Änderung der Regel-UHRZEIT verschiebt den bestehenden Termin,
--        statt ihn zu löschen und daneben einen zweiten zu erzeugen.
-- =========================================================
-- BEFUND (an Staging-Daten bewiesen, nicht vermutet)
-- ---------------------------------------------------------
--   Regel "Kronen Apotheke" (Mo–Fr), Uhrzeit 19:30 → 20:30 geändert.
--   Danach standen für den 16.09.2026 ZWEI Termine derselben Regel:
--     ea1db19f… 19:30 open, started_at NULL, completed_at NULL,
--               0 Kommentare, 0 Fotos, 1 Zeile in job_comment_reads
--     c6ba360e… 20:30 open, erzeugt 43 s später
--
--   Ursachenkette, Schritt für Schritt:
--     1. Die logische Identität eines Termins war
--        (parent_job_id, date, start_time) — so der Unique Index
--        idx_jobs_occurrence_unique und so das ON-CONFLICT-Ziel in
--        generate_job_occurrences.
--     2. Eine Uhrzeit-Änderung ist in diesem Modell deshalb KEINE
--        Verschiebung, sondern "alte Zeile passt nicht mehr" +
--        "neue Zeile fehlt": update_job_occurrences löscht im PRUNE-Schritt
--        (Bedingung `c.start_time is distinct from parent.start_time`) und
--        generate_job_occurrences fügt danach neu ein.
--     3. PRUNE löscht aber — zu Recht — nur SPURENFREIE Zeilen
--        (20260723000004). Eine einzige Zeile in job_comments, job_photos
--        ODER job_comment_reads schützt den Termin vor dem Löschen.
--     4. job_comment_reads bekommt schon durch reines ÖFFNEN der
--        Job-Detailansicht eine Zeile — JobDetailScreen ruft
--        markJobCommentsAsRead() unabhängig davon auf, ob überhaupt
--        Kommentare existieren (die blockierende Zeile oben gehört einem
--        Admin, comment_count = 0).
--     5. Das Löschen unterbleibt, das Einfügen läuft trotzdem: der neue
--        Termin hat eine andere start_time und verletzt den Unique Index
--        deshalb NICHT.
--   ⇒ Zwei aktive Termine für dieselbe Regel am selben Tag. Der alte wird
--     von isDetachedOccurrence (utils/recurringRule.ts) korrekt als
--     "Abweichender Termin" erkannt — er weicht ja von der Regel ab. Das
--     Etikett ist die Folge, nicht die Ursache.
--
--   Dieselbe Kette greift bei JEDER Spur: ein Kommentar, ein Foto, ein
--   gestarteter/abgeschlossener Zukunftstermin. job_comment_reads ist nur
--   der mit Abstand häufigste Auslöser.
--
-- =========================================================
-- NEUES MODELL: der Slot ist die Identität
-- ---------------------------------------------------------
--   jobs.occurrence_date  — der Kalendertag der REGEL, für den dieser
--     Termin erzeugt wurde. Unveränderlich (Trigger), NULL für alles, was
--     kein generierter Termin ist. Das ist die "logische Identität":
--     genau EIN aktiver Termin je (Regel, Slot).
--
--   jobs.date / start_time — der TATSÄCHLICH geplante Termin. Folgt
--     normalerweise dem Slot, kann aber vom Admin einzeln abweichen.
--
--   jobs.schedule_overridden — TRUE, sobald ein Admin Datum oder Uhrzeit
--     dieses Termins EINZELN geändert hat (echter abweichender Termin).
--     Die Regel-Synchronisierung fasst dessen Terminierung dann nicht mehr
--     an. Gesetzt vom Trigger trg_jobs_mark_schedule_override, nicht vom
--     Client — damit gilt die Regel für JEDEN Schreibpfad, auch für das
--     direkte .update() aus services/jobs/jobs.service.ts.
--
--   Warum eine Spalte und keine Markierungstabelle (anders als
--   job_occurrence_assignment_overrides, 20260728000000)? Dort war die
--   eigene Tabelle nötig, weil die LEERE Zuweisungsmenge sonst keine
--   Zeile hätte, die die Markierung trägt. Terminfelder existieren dagegen
--   immer auf der Zeile selbst; die Markierung gehört fachlich genau
--   dorthin — und nur als Spalte kann der Unique Index unten sie über
--   occurrence_date überhaupt absichern.
--
-- =========================================================
-- NEUER ABLAUF in update_job_occurrences
-- ---------------------------------------------------------
--   1) PRUNE      — entfernt nur Termine, deren SLOT nicht mehr zur Regel
--                   gehört (Wochentag entfernt / außerhalb des Zeitraums).
--                   Uhrzeit ist KEIN Löschgrund mehr. Spurenschutz und
--                   Historienschutz aus 20260723000004 unverändert; zusätzlich
--                   sind einzeln angepasste Termine ausgenommen.
--   2) RESCHEDULE — NEU und der eigentliche Fix: zieht Datum/Uhrzeit der
--                   verbleibenden, regelgebundenen Zukunftstermine auf den
--                   Stand der Regel. Reines UPDATE: dieselbe id, dieselben
--                   Zuweisungen, Kommentare, Fotos, Lesestatus.
--   3) SYNC       — Inhaltsfelder wie bisher (20260813000000).
--   4) GENERATE   — füllt nur noch LEERE Slots.
--
--   Invariante: für eine Regel und einen Slot gibt es höchstens EINEN
--   Termin — durchgesetzt vom Unique Index, nicht nur von der Funktion.
--
-- =========================================================
-- HISTORIE / LAUFENDE ARBEIT (unverändert geschützt)
-- ---------------------------------------------------------
--   * date < current_date          → nie angefasst
--   * status <> 'open'             → nie angefasst (in_progress, completed)
--   * started_at/completed_at      → nie angefasst
--   * schedule_overridden = true   → Terminierung nie angefasst
--   RESCHEDULE hat damit denselben Schutzumfang wie PRUNE vorher, ist aber
--   nicht mehr auf Spurenfreiheit angewiesen: ein Kommentar verhindert kein
--   Verschieben, weil beim Verschieben nichts verloren geht.
--
-- =========================================================
-- UNIQUE INDEX — bewusst NICHT blind gesetzt
-- ---------------------------------------------------------
--   idx_jobs_occurrence_unique (parent_job_id, date, start_time) bildet die
--   FALSCHE Identität ab und wird ersetzt durch
--   idx_jobs_occurrence_slot_unique (parent_job_id, occurrence_date).
--
--   Geprüft, dass kein legitimer Fall blockiert wird:
--     * generate_job_occurrences erzeugt je Kalendertag höchstens eine
--       Zeile — der Index ist für den Erzeugungspfad ohnehin erfüllt.
--     * Verschiebt ein Admin einen Termin einzeln auf einen anderen Tag,
--       bleibt occurrence_date der ursprüngliche Slot. Der Termin kollidiert
--       deshalb NICHT mit dem regulären Termin des Zieltags — ein Index auf
--       (parent_job_id, date) hätte genau das fälschlich verboten.
--     * Zwei Termine derselben Regel am selben Tag lassen sich im Datenmodell
--       gar nicht ausdrücken (die Regel trägt genau eine start_time); ein
--       zweiter Besuch ist eine zweite Regel.
--
--   Bestandsdaten: der Backfill setzt occurrence_date = date. Existieren
--   bereits Duplikate aus genau diesem Bug, schlägt Schritt 5 unten mit einer
--   Auflistung der betroffenen Zeilen LAUT fehl, statt still etwas zu löschen.
--   Aufräumen ist eine bewusste, eigene Entscheidung (siehe Report/Phase 5).
--
-- =========================================================
-- BEWUSST NICHT TEIL DIESER MIGRATION
--   * Keine Änderung an RLS/Policies/Grants.
--   * Keine Änderung an Zuweisungs-Vererbung (inherit_occurrence_assignments)
--     oder an job_occurrence_assignment_overrides.
--   * Keine Änderung an der Zeit-Semantik (started_at/completed_at).
--   * Kein UI-Filter: Duplikate werden nicht ausgeblendet, sondern entstehen
--     nicht mehr.
--   * Keine RPC zum Zurücksetzen eines abweichenden Termins auf die Regel
--     (es gibt dafür heute keine Oberfläche; im Report vermerkt).
--
-- ANWENDUNG: manuell im Supabase SQL Editor (siehe CLAUDE.md).
-- Diese Migration wurde NICHT auf Produktion ausgeführt.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Spalten
-- ---------------------------------------------------------
alter table public.jobs
  add column if not exists occurrence_date date;

alter table public.jobs
  add column if not exists schedule_overridden boolean not null default false;

comment on column public.jobs.occurrence_date is
'Kalendertag der Regel, für den dieser Termin erzeugt wurde (Slot). Bildet '
'zusammen mit parent_job_id die logische Identität eines generierten Termins '
'und ist unveränderlich (trg_jobs_mark_schedule_override). NULL bei allem, was '
'kein generierter Termin ist. Der TATSÄCHLICHE Termin steht in date/start_time '
'und darf davon abweichen (schedule_overridden).';

comment on column public.jobs.schedule_overridden is
'TRUE, sobald Datum oder Uhrzeit dieses Termins einzeln geändert wurden '
'(echter abweichender Termin). update_job_occurrences lässt die Terminierung '
'solcher Zeilen unangetastet. Wird ausschließlich vom Trigger gesetzt, nie vom '
'Client. Für Nicht-Termine bedeutungslos (bleibt false).';


-- ---------------------------------------------------------
-- 2. Backfill
-- ---------------------------------------------------------
-- Bestandstermine gelten als an ihrem heutigen Datum verankert. Bei einem
-- bereits einzeln verschobenen Termin ist der ursprüngliche Slot nicht mehr
-- rekonstruierbar — das aktuelle Datum ist die einzige verfügbare und die
-- fachlich unschädlichste Annahme (der Termin belegt dann eben den Slot
-- seines tatsächlichen Tages).
update public.jobs
set occurrence_date = date
where parent_job_id is not null
  and occurrence_date is null
  and date is not null;


-- ---------------------------------------------------------
-- 3. Konsistenz-Constraint
-- ---------------------------------------------------------
-- occurrence_date gibt es nur für generierte Termine.
alter table public.jobs
  drop constraint if exists chk_jobs_occurrence_date_requires_parent;

alter table public.jobs
  add constraint chk_jobs_occurrence_date_requires_parent
  check (occurrence_date is null or parent_job_id is not null)
  not valid;

-- Getrennt validieren: schlägt die Validierung fehl, ist die Spalte trotzdem
-- schon da und die Ursache steht in der Fehlermeldung.
alter table public.jobs
  validate constraint chk_jobs_occurrence_date_requires_parent;


-- ---------------------------------------------------------
-- 4. Trigger: Slot unveränderlich, Einzel-Anpassung markieren
-- ---------------------------------------------------------
-- SECURITY DEFINER wäre hier unnötig: die Funktion liest keine fremden
-- Zeilen und schreibt nur NEW. Bewusst SECURITY INVOKER (Default).
--
-- Die Erkennung "kommt aus der Regel-Synchronisierung" läuft über eine
-- transaktionslokale Einstellung, die ausschließlich update_job_occurrences
-- und generate_job_occurrences setzen. Damit ist JEDER andere Schreibpfad —
-- insbesondere das direkte .update() des Admin-Clients auf jobs — automatisch
-- eine Einzel-Anpassung, ohne dass der Client etwas mitschicken muss.
create or replace function public.mark_occurrence_schedule_override()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Keine generierte Occurrence (normaler Einzeljob oder Parent-Regel):
  -- Slot und Markierung sind dort bedeutungslos. Das explizite Nullen hält
  -- chk_jobs_occurrence_date_requires_parent auch dann erfüllt, wenn eine
  -- Zeile ihren Parent verliert.
  if new.parent_job_id is null then
    new.occurrence_date     := null;
    new.schedule_overridden := false;
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Slot IMMER setzen, unabhängig vom Schreibpfad — sonst könnte eine
    -- Zeile mit occurrence_date IS NULL am Unique Index vorbeilaufen (NULLs
    -- gelten dort als verschieden) und die Invariante aushebeln.
    new.occurrence_date := coalesce(new.occurrence_date, new.date);
    return new;
  end if;

  -- UPDATE: der Slot ist unveränderlich, sobald er einmal gesetzt ist.
  -- Bestandszeilen ohne Slot heilen sich beim ersten Schreibzugriff selbst.
  if old.occurrence_date is not null then
    new.occurrence_date := old.occurrence_date;
  else
    new.occurrence_date := coalesce(new.occurrence_date, new.date);
  end if;

  -- Terminfeld geändert und NICHT aus der Regel-Synchronisierung?
  -- → einzeln angepasst.
  if (new.date is distinct from old.date
      or new.start_time is distinct from old.start_time)
     and coalesce(current_setting('app.series_sync', true), '') <> 'on'
  then
    new.schedule_overridden := true;
  end if;

  return new;
end;
$$;

comment on function public.mark_occurrence_schedule_override() is
'BEFORE-INSERT/UPDATE-Trigger auf public.jobs: vergibt jedem generierten Termin '
'einen Slot (occurrence_date), hält ihn danach unveränderlich und markiert den '
'Termin als schedule_overridden, sobald Datum oder Uhrzeit außerhalb der '
'Regel-Synchronisierung geändert werden.';

drop trigger if exists trg_jobs_mark_schedule_override on public.jobs;

create trigger trg_jobs_mark_schedule_override
  before insert or update on public.jobs
  for each row
  execute function public.mark_occurrence_schedule_override();

comment on trigger trg_jobs_mark_schedule_override on public.jobs is
'Vergibt und schützt den Occurrence-Slot und erkennt einzeln angepasste Termine '
'(abweichende Termine) unabhängig vom Schreibpfad.';

-- Die Funktion ist ausschließlich als Trigger sinnvoll (Rückgabetyp trigger,
-- damit ohnehin nicht über PostgREST aufrufbar). Rechte trotzdem entziehen —
-- gleiche Defense-in-Depth wie bei protect_recurring_job_history
-- (20260723000003).
revoke all on function public.mark_occurrence_schedule_override() from public;
revoke all on function public.mark_occurrence_schedule_override() from anon, authenticated;


-- ---------------------------------------------------------
-- 5. Unique Index auf die logische Identität
-- ---------------------------------------------------------
-- Erst prüfen, dann ersetzen: bestehende Duplikate aus dem Bug sollen den
-- Lauf mit einer verwertbaren Liste abbrechen, nicht stillschweigend
-- verschwinden.
do $$
declare
  dupes text;
begin
  select string_agg(
           format('Regel %s / Slot %s: %s', parent_job_id, occurrence_date, ids),
           E'\n'
         )
    into dupes
  from (
    select parent_job_id,
           occurrence_date,
           string_agg(id::text || ' (' || coalesce(start_time::text, 'ohne Zeit') || ', ' || status || ')', ', ' order by created_at) as ids
    from public.jobs
    where parent_job_id is not null
      and occurrence_date is not null
    group by parent_job_id, occurrence_date
    having count(*) > 1
  ) d;

  if dupes is not null then
    raise exception
      'Es gibt bereits mehrere Termine für dieselbe Regel und denselben Slot — der Unique Index kann nicht angelegt werden.'
      using
        detail = dupes,
        hint   = 'Diese Zeilen stammen aus dem behobenen Fehler. Vor dem erneuten Lauf gezielt bereinigen: '
              || 'pro Slot die Zeile behalten, die der Regel entspricht bzw. Historie (started_at/completed_at/'
              || 'Kommentare/Fotos) trägt, und die andere löschen.';
  end if;
end $$;

drop index if exists public.idx_jobs_occurrence_unique;

create unique index if not exists idx_jobs_occurrence_slot_unique
  on public.jobs (parent_job_id, occurrence_date)
  where parent_job_id is not null;

comment on index public.idx_jobs_occurrence_slot_unique is
'Genau ein Termin je (Dauerauftrags-Regel, Slot). Ersetzt idx_jobs_occurrence_unique, '
'das über start_time die falsche Identität abbildete und deshalb bei einer '
'Uhrzeit-Änderung einen zweiten Termin für denselben Tag zuließ.';


-- ---------------------------------------------------------
-- 6. generate_job_occurrences: Slot schreiben, leere Slots füllen
-- ---------------------------------------------------------
-- Unverändert gegenüber 20260813000000 bis auf:
--   * occurrence_date wird mitgeschrieben (= check_date),
--   * ON CONFLICT zielt auf den Slot statt auf (date, start_time) —
--     ein bereits belegter Slot wird also auch dann nicht neu befüllt,
--     wenn sein Termin einzeln verschoben wurde,
--   * app.series_sync wird gesetzt, damit der Trigger diese Schreibvorgänge
--     nicht als Einzel-Anpassung missversteht.
create or replace function public.generate_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent                public.jobs%rowtype;
  generation_start      date;
  generation_end        date;
  hard_limit            date;
  check_date            date;
  day_code              text;
  inserted_count        int := 0;
  rows_affected         int;
  effective_assigned_to uuid;
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

  hard_limit := generation_start + interval '730 days';

  generation_end := least(
    case
      when parent.recurrence_end_date is not null
        then parent.recurrence_end_date
      else generation_start + interval '3 months'
    end,
    hard_limit
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

    if parent.recurring_days @> array[day_code] then
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
          then (check_date::text || ' ' || parent.start_time::text)::timestamptz
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

  -- Vollstaendige Zuweisungsmenge der Regel auf die nicht angepassten
  -- Termine uebertragen (unveraendert seit Phase 4).
  perform public.inherit_occurrence_assignments(parent_job_id_input);

  perform set_config('app.series_sync', 'off', true);

  return inserted_count;
end;
$$;

grant execute on function public.generate_job_occurrences(uuid) to authenticated;

comment on function public.generate_job_occurrences(uuid) is
'Erzeugt konkrete Single-Jobs aus einer Recurring-Regel. Zeitraum aus '
'recurrence_start/end_date, hartes Maximum 730 Tage, idempotent über den Slot '
'(parent_job_id, occurrence_date) — ein belegter Slot wird nie erneut befüllt, '
'auch nicht, wenn sein Termin einzeln verschoben wurde. Weist keine Occurrence '
'einem inaktiven Mitarbeiter zu. Kopiert planned_duration_minutes von der Regel. '
'Uebertraegt die vollstaendige Zuweisungsmenge der Regel auf nicht angepasste Termine.';


-- ---------------------------------------------------------
-- 7. update_job_occurrences: PRUNE → RESCHEDULE → SYNC → GENERATE
-- ---------------------------------------------------------
create or replace function public.update_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent    public.jobs%rowtype;
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

  perform set_config('app.series_sync', 'on', true);

  -- ── 1) PRUNE ──────────────────────────────────────────────────────
  -- Nur noch ein Löschgrund: der SLOT gehört nicht mehr zur Regel
  -- (Wochentag entfernt oder außerhalb des Gültigkeitszeitraums). Eine
  -- geänderte Uhrzeit ist KEIN Löschgrund mehr — dafür gibt es Schritt 2.
  -- Schutz wie bisher: nichts Vergangenes, nichts Gestartetes/Abgeschlossenes,
  -- nichts mit Kommentaren/Fotos/Lesestatus. Zusätzlich ausgenommen: einzeln
  -- angepasste Termine (die hat ein Admin bewusst so gelegt).
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
  -- DER FIX. Termine, die weiterhin zur Regel gehören, werden auf den
  -- aktuellen Regelstand VERSCHOBEN statt gelöscht und neu erzeugt.
  -- Gleiche id ⇒ Zuweisungen, Kommentare, Fotos, Lesestatus, Benachrichtigungen
  -- und jede andere Verknüpfung bleiben erhalten. Genau deshalb ist hier — im
  -- Gegensatz zu PRUNE — Spurenfreiheit KEINE Bedingung: beim Verschieben geht
  -- nichts verloren.
  --
  -- Nicht angefasst: Vergangenheit, in_progress/completed, gestartete oder
  -- abgeschlossene Zeilen, einzeln angepasste Termine.
  update public.jobs c
  set
    date            = coalesce(c.occurrence_date, c.date),
    start_time      = parent.start_time,
    scheduled_start = case
                        when parent.start_time is not null
                        then (coalesce(c.occurrence_date, c.date)::text || ' ' || parent.start_time::text)::timestamptz
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
  -- gegenüber 20260813000000. Bewusst OHNE schedule_overridden-Filter: ein
  -- einzeln verschobener Termin soll weiterhin den aktuellen Kunden-/Service-/
  -- Ortsstand der Regel zeigen. Individuell ist an ihm nur die TERMINIERUNG,
  -- und die schützt allein Schritt 2.
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

grant execute on function public.update_job_occurrences(uuid) to authenticated;

comment on function public.update_job_occurrences(uuid) is
'Regel-Synchronisierung in vier Schritten: PRUNE entfernt nur Termine, deren '
'Slot nicht mehr zur Regel gehört; RESCHEDULE verschiebt die verbleibenden '
'regelgebundenen Zukunftstermine per UPDATE auf Datum/Uhrzeit der Regel (gleiche '
'id, keine verlorenen Kommentare/Fotos/Zuweisungen); SYNC überträgt die '
'Inhaltsfelder; GENERATE füllt leere Slots. Eine Uhrzeit-Änderung erzeugt damit '
'KEINEN zweiten Termin für denselben Tag mehr. Bewahrt Vergangenheit, '
'in_progress/completed, Zeitstempel und einzeln angepasste Termine '
'(schedule_overridden).';
