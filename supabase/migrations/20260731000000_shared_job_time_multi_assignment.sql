-- =========================================================
-- MIGRATION: Shared Job Time — Start/Abschluss fuer JEDEN Zugewiesenen
-- Datum: 2026-07-31   (Phase 7 von 11 — Aktionspfad)
-- =========================================================
-- ZWECK
--   Seit Phase 5/6 kann ein Auftrag mehrere Mitarbeiter tragen
--   (job_assignments) und alle sehen ihn. Starten und Abschliessen darf
--   aber weiterhin AUSSCHLIESSLICH der Legacy-Primaer jobs.assigned_to —
--   welcher Mitarbeiter das ist, entscheidet compat_primary_assignee() und
--   ist bei gleichzeitig angelegten Zuweisungen ARBITRAER (Tiebreak ueber
--   die Zufalls-UUID, siehe 20260726000000). Praktisch heisst das: von zwei
--   gleichzeitig zugewiesenen Mitarbeitern kann einer den Auftrag nicht
--   starten. Genau das ist im Beta-Test aufgefallen.
--
--   Diese Migration stellt beide RPCs auf die ZUWEISUNGSMENGE um und
--   ergaenzt die Auftragszeile um die AKTEURE der beiden Uebergaenge.
--
-- FACHMODELL: EINE GETEILTE ZEITSCHIENE (bewusst, erste Fassung)
--   Der Auftrag hat GENAU EINE offizielle Dauer:
--       jobs.completed_at - jobs.started_at
--   Wer Start gedrueckt hat, ist fuer die Dauer UNERHEBLICH. Startet Ahmed
--   um 08:00 und schliesst Mohammed um 10:00 ab, erhalten BEIDE
--   08:00–10:00 im Stundenzettel — auch der, der Start nie gedrueckt hat.
--   Die Uhr gehoert dem AUFTRAG, nicht dem Mitarbeiter.
--
--   Es entstehen deshalb ausdruecklich KEINE Pro-Mitarbeiter-Timer, KEINE
--   Arbeitssitzungen und KEINE Anwesenheitserfassung. Das folgt in einer
--   spaeteren Phase.
--
-- =========================================================
-- WARUM DIESE MIGRATION UEBERHAUPT NOETIG IST
-- =========================================================
-- Es gibt keinen rein clientseitigen Weg. Die beiden Statuswechsel laufen
-- zwingend ueber start_own_job/complete_own_job, weil Mitarbeiter per RLS
-- KEIN UPDATE auf public.jobs haben (bewusst so, siehe lib/schema.sql).
-- Beide Funktionen tragen den Vergleich
--     assigned_to = auth.uid()
-- HART IM FUNKTIONSKOERPER. Ein sekundaer Zugewiesener bekommt dort
-- garantiert "Job not found or not allowed" — unabhaengig davon, was die
-- App anzeigt oder sendet.
--
-- GEPRUEFTE ALTERNATIVEN UND WARUM SIE NICHT AUSREICHEN
--
--   (1) Nur die App aendern (Buttons fuer alle Zugewiesenen zeigen).
--       Ergebnis: der Button erscheint und scheitert serverseitig. Genau
--       davor warnen die bestehenden Kommentare in utils/jobAssignees.ts.
--       Loest nichts.
--
--   (2) Mitarbeitern eine UPDATE-Policy auf public.jobs geben.
--       Deutlich groesserer Eingriff und fachlich falsch: eine
--       Spalten-Einschraenkung laesst sich in einer Policy nicht
--       ausdruecken — der Mitarbeiter koennte damit Kunde, Adresse,
--       Terminierung oder started_at ruecksetzen. Die RPC-Loesung haelt
--       genau zwei Uebergaenge erlaubt. Verworfen.
--
--   (3) jobs.assigned_to beim Start auf den Handelnden umbiegen
--       ("wer startet, wird Primaer").
--       Kein Schema-Zuwachs, aber es zerstoert Daten: ein Legacy-Schreiben
--       auf assigned_to bedeutet seit 20260729000000 MENGE ERSETZEN — der
--       Start eines Mitarbeiters wuerde alle uebrigen Zuweisungen des
--       Auftrags entfernen und damit genau die Stundenzettel-Grundlage aus
--       PR #58 loeschen. Verworfen.
--
--   (4) attendance / employee_started_at in job_assignments pflegen
--       (der Weg, den die Roadmap fuer die Anwesenheitsphase vorsieht).
--       Waere ohne neue Spalten moeglich, ist hier aber ausdruecklich NICHT
--       gewollt: das ist Anwesenheitserfassung und damit ausser Scope.
--       Zusaetzlich haette es zwei echte Nebenwirkungen — es veraendert
--       counts_for_timesheet (generierte Spalte) und es entzieht die Zeile
--       der Primaer-Auswahl in compat_primary_assignee() (Bedingung
--       attendance = 'assigned'). Bewusst verworfen; job_assignments wird
--       von dieser Migration NICHT angefasst.
--
-- WARUM ZWEI NEUE SPALTEN (started_by/completed_by)
--   Bisher war der Akteur implizit: es KONNTE nur assigned_to sein. Genau
--   diese Implikation faellt mit dieser Migration weg — ohne die Spalten
--   waere nach dem Start nicht mehr feststellbar, WER gestartet hat. Das
--   ist keine Kuer: die geteilte Zeitschiene schreibt einem Mitarbeiter
--   Arbeitszeit zu, die ein Kollege gestartet hat. Wer die Uhr gestellt
--   hat, muss nachvollziehbar bleiben.
--   notification_outbox traegt den Akteur zwar auch, ist aber eine
--   Versand-Warteschlange (wird abgearbeitet und aufgeraeumt) und damit
--   kein Nachweis.
--   Beide Spalten sind rein additiv, NULLABLE und ON DELETE SET NULL —
--   kein Bestandsleser und keine Konto-Loeschung wird davon beruehrt
--   (siehe Begruendung in Abschnitt 1).
--
-- =========================================================
-- BEWUSST NICHT TEIL DIESER MIGRATION
-- =========================================================
--   * public.job_assignments — keine Spalte, kein Trigger, KEIN Schreiben.
--     attendance, employee_started_at, employee_completed_at, review und
--     counts_for_timesheet bleiben unangetastet.
--   * Der Stundenzettel (services/timesheets/timesheet.service.ts, PR #58)
--     bleibt unveraendert. Er filtert bereits ueber job_assignments und
--     credited damit ALLE Zugewiesenen mit der offiziellen Job-Dauer —
--     also exakt das hier gewuenschte Verhalten. Es gibt nichts anzupassen.
--     Insbesondere wird NICHT auf counts_for_timesheet umgestellt (waere
--     dauerhaft false, siehe (4) oben und PR #58).
--   * Die INSERT-Policies auf job_comments, job_photos, job_comment_reads
--     und storage.objects bleiben an assigned_to gebunden. Kommentieren und
--     Fotos gehoeren nicht zur Job-Uhr; sie zu erweitern waere eine zweite,
--     eigenstaendige Rechteausweitung. Die App gated diese Buttons
--     weiterhin am Legacy-Primaer — die Asymmetrie bleibt damit
--     konsistent zwischen Client und Server.
--   * get_unread_comment_job_ids() bleibt unveraendert (haengt am
--     Schreibpfad job_comment_reads, siehe Abschnitt 5 von 20260730000000).
--   * Keine Aenderung an Benachrichtigungen: beide RPCs schreiben ihre
--     notification_outbox-Zeile wie bisher, mit dem HANDELNDEN als
--     employee_id/employee_name. Vorher war das zwangslaeufig der Primaer,
--     jetzt ist es der tatsaechliche Akteur — der Admin-Push wird dadurch
--     genauer, nicht anders geartet.
--   * Keine Aenderung an Admin-Policies, an generate_job_occurrences/
--     update_job_occurrences oder an den compat_*-Triggern.
--
-- IDEMPOTENZ
--   Vollstaendig wiederholbar: Spalten via ADD COLUMN IF NOT EXISTS,
--   Indizes via CREATE INDEX IF NOT EXISTS, Funktionen via
--   CREATE OR REPLACE (Signatur unveraendert, Grants bleiben erhalten).
--
-- ANWENDUNG
--   Wie alle Schemaaenderungen hier MANUELL im Supabase SQL Editor
--   ausfuehren (siehe CLAUDE.md). Diese Migration wurde NICHT auf der
--   Produktionsdatenbank ausgefuehrt.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Akteure der beiden Uebergaenge
-- ---------------------------------------------------------
-- FK-VERHALTEN — nicht verhandelbar, gelernter Fehler:
--   NULLABLE + ON DELETE SET NULL. In genau diesem Repository hat eine
--   Spalte mit NOT NULL + ON DELETE RESTRICT (job_photos.uploaded_by) in
--   PRODUKTION die Konto-Loeschung blockiert; behoben in
--   20260722000000 / 20260722000001. Derselbe Fehler wird hier nicht
--   wiederholt. Konsistent mit jobs.assigned_to und jobs.created_by, die
--   aus demselben Grund anonymisieren statt zu blockieren.
--
-- KEIN NAMENS-SCHNAPPSCHUSS: nach einer Konto-Loeschung ist der Akteur
-- anonym (NULL) und die Anzeige zeigt nur noch den Zeitpunkt. Der
-- belastbare Abrechnungsnachweis liegt nicht hier, sondern in
-- job_assignments.employee_name_snapshot (Phase 1). Eine zweite
-- Namenskopie waere Redundanz ohne Zugewinn.
--
-- KEINE CHECK-CONSTRAINT gegen started_at (etwa "beide gesetzt oder beide
-- NULL"): CHECKs werden bei JEDEM UPDATE geprueft, auch bei dem UPDATE,
-- das ON DELETE SET NULL selbst ausloest — genau so blockiert man wieder
-- Konto-Loeschungen. Die Kopplung wird stattdessen zum SCHREIBZEITPUNKT in
-- den beiden RPCs erzwungen (dieselbe Begruendung wie bei
-- job_assignments.reviewed_by, Phase 1).
alter table public.jobs
  add column if not exists started_by uuid references public.profiles(id) on delete set null;

alter table public.jobs
  add column if not exists completed_by uuid references public.profiles(id) on delete set null;

comment on column public.jobs.started_by is
'Mitarbeiter, der den Uebergang open -> in_progress ausgeloest hat (Akteur, '
'nicht Eigentuemer). NULL = nie gestartet ODER Konto geloescht. Traegt KEINE '
'Abrechnungsbedeutung: die offizielle Dauer ist completed_at - started_at und '
'gilt fuer ALLE Zugewiesenen, unabhaengig davon, wer gedrueckt hat.';

comment on column public.jobs.completed_by is
'Mitarbeiter, der den Uebergang in_progress -> completed ausgeloest hat. '
'Gleiche Semantik wie started_by — Akteur, keine Abrechnungsbedeutung.';

-- FK-Rueckwaertsindizes, damit eine Konto-Loeschung (ON DELETE SET NULL)
-- nicht ueber einen Seq Scan auf jobs laeuft. Partiell, weil die Spalten
-- fuer die grosse Mehrheit der Zeilen NULL sind (dieselbe Bauform wie
-- idx_job_assignments_assigned_by aus Phase 1).
create index if not exists idx_jobs_started_by
  on public.jobs (started_by) where started_by is not null;

create index if not exists idx_jobs_completed_by
  on public.jobs (completed_by) where completed_by is not null;


-- ---------------------------------------------------------
-- 2. RPC: START OWN JOB — jeder Zugewiesene darf starten
-- ---------------------------------------------------------
-- GEAENDERT wird GENAU DREIERLEI:
--   a) Berechtigung: "assigned_to = auth.uid()"
--      ->  "assigned_to = auth.uid() OR public.is_assigned_to_job(...)"
--   b) started_by wird beim echten Uebergang gesetzt
--   c) completed_by wird zusammen mit completed_at zurueckgesetzt
-- Alles andere (Rolle, Firma, job_type, Statusbedingung, Idempotenz,
-- Outbox-Event, Rueckgabewert, Signatur) bleibt Zeichen fuer Zeichen wie
-- gehabt.
--
-- (a) IST EINE ECHTE OBERMENGE — niemand verliert ein Recht. Der
--     Legacy-Zweig bleibt bewusst stehen: es gibt Bestandszeilen mit
--     assigned_to OHNE passende job_assignments-Zeile (der Phase-1-Backfill
--     hat 6 nicht-konforme Zeilen ausdruecklich erhalten). Ein Ersetzen
--     statt Erweitern haette genau diesen Mitarbeitern den Start entzogen.
--     Der Zweig faellt erst mit der Spalte selbst (Phase 11).
--
-- is_assigned_to_job(uuid) ist der GLEICHE Helfer, den die Lesepolicies aus
-- 20260730000000 nutzen — Lese- und Aktionsrecht koennen damit nicht
-- auseinanderlaufen. Er ist SECURITY DEFINER (keine RLS-Rekursion), STABLE,
-- prueft die Firma selbst und ist fuer authenticated ausfuehrbar (Phase 3);
-- diese Migration vergibt KEIN neues Recht.
--
-- job_type = 'single' BLEIBT EIGENSTAENDIGE BEDINGUNG, ausserhalb der
-- ODER-Klammer. Recurring-PARENT-Regeln tragen seit Phase 4 selbst
-- Zuweisungen (sie sind die Vorlage) und is_assigned_to_job() kennt
-- job_type nicht — liefert dort also true. Innerhalb der Klammer waere eine
-- Parent-Regel damit startbar. Identische Falle wie in Abschnitt (B) von
-- 20260730000000.
--
-- "NIEMAND KANN ZWEIMAL STARTEN" — WIE DAS GARANTIERT IST:
--   Die Bedingung status = 'open' steht im UPDATE selbst. Zwei
--   gleichzeitige Starts konkurrieren um dieselbe Zeilensperre; der
--   Zweite wertet nach dem Commit des Ersten seine WHERE-Klausel gegen die
--   NEUE Zeilenversion erneut aus (EvalPlanQual), findet status =
--   'in_progress' und trifft nichts. Er laeuft dann in den No-Op-Zweig und
--   erhaelt den bereits gesetzten started_at zurueck. started_at,
--   started_by und das Outbox-Event koennen also NIE ueberschrieben oder
--   verdoppelt werden — der Erste gewinnt, ohne dass der Zweite einen
--   Fehler sieht (wichtig fuer Doppel-Tap und Offline-Retry).
create or replace function public.start_own_job(
  job_id_input uuid,
  started_at_input timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_row  public.jobs%rowtype;
  existing_row public.jobs%rowtype;
  emp_name     text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.jobs
  set
    status       = 'in_progress',
    started_at   = started_at_input,
    started_by   = auth.uid(),
    -- Rueckwaerts-Uebergang: completed_at wurde hier immer schon genullt.
    -- completed_by muss zwingend mitgenullt werden, sonst behauptet die
    -- Zeile einen Abschluss-Akteur ohne Abschlusszeitpunkt.
    completed_at = null,
    completed_by = null
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'   -- Parent-Recurring-Regeln duerfen nicht gestartet werden
    and status = 'open'       -- NUR der echte Uebergang open -> in_progress
    and (
      assigned_to = auth.uid()                    -- Legacy-Primaer (Bestand)
      or public.is_assigned_to_job(job_id_input)  -- Zuweisungsmenge (Phase 7)
    )
  returning * into updated_row;

  if found then
    select full_name into emp_name from public.profiles where id = auth.uid();

    insert into public.notification_outbox (
      company_id, job_id, event_type, job_status,
      employee_id, employee_name, customer_name, service_name
    )
    values (
      updated_row.company_id, updated_row.id, 'job_started', 'in_progress',
      auth.uid(), emp_name, updated_row.customer_name, updated_row.service_name
    )
    on conflict (job_id, event_type) do nothing;

    return started_at_input;
  end if;

  -- Kein Uebergang: zugewiesener Job, aber nicht mehr 'open' (idempotenter
  -- No-Op) vs. nicht erlaubt (fremder/nicht gefundener Job) unterscheiden.
  select * into existing_row
  from public.jobs
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    );

  if found then
    -- Der Kollege war schneller (oder Doppel-Tap/Retry): die bereits
    -- gesetzte, GETEILTE Startzeit zurueckgeben — nie die eigene.
    return coalesce(existing_row.started_at, started_at_input);
  end if;

  raise exception 'Job not found or not allowed';
end;
$$;

comment on function public.start_own_job(uuid, timestamptz) is
'Setzt einen Auftrag der eigenen Firma auf in_progress. Berechtigt ist JEDER '
'ueber job_assignments Zugewiesene sowie (Bestand) der Legacy-Primaer '
'jobs.assigned_to; nur role=employee, nur job_type=single. Schreibt '
'started_at/started_by und ein job_started-Outbox-Event genau beim echten '
'Uebergang open -> in_progress; bereits gestartet/abgeschlossen ist ein '
'idempotenter No-Op und gibt die GETEILTE Startzeit zurueck. Fasst '
'job_assignments nicht an (keine Anwesenheitserfassung).';

-- Grants bleiben durch CREATE OR REPLACE erhalten; hier nur, damit die
-- Migration auch auf einer frisch gebauten Datenbank vollstaendig ist.
grant execute on function public.start_own_job(uuid, timestamptz) to authenticated;


-- ---------------------------------------------------------
-- 3. RPC: COMPLETE OWN JOB — jeder Zugewiesene darf abschliessen
-- ---------------------------------------------------------
-- Gleiche Erweiterung wie oben, plus completed_by.
--
-- BEWUSST UNVERAENDERT: das Abschliessen eines noch NICHT gestarteten
-- Auftrags (status = 'open') scheitert weiterhin sichtbar. Fachlich ist das
-- hier sogar wichtiger als vorher — bei einer geteilten Zeitschiene gibt es
-- ohne Start keine Startzeit, und ein stillschweigender Erfolg wuerde einen
-- Auftrag ohne Dauer als abgeschlossen fuehren. Der Mitarbeiter, der Start
-- vergessen hat, drueckt in diesem Fall zuerst Start (die App zeigt genau
-- diesen Button, weil der Auftrag fuer alle noch 'open' ist).
create or replace function public.complete_own_job(
  job_id_input uuid,
  completed_at_input timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_row  public.jobs%rowtype;
  existing_row public.jobs%rowtype;
  emp_name     text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.jobs
  set
    status       = 'completed',
    completed_at = completed_at_input,
    completed_by = auth.uid()
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'      -- Parent-Recurring-Regeln nicht abschliessbar
    and status = 'in_progress'   -- NUR der echte Uebergang in_progress -> completed
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    )
  returning * into updated_row;

  if found then
    select full_name into emp_name from public.profiles where id = auth.uid();

    insert into public.notification_outbox (
      company_id, job_id, event_type, job_status,
      employee_id, employee_name, customer_name, service_name
    )
    values (
      updated_row.company_id, updated_row.id, 'job_completed', 'completed',
      auth.uid(), emp_name, updated_row.customer_name, updated_row.service_name
    )
    on conflict (job_id, event_type) do nothing;

    return completed_at_input;
  end if;

  select * into existing_row
  from public.jobs
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    );

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  -- Bereits abgeschlossen -> idempotenter No-Op (retry-sicher), kein Event.
  -- Deckt auch den Wettlauf zweier Zugewiesener ab: der Zweite erhaelt die
  -- GETEILTE Endzeit des Ersten.
  if existing_row.status = 'completed' then
    return coalesce(existing_row.completed_at, completed_at_input);
  end if;

  -- Zugewiesener Job, aber (noch) nicht in_progress -> nicht als Erfolg
  -- vortaeuschen, sichtbar scheitern.
  raise exception 'Job not in progress (cannot complete)';
end;
$$;

comment on function public.complete_own_job(uuid, timestamptz) is
'Setzt einen laufenden Auftrag der eigenen Firma auf completed. Berechtigt ist '
'JEDER ueber job_assignments Zugewiesene sowie (Bestand) der Legacy-Primaer; '
'nur role=employee, nur job_type=single. Schreibt completed_at/completed_by und '
'ein job_completed-Outbox-Event genau beim echten Uebergang in_progress -> '
'completed; bereits abgeschlossen ist ein idempotenter No-Op. Ein noch nicht '
'gestarteter Auftrag wird abgelehnt (ohne Start gibt es keine Dauer). Fasst '
'job_assignments nicht an (keine Anwesenheitserfassung).';

grant execute on function public.complete_own_job(uuid, timestamptz) to authenticated;


-- =========================================================
-- SICHERHEITSBILANZ
-- =========================================================
-- HINZUGEKOMMEN ist genau ein Recht: ein Mitarbeiter, der ueber
-- job_assignments einem Auftrag SEINER EIGENEN FIRMA zugewiesen ist, darf
-- diesen Auftrag starten und abschliessen. Nicht mehr.
--
-- UNVERAENDERT fail-closed bleiben:
--   * role = 'employee' — Admins aendern den Status nie ueber diese RPCs.
--   * Firmengrenze — doppelt: current_user_company_id() in der RPC UND
--     die Firmenpruefung innerhalb von is_assigned_to_job().
--   * Deaktivierte Konten — current_user_role() und
--     current_user_company_id() liefern fuer is_active = false NULL
--     (20260714000000); die WHERE-Klausel trifft dann nichts, und auch
--     is_assigned_to_job() liefert false. Ein deaktivierter Mitarbeiter
--     kann also nichts starten oder abschliessen, selbst wenn seine
--     Zuweisungszeile noch existiert.
--   * job_type = 'single' — Parent-Recurring-Regeln bleiben nicht
--     ausfuehrbar (eigenstaendiges AND, siehe Abschnitt 2).
--   * Nicht zugewiesene Mitarbeiter derselben Firma: beide Zweige der
--     ODER-Klammer sind falsch -> "Job not found or not allowed". Der
--     Auftrag ist fuer sie ohnehin per RLS unsichtbar.
--   * KEINE neue Policy, KEIN neuer Grant, KEINE neue Funktion, KEIN
--     zusaetzliches UPDATE-Recht auf public.jobs. Der Statuswechsel bleibt
--     ausschliesslich ueber diese zwei Uebergaenge moeglich.
--
-- NEBENWIRKUNG DER NEUEN SPALTEN: Admins haben eine UPDATE-Policy auf
-- public.jobs und koennten started_by/completed_by grundsaetzlich direkt
-- schreiben — genau wie heute schon started_at/completed_at. Die App tut
-- das nicht (updateJob sendet beide Spalten nicht). Admin-seitige
-- Zeitkorrekturen sind ein eigenes Thema einer spaeteren Phase und werden
-- hier nicht eroeffnet.


-- =========================================================
-- ROLLBACK
-- =========================================================
-- 1. Beide Funktionen in ihrer Fassung aus lib/schema.sql (Stand VOR dieser
--    Migration) neu anlegen: den ODER-Zweig entfernen, wieder
--    "and assigned_to = auth.uid()" verwenden und die Zuweisungen von
--    started_by/completed_by aus dem UPDATE loeschen.
-- 2. Optional die Spalten entfernen:
--       drop index if exists public.idx_jobs_completed_by;
--       drop index if exists public.idx_jobs_started_by;
--       alter table public.jobs drop column if exists completed_by;
--       alter table public.jobs drop column if exists started_by;
--    REIHENFOLGE IST PFLICHT: erst Schritt 1, dann Schritt 2 — die
--    zurueckgerollten Funktionen referenzieren die Spalten nicht mehr.
--    Umgekehrt schlaegt jeder Start/Abschluss mit "column does not exist"
--    fehl, weil PL/pgSQL-Koerper nicht abhaengigkeitsverfolgt sind
--    (derselbe Rollback-Fallstrick wie in Phase 2 und 4 dokumentiert).
--
-- Datenverlust: nur die beiden Akteur-Spalten. started_at/completed_at,
-- job_assignments und der Stundenzettel bleiben unberuehrt — nach dem
-- Rollback darf lediglich wieder ausschliesslich der Legacy-Primaer
-- starten und abschliessen.
