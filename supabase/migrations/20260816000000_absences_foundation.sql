-- =========================================================
-- MIGRATION: Abwesenheiten — Grundlage (Phase A)
-- Datum: 2026-08-16
-- =========================================================
-- ZWECK
--   Urlaub und Krankheit sind Beta-relevante Features (siehe Architektur-
--   Audit "Abwesenheiten"). Diese Migration legt AUSSCHLIESSLICH die
--   Datenschicht: eine Tabelle (employee_absences), zwei Enums, RLS
--   (nur SELECT fuer Clients) und sieben SECURITY-DEFINER-RPCs fuer den
--   kompletten Schreibpfad (Mitarbeiter-Selbstbedienung + Admin-Review/
--   manuelle Erfassung).
--
-- EIN TABELLE, TYPDISKRIMINIERT
--   Urlaub und Krankheit teilen sich Firma/Mitarbeiter/Datumsbereich/Notizen/
--   Pruefpfad — nur der Workflow unterscheidet sich. Ein CHECK-Constraint
--   (chk_employee_absences_status_matches_type) macht ungueltige
--   Typ/Status-Kombinationen strukturell unmoeglich, exakt wie
--   chk_job_assignments_review_pair es fuer job_assignments tut. Zwei
--   getrennte Tabellen wuerden jede RLS-Policy, jeden Index und jede
--   kuenftige Kalender-/Stundenzettel-Abfrage verdoppeln, ohne dass ein
--   Feld tatsaechlich typ-spezifisch waere.
--
-- BEWUSST NICHT TEIL DIESER MIGRATION
--   * KEINE Aenderung an notification_outbox/notification_deliveries oder
--     an supabase/functions/dispatch-notifications. Benachrichtigungen
--     folgen in einem eigenen PR, NACHDEM der Abwesenheits-Workflow selbst
--     bewiesen ist — das bestehende, funktionierende Job-Push-System soll
--     hier keinem Risiko ausgesetzt werden.
--   * KEINE Aenderung an jobs, job_assignments, services/timesheets/* oder
--     irgendeiner UI. Phase A ist reine Datenschicht.
--   * KEINE gespeicherten Stunden/Minuten auf employee_absences (keine
--     paid_hours/planned_hours/duration-Spalte). Die kuenftige "geplante
--     Abwesenheits-Zeit" (siehe Beispiel im Audit: Krankheit an einem Tag
--     mit einer Recurring-Occurrence, planned_duration_minutes=240) MUSS
--     dynamisch aus jobs.planned_duration_minutes der tatsaechlichen
--     Occurrence berechnet werden (join ueber date-Bereich + Zuweisung),
--     NICHT aus einer hier gespeicherten Kopie — sonst entsteht genau die
--     "stale duplicated data"-Falle, vor der der Auftrag warnt. Recurring
--     Jobs sind bereits ueber generate_job_occurrences/update_job_occurrences
--     als echte jobs-Zeilen (job_type='single', parent_job_id gesetzt)
--     materialisiert; getScheduleOccurrences() liest sie bereits so. Eine
--     kuenftige Stundenzettel-Berechnung kann also ohne Schemaaenderung auf
--     genau diesem Weg aufsetzen.
--
-- ANWENDUNG
--   Wie alle Schemaaenderungen hier MANUELL im Supabase SQL Editor
--   ausfuehren (siehe CLAUDE.md). Diese Migration wurde NICHT auf der
--   Produktionsdatenbank ausgefuehrt.
--
-- KORREKTUR (noch vor jeder Anwendung, PR-Review):
--   Eine fruehere Version dieser Migration hatte ein CHECK-Constraint
--   chk_employee_absences_review_pair ((reviewed_by is null) = (reviewed_at
--   is null)). Es kollidierte mit reviewed_by ON DELETE SET NULL: die
--   Loeschung eines Admin-Profils, das irgendeine Zeile reviewed hatte,
--   schlug fehl (23514), weil die FK-Aktion nur reviewed_by nullt und
--   reviewed_at unangetastet laesst. Entfernt — siehe Kommentar bei den
--   Spalten reviewed_by/reviewed_at fuer die Begruendung, warum die
--   Konsistenz stattdessen ausschliesslich durch die beiden schreibenden
--   RPCs (admin_review_vacation, admin_create_absence) garantiert wird.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'absence_type') then
    create type public.absence_type as enum ('vacation', 'sickness');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'absence_status') then
    -- 'cancelled' wird von beiden Typen genutzt. 'requested'/'approved'/
    -- 'rejected' sind Urlaub-exklusiv, 'reported' ist Krankheit-exklusiv —
    -- durchgesetzt ueber chk_employee_absences_status_matches_type, NICHT
    -- ueber zwei Enums (ein Enum pro Typ waere hier Overkill fuer eine
    -- einzige gemeinsame Spalte).
    create type public.absence_status as enum (
      'requested', 'approved', 'rejected', 'cancelled', 'reported'
    );
  end if;
end $$;


-- ---------------------------------------------------------
-- 2. Tabelle
-- ---------------------------------------------------------
-- ON-DELETE-Strategie je Spalte:
--   * company_id -> CASCADE. Verschwindet eine Firma, verschwinden alle
--     ihre Daten (bestehendes Muster ueberall, z. B. jobs.company_id).
--   * employee_id -> SET NULL. Ein Mitarbeiterkonto muss loeschbar bleiben,
--     OHNE dass die Abwesenheits-Historie verschwindet — exakt das Muster
--     von job_assignments.employee_id/employee_name_snapshot (Phase 1) und
--     employee_time_adjustments.employee_id (Phase 8). NICHT CASCADE: der
--     historische Produktionsfehler von job_photos.uploaded_by (RESTRICT +
--     NOT NULL blockierte Kontoloeschung, siehe 20260722000000/...0001)
--     wird hier nicht wiederholt, und CASCADE waere der andere fehlerhafte
--     Extremfall (Historie geht verloren).
--   * created_by / reviewed_by -> SET NULL. Gleicher Grund: der Admin, der
--     erfasst/geprueft hat, kann sein Konto ebenfalls loeschen, ohne den
--     Pruefpfad zu zerstoeren.
create table if not exists public.employee_absences (
  id uuid primary key default gen_random_uuid(),

  company_id uuid not null references public.companies(id) on delete cascade,

  -- NULL = das Mitarbeiterkonto wurde geloescht (Anonymisierung).
  employee_id uuid references public.profiles(id) on delete set null,
  -- Schnappschuss des Namens zum Erfassungszeitpunkt — ueberlebt eine
  -- Kontoloeschung, exakt wie job_assignments.employee_name_snapshot.
  employee_name_snapshot text not null,

  type public.absence_type not null,
  status public.absence_status not null,

  start_date date not null,
  end_date date,

  employee_note text,
  admin_note text,

  -- Ersteller der Zeile. Bei Selbstbedienung ist created_by = employee_id
  -- (der Mitarbeiter erfasst seine eigene Abwesenheit). Bei manueller
  -- Admin-Erfassung (admin_create_absence) ist created_by der Admin und
  -- WEICHT VON employee_id AB — genau dieses Auseinanderfallen ist das
  -- Signal "von einem Admin im Namen des Mitarbeiters erfasst" (z. B.
  -- telefonische Krankmeldung, ausserhalb der App vereinbarter Urlaub).
  created_by uuid references public.profiles(id) on delete set null,

  -- reviewed_by/reviewed_at werden IMMER gemeinsam von den Review-RPCs
  -- gesetzt (admin_review_vacation, admin_create_absence) — es gibt
  -- absichtlich KEIN CHECK-Constraint, das dieses Gleichschritt-Paar
  -- erzwingt. Ein solcher Constraint (chk_employee_absences_review_pair,
  -- Vorversion dieser Migration) kollidiert mit reviewed_by ON DELETE SET
  -- NULL: loescht man das Profil eines Admins, der irgendeine Zeile
  -- reviewed hat, setzt Postgres NUR reviewed_by auf NULL — reviewed_at
  -- bleibt unangetastet stehen. Genau dieses "nur eine Spalte des Paares
  -- wird genullt" verletzt einen Gleichschritt-Constraint und macht die
  -- Konto-Loeschung fehlschlagen (23514) — derselbe Fehler-Typ wie der
  -- historische job_photos.uploaded_by-Vorfall (RESTRICT+NOT NULL
  -- blockierte Kontoloeschung, siehe 20260722000000/...0001), nur ueber
  -- einen CHECK statt eine FK-Aktion ausgeloest. Da jeder Schreibpfad
  -- ausschliesslich ueber die beiden Review-RPCs laeuft (siehe unten —
  -- keine INSERT/UPDATE-Policy existiert), ist die Konsistenz dort
  -- garantiert; nach einer Kontoloeschung ist reviewed_at=<Zeitpunkt> bei
  -- reviewed_by=NULL bewusst der gueltige Endzustand ("wurde reviewt,
  -- aber von wem ist nicht mehr rekonstruierbar" — reviewed_at bleibt als
  -- Nachweis DASS und WANN reviewt wurde).
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Name-Schnappschuss darf nicht leer sein — gleiche Bauform wie
  -- chk_job_assignments_name_snapshot.
  constraint chk_employee_absences_name_snapshot
    check (length(btrim(employee_name_snapshot)) > 0),

  -- Datumsregeln (Abschnitt 3 der Spezifikation):
  --   Urlaub: end_date PFLICHT, end_date >= start_date.
  --   Krankheit: end_date darf NULL sein (laufende Krankmeldung ohne
  --     bekanntes Ende); ist es gesetzt, muss end_date >= start_date gelten.
  -- Nur ganztaegige Abwesenheiten fuer Beta — start_date/end_date sind date,
  -- keine timestamptz, damit Teiltage strukturell nicht darstellbar sind.
  constraint chk_employee_absences_dates check (
    (type = 'vacation' and end_date is not null and end_date >= start_date)
    or
    (type = 'sickness' and (end_date is null or end_date >= start_date))
  ),

  -- Verhindert strukturell ungueltige Typ/Status-Kombinationen (Abschnitt 2
  -- der Spezifikation). Urlaub und Krankheit teilen NIE einen ungueltigen
  -- Zustand.
  constraint chk_employee_absences_status_matches_type check (
    (type = 'vacation' and status in ('requested', 'approved', 'rejected', 'cancelled'))
    or
    (type = 'sickness' and status in ('reported', 'cancelled'))
  )
);

comment on table public.employee_absences is
'Urlaub/Krankheit je Mitarbeiter. Ein Typ-diskriminiertes Modell (type +'
'status, siehe chk_employee_absences_status_matches_type) statt zweier '
'Tabellen, weil beide Abwesenheitsarten dieselbe Struktur teilen. Traegt '
'BEWUSST KEINE Stunden-/Minutenspalte — geplante Abwesenheitszeit wird '
'kuenftig dynamisch aus jobs.planned_duration_minutes der betroffenen '
'Occurrences berechnet, nie hier dupliziert. Schreibzugriff ausschliesslich '
'ueber die RPCs in dieser Migration (request_own_vacation, '
'report_own_sickness, cancel_own_vacation, cancel_own_sickness, '
'update_own_sickness_end, admin_review_vacation, admin_create_absence) — '
'es gibt keine INSERT/UPDATE/DELETE-Policy.';

comment on column public.employee_absences.employee_id is
'NULL = Mitarbeiterkonto wurde geloescht (ON DELETE SET NULL). Die Zeile '
'bleibt als Historie erhalten, siehe employee_name_snapshot.';

comment on column public.employee_absences.created_by is
'Ersteller der Zeile. created_by = employee_id bei Selbstbedienung; '
'created_by <> employee_id signalisiert eine manuelle Admin-Erfassung '
'(admin_create_absence).';


-- ---------------------------------------------------------
-- 3. Indizes
-- ---------------------------------------------------------
-- Firmen-/Bereichsabfragen ("wer ist in diesem Kalenderbereich abwesend?",
-- "ueberschneidet sich diese Abwesenheit mit diesem Job-/Occurrence-Datum?").
-- end_date kann NULL sein (laufende Krankmeldung) — ein Btree-Index behandelt
-- NULL wie einen eigenen (hoechsten) Sortierwert und unterstuetzt sowohl
-- Range- als auch "end_date IS NULL"-Praedikate ueber denselben Index.
create index if not exists idx_employee_absences_company_range
  on public.employee_absences (company_id, start_date, end_date);

-- Mitarbeiter-Historie (Employee-Detail, "Meine Abwesenheiten") UND
-- gleichzeitig der FK-Rueckwaertsindex fuer employee_id (ON DELETE SET
-- NULL) — employee_id ist die fuehrende Spalte, daher deckt dieser eine
-- Index beide Zugriffsmuster ab, kein zusaetzlicher Einzelspalten-Index
-- noetig.
create index if not exists idx_employee_absences_employee_history
  on public.employee_absences (employee_id, start_date)
  where employee_id is not null;

-- FK-Rueckwaertsindizes fuer die beiden weiteren ON-DELETE-SET-NULL-Spalten,
-- gleiche Bauform wie idx_employee_time_adjustments_changed_by.
create index if not exists idx_employee_absences_created_by
  on public.employee_absences (created_by)
  where created_by is not null;

create index if not exists idx_employee_absences_reviewed_by
  on public.employee_absences (reviewed_by)
  where reviewed_by is not null;


-- ---------------------------------------------------------
-- 4. Zugriff: RLS an, NUR SELECT fuer Clients
-- ---------------------------------------------------------
-- REIHENFOLGE IST SICHERHEITSRELEVANT (siehe wiederholte Kommentare in
-- lib/schema.sql): ALTER DEFAULT PRIVILEGES vergibt an neue Tabellen im
-- public-Schema automatisch ALLE Rechte an anon/authenticated. Erst
-- vollstaendig entziehen, dann gezielt SELECT vergeben.
alter table public.employee_absences enable row level security;

revoke all on public.employee_absences from anon, authenticated;
grant select on public.employee_absences to authenticated;

-- Mitarbeiter: nur eigene Zeilen, firmenskopiert (Verteidigung in der
-- Tiefe — employee_id impliziert bereits dieselbe Firma, aber jede andere
-- Policy in diesem Schema prueft company_id explizit mit).
drop policy if exists "employee read own absences" on public.employee_absences;
create policy "employee read own absences"
on public.employee_absences
for select
to authenticated
using (
  employee_id = auth.uid()
  and company_id = public.current_user_company_id()
);

-- Admin: alle Zeilen der eigenen Firma.
drop policy if exists "admin read company absences" on public.employee_absences;
create policy "admin read company absences"
on public.employee_absences
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

-- KEINE INSERT-, UPDATE- oder DELETE-Policy. Beabsichtigt — jeder
-- Schreibvorgang laeuft ueber die SECURITY-DEFINER-RPCs unten.


-- ---------------------------------------------------------
-- 5. RPC: request_own_vacation
-- ---------------------------------------------------------
create or replace function public.request_own_vacation(
  start_date_input date,
  end_date_input date,
  employee_note_input text default null
)
returns setof public.employee_absences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_full_name  text;
  v_new_id     uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- current_user_role()/current_user_company_id() liefern NULL fuer ein
  -- inaktives oder firmenloses Profil (siehe lib/schema.sql) — IS DISTINCT
  -- FROM statt <>, damit der Guard fuer ein deaktiviertes Konto nicht still
  -- uebersprungen wird.
  if public.current_user_role() is distinct from 'employee' then
    raise exception 'Only employees can request their own vacation'
      using errcode = '42501';
  end if;

  v_company_id := public.current_user_company_id();
  if v_company_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if start_date_input is null or end_date_input is null then
    raise exception 'start_date and end_date are required'
      using errcode = '23514';
  end if;

  if end_date_input < start_date_input then
    raise exception 'end_date must not be before start_date'
      using errcode = '23514';
  end if;

  -- Ueberlappung: eine neue Anfrage darf sich nicht mit einer bereits
  -- angefragten oder genehmigten eigenen Abwesenheit ueberschneiden.
  -- 'rejected'/'cancelled' zaehlen bewusst NICHT — sie belegen den
  -- Zeitraum nicht mehr.
  if exists (
    select 1 from public.employee_absences ea
    where ea.employee_id = auth.uid()
      and ea.type = 'vacation'
      and ea.status in ('requested', 'approved')
      and ea.start_date <= end_date_input
      and ea.end_date   >= start_date_input
  ) then
    raise exception 'Overlaps an existing vacation request'
      using errcode = '23514';
  end if;

  select full_name into v_full_name from public.profiles where id = auth.uid();

  insert into public.employee_absences (
    company_id, employee_id, employee_name_snapshot,
    type, status, start_date, end_date, employee_note, created_by
  )
  values (
    v_company_id, auth.uid(), coalesce(nullif(btrim(v_full_name), ''), 'Unbekannt'),
    'vacation', 'requested', start_date_input, end_date_input, employee_note_input, auth.uid()
  )
  returning id into v_new_id;

  return query select * from public.employee_absences where id = v_new_id;
end;
$$;

comment on function public.request_own_vacation(date, date, text) is
'Mitarbeiter beantragt eigenen Urlaub (status=requested). Lehnt eine '
'Ueberschneidung mit einer eigenen angefragten/genehmigten Abwesenheit ab.';

revoke all on function public.request_own_vacation(date, date, text) from public, anon;
grant execute on function public.request_own_vacation(date, date, text) to authenticated;


-- ---------------------------------------------------------
-- 6. RPC: report_own_sickness
-- ---------------------------------------------------------
create or replace function public.report_own_sickness(
  start_date_input date,
  end_date_input date default null,
  employee_note_input text default null
)
returns setof public.employee_absences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_full_name  text;
  v_new_id     uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'employee' then
    raise exception 'Only employees can report their own sickness'
      using errcode = '42501';
  end if;

  v_company_id := public.current_user_company_id();
  if v_company_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if start_date_input is null then
    raise exception 'start_date is required' using errcode = '23514';
  end if;

  if end_date_input is not null and end_date_input < start_date_input then
    raise exception 'end_date must not be before start_date'
      using errcode = '23514';
  end if;

  -- Ueberlappung: hoechstens eine aktive ('reported') Krankmeldung
  -- gleichzeitig je Mitarbeiter — haelt das Modell fuer Beta einfach
  -- (Spezifikation Abschnitt 7). 'infinity'::date ist der Sentinel fuer ein
  -- offenes Ende (sowohl auf der neuen als auch auf bestehenden Zeilen), so
  -- dass NULL-Enddaten korrekt "bis auf Weiteres" bedeuten.
  if exists (
    select 1 from public.employee_absences ea
    where ea.employee_id = auth.uid()
      and ea.type = 'sickness'
      and ea.status = 'reported'
      and ea.start_date <= coalesce(end_date_input, 'infinity'::date)
      and coalesce(ea.end_date, 'infinity'::date) >= start_date_input
  ) then
    raise exception 'Overlaps an existing active sickness report'
      using errcode = '23514';
  end if;

  select full_name into v_full_name from public.profiles where id = auth.uid();

  insert into public.employee_absences (
    company_id, employee_id, employee_name_snapshot,
    type, status, start_date, end_date, employee_note, created_by
  )
  values (
    v_company_id, auth.uid(), coalesce(nullif(btrim(v_full_name), ''), 'Unbekannt'),
    'sickness', 'reported', start_date_input, end_date_input, employee_note_input, auth.uid()
  )
  returning id into v_new_id;

  return query select * from public.employee_absences where id = v_new_id;
end;
$$;

comment on function public.report_own_sickness(date, date, text) is
'Mitarbeiter meldet eigene Krankheit (status=reported, sofort aktiv, keine '
'Admin-Genehmigung noetig). end_date darf NULL sein (Ende noch unbekannt). '
'Lehnt eine Ueberschneidung mit einer bereits aktiven eigenen Krankmeldung ab.';

revoke all on function public.report_own_sickness(date, date, text) from public, anon;
grant execute on function public.report_own_sickness(date, date, text) to authenticated;


-- ---------------------------------------------------------
-- 7. RPC: cancel_own_vacation
-- ---------------------------------------------------------
create or replace function public.cancel_own_vacation(
  absence_id_input uuid
)
returns setof public.employee_absences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'employee' then
    raise exception 'Only employees can cancel their own vacation'
      using errcode = '42501';
  end if;

  -- Nur zukuenftiger Urlaub ist selbst stornierbar (Spezifikation
  -- Abschnitt 5): start_date muss noch in der Zukunft liegen. Bereits
  -- begonnener/vergangener Urlaub bleibt unveraendert stehen — eine
  -- Korrektur nachtraeglich waere eine Admin-Angelegenheit, nicht Teil von
  -- Phase A (siehe Abschnitt 6 der Spezifikation: kein
  -- admin_correct_absence ohne konkreten Bedarf).
  update public.employee_absences
  set status = 'cancelled', updated_at = now()
  where id = absence_id_input
    and employee_id = auth.uid()
    and type = 'vacation'
    and status in ('requested', 'approved')
    and start_date > current_date;

  if not found then
    raise exception 'Vacation not found, not yours, or no longer cancellable'
      using errcode = '42501';
  end if;

  return query select * from public.employee_absences where id = absence_id_input;
end;
$$;

comment on function public.cancel_own_vacation(uuid) is
'Mitarbeiter storniert eigenen, noch nicht begonnenen Urlaub '
'(status requested/approved, start_date > heute).';

revoke all on function public.cancel_own_vacation(uuid) from public, anon;
grant execute on function public.cancel_own_vacation(uuid) to authenticated;


-- ---------------------------------------------------------
-- 8. RPC: cancel_own_sickness
-- ---------------------------------------------------------
create or replace function public.cancel_own_sickness(
  absence_id_input uuid
)
returns setof public.employee_absences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'employee' then
    raise exception 'Only employees can cancel their own sickness report'
      using errcode = '42501';
  end if;

  update public.employee_absences
  set status = 'cancelled', updated_at = now()
  where id = absence_id_input
    and employee_id = auth.uid()
    and type = 'sickness'
    and status = 'reported';

  if not found then
    raise exception 'Sickness report not found, not yours, or already closed'
      using errcode = '42501';
  end if;

  return query select * from public.employee_absences where id = absence_id_input;
end;
$$;

comment on function public.cancel_own_sickness(uuid) is
'Mitarbeiter storniert eigene Krankmeldung (z. B. faelschlich erfasst).';

revoke all on function public.cancel_own_sickness(uuid) from public, anon;
grant execute on function public.cancel_own_sickness(uuid) to authenticated;


-- ---------------------------------------------------------
-- 9. RPC: update_own_sickness_end
-- ---------------------------------------------------------
create or replace function public.update_own_sickness_end(
  absence_id_input uuid,
  new_end_date_input date
)
returns setof public.employee_absences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_start_date date;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'employee' then
    raise exception 'Only employees can update their own sickness report'
      using errcode = '42501';
  end if;

  select start_date into v_start_date
  from public.employee_absences
  where id = absence_id_input
    and employee_id = auth.uid()
    and type = 'sickness'
    and status = 'reported';

  if not found then
    raise exception 'Sickness report not found, not yours, or already closed'
      using errcode = '42501';
  end if;

  -- new_end_date_input darf NULL sein (zurueck auf "Ende noch unbekannt").
  -- Ist es gesetzt, muss es weiterhin auf/nach start_date liegen.
  if new_end_date_input is not null and new_end_date_input < v_start_date then
    raise exception 'end_date must not be before start_date'
      using errcode = '23514';
  end if;

  -- Setzt das Enddatum auf DERSELBEN Zeile — erzeugt bewusst KEINE zweite
  -- Krankmeldung (Spezifikation Abschnitt 5).
  update public.employee_absences
  set end_date = new_end_date_input, updated_at = now()
  where id = absence_id_input;

  return query select * from public.employee_absences where id = absence_id_input;
end;
$$;

comment on function public.update_own_sickness_end(uuid, date) is
'Mitarbeiter setzt/aendert das Enddatum der eigenen aktiven Krankmeldung, '
'ohne eine zweite Zeile anzulegen. new_end_date_input=NULL macht sie wieder '
'offen-endig.';

revoke all on function public.update_own_sickness_end(uuid, date) from public, anon;
grant execute on function public.update_own_sickness_end(uuid, date) to authenticated;


-- ---------------------------------------------------------
-- 10. RPC: admin_review_vacation
-- ---------------------------------------------------------
create or replace function public.admin_review_vacation(
  absence_id_input uuid,
  decision_input text,
  admin_note_input text default null
)
returns setof public.employee_absences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.absence_status;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can review vacation requests'
      using errcode = '42501';
  end if;

  if decision_input not in ('approved', 'rejected') then
    raise exception 'decision must be ''approved'' or ''rejected'''
      using errcode = '22023';
  end if;
  v_status := decision_input::public.absence_status;

  -- Firmenscoping direkt im UPDATE (Verteidigung in der Tiefe: current_
  -- user_company_id() ist bereits firmenskopiert, die WHERE-Klausel prueft
  -- zusaetzlich explizit mit, gleiche Bauform wie in job-bezogenen RPCs).
  -- Nur aus status='requested' heraus reviewbar — verhindert ein erneutes
  -- Ueberschreiben einer bereits entschiedenen Anfrage.
  update public.employee_absences
  set status = v_status,
      admin_note = admin_note_input,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  where id = absence_id_input
    and company_id = public.current_user_company_id()
    and type = 'vacation'
    and status = 'requested';

  if not found then
    raise exception 'Vacation request not found, not in your company, or already reviewed'
      using errcode = '42501';
  end if;

  return query select * from public.employee_absences where id = absence_id_input;
end;
$$;

comment on function public.admin_review_vacation(uuid, text, text) is
'Admin genehmigt/lehnt eine Urlaubsanfrage der eigenen Firma ab (nur aus '
'status=requested). Krankmeldungen sind hierueber NICHT review-faehig — es '
'gibt fuer sie keinen Genehmigungs-Workflow.';

revoke all on function public.admin_review_vacation(uuid, text, text) from public, anon;
grant execute on function public.admin_review_vacation(uuid, text, text) to authenticated;


-- ---------------------------------------------------------
-- 11. RPC: admin_create_absence
-- ---------------------------------------------------------
-- Manuelle Erfassung durch einen Admin (Telefonanruf, ausserhalb der App
-- vereinbarter Urlaub, vergessene Krankmeldung — siehe Spezifikation
-- Abschnitt 6/10). Geht bei Urlaub DIREKT auf 'approved', bei Krankheit
-- DIREKT auf 'reported' — der Admin ist bereits die entscheidende Instanz,
-- ein zusaetzlicher Genehmigungsschritt fuer die eigene Erfassung waere
-- sinnlos.
create or replace function public.admin_create_absence(
  employee_id_input uuid,
  type_input public.absence_type,
  start_date_input date,
  end_date_input date default null,
  note_input text default null
)
returns setof public.employee_absences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_full_name  text;
  v_status     public.absence_status;
  v_new_id     uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can manually record an absence'
      using errcode = '42501';
  end if;

  v_company_id := public.current_user_company_id();
  if v_company_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Mitarbeiter muss in derselben Firma sein. BEWUSST OHNE is_active-
  -- Bedingung: ein Admin muss eine historische Abwesenheit auch fuer einen
  -- inzwischen deaktivierten Mitarbeiter nachtragen koennen (z. B.
  -- Krankmeldung kurz vor Austritt), ohne dass ein Datensatz verloren geht.
  -- Das entspricht dem Muster von admin_correct_assignment_time, das
  -- ebenfalls keine is_active-Bedingung an der betroffenen Person kennt.
  select full_name into v_full_name
  from public.profiles
  where id = employee_id_input
    and company_id = v_company_id;

  if not found then
    raise exception 'Employee not found in your company'
      using errcode = '42501';
  end if;

  if start_date_input is null then
    raise exception 'start_date is required' using errcode = '23514';
  end if;

  if type_input = 'vacation' then
    if end_date_input is null then
      raise exception 'end_date is required for vacation'
        using errcode = '23514';
    end if;
    if end_date_input < start_date_input then
      raise exception 'end_date must not be before start_date'
        using errcode = '23514';
    end if;

    if exists (
      select 1 from public.employee_absences ea
      where ea.employee_id = employee_id_input
        and ea.type = 'vacation'
        and ea.status in ('requested', 'approved')
        and ea.start_date <= end_date_input
        and ea.end_date   >= start_date_input
    ) then
      raise exception 'Overlaps an existing vacation request'
        using errcode = '23514';
    end if;

    v_status := 'approved';
  elsif type_input = 'sickness' then
    if end_date_input is not null and end_date_input < start_date_input then
      raise exception 'end_date must not be before start_date'
        using errcode = '23514';
    end if;

    if exists (
      select 1 from public.employee_absences ea
      where ea.employee_id = employee_id_input
        and ea.type = 'sickness'
        and ea.status = 'reported'
        and ea.start_date <= coalesce(end_date_input, 'infinity'::date)
        and coalesce(ea.end_date, 'infinity'::date) >= start_date_input
    ) then
      raise exception 'Overlaps an existing active sickness report'
        using errcode = '23514';
    end if;

    v_status := 'reported';
  else
    raise exception 'Unknown absence type' using errcode = '22023';
  end if;

  insert into public.employee_absences (
    company_id, employee_id, employee_name_snapshot,
    type, status, start_date, end_date, admin_note, created_by,
    reviewed_by, reviewed_at
  )
  values (
    v_company_id, employee_id_input, coalesce(nullif(btrim(v_full_name), ''), 'Unbekannt'),
    type_input, v_status, start_date_input, end_date_input, note_input, auth.uid(),
    -- Urlaub geht direkt auf 'approved' -> der erfassende Admin ist damit
    -- auch der Pruefende, BEIDE Spalten gemeinsam gesetzt. Krankheit hat
    -- keinen Genehmigungsschritt, also bleiben reviewed_by/at dort BEIDE
    -- NULL — die RPC ist die einzige Stelle, die dieses Paar schreibt, und
    -- haelt es hier bewusst im Gleichschritt (siehe Kommentar bei der
    -- Spaltendefinition oben, warum das nicht per CHECK erzwungen wird).
    case when type_input = 'vacation' then auth.uid() else null end,
    case when type_input = 'vacation' then now() else null end
  )
  returning id into v_new_id;

  return query select * from public.employee_absences where id = v_new_id;
end;
$$;

comment on function public.admin_create_absence(uuid, public.absence_type, date, date, text) is
'Admin erfasst eine Abwesenheit manuell fuer einen Mitarbeiter der eigenen '
'Firma (Telefon-Krankmeldung, ausserhalb der App vereinbarter Urlaub). '
'Urlaub landet direkt bei status=approved (reviewed_by/at = der erfassende '
'Admin), Krankheit direkt bei status=reported (kein Genehmigungsschritt). '
'created_by <> employee_id markiert die Zeile als manuell erfasst. Erlaubt '
'auch fuer inzwischen deaktivierte Mitarbeiter (historische Nacherfassung).';

revoke all on function public.admin_create_absence(uuid, public.absence_type, date, date, text) from public, anon;
grant execute on function public.admin_create_absence(uuid, public.absence_type, date, date, text) to authenticated;


-- =========================================================
-- ABWAERTSKOMPATIBILITAET
-- =========================================================
-- Rein additiv. Keine bestehende Tabelle, Spalte, Policy, Funktion,
-- notification_outbox/dispatch-notifications oder UI wurde veraendert.
-- Alte Clients im Feld rufen die neuen RPCs schlicht nie auf.
--
-- ROLLBACK:
--   drop function if exists public.admin_create_absence(uuid, public.absence_type, date, date, text);
--   drop function if exists public.admin_review_vacation(uuid, text, text);
--   drop function if exists public.update_own_sickness_end(uuid, date);
--   drop function if exists public.cancel_own_sickness(uuid);
--   drop function if exists public.cancel_own_vacation(uuid);
--   drop function if exists public.report_own_sickness(date, date, text);
--   drop function if exists public.request_own_vacation(date, date, text);
--   drop policy if exists "admin read company absences" on public.employee_absences;
--   drop policy if exists "employee read own absences" on public.employee_absences;
--   drop table if exists public.employee_absences;
--   drop type if exists public.absence_status;
--   drop type if exists public.absence_type;
-- Gefahrlos: kein Bestandsobjekt haengt an Tabelle, Typen oder Funktionen.
-- =========================================================
