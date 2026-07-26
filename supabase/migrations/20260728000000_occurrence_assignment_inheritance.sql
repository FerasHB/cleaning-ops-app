-- =========================================================
-- MIGRATION: Vererbung und Anpassung von Zuweisungen auf Occurrences
-- Datum: 2026-07-28   (Phase 4 von 11 — reine Datenschicht)
-- =========================================================
-- ZWECK
--   Zuweisungsmengen auf generierten Terminen (Occurrences) dauerhaft und
--   vorhersagbar machen. Ein Admin muss EINEN Termin individuell anpassen
--   koennen, ohne dass eine spaetere Regel-Aenderung diese Anpassung
--   still ueberschreibt.
--
-- =========================================================
-- BEFUND: EXAKTE URSACHE (reproduziert, nicht vermutet)
-- =========================================================
-- Ausgangslage: Regel R ist Mitarbeiter P zugewiesen, Occurrence O erbt P.
-- Der Admin passt O individuell auf {A, B} an. Danach aendert er an der
-- REGEL nur den Kundennamen und ruft update_job_occurrences auf.
--
-- Beobachtetes Ergebnis (5 Laeufe): {A,P} / {B,P} / {A,P} / {B,P} / {A,P}
--
-- Ablauf im Detail:
--   1. Der SYNC-Block von update_job_occurrences setzt auf jeder
--      zukuenftigen offenen Occurrence
--          assigned_to = effective_assigned_to   (= P)
--      und zwar bereits dann, wenn IRGENDEIN Feld der Regel abweicht —
--      im Beispiel nur customer_name.
--   2. Dieses UPDATE loest den Phase-2-Trigger
--      compat_sync_assignments_from_legacy (Richtung A) aus. Dieser
--      loescht die SAUBERE Zuweisung von OLD.assigned_to und legt eine
--      Zuweisung fuer NEW.assigned_to an.
--   3. OLD.assigned_to ist der von Phase 2 bestimmte PRIMAER der
--      angepassten Menge. Welcher der beiden das ist, entscheidet bei
--      gleichem assigned_at der zufaellige id-Tiebreaker.
--
-- Folge: Von der individuellen Menge {A,B} wird GENAU EIN Mitarbeiter
-- geloescht — nicht deterministisch welcher — und der Regel-Mitarbeiter
-- P wieder hinzugefuegt. Es ist also weder ein sauberes Ueberschreiben
-- noch ein sauberes Bewahren, sondern ein nicht reproduzierbarer
-- Mischzustand, ausgeloest durch eine voellig unbeteiligte Feldaenderung.
--
-- =========================================================
-- ENTSCHEIDUNG: Occurrence-weite Anpassungs-Markierung (Variante D)
-- =========================================================
-- Bewertet wurden:
--
--   A) Boolean-Spalte auf public.jobs
--      Funktioniert fachlich, fasst aber die am staerksten belastete
--      Tabelle an, die zusaetzlich Teil der supabase_realtime-Publication
--      ist, und traegt keinerlei Audit-Information (wer/wann).
--
--   B) Herkunfts-Metadatum je job_assignments-Zeile ('inherited'|'manual')
--      ABGELEHNT — hat eine echte Luecke: Passt ein Admin einen Termin auf
--      die LEERE Menge an ("heute niemand"), existiert keine einzige Zeile
--      mehr, die die Markierung tragen koennte. Der Termin saehe wieder wie
--      "geerbt" aus und die naechste Regel-Aenderung wuerde ihn neu
--      befuellen. Genau die geforderte Eigenschaft 3 waere damit fuer den
--      Leerfall verletzt. Die Zugehoerigkeit "folgt der Regel" ist eine
--      Eigenschaft des TERMINS, nicht der einzelnen Zuweisungszeile.
--
--   C) Dedizierter Modus/Status je Occurrence
--      Fachlich korrekt und identisch zur gewaehlten Loesung; D ist die
--      konkrete Umsetzung davon.
--
--   D) GEWAEHLT — eigene Tabelle job_occurrence_assignment_overrides
--      Vorhandensein einer Zeile = individuell angepasst.
--      Fehlen der Zeile      = folgt der Regel.
--      * korrekte Granularitaet (Termin-Ebene), deckt auch die leere Menge
--      * public.jobs bleibt vollstaendig unveraendert — keine neue Spalte,
--        keine Aenderung an Realtime-Payloads, keine Auswirkung auf die
--        bestehenden Client-Abfragen
--      * Audit (wer/wann) ohne Zusatzaufwand enthalten
--      * Rueckbau = Tabelle loeschen; nichts anderes verweist darauf
--
-- =========================================================
-- ZUSAETZLICHE KORREKTUR: assigned_to verlaesst den SYNC-Block
-- =========================================================
-- Die eigentliche Beschaedigung entsteht dadurch, dass die Regel-Synchro-
-- nisierung die LEGACY-Spalte schreibt und damit den Phase-2-Trigger als
-- Mengen-Mutator missbraucht. Deshalb faellt assigned_to aus dem
-- SYNC-UPDATE heraus. Stattdessen wird die ZUWEISUNGSMENGE direkt
-- abgeglichen (inherit_occurrence_assignments), und die Legacy-Spalte
-- leitet wie gehabt allein die Phase-2-Richtung B ab. Damit bleibt genau
-- EINE Stelle fuer die Bestimmung des primaeren Mitarbeiters.
--
-- Fuer den Einzel-Mitarbeiter-Fall (heutiger Produktionszustand) ist das
-- verhaltensgleich: die Regel hat genau eine Zuweisung, der Termin erhaelt
-- genau diese, und assigned_to zeigt danach auf denselben Mitarbeiter wie
-- zuvor.
--
-- =========================================================
-- BEWUSST NICHT TEIL DIESER MIGRATION
--   * Keine Aenderung an public.jobs (Spalten, Policies, assigned_to).
--   * Keine Verbreiterung der RLS von jobs/job_comments/job_photos/
--     storage.objects.
--   * Keine Aenderung an Benachrichtigungen.
--   * Keine Aenderung an der offiziellen Zeit-Semantik
--     (jobs.started_at/completed_at bleiben unberuehrt).
--   * Keine App-/UI-Aenderung.
--   * Kein Backfill: bestehende Termine gelten alle als "folgt der Regel",
--     was exakt dem heutigen Verhalten entspricht.
--
-- ANWENDUNG: manuell im Supabase SQL Editor (siehe CLAUDE.md).
-- Diese Migration wurde NICHT auf Produktion oder Staging ausgefuehrt.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Markierungstabelle
-- ---------------------------------------------------------
create table if not exists public.job_occurrence_assignment_overrides (
  -- Termin, dessen Zuweisungsmenge individuell angepasst wurde.
  -- ON DELETE CASCADE: wird der Termin (z. B. vom PRUNE-Block) entfernt,
  -- verschwindet die Markierung mit ihm.
  job_id        uuid primary key references public.jobs(id) on delete cascade,
  customized_at timestamptz not null default now(),
  -- ON DELETE SET NULL, damit eine Konto-Loeschung nicht blockiert wird
  -- (gleiche Begruendung wie bei job_assignments.reviewed_by).
  customized_by uuid references public.profiles(id) on delete set null
);

comment on table public.job_occurrence_assignment_overrides is
'Markiert Termine (Occurrences), deren Zuweisungsmenge individuell angepasst '
'wurde. Vorhandene Zeile = die Regel-Synchronisierung fasst die Zuweisungen '
'dieses Termins NICHT mehr an. Fehlende Zeile = Termin folgt der Regel. '
'Absichtlich eine eigene Tabelle statt einer Spalte auf jobs: deckt auch die '
'leere Zuweisungsmenge ab, laesst jobs unveraendert und traegt Audit-Daten.';

comment on column public.job_occurrence_assignment_overrides.customized_by is
'Admin, der die Anpassung vorgenommen hat. Ohne NOT-NULL-Kopplung, damit eine '
'Konto-Loeschung (ON DELETE SET NULL) nicht fehlschlaegt.';

create index if not exists idx_job_occ_overrides_customized_by
  on public.job_occurrence_assignment_overrides (customized_by)
  where customized_by is not null;

-- Zugriff: wie in Phase 3 — Lesen fuer Admins der eigenen Firma (die
-- spaetere Oberflaeche muss "individuell angepasst" anzeigen koennen),
-- Schreiben ausschliesslich ueber die RPCs unten.
alter table public.job_occurrence_assignment_overrides enable row level security;

-- WICHTIG: Supabase vergibt auf NEUE Tabellen im public-Schema per
-- Default-Privilegien automatisch ALLE Rechte an anon UND authenticated
-- (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER). Ein
-- blosses "grant select" haerten hier NICHTS — die Schreibrechte blieben
-- bestehen und ein beliebiger eingeloggter Nutzer koennte die Markierungen
-- direkt setzen, loeschen oder die Tabelle leeren und damit die gesamte
-- Anpassungs-Garantie aushebeln. Deshalb zuerst vollstaendig ENTZIEHEN und
-- danach gezielt nur SELECT vergeben — exakt wie in Phase 1 fuer
-- job_assignments (20260725000000).
revoke all on public.job_occurrence_assignment_overrides from anon, authenticated;
grant select on public.job_occurrence_assignment_overrides to authenticated;

drop policy if exists "admin read occurrence overrides in own company"
  on public.job_occurrence_assignment_overrides;
create policy "admin read occurrence overrides in own company"
on public.job_occurrence_assignment_overrides
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and public.job_in_current_company(job_id)
);
-- KEINE INSERT/UPDATE/DELETE-Policy und kein Schreibrecht: die Markierung
-- setzt ausschliesslich set_job_assignments bzw. entfernt sie
-- reset_job_occurrence_assignments.


-- ---------------------------------------------------------
-- 2. Mengenabgleich Regel -> Termine
-- ---------------------------------------------------------
-- Gleicht die Zuweisungsmenge aller NICHT angepassten, zukuenftigen,
-- offenen und noch nicht gestarteten Termine einer Regel an die Menge der
-- Regel an. p_only_job_id begrenzt den Abgleich auf einen einzelnen Termin
-- (verwendet vom Zuruecksetzen).
--
-- SECURITY DEFINER: schreibt job_assignments, worauf normale Clients
-- bewusst kein Schreibrecht haben. Die Funktion nimmt keine Nutzereingabe
-- ausser IDs entgegen und wird nur aus bereits autorisierten RPCs
-- aufgerufen; EXECUTE wird unten vollstaendig entzogen.
--
-- HISTORIE: Entfernt werden ausschliesslich SPURENFREIE Zeilen. Alles mit
-- Anwesenheit, Zeitstempeln, Review oder anonymisierter Herkunft
-- (employee_id IS NULL) bleibt unangetastet — unabhaengig davon, ob der
-- Termin geerbt oder angepasst ist.
create or replace function public.inherit_occurrence_assignments(
  p_parent_job_id uuid,
  p_only_job_id   uuid default null
)
returns int
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

comment on function public.inherit_occurrence_assignments(uuid, uuid) is
'Gleicht die Zuweisungsmenge nicht angepasster, zukuenftiger, offener Termine '
'an die aktive Menge der Regel an. Entfernt ausschliesslich spurenfreie Zeilen '
'und legt fehlende an (ON CONFLICT DO NOTHING). Interne Hilfsfunktion — nur aus '
'autorisierten RPCs aufrufbar.';

revoke all on function public.inherit_occurrence_assignments(uuid, uuid) from public;
revoke all on function public.inherit_occurrence_assignments(uuid, uuid) from anon, authenticated;


-- ---------------------------------------------------------
-- 3. generate_job_occurrences: neue Termine erben die MENGE
-- ---------------------------------------------------------
-- Unveraendert gegenueber 20260714000000, mit EINER Ergaenzung am Ende:
-- nach dem Erzeugen wird die Zuweisungsmenge der Regel auf die neuen
-- (per Definition nicht angepassten) Termine uebertragen. Der INSERT
-- selbst setzt weiterhin assigned_to = effective_assigned_to, damit die
-- Legacy-Spalte zu keinem Zeitpunkt unbelegt ist.
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
        job_type, date, start_time, scheduled_start, is_active, created_by
      )
      values (
        parent.company_id, parent.id, parent.customer_name, parent.service_name,
        parent.location_address, parent.notes, 'open', effective_assigned_to,
        'single', check_date, parent.start_time,
        case
          when parent.start_time is not null
          then (check_date::text || ' ' || parent.start_time::text)::timestamptz
          else null
        end,
        parent.is_active, parent.created_by
      )
      on conflict (parent_job_id, date, start_time)
        where parent_job_id is not null
      do nothing;

      get diagnostics rows_affected = row_count;
      inserted_count := inserted_count + rows_affected;
    end if;

    check_date := check_date + 1;
  end loop;

  -- NEU (Phase 4): vollstaendige Zuweisungsmenge der Regel auf die nicht
  -- angepassten Termine uebertragen. Ohne diesen Schritt erbte ein neuer
  -- Termin weiterhin nur den einzelnen Legacy-Mitarbeiter.
  perform public.inherit_occurrence_assignments(parent_job_id_input);

  return inserted_count;
end;
$$;

comment on function public.generate_job_occurrences(uuid) is
'Erzeugt konkrete Single-Jobs aus einer Recurring-Regel. Zeitraum aus '
'recurrence_start/end_date, hartes Maximum 730 Tage, idempotent. Weist keine '
'Occurrence einem inaktiven Mitarbeiter zu. Uebertraegt seit Phase 4 die '
'vollstaendige Zuweisungsmenge der Regel auf nicht angepasste Termine.';


-- ---------------------------------------------------------
-- 4. update_job_occurrences: assigned_to raus, Mengenabgleich rein
-- ---------------------------------------------------------
-- Unveraendert gegenueber 20260723000004 in PRUNE und GENERATE. Geaendert:
--   * SYNC schreibt assigned_to NICHT mehr (Ursache der Beschaedigung).
--   * Danach laeuft der Mengenabgleich, der angepasste Termine ausspart.
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

  -- Parent laden UND sperren: serialisiert konkurrierende Aufrufe fuer
  -- dieselbe Regel. Diese Sperre ist zugleich die erste Stufe der
  -- Sperrreihenfolge Parent -> Termin, an die sich set_job_assignments
  -- haelt (siehe dort) — dadurch sind Deadlocks ausgeschlossen.
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

  -- ── 1) PRUNE ──────────────────────────────────────────────────────
  -- Unveraendert: nur zukuenftige, nachweislich unberuehrte Termine, die
  -- nicht mehr zur Regel passen. Historie schuetzt die Zeile immer.
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
          not (parent.recurring_days @> array[
            case extract(isodow from c.date)::int
              when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
              when 4 then 'thu' when 5 then 'fri' when 6 then 'sat'
              when 7 then 'sun'
            end
          ])
          or c.start_time is distinct from parent.start_time
          or (parent.recurrence_end_date   is not null and c.date > parent.recurrence_end_date)
          or (parent.recurrence_start_date is not null and c.date < parent.recurrence_start_date)
        );

  -- ── 2) SYNC (OHNE assigned_to) ────────────────────────────────────
  -- assigned_to wurde hier bewusst entfernt. Frueher schrieb dieser
  -- Block die Legacy-Spalte und loeste damit den Phase-2-Trigger als
  -- Mengen-Mutator aus, der genau einen Mitarbeiter der individuell
  -- angepassten Menge loeschte (siehe Ursachenanalyse oben). Die
  -- Zuweisungen regelt jetzt ausschliesslich Schritt 3.
  update public.jobs c
  set
    customer_name    = parent.customer_name,
    service_name     = parent.service_name,
    location_address = parent.location_address,
    notes            = parent.notes,
    is_active        = parent.is_active
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
    );

  -- ── 3) GENERATE (inkl. Mengenabgleich) ────────────────────────────
  -- generate_job_occurrences fuegt fehlende Termine ein und ruft danach
  -- selbst inherit_occurrence_assignments auf. Dessen Abgleich ist NICHT
  -- auf neu erzeugte Zeilen beschraenkt, sondern erfasst alle nicht
  -- angepassten, zukuenftigen, offenen Termine der Regel — also auch die
  -- bereits bestehenden. Ein zusaetzlicher Aufruf an dieser Stelle waere
  -- daher nachweislich redundant und wuerde den Abgleich bei Regeln mit
  -- vielen Terminen unnoetig verdoppeln.
  -- (generate kann seinen inherit-Aufruf auch nicht verfehlen: seine drei
  -- Guards — Authentifizierung, Admin-Rolle, Parent-Lookup — sind mit den
  -- oben bereits bestandenen identisch.)
  --
  -- jobs.assigned_to wird dabei nirgends direkt geschrieben; die
  -- Phase-2-Richtung B leitet den primaeren Mitarbeiter aus der
  -- resultierenden Menge ab.
  select public.generate_job_occurrences(parent_job_id_input)
  into new_count;

  return new_count;
end;
$$;

comment on function public.update_job_occurrences(uuid) is
'Nicht-destruktiv: prunt nur unberuehrte, nicht mehr passende Zukunfts-Termine, '
'synct Nicht-Termin-Felder (OHNE assigned_to) und gleicht die Zuweisungsmenge '
'nicht angepasster Termine an die Regel an. Individuell angepasste Termine '
'behalten ihre Zuweisungen. Bewahrt in_progress/completed, Zeitstempel, '
'Kommentare, Fotos und Lesestatus.';


-- ---------------------------------------------------------
-- 5. set_job_assignments: Termin als angepasst markieren
-- ---------------------------------------------------------
-- Unveraendert gegenueber 20260727000000 bis auf zwei Ergaenzungen:
--   a) Ist der Auftrag ein Termin, wird ZUERST die Regel-Zeile gesperrt
--      und danach der Termin. Gleiche Reihenfolge wie
--      update_job_occurrences (Parent -> Kind) => kein Deadlock.
--   b) Nach erfolgreicher Aenderung wird der Termin als individuell
--      angepasst markiert.
create or replace function public.set_job_assignments(
  p_job_id       uuid,
  p_employee_ids uuid[] default '{}'::uuid[]
)
returns setof public.job_assignments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company    uuid;
  v_parent     uuid;
  v_ids        uuid[];
  v_parent_ids uuid[];
  v_invalid    int;
  v_actor      uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can change job assignments' using errcode = '42501';
  end if;

  -- (a) Sperrreihenfolge: bei einem Termin zuerst die Regel sperren.
  -- parent_job_id ist fuer eine bestehende Zeile unveraenderlich, das
  -- Lesen vor dem Sperren ist daher unkritisch.
  select j.parent_job_id into v_parent
  from public.jobs j
  where j.id = p_job_id;

  if v_parent is not null then
    perform 1 from public.jobs where id = v_parent for update;
  end if;

  select j.company_id
    into v_company
  from public.jobs j
  where j.id         = p_job_id
    and j.company_id = public.current_user_company_id()
  for update;

  if not found then
    raise exception 'Job not found or not accessible' using errcode = '42501';
  end if;

  -- Kanonische Form: dedupliziert UND sortiert. Die Sortierung ist noetig,
  -- damit die Menge unten direkt mit der Regelmenge verglichen werden kann.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
    into v_ids
  from unnest(coalesce(p_employee_ids, '{}'::uuid[])) as x
  where x is not null;

  select count(*)
    into v_invalid
  from unnest(v_ids) as x
  where not exists (
    select 1
    from public.profiles p
    where p.id         = x
      and p.is_active  = true
      and p.role       = 'employee'
      and p.company_id = v_company
  );

  if v_invalid > 0 then
    raise exception
      'Assignment rejected: % of % employee(s) are not active employees of this company',
      v_invalid, cardinality(v_ids)
      using errcode = '23514';
  end if;

  delete from public.job_assignments ja
  where ja.job_id                 = p_job_id
    and ja.employee_id           is not null
    and not (ja.employee_id = any (v_ids))
    and ja.attendance             = 'assigned'
    and ja.review                is null
    and ja.employee_started_at   is null
    and ja.employee_completed_at is null;

  insert into public.job_assignments (
    job_id, employee_id, employee_name_snapshot, assigned_by
  )
  select
    p_job_id,
    x,
    coalesce(nullif(btrim(p.full_name), ''), 'Unbekannt'),
    auth.uid()
  from unnest(v_ids) as x
  join public.profiles p on p.id = x
  on conflict (job_id, employee_id) do nothing;

  -- (b) Markierung NUR bei echter Abweichung von der Regelmenge.
  --
  -- Verglichen wird die ABSICHT des Aufrufers (die validierte, kanonische
  -- Zielmenge v_ids) mit der effektiven Zuweisungsmenge der Regel — nicht
  -- der resultierende Tabelleninhalt. Das ist wichtig, weil auf dem Termin
  -- spurenbehaftete Zeilen liegen koennen, die gar nicht entfernt werden
  -- duerfen; wuerde man diese mitvergleichen, wuerde ein Termin allein
  -- wegen eines Nachweises faelschlich als "angepasst" gelten.
  --
  -- Folgen:
  --   * Speichern OHNE Aenderung ist ein echter No-Op — der Termin wird
  --     nicht abgekoppelt. Ohne diese Pruefung koppelte ein blosses
  --     Oeffnen-und-Speichern in der spaeteren Oberflaeche den Termin
  --     dauerhaft und unsichtbar von der Regel ab.
  --   * Wird ein angepasster Termin wieder exakt auf die Regelmenge
  --     gesetzt, verschwindet die Markierung automatisch; er folgt der
  --     Regel wieder, ohne dass ein Zuruecksetzen noetig waere.
  --   * Die LEERE Zielmenge bleibt eine echte Anpassung, solange die Regel
  --     nicht ebenfalls leer ist — der Fall, der eine Markierung je
  --     Zuweisungszeile unmoeglich macht, bleibt damit abgedeckt.
  if v_parent is not null then
    select coalesce(array_agg(pa.employee_id order by pa.employee_id), '{}'::uuid[])
      into v_parent_ids
    from public.job_assignments pa
    join public.profiles pp on pp.id = pa.employee_id
    join public.jobs      pj on pj.id = pa.job_id
    where pa.job_id      = v_parent
      and pa.employee_id is not null
      and pp.is_active   = true
      and pp.role        = 'employee'
      and pp.company_id  = pj.company_id;

    if v_ids = v_parent_ids then
      delete from public.job_occurrence_assignment_overrides where job_id = p_job_id;
    else
      select p.id into v_actor from public.profiles p where p.id = auth.uid();

      insert into public.job_occurrence_assignment_overrides (job_id, customized_at, customized_by)
      values (p_job_id, now(), v_actor)
      on conflict (job_id) do update
        set customized_at = now(),
            customized_by = excluded.customized_by;
    end if;
  end if;

  return query
  select ja.*
  from public.job_assignments ja
  where ja.job_id = p_job_id
  order by ja.assigned_at, ja.id;
end;
$$;

comment on function public.set_job_assignments(uuid, uuid[]) is
'Ersetzt die Zuweisungsmenge EINES Auftrags transaktional (nur Admin, nur '
'eigene Firma). Validiert die gesamte Zielmenge vor dem ersten Schreibvorgang, '
'sperrt bei Terminen zuerst die Regel und dann den Termin, entfernt '
'ausschliesslich spurenfreie Zuweisungen und legt fehlende an. Markiert einen '
'Termin als individuell angepasst, sodass die Regel-Synchronisierung ihn nicht '
'mehr ueberschreibt. jobs.assigned_to wird nicht angefasst.';

revoke all on function public.set_job_assignments(uuid, uuid[]) from public;
revoke all on function public.set_job_assignments(uuid, uuid[]) from anon;
grant execute on function public.set_job_assignments(uuid, uuid[]) to authenticated;


-- ---------------------------------------------------------
-- 6. Zuruecksetzen auf "folgt der Regel"
-- ---------------------------------------------------------
create or replace function public.reset_job_occurrence_assignments(
  p_job_id uuid
)
returns setof public.job_assignments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent    uuid;
  v_status    public.job_status;
  v_started   timestamptz;
  v_completed timestamptz;
  v_date      date;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can reset occurrence assignments' using errcode = '42501';
  end if;

  select j.parent_job_id into v_parent
  from public.jobs j
  where j.id         = p_job_id
    and j.company_id = public.current_user_company_id();

  if not found then
    raise exception 'Job not found or not accessible' using errcode = '42501';
  end if;

  if v_parent is null then
    raise exception 'Job is not a generated occurrence' using errcode = '22023';
  end if;

  -- Gleiche Sperrreihenfolge wie ueberall: Regel zuerst, dann Termin.
  perform 1 from public.jobs where id = v_parent  for update;
  perform 1 from public.jobs where id = p_job_id  for update;

  -- Zustand ERST NACH der Sperre lesen und pruefen, damit kein Wettlauf
  -- zwischen Pruefung und Aenderung entsteht.
  select j.status, j.started_at, j.completed_at, j.date
    into v_status, v_started, v_completed, v_date
  from public.jobs j
  where j.id = p_job_id;

  -- Der Mengenabgleich fasst ausschliesslich zukuenftige, offene und noch
  -- nicht gestartete Termine an. Auf allen anderen wuerde das Entfernen der
  -- Markierung den Termin als "folgt der Regel" ausweisen, ohne dass jemals
  -- wieder etwas geerbt wird — ein Zustand, der die Wahrheit verfehlt.
  -- Deshalb hier ABLEHNEN statt still die Markierung zu verlieren.
  if v_status is distinct from 'open'
     or v_started   is not null
     or v_completed is not null
     or coalesce(v_date, date '0001-01-01') < current_date then
    raise exception
      'Occurrence has already started, is completed or lies in the past; assignments can no longer be inherited'
      using errcode = '22023',
            detail  = 'Nur zukuenftige, offene und nicht gestartete Termine koennen die Zuweisungen der Regel erneut uebernehmen.',
            hint    = 'Die Zuweisungen dieses Termins bleiben unveraendert erhalten.';
  end if;

  delete from public.job_occurrence_assignment_overrides where job_id = p_job_id;

  -- Sofort neu erben, damit der Termin nicht bis zur naechsten
  -- Regel-Aenderung in einem Zwischenzustand verharrt.
  perform public.inherit_occurrence_assignments(v_parent, p_job_id);

  return query
  select ja.*
  from public.job_assignments ja
  where ja.job_id = p_job_id
  order by ja.assigned_at, ja.id;
end;
$$;

comment on function public.reset_job_occurrence_assignments(uuid) is
'Setzt einen Termin auf "folgt der Regel" zurueck: entfernt die '
'Anpassungs-Markierung und uebernimmt sofort wieder die Zuweisungsmenge der '
'Regel. Nur Admin, nur eigene Firma, nur fuer generierte Termine. '
'Spurenbehaftete Zuweisungen (Anwesenheit/Review/Zeitstempel) bleiben erhalten.';

revoke all on function public.reset_job_occurrence_assignments(uuid) from public;
revoke all on function public.reset_job_occurrence_assignments(uuid) from anon;
grant execute on function public.reset_job_occurrence_assignments(uuid) to authenticated;


-- =========================================================
-- NEBENWIRKUNGEN UND GRENZEN
-- =========================================================
--   * Ein bereits GESTARTETER oder abgeschlossener Termin wird vom
--     Mengenabgleich nie angefasst (status/Zeitstempel-Bedingung), auch
--     wenn er nicht angepasst ist. Das entspricht dem bisherigen Verhalten.
--   * Spurenbehaftete Zuweisungen auf einem geerbten Termin werden nicht
--     entfernt. Ein solcher Termin kann daher dauerhaft mehr Mitarbeiter
--     tragen als die Regel — bewusst, weil Nachweise Vorrang haben.
--   * Die Markierung ist bewusst nicht rueckwirkend: bestehende Termine
--     gelten nach dieser Migration alle als "folgt der Regel", exakt wie
--     bisher. Ein Backfill waere eine Verhaltensaenderung an Bestandsdaten
--     und ist ausdruecklich nicht gewuenscht.
--
-- =========================================================
-- ROLLBACK (vollstaendig, nicht destruktiv)
-- =========================================================
-- REIHENFOLGE IST ZWINGEND — anders als bei den RLS-Policies der Phase 3
-- schuetzt PostgreSQL hier NICHTS: inherit_occurrence_assignments,
-- set_job_assignments und reset_job_occurrence_assignments verweisen im
-- FUNKTIONSRUMPF auf job_occurrence_assignment_overrides, und
-- Funktionsrumpfe werden nicht als Abhaengigkeit verfolgt. Wird die
-- Tabelle zuerst geloescht, scheitern ab diesem Moment sowohl die
-- Terminerzeugung als auch jede Zuweisungsaenderung mit
-- 'relation ... does not exist' (nachgestellt und bestaetigt). Da
-- Schemaaenderungen in diesem Repository manuell und Anweisung fuer
-- Anweisung im SQL Editor laufen, ist dieses Fenster real.
--
-- Deshalb ZUERST die drei Funktionsrumpfe zurueckstellen und ERST DANACH
-- die Hilfsfunktion und die Tabelle entfernen:
--
--   drop function if exists public.reset_job_occurrence_assignments(uuid);
--   -- generate_job_occurrences / update_job_occurrences / set_job_assignments
--   -- auf den Stand der Migrationen 20260714000000 / 20260723000004 /
--   -- 20260727000000 zuruecksetzen (identische Rumpfe, ohne den
--   -- inherit-Aufruf, mit assigned_to im SYNC-Block bzw. ohne
--   -- Markierungslogik).
--   drop function if exists public.inherit_occurrence_assignments(uuid, uuid);
--   drop table if exists public.job_occurrence_assignment_overrides;
--
-- Es gehen keine Zuweisungsdaten verloren: die Markierungstabelle traegt
-- keine Zuweisungen, sondern nur die Information "folgt der Regel nicht".
-- Nach dem Rueckbau folgen wieder alle Termine der Regel — also exakt das
-- Verhalten vor Phase 4.
-- =========================================================
