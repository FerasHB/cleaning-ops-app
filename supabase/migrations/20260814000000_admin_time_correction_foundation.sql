-- =========================================================
-- MIGRATION: Admin Time Correction — Grundlage (Phase A)
-- Datum: 2026-08-14
-- =========================================================
-- ZWECK
--   Mitarbeiter vergessen in der Praxis, Start oder Abschluss zu druecken.
--   Der Stundenzettel liest seit Phase 2 ausschliesslich
--   job_assignments.employee_started_at/employee_completed_at
--   (services/timesheets/timesheet.service.ts) — fehlt dieses Paar, entsteht
--   fuer den betroffenen Mitarbeiter GAR KEIN Eintrag. Diese Migration gibt
--   Admins den einzigen sicheren Weg, genau dieses Paar nachtraeglich zu
--   korrigieren, samt vollstaendigem Pruefpfad.
--
--   Zwei Objekte:
--     1. public.employee_time_adjustments — append-only Audit-Log
--     2. public.admin_correct_assignment_time(...) — die einzige Schreib-RPC
--
-- DIE GETEILTE JOB-UHR BLEIBT UNANGETASTET
--   jobs.started_at/completed_at werden von dieser Migration NIRGENDS
--   geschrieben. Das ist die zentrale Invariante: die geteilte Uhr ist die
--   EINE offizielle Ausfuehrungszeit des Auftrags und gilt fuer alle
--   Zugewiesenen (Phase 7, 20260731000000). Wuerde eine Korrektur sie
--   anfassen, veraenderte sie die abgerechnete Dauer ALLER Kolleginnen und
--   Kollegen auf demselben Auftrag — bei Alt-Auftraegen (vor Phase 1) sogar
--   unmittelbar sichtbar, weil mapEntry() dort auf genau diese Spalten
--   zurueckfaellt. Korrigiert wird deshalb ausschliesslich die EIGENE
--   Zuweisungszeile des betroffenen Mitarbeiters.
--
-- BEWUSST NICHT TEIL DIESER MIGRATION
--   * KEINE UPDATE-Policy auf job_assignments. Das Sicherheitsmodell aus
--     Phase 3 (20260727000000) bleibt unveraendert: authenticated hat auf
--     job_assignments ausschliesslich SELECT; jeder Schreibvorgang laeuft
--     ueber SECURITY-DEFINER-RPCs. Diese Migration fuegt exakt eine solche
--     RPC hinzu — sie erweitert die Rechte des Clients um NICHTS.
--   * KEINE Aenderung an start_own_job/complete_own_job, an deren
--     Autorisierung, Statusbedingungen oder Rueckgabewerten.
--   * KEINE Aenderung am Stundenzettel-Lesepfad. Die RPC schreibt exakt die
--     Spalten, die timesheet.service.ts ohnehin liest — der Client braucht
--     dafuer keine Zeile Code.
--   * KEINE UI. Phase A ist reine Datenschicht.
--   * Keine Aenderung an jobs, an dessen Policies oder an der
--     Phase-2-Kompatibilitaetsschicht.
--
-- IDEMPOTENZ
--   Tabelle via IF NOT EXISTS, Constraints/Policies via DROP + CREATE,
--   Funktion via CREATE OR REPLACE — vollstaendig wiederholbar.
--
-- ANWENDUNG
--   Wie alle Schemaaenderungen hier MANUELL im Supabase SQL Editor
--   ausfuehren (siehe CLAUDE.md). Diese Migration wurde NICHT auf der
--   Produktionsdatenbank ausgefuehrt.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Audit-Tabelle
-- ---------------------------------------------------------
-- APPEND-ONLY, exakt nach dem Muster von job_comments/job_photos: es gibt
-- weder UPDATE- noch DELETE-Policy und weder UPDATE- noch DELETE-Grant.
-- Eine Korrektur ist ein Ereignis, kein veraenderlicher Zustand.
--
-- ON-DELETE-Strategie je Spalte (die Unterschiede sind Absicht):
--   * job_id / assignment_id -> CASCADE. Wird der Auftrag geloescht,
--     verschwinden seine Zuweisungen ohnehin (Phase 1) und mit ihnen die
--     Stundenzettel-Eintraege — ein Korrektur-Nachweis fuer eine nicht mehr
--     existierende Abrechnungszeile waere gegenstandslos. Gleiches Verhalten
--     wie job_comments/job_photos.
--   * employee_id / changed_by -> SET NULL. Ein Konto muss loeschbar
--     bleiben, OHNE dass der Nachweis verschwindet. Genau hier lag der
--     Produktionsfehler von job_photos.uploaded_by (RESTRICT + NOT NULL
--     blockierte die Kontoloeschung, behoben in 20260722000000/
--     20260722000001) — dieser Fehler wird hier nicht wiederholt.
create table if not exists public.employee_time_adjustments (
  id uuid primary key default gen_random_uuid(),

  assignment_id uuid not null references public.job_assignments(id) on delete cascade,
  job_id        uuid not null references public.jobs(id)            on delete cascade,
  -- NULL = das Mitarbeiterkonto wurde nach der Korrektur geloescht.
  employee_id   uuid          references public.profiles(id)        on delete set null,

  -- Zustand VOR der Korrektur (beide duerfen NULL sein — genau das ist ja
  -- der haeufigste Anlass: der Mitarbeiter hat nie gedrueckt).
  old_started_at   timestamptz,
  old_completed_at timestamptz,

  -- Zustand NACH der Korrektur.
  new_started_at   timestamptz,
  new_completed_at timestamptz,

  -- Der korrigierende Admin. NULL = Konto inzwischen geloescht.
  changed_by uuid references public.profiles(id) on delete set null,

  -- PFLICHT. Eine abrechnungsrelevante Aenderung ohne Begruendung ist genau
  -- die Luecke, die eine Pruefung beanstanden wuerde.
  reason text not null,

  created_at timestamptz not null default now(),

  -- Begruendung darf nicht leer/nur Leerzeichen sein — gleiche Bauform wie
  -- chk_job_assignments_name_snapshot (Phase 1).
  constraint chk_employee_time_adjustments_reason
    check (length(btrim(reason)) > 0),

  -- Ende nach Beginn, sofern BEIDE gesetzt sind. Eine Korrektur, die nur
  -- den Beginn setzt, bleibt zulaessig (siehe RPC).
  constraint chk_employee_time_adjustments_new_order
    check (
      new_started_at is null
      or new_completed_at is null
      or new_completed_at > new_started_at
    )
);

comment on table public.employee_time_adjustments is
'Append-only Pruefpfad fuer manuelle Korrekturen der Mitarbeiter-Arbeitszeit '
'(job_assignments.employee_started_at/employee_completed_at). Eine Zeile je '
'Korrektur-Ereignis mit Alt- und Neuwerten, Admin, Begruendung und Zeitpunkt. '
'Wird ausschliesslich von admin_correct_assignment_time() geschrieben; es '
'gibt weder UPDATE- noch DELETE-Policy. Traegt selbst KEINE Abrechnungs'
'bedeutung — die abgerechnete Zeit steht immer in job_assignments.';

comment on column public.employee_time_adjustments.old_started_at is
'employee_started_at VOR der Korrektur. NULL ist der Regelfall: der '
'Mitarbeiter hat den Start nie selbst ausgeloest.';

comment on column public.employee_time_adjustments.changed_by is
'Korrigierender Admin. NULL = Konto inzwischen geloescht (ON DELETE SET '
'NULL) — der Nachweis selbst bleibt erhalten.';

comment on column public.employee_time_adjustments.reason is
'PFLICHTFELD. Freitext-Begruendung der Korrektur (abrechnungsrelevant).';


-- ---------------------------------------------------------
-- 2. Indizes
-- ---------------------------------------------------------
-- Korrektur-Historie eines Auftrags bzw. einer Zuweisung (die einzigen
-- beiden Leserichtungen, die Phase B braucht).
create index if not exists idx_employee_time_adjustments_job
  on public.employee_time_adjustments (job_id, created_at desc);

create index if not exists idx_employee_time_adjustments_assignment
  on public.employee_time_adjustments (assignment_id, created_at desc);

-- FK-Rueckwaertsindizes, damit eine Kontoloeschung (ON DELETE SET NULL)
-- nicht ueber einen Seq Scan laeuft. Partiell, exakt die Bauform von
-- idx_job_assignments_assigned_by / idx_jobs_started_by.
create index if not exists idx_employee_time_adjustments_employee
  on public.employee_time_adjustments (employee_id) where employee_id is not null;

create index if not exists idx_employee_time_adjustments_changed_by
  on public.employee_time_adjustments (changed_by) where changed_by is not null;


-- ---------------------------------------------------------
-- 3. Zugriff: RLS an, NUR SELECT fuer Admins der eigenen Firma
-- ---------------------------------------------------------
-- Wie bei job_assignments (Phase 3): INSERT/UPDATE/DELETE bleiben OHNE
-- Grant UND OHNE Policy — doppelt verriegelt. Geschrieben wird
-- ausschliesslich durch die SECURITY-DEFINER-RPC unten.
--
-- Mitarbeiter sehen ihre eigenen Korrekturen BEWUSST NICHT: ob und warum
-- ein Admin eine Zeit korrigiert hat, ist eine Personal-/Abrechnungs-
-- angelegenheit (das Feld `reason` kann interne Bewertungen enthalten). Die
-- korrigierte ZEIT selbst sieht der Mitarbeiter ohnehin sofort in seinem
-- eigenen Stundenzettel — nur der Kommentar des Admins bleibt intern.
alter table public.employee_time_adjustments enable row level security;

-- REIHENFOLGE IST SICHERHEITSRELEVANT: Supabase vergibt ueber
-- ALTER DEFAULT PRIVILEGES auf neue Tabellen im public-Schema automatisch
-- ALLE Rechte an anon und authenticated. Ein blosses "grant select" wuerde
-- die bereits vorhandenen INSERT/UPDATE/DELETE-Rechte NICHT entfernen — die
-- Tabelle waere trotz fehlender Schreib-Policy direkt beschreibbar, sobald
-- irgendeine Policy fuer die Rolle zutrifft. Erst vollstaendig entziehen,
-- dann gezielt SELECT vergeben (genau die Reihenfolge, die Phase 1/3 fuer
-- job_assignments ueber zwei Migrationen hinweg herstellt).
revoke all on public.employee_time_adjustments from anon, authenticated;
grant select on public.employee_time_adjustments to authenticated;

-- Firmen-Scoping ueber den bestehenden Helfer aus Phase 3 — KEIN neuer
-- Helfer, keine company_id-Spalte noetig.
drop policy if exists "admin read time adjustments in own company" on public.employee_time_adjustments;
create policy "admin read time adjustments in own company"
on public.employee_time_adjustments
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and public.job_in_current_company(job_id)
);

-- KEINE INSERT-, UPDATE- oder DELETE-Policy. Beabsichtigt.


-- ---------------------------------------------------------
-- 4. RPC: admin_correct_assignment_time
-- ---------------------------------------------------------
-- SECURITY DEFINER — zwingend: authenticated hat auf job_assignments
-- absichtlich KEIN Schreibrecht (Phase 3) und auf
-- employee_time_adjustments ebenfalls nicht. Die Funktion prueft
-- Authentifizierung, Rolle und Firmenzugehoerigkeit selbst und ist
-- fail-closed.
--
-- SPERRREIHENFOLGE: AUFTRAG ZUERST, DANN ZUWEISUNG.
--   Bewusst NICHT umgekehrt. Zwei bestehende Schreibpfade halten dieselbe
--   Reihenfolge:
--     * set_job_assignments() sperrt die jobs-Zeile (FOR UPDATE) und
--       schreibt DANACH job_assignments (20260727000000).
--     * update_job_occurrences() sperrt die Parent-Regel und arbeitet
--       danach auf den Terminen (20260728000000, dort ausdruecklich als
--       "Sperrreihenfolge Parent -> Termin" dokumentiert).
--   Zusaetzlich zwingend: der AFTER-Trigger
--   touch_job_on_assignment_change_trg (Phase 1) fordert NACH jedem
--   job_assignments-UPDATE selbst eine Sperre auf der jobs-Zeile an. Wuerde
--   diese RPC zuerst die Zuweisung sperren, entstuende exakt die
--   umgekehrte Reihenfolge zu set_job_assignments — und damit ein echtes
--   Deadlock-Fenster zwischen einem Admin, der zuweist, und einem Admin,
--   der korrigiert.
--
-- REALTIME (Anforderung "jobs.updated_at anfassen"): bereits erfuellt, ohne
--   dass diese RPC etwas dafuer tun muss. job_assignments ist NICHT Teil der
--   supabase_realtime-Publication, public.jobs schon; genau dafuer existiert
--   touch_job_on_assignment_change_trg seit Phase 1, und er feuert auch bei
--   UPDATE. Ein zusaetzliches explizites "update jobs set updated_at" waere
--   ein redundanter Schreibvorgang und ein zweites Realtime-Event fuer
--   dieselbe Aenderung. Der Test weist nach, dass updated_at steigt.
--
-- WARUM NUR ABGESCHLOSSENE AUFTRAEGE KORRIGIERBAR SIND:
--   Der Stundenzettel filtert serverseitig auf
--   j.status='completed' AND j.started_at IS NOT NULL AND
--   j.completed_at IS NOT NULL (timesheet.service.ts). Eine Korrektur an
--   einem Auftrag, der diese Bedingungen nicht erfuellt, wuerde die
--   Zuweisungszeile zwar veraendern, im Stundenzettel aber WIRKUNGSLOS
--   bleiben — eine stille Nulloperation auf einer Abrechnungskorrektur.
--   Sie wird deshalb hart abgelehnt statt scheinbar zu gelingen.
--
-- WARUM ALT-AUFTRAEGE (VOR PHASE 1) ABGELEHNT WERDEN:
--   Fuer sie liest der Stundenzettel ueber isLegacyJob() die GETEILTE
--   Job-Uhr. Wuerde man dort employee_started_at/completed_at setzen,
--   kippte mapEntry() diese Zeile schlagartig in den Eigenzeit-Zweig
--   (hasOwnTimes) — die Berechnungsgrundlage eines abgeschlossenen,
--   moeglicherweise bereits abgerechneten Zeitraums aendert sich damit
--   still. Der Grenzwert ist derselbe wie im Client (PHASE1_CUTOFF_ISO).
create or replace function public.admin_correct_assignment_time(
  assignment_id_input uuid,
  new_started_at      timestamptz,
  new_completed_at    timestamptz,
  reason_input        text
)
returns setof public.job_assignments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id        uuid;
  v_assignment    public.job_assignments%rowtype;
  v_job           public.jobs%rowtype;
  v_reason        text;
  v_attendance    public.attendance_state;
  -- Entspricht PHASE1_CUTOFF_ISO in services/timesheets/timesheet.service.ts
  -- (Migration 20260812000000, "Phase 1 Worked Time"). Bewusst dieselbe
  -- Konstante: Client und Server duerfen bei der Frage "gilt hier noch der
  -- Legacy-Fallback?" nicht auseinanderlaufen.
  c_phase1_cutoff constant timestamptz := timestamptz '2026-08-12 00:00:00+00';
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- IS DISTINCT FROM statt <>: current_user_role() liefert fuer ein
  -- inaktives/fehlendes Profil NULL, und "NULL <> 'admin'" ist NULL — der
  -- Guard wuerde fuer einen deaktivierten Admin still uebersprungen.
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can correct employee work times'
      using errcode = '42501';
  end if;

  -- ── Eingabevalidierung VOR jedem Schreibvorgang ──────────────────
  v_reason := btrim(coalesce(reason_input, ''));
  if v_reason = '' then
    raise exception 'A reason is required for a time correction'
      using errcode = '23514';
  end if;

  -- Beide NULL waere keine Korrektur, sondern ein Loeschen der erfassten
  -- Zeit — dafuer gibt es weder einen definierten attendance-Zustand noch
  -- einen fachlichen Anlass (eine faelschlich zugewiesene Person wird aus
  -- der Zuweisungsmenge entfernt, nicht auf NULL korrigiert).
  if new_started_at is null and new_completed_at is null then
    raise exception 'At least one of new_started_at / new_completed_at must be set'
      using errcode = '23514';
  end if;

  if new_started_at is not null
     and new_completed_at is not null
     and new_completed_at <= new_started_at then
    raise exception 'new_completed_at must be after new_started_at'
      using errcode = '23514';
  end if;

  -- ── Auftrag ermitteln (noch ohne Sperre) ─────────────────────────
  select ja.job_id into v_job_id
  from public.job_assignments ja
  where ja.id = assignment_id_input;

  if v_job_id is null then
    raise exception 'Assignment not found or not accessible'
      using errcode = '42501';
  end if;

  -- ── 1) AUFTRAG SPERREN (inkl. Firmenpruefung) ────────────────────
  -- Firmenfremde Auftraege sind hier bereits nicht auffindbar; die
  -- Fehlermeldung ist absichtlich identisch mit "nicht gefunden" und
  -- verraet damit nicht, ob eine fremde Zuweisung existiert.
  select * into v_job
  from public.jobs
  where id         = v_job_id
    and company_id = public.current_user_company_id()
  for update;

  if not found then
    raise exception 'Assignment not found or not accessible'
      using errcode = '42501';
  end if;

  -- ── 2) ZUWEISUNG SPERREN ─────────────────────────────────────────
  select * into v_assignment
  from public.job_assignments
  where id = assignment_id_input
  for update;

  if not found then
    raise exception 'Assignment not found or not accessible'
      using errcode = '42501';
  end if;

  -- Die Zuweisung muss nach dem Sperren immer noch an DIESEM Auftrag
  -- haengen (Schutz gegen ein Verschieben zwischen den beiden Sperren).
  if v_assignment.job_id is distinct from v_job.id then
    raise exception 'Assignment not found or not accessible'
      using errcode = '42501';
  end if;

  -- ── Fachliche Vorbedingungen am Auftrag ──────────────────────────
  if v_job.status is distinct from 'completed'
     or v_job.started_at is null
     or v_job.completed_at is null then
    raise exception
      'Only completed jobs can be corrected (job must have a shared start and completion)'
      using errcode = '22023';
  end if;

  if v_job.completed_at < c_phase1_cutoff then
    raise exception
      'Jobs completed before the worked-time cutoff (2026-08-12) cannot be corrected'
      using errcode = '22023';
  end if;

  -- ── 3) Neuer attendance-Zustand ──────────────────────────────────
  -- KEIN neuer Enum-Wert: die Herkunft der Zeit ("vom Admin korrigiert")
  -- steht im Pruefpfad, nicht im Zustand. Wichtig ist, dass attendance
  -- ueberhaupt mitgezogen wird: counts_for_timesheet ist eine GENERIERTE
  -- Spalte auf attendance/review (Phase 1) und bliebe bei 'assigned'
  -- dauerhaft false — eine korrigierte Zeile waere damit fuer jede kuenftige
  -- Abrechnungs-Berechtigung unsichtbar.
  v_attendance := case
    when new_started_at is not null and new_completed_at is not null then 'completed'
    when new_completed_at is not null                                then 'completed'
    else                                                                  'started'
  end::public.attendance_state;

  -- ── 4) NUR die eigene Zuweisungszeile aktualisieren ───────────────
  -- Ueberschreibt bewusst (kein COALESCE): eine Korrektur MUSS einen
  -- bestehenden, falschen Wert ersetzen koennen — anders als
  -- start_own_job/complete_own_job, wo "der Erste gewinnt" gilt.
  -- jobs.started_at/completed_at werden hier NICHT angefasst.
  update public.job_assignments
  set
    employee_started_at   = new_started_at,
    employee_completed_at = new_completed_at,
    attendance            = v_attendance
  where id = assignment_id_input;

  -- ── 5) Pruefpfad in DERSELBEN Transaktion ────────────────────────
  insert into public.employee_time_adjustments (
    assignment_id, job_id, employee_id,
    old_started_at, old_completed_at,
    new_started_at, new_completed_at,
    changed_by, reason
  )
  values (
    v_assignment.id, v_job.id, v_assignment.employee_id,
    v_assignment.employee_started_at, v_assignment.employee_completed_at,
    new_started_at, new_completed_at,
    auth.uid(), v_reason
  );

  -- ── 6) Ergebnis ──────────────────────────────────────────────────
  -- jobs.updated_at wurde durch touch_job_on_assignment_change_trg bereits
  -- angehoben (siehe Kopf) — kein zusaetzlicher Schreibvorgang noetig.
  return query
  select ja.*
  from public.job_assignments ja
  where ja.id = assignment_id_input;
end;
$$;

comment on function public.admin_correct_assignment_time(uuid, timestamptz, timestamptz, text) is
'Korrigiert die Arbeitszeit EINER Zuweisung (nur Admin, nur eigene Firma). '
'Schreibt ausschliesslich job_assignments.employee_started_at/'
'employee_completed_at/attendance der uebergebenen Zeile und legt in '
'derselben Transaktion einen Pruefpfad-Eintrag in employee_time_adjustments '
'an. Faesst jobs.started_at/completed_at NIEMALS an — die geteilte Job-Uhr '
'und damit die Zeiten aller uebrigen Zugewiesenen bleiben unveraendert. '
'Verlangt einen nicht-leeren Grund, mindestens einen der beiden neuen '
'Zeitstempel und (falls beide gesetzt) Ende nach Beginn. Nur abgeschlossene '
'Auftraege mit vollstaendiger geteilter Uhr sind korrigierbar; Auftraege, die '
'vor dem Worked-Time-Grenzwert 2026-08-12 abgeschlossen wurden, werden '
'abgelehnt (dort gilt weiterhin der Legacy-Fallback des Stundenzettels). '
'Sperrreihenfolge Auftrag -> Zuweisung, identisch zu set_job_assignments.';

-- Nur eingeloggte Nutzer duerfen die RPC ueberhaupt aufrufen; die
-- Admin-Pruefung passiert intern. anon und PUBLIC bleiben ausgeschlossen.
revoke all on function public.admin_correct_assignment_time(uuid, timestamptz, timestamptz, text) from public;
revoke all on function public.admin_correct_assignment_time(uuid, timestamptz, timestamptz, text) from anon;
grant execute on function public.admin_correct_assignment_time(uuid, timestamptz, timestamptz, text) to authenticated;


-- =========================================================
-- ABWAERTSKOMPATIBILITAET
-- =========================================================
-- Rein additiv. Keine bestehende Tabelle, Spalte, Policy, Funktion oder
-- Trigger wurde veraendert. start_own_job/complete_own_job sind Zeichen
-- fuer Zeichen unveraendert; der Stundenzettel liest dieselben Spalten wie
-- zuvor und braucht keine Anpassung. Alte Clients im Feld sehen exakt das
-- bisherige Verhalten — sie rufen die neue RPC schlicht nie auf.
--
-- ROLLBACK:
--   drop function if exists public.admin_correct_assignment_time(uuid, timestamptz, timestamptz, text);
--   drop policy if exists "admin read time adjustments in own company" on public.employee_time_adjustments;
--   drop table if exists public.employee_time_adjustments;
-- Gefahrlos: kein Bestandsobjekt haengt an der Tabelle oder der Funktion.
-- Bereits vorgenommene Korrekturen bleiben als Werte in job_assignments
-- erhalten (nur der Pruefpfad ginge verloren).
-- =========================================================
