-- =========================================================
-- MIGRATION: job_assignments — Grundlage für "Mehrere Mitarbeiter pro Auftrag"
-- Datum: 2026-07-25   (Phase 1 von 11 — reine Datenschicht)
-- =========================================================
-- ZWECK
--   Legt die normalisierte Zuweisungstabelle inkl. Anwesenheits- und
--   Review-Modell an und befüllt sie verlustfrei aus der bestehenden
--   Einzel-Spalte public.jobs.assigned_to.
--
-- BEWUSST NICHT TEIL DIESER MIGRATION (folgt in späteren Phasen):
--   * KEINE Änderung an public.jobs — assigned_to bleibt unangetastet und
--     bleibt bis zur Sunset-Phase die maßgebliche Quelle für alle Leser.
--   * KEINE Änderung an bestehenden RLS-Policies.
--   * KEINE Änderung an start_own_job / complete_own_job.
--   * KEINE Änderung an generate_job_occurrences / update_job_occurrences.
--   * KEINE Änderung an Benachrichtigungen (Outbox/Deliveries).
--   * KEINE Anwendungs-/Client-Änderung.
--   Nach dieser Migration liest und schreibt KEIN Code job_assignments. Die
--   Tabelle ist vollständig inert; das Verhalten der App ändert sich nicht.
--
-- FACHMODELL (final abgestimmt)
--   Ein Auftrag hat GENAU EINE offizielle Dauer:
--       jobs.completed_at - jobs.started_at
--   Diese Dauer ist die alleinige Grundlage für Stundenzettel, PDF-Export
--   und Statistiken. Sie wird NIRGENDS dupliziert gespeichert.
--
--   Anwesenheit ist zweiachsig:
--     attendance (Mitarbeiter-Selbsterfassung): assigned | started | completed
--     review     (Manager-Entscheidung):        NULL | present | absent
--   Die Trennung ist Absicht: ein Manager muss die Abrechnungs-Berechtigung
--   korrigieren können, OHNE die tatsächlich erfassten Aktionen des
--   Mitarbeiters zu überschreiben. "attendance = started, review = absent"
--   heißt: der Mitarbeiter hat Start gedrückt, der Manager schließt die
--   Zuweisung dennoch vom Stundenzettel aus. Beides bleibt nachvollziehbar.
--
--   counts_for_timesheet ist die EINZIGE Quelle der Berechtigung. Als
--   generierte, gespeicherte Spalte kann kein Aufrufer sie abweichend
--   berechnen — Stundenzettel, Exporte und künftige Statistiken joinen
--   ausschließlich hierauf.
--
-- IDEMPOTENZ
--   Vollständig wiederholbar (Enums via DO-Block, Tabelle via
--   IF NOT EXISTS, Backfill via NOT EXISTS + ON CONFLICT DO NOTHING,
--   Trigger via DROP + CREATE).
--
-- ANWENDUNG
--   Wie alle Schemaänderungen hier MANUELL im Supabase SQL Editor
--   ausführen (siehe CLAUDE.md). Diese Migration wurde NICHT auf der
--   Produktionsdatenbank ausgeführt.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------
-- "create type" kennt kein IF NOT EXISTS — daher der Existenz-Check.

do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'attendance_state' and n.nspname = 'public'
  ) then
    create type public.attendance_state as enum (
      'assigned',   -- zugewiesen, hat selbst nichts erfasst
      'started',    -- hat "Start" gedrückt
      'completed'   -- hat "Abschluss" gedrückt
    );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'attendance_review' and n.nspname = 'public'
  ) then
    create type public.attendance_review as enum (
      'present',    -- Manager bestätigt Teilnahme
      'absent'      -- Manager schließt von der Abrechnung aus
    );
  end if;
end $$;

comment on type public.attendance_state is
'Selbsterfassung des Mitarbeiters an einer Zuweisung (assigned|started|completed). '
'Reines Nachweis-/Audit-Signal — NIE Grundlage einer Dauer.';

comment on type public.attendance_review is
'Manager-Entscheidung zur Anwesenheit (present|absent). Überschreibt die '
'Abrechnungs-Berechtigung, ohne die Selbsterfassung (attendance) zu verändern.';


-- ---------------------------------------------------------
-- 2. Tabelle
-- ---------------------------------------------------------
create table if not exists public.job_assignments (
  -- Surrogat-PK statt (job_id, employee_id): Anwesenheit ist ein
  -- Abrechnungsnachweis und muss eine Konto-Löschung überleben. employee_id
  -- ist deshalb NULLABLE mit ON DELETE SET NULL — konsistent mit
  -- jobs.assigned_to / jobs.created_by, die aus demselben Grund
  -- anonymisieren statt zu löschen (siehe supabase/functions/delete-account).
  id            uuid primary key default gen_random_uuid(),

  job_id        uuid not null references public.jobs(id)     on delete cascade,
  employee_id   uuid          references public.profiles(id) on delete set null,

  -- Name zum Zeitpunkt der Zuweisung. Reports nutzen den LEBENDEN
  -- Profilnamen, solange das Profil existiert, und fallen erst auf diesen
  -- Schnappschuss zurück, wenn employee_id durch eine Konto-Löschung auf
  -- NULL gesetzt wurde. Ohne ihn wäre eine anonymisierte Zeile im
  -- Stundenzettel-Nachweis nicht mehr zuordenbar.
  employee_name_snapshot text not null,

  assigned_at   timestamptz not null default now(),
  assigned_by   uuid references public.profiles(id) on delete set null,

  -- ── Anwesenheit: NUR Audit/Nachweis, NIE Abrechnungsgrundlage ──
  attendance            public.attendance_state not null default 'assigned',
  employee_started_at   timestamptz,
  employee_completed_at timestamptz,

  -- ── Manager-Review (fachlich erst nach Job-Abschluss relevant) ──
  review        public.attendance_review,
  reviewed_at   timestamptz,
  reviewed_by   uuid references public.profiles(id) on delete set null,

  -- ── EINZIGE Quelle der Stundenzettel-Berechtigung ──
  -- Speichert KEINE Dauer, sondern entscheidet ausschließlich, OB der
  -- Mitarbeiter die offizielle Job-Dauer erhält.
  counts_for_timesheet boolean
    generated always as (
      case
        when review = 'absent'                       then false
        when review = 'present'                      then true
        when attendance in ('started', 'completed')  then true
        else false                                   -- 'assigned', ungeprüft
      end
    ) stored,

  -- Eine lebende Zuweisung je (Auftrag, Mitarbeiter). Zum NULL-Verhalten
  -- siehe den ausführlichen Block unter "Duplikat-Schutz".
  constraint uq_job_assignments_job_employee unique (job_id, employee_id),

  -- Review ist genau dann gesetzt, wenn ein Review-Zeitpunkt existiert.
  constraint chk_job_assignments_review_pair
    check ((review is null) = (reviewed_at is null)),

  -- Der Namens-Schnappschuss darf nie leer sein — er ist der letzte
  -- verbleibende Nachweis, sobald das Profil gelöscht wurde.
  constraint chk_job_assignments_name_snapshot
    check (length(btrim(employee_name_snapshot)) > 0)

  -- BEWUSST KEINE Reihenfolge-Constraint zwischen employee_started_at und
  -- employee_completed_at: fachlich darf ein Mitarbeiter abschließen, ohne
  -- je gestartet zu haben (ein Kollege hat den Auftrag bereits gestartet).
  -- employee_started_at bleibt dann NULL — genau dieses NULL ist das
  -- Audit-Signal, das der spätere Review-Screen hervorhebt.

  -- BEWUSST KEINE Dauer-Spalte: die offizielle Dauer ergibt sich
  -- ausschließlich aus jobs.started_at/jobs.completed_at.
);

comment on table public.job_assignments is
'Zuweisung von Mitarbeitern zu Aufträgen (n:m) inkl. Anwesenheitsnachweis. '
'Gilt für Einzel-Jobs, Recurring-Parent-Regeln (Vorlage) und Occurrences. '
'Enthält BEWUSST KEINE Dauer: die einzige offizielle Dauer ist '
'jobs.completed_at - jobs.started_at. Pro-Mitarbeiter-Zeitstempel sind '
'reine Audit-/Nachweisdaten und dürfen NIE in Reports als Dauer dienen.';

comment on column public.job_assignments.employee_id is
'NULL = Mitarbeiterkonto wurde gelöscht (ON DELETE SET NULL). Die Zeile '
'bleibt als Anwesenheits-/Abrechnungsnachweis erhalten; der Name steht dann '
'nur noch in employee_name_snapshot.';

comment on column public.job_assignments.employee_name_snapshot is
'Voller Name zum Zuweisungszeitpunkt. Reports bevorzugen den lebenden '
'profiles.full_name und nutzen diesen Wert als Fallback für gelöschte Konten.';

comment on column public.job_assignments.attendance is
'Selbsterfassung des Mitarbeiters. Wird durch ein Manager-Review NIE '
'überschrieben — die erfasste Aktion bleibt dauerhaft nachvollziehbar.';

comment on column public.job_assignments.employee_started_at is
'AUDIT ONLY. Wann dieser Mitarbeiter selbst Start gedrückt hat. Niemals '
'Grundlage einer Dauerberechnung.';

comment on column public.job_assignments.employee_completed_at is
'AUDIT ONLY. Wann dieser Mitarbeiter selbst Abschluss gedrückt hat. Niemals '
'Grundlage einer Dauerberechnung. Darf ohne employee_started_at existieren.';

comment on column public.job_assignments.review is
'Manager-Entscheidung. NULL = ungeprüft. Überschreibt ausschließlich '
'counts_for_timesheet, nicht attendance.';

comment on column public.job_assignments.reviewed_by is
'Prüfender Admin. BEWUSST OHNE NOT-NULL-Kopplung an review — siehe '
'Begründung im Migrations-Header-Abschnitt "reviewed_by".';

comment on column public.job_assignments.counts_for_timesheet is
'Einzige Quelle der Stundenzettel-Berechtigung. true = dieser Mitarbeiter '
'erhält die OFFIZIELLE Job-Dauer (jobs.completed_at - jobs.started_at). '
'Reports joinen ausschließlich hierauf und berechnen die Berechtigung NIE selbst.';

comment on constraint uq_job_assignments_job_employee on public.job_assignments is
'Eine lebende Zuweisung je (Auftrag, Mitarbeiter). NULLS DISTINCT ist hier '
'korrekt und erforderlich — mehrere anonymisierte Zeilen je Auftrag stehen für '
'mehrere verschiedene gelöschte Mitarbeiter.';


-- ---------------------------------------------------------
-- reviewed_by: dokumentierte Ausnahme von der NOT-NULL-Kopplung
-- ---------------------------------------------------------
-- Gefordert war "reviewed_by required when review is not null, unless
-- existing repository conventions require a documented exception". Genau so
-- ein Fall liegt hier vor:
--
--   reviewed_by verweist mit ON DELETE SET NULL auf profiles. Wird das Konto
--   des prüfenden Admins gelöscht, führt PostgreSQL ein UPDATE auf dieser
--   Zeile aus. CHECK-Constraints werden bei JEDEM UPDATE erneut geprüft —
--   eine Bedingung wie "review is null or reviewed_by is not null" würde
--   dieses UPDATE also verletzen und damit die KONTO-LÖSCHUNG BLOCKIEREN.
--
--   Exakt dieser Fehler ist in diesem Repository bereits einmal in
--   Produktion aufgetreten: job_photos.uploaded_by war RESTRICT + NOT NULL
--   und hat die Konto-Löschung blockiert (behoben in
--   20260722000000_fix_job_photos_uploaded_by_on_delete.sql und
--   20260722000001_job_photos_uploaded_by_drop_not_null.sql).
--
-- Durchsetzung stattdessen zum SCHREIBZEITPUNKT in der Review-RPC
-- (Phase 10), die reviewed_by immer auf auth.uid() setzt. Die
-- Nachvollziehbarkeit "wurde geprüft" bleibt über reviewed_at erhalten und
-- ist über chk_job_assignments_review_pair hart garantiert — reviewed_at
-- ist ein Zeitstempel und wird von keiner FK-Aktion genullt.


-- ---------------------------------------------------------
-- Duplikat-Schutz bei NULL-employee_id (dokumentiert)
-- ---------------------------------------------------------
-- UNIQUE (job_id, employee_id) nutzt bewusst das PostgreSQL-Standard-
-- verhalten NULLS DISTINCT: mehrere Zeilen mit employee_id IS NULL sind je
-- Auftrag erlaubt. Das ist KEIN Duplikat-Leck:
--
--   1. employee_id wird NIEMALS als NULL eingefügt. Der Guard-Trigger
--      enforce_active_assignment (unten) verlangt ein existierendes,
--      aktives Profil mit role='employee' derselben Firma. Ein INSERT mit
--      employee_id = NULL findet dieses Profil nie (NULL vergleicht sich
--      mit nichts) und wird abgewiesen. Es existiert damit KEIN
--      Anwendungs-, RPC- oder Backfill-Pfad, der eine anonyme Zeile
--      erzeugen kann.
--   2. NULL entsteht ausschließlich NACHTRÄGLICH über ON DELETE SET NULL,
--      wenn ein Mitarbeiterprofil gelöscht wird.
--   3. Zwei NULL-Zeilen am selben Auftrag bedeuten deshalb zwangsläufig
--      zwei VERSCHIEDENE, inzwischen gelöschte Mitarbeiter — historisch
--      korrekt und ausdrücklich erwünscht. NULLS NOT DISTINCT (PG 15+)
--      wäre hier FALSCH: es würde die Löschung des zweiten Kontos
--      blockieren, sobald am selben Auftrag bereits eine anonymisierte
--      Zeile existiert — also erneut der job_photos-Fehler von oben.
--   4. Ein echtes Duplikat (derselbe Mitarbeiter zweimal am selben
--      Auftrag) ist unmöglich: solange employee_id gesetzt ist, greift die
--      UNIQUE-Bedingung. Ein Rückweg von NULL auf einen konkreten
--      Mitarbeiter wird von keinem Pfad beschritten und würde vom Guard
--      zusätzlich als Identitätswechsel erneut geprüft.
--   5. Der Namens-Schnappschuss bleibt auch bei NULL erhalten, sodass
--      mehrere anonymisierte Zeilen im Nachweis weiterhin unterscheidbar
--      sind.


-- ---------------------------------------------------------
-- 3. Indizes
-- ---------------------------------------------------------
-- Richtung "welche Mitarbeiter hat Auftrag X?" sowie der spätere
-- RLS-EXISTS (job_id = j.id AND employee_id = auth.uid()) werden bereits
-- vom UNIQUE-Index uq_job_assignments_job_employee bedient.

-- Gegenrichtung "welche Aufträge hat Mitarbeiter Y?" (Stundenzettel,
-- Mitarbeiter-Detail, Zeitplan-Filter).
create index if not exists idx_job_assignments_employee
  on public.job_assignments (employee_id, job_id);

-- Stundenzettel/Reports: nur abrechnungsberechtigte Teilnahmen.
create index if not exists idx_job_assignments_timesheet
  on public.job_assignments (employee_id, job_id)
  where counts_for_timesheet;

-- Review-Queue des Admins: offene Prüfungen (Phase 10).
create index if not exists idx_job_assignments_review_pending
  on public.job_assignments (job_id)
  where attendance = 'assigned' and review is null;

-- FK-Rückwärtsindizes, damit Konto-Löschungen (ON DELETE SET NULL) nicht
-- über einen Seq Scan laufen.
create index if not exists idx_job_assignments_assigned_by
  on public.job_assignments (assigned_by) where assigned_by is not null;

create index if not exists idx_job_assignments_reviewed_by
  on public.job_assignments (reviewed_by) where reviewed_by is not null;


-- ---------------------------------------------------------
-- 4. Zugriff: RLS an, KEINE Policies, Grants entzogen
-- ---------------------------------------------------------
-- Diese Migration ändert bewusst KEINE bestehende RLS-Policy. Die NEUE
-- Tabelle darf aber unter keinen Umständen offen durch PostgREST erreichbar
-- sein — ohne RLS wäre sie firmenübergreifend lesbar. Bis Phase 3 die
-- Policies ergänzt, gilt daher fail-closed (deny-all), exakt nach dem
-- Muster von notification_outbox/notification_deliveries in
-- 20260717000000_admin_status_notifications.sql.
alter table public.job_assignments enable row level security;
revoke all on public.job_assignments from anon, authenticated;


-- ---------------------------------------------------------
-- 5. Backfill aus jobs.assigned_to
-- ---------------------------------------------------------
-- REIHENFOLGE IST BEABSICHTIGT: Der Backfill läuft VOR dem Anlegen des
-- Guard-Triggers. Bestandsdaten dürfen ausdrücklich Zuweisungen an
-- inzwischen DEAKTIVIERTE Mitarbeiter enthalten (genau deshalb existiert
-- die effective_assigned_to-Logik in generate_job_occurrences). Historie
-- ist Tatsache und wird unverändert übernommen; der Guard gilt erst für
-- NEUE Schreibvorgänge.
--
-- Abbildung:
--   status = 'completed'   -> attendance = 'completed'   -> counts = true
--   status = 'in_progress' -> attendance = 'started'     -> counts = true
--   status = 'open'        -> attendance = 'assigned'    -> counts = false
--
-- Damit bleibt die historische Stundenzettel-Berechtigung exakt erhalten:
-- der heutige Stundenzettel liefert ausschließlich Jobs mit
-- status='completed' — und genau diese Zeilen erhalten counts = true.
--
-- assigned_at  := jobs.created_at (bester verfügbarer Zeitpunkt)
-- assigned_by  := jobs.created_by (der anlegende Admin hat zugewiesen)
--
-- Wiederholbar: NOT EXISTS verhindert, dass ein erneuter Lauf überhaupt
-- INSERT-Versuche unternimmt (und damit den dann existierenden Guard
-- auslöst). ON CONFLICT DO NOTHING ist der zusätzliche Gürtel für
-- parallele Ausführung.
insert into public.job_assignments (
  job_id,
  employee_id,
  employee_name_snapshot,
  assigned_at,
  assigned_by,
  attendance,
  employee_started_at,
  employee_completed_at
)
select
  j.id,
  j.assigned_to,
  coalesce(nullif(btrim(p.full_name), ''), 'Unbekannt'),
  j.created_at,
  j.created_by,
  case j.status
    when 'completed'   then 'completed'
    when 'in_progress' then 'started'
    else                    'assigned'
  end::public.attendance_state,
  j.started_at,
  j.completed_at
from public.jobs j
join public.profiles p on p.id = j.assigned_to
where j.assigned_to is not null
  and not exists (
    select 1 from public.job_assignments ja
    where ja.job_id = j.id
      and ja.employee_id = j.assigned_to
  )
on conflict (job_id, employee_id) do nothing;

-- Transparenzbericht: wie viele übernommene Bestandszeilen würden den
-- ab jetzt geltenden Guard NICHT erfüllen (inaktiv / falsche Rolle /
-- andere Firma)? Rein informativ — blockiert nichts, löscht nichts.
do $$
declare
  gesamt        int;
  nicht_konform int;
begin
  select count(*) into gesamt from public.job_assignments;

  select count(*) into nicht_konform
  from public.job_assignments ja
  join public.jobs j     on j.id = ja.job_id
  join public.profiles p on p.id = ja.employee_id
  where p.is_active is not true
     or p.role       <> 'employee'
     or p.company_id is distinct from j.company_id;

  raise notice 'job_assignments Backfill: % Zeile(n) gesamt, davon % nach heutiger Guard-Regel nicht konform (Bestandshistorie, bewusst erhalten).',
    gesamt, nicht_konform;
end $$;


-- ---------------------------------------------------------
-- 6. Guard: Zuweisung nur an aktive Mitarbeiter derselben Firma
-- ---------------------------------------------------------
-- Portierung von public.enforce_active_assignee() (jobs.assigned_to,
-- Migration 20260714000000) auf die Zuweisungstabelle.
--
-- SECURITY DEFINER — begründet wie beim Vorbild: die Prüfung muss
-- fail-closed und unabhängig von der Zeilensichtbarkeit des Aufrufers
-- autoritativ sein. Sie nimmt keine Nutzereingabe außer NEW entgegen,
-- schreibt nichts und ist als Trigger-Funktion nicht über PostgREST
-- aufrufbar. search_path ist fest gesetzt; EXECUTE wird unten entzogen.
--
-- DREI bewusste Nicht-Prüfungen:
--   a) employee_id IS NULL -> sofort durchlassen. Das ist der
--      Anonymisierungspfad (ON DELETE SET NULL) einer Konto-Löschung.
--      Würde der Guard hier greifen, ließen sich Konten nicht mehr
--      löschen — derselbe Fehler wie seinerzeit bei job_photos.
--   b) UPDATE ohne Identitätswechsel -> durchlassen. Anwesenheits- und
--      Review-Änderungen müssen auch dann funktionieren, wenn der
--      Mitarbeiter INZWISCHEN DEAKTIVIERT wurde. Ein Manager muss einen
--      deaktivierten Mitarbeiter nachträglich als anwesend bestätigen
--      oder als abwesend markieren können.
--   c) DELETE -> Trigger läuft gar nicht erst (nur INSERT/UPDATE).
create or replace function public.enforce_active_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  must_check boolean := false;
begin
  -- (a) Anonymisierte Historie niemals blockieren.
  if new.employee_id is null then
    return new;
  end if;

  -- (b) Nur bei INSERT oder echtem Identitätswechsel prüfen.
  if tg_op = 'INSERT' then
    must_check := true;
  else
    must_check :=
      new.employee_id is distinct from old.employee_id
      or new.job_id is distinct from old.job_id;
  end if;

  if not must_check then
    return new;
  end if;

  if not exists (
    select 1
    from public.profiles p
    join public.jobs j on j.id = new.job_id
    where p.id         = new.employee_id
      and p.is_active  = true
      and p.role       = 'employee'
      and p.company_id = j.company_id
  ) then
    raise exception 'Assignee must be an active employee of the same company';
  end if;

  return new;
end;
$$;

comment on function public.enforce_active_assignment() is
'BEFORE INSERT/UPDATE Guard auf job_assignments: Zuweisung nur an ein aktives '
'Profil mit role=employee derselben company_id wie der Auftrag. Prüft bei INSERT '
'und nur bei echtem Wechsel von employee_id/job_id — Anwesenheits- und '
'Review-Änderungen bleiben für inzwischen deaktivierte Mitarbeiter möglich. '
'employee_id IS NULL (Konto-Löschung) wird immer durchgelassen.';

revoke all on function public.enforce_active_assignment() from public;
revoke all on function public.enforce_active_assignment() from anon, authenticated;

drop trigger if exists enforce_active_assignment_on_job_assignments on public.job_assignments;
create trigger enforce_active_assignment_on_job_assignments
  before insert or update on public.job_assignments
  for each row
  execute function public.enforce_active_assignment();


-- ---------------------------------------------------------
-- 7. Touch: jobs.updated_at bei Zuweisungsänderungen anfassen
-- ---------------------------------------------------------
-- Grund (Realtime): public.jobs ist Teil der supabase_realtime-Publication,
-- public.job_assignments NICHT. context/JobContext.tsx abonniert
-- ausschließlich Änderungen an der jobs-Tabelle und lädt daraufhin neu.
-- Ohne dieses Anfassen würde eine reine Zuweisungsänderung KEIN
-- Realtime-Event auslösen — zugewiesene Mitarbeiter erführen erst beim
-- manuellen Pull-to-Refresh davon. Das wäre eine stille Regression eines
-- heute funktionierenden Verhaltens.
--
-- SECURITY DEFINER, weil der schreibende Mitarbeiter (Phase 7: Anwesenheit
-- über RPC) selbst kein UPDATE-Recht auf der jobs-Zeile haben muss.
-- Angefasst wird ausschließlich updated_at des zugehörigen Auftrags.
--
-- Hinweis: der bestehende BEFORE-UPDATE-Trigger trg_jobs_updated_at setzt
-- updated_at ohnehin auf now(). Das explizite Setzen hier ist bewusst
-- redundant und dokumentiert die Absicht.
--
-- Cascade-Fall: wird ein Auftrag gelöscht, verschwinden seine Zuweisungen
-- per ON DELETE CASCADE. Der AFTER-DELETE-Trigger läuft dann gegen eine
-- bereits gelöschte jobs-Zeile — das UPDATE trifft 0 Zeilen und ist ein
-- harmloser No-Op.
create or replace function public.touch_job_on_assignment_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    update public.jobs set updated_at = now() where id = old.job_id;
    return null;
  end if;

  update public.jobs set updated_at = now() where id = new.job_id;

  -- Wechselt eine Zuweisung den Auftrag, müssen BEIDE Seiten neu laden.
  if tg_op = 'UPDATE' and new.job_id is distinct from old.job_id then
    update public.jobs set updated_at = now() where id = old.job_id;
  end if;

  return null;
end;
$$;

comment on function public.touch_job_on_assignment_change() is
'AFTER INSERT/UPDATE/DELETE auf job_assignments: hebt jobs.updated_at des '
'betroffenen Auftrags an. Notwendig, weil nur public.jobs Teil der '
'supabase_realtime-Publication ist — ohne dieses Anfassen löst eine reine '
'Zuweisungsänderung kein Realtime-Event für die Clients aus.';

revoke all on function public.touch_job_on_assignment_change() from public;
revoke all on function public.touch_job_on_assignment_change() from anon, authenticated;

drop trigger if exists touch_job_on_assignment_change_trg on public.job_assignments;
create trigger touch_job_on_assignment_change_trg
  after insert or update or delete on public.job_assignments
  for each row
  execute function public.touch_job_on_assignment_change();


-- =========================================================
-- ABWÄRTSKOMPATIBILITÄT
-- =========================================================
-- public.jobs bleibt in dieser Migration UNVERÄNDERT: keine Spalte
-- hinzugefügt, keine entfernt, assigned_to unangetastet, keine Constraint,
-- kein Index und kein Trigger auf jobs geändert. Bestehende Clients (auch
-- alte App-Versionen im Feld) sehen exakt das bisherige Verhalten; die
-- einzige Auswirkung auf jobs ist ein angehobenes updated_at, sobald
-- Zuweisungen geschrieben werden — was ab Phase 6 der Fall ist.
--
-- ROLLBACK dieser Migration:
--   drop trigger if exists touch_job_on_assignment_change_trg on public.job_assignments;
--   drop trigger if exists enforce_active_assignment_on_job_assignments on public.job_assignments;
--   drop function if exists public.touch_job_on_assignment_change();
--   drop function if exists public.enforce_active_assignment();
--   drop table if exists public.job_assignments;
--   drop type if exists public.attendance_review;
--   drop type if exists public.attendance_state;
-- Gefahrlos, solange keine spätere Phase gelaufen ist: kein Bestandsobjekt
-- hängt an der Tabelle, und jobs.assigned_to bleibt die maßgebliche Quelle.
