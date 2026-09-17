-- =========================================================
-- MIGRATION: Phase 16 — Post-Deploy Hardening
-- Datum: 2026-09-18
-- =========================================================
-- ZWECK
--   Schliesst drei Befunde aus der Astra-Architektur-Review (Audit vom
--   2026-09-18) an bereits deployten bzw. deploy-bereiten Phase-16-Objekten.
--   Alle drei Funktionen werden per CREATE OR REPLACE gepatcht (Signaturen
--   unveraendert -> bestehende GRANTs bleiben erhalten, siehe die WICHTIG-
--   Warnung zu DROP FUNCTION in 20260916120000). Diese Migration ersetzt
--   NICHT die Inhalte von 20260917000000/20260917000001 — sie kommt danach
--   und patcht die von dort bereits live stehenden Funktionen.
--
--   BEFUND 1 (Legacy-Zeitstempel-Durchsickern): compat_sync_assignments_
--     from_legacy() — Basis 20260726000000, MENGE-ERSETZEN-Semantik seit
--     20260729000000_legacy_write_replaces_assignment_set (das ist die
--     tatsaechlich aktuell live stehende Fassung, seither unveraendert bis
--     Phase 16) — leitete employee_started_at/employee_completed_at aus dem
--     GETEILTEN Job-Status ab, sobald ein direkter Schreibvorgang auf
--     jobs.assigned_to eine NEUE job_assignments-Zeile anlegte. Verifiziert
--     gegen den echten Stundenzettel-Lesepfad (services/timesheets/
--     timesheet.service.ts, mapEntry Regel 1): ein vollstaendiges eigenes
--     Zeitpaar wird DORT UNABHAENGIG vom Phase-1-Cutoff (PHASE1_CUTOFF_ISO,
--     utils/jobCorrection.ts) als eigene Arbeitszeit gebucht. Ein direkter
--     assigned_to-Schreibvorgang auf einen bereits abgeschlossenen Auftrag
--     haette damit unbemerkt eine volle, ungeprüfte Stundenzettel-Zeile fuer
--     einen Mitarbeiter erzeugen koennen, der nie selbst start_own_job/
--     complete_own_job aufgerufen hat. Das verletzt den in 20260917000000
--     selbst festgeschriebenen Leitsatz ("Keine Funktion hier leitet
--     Arbeitszeit aus der Auftragsuhr ab oder umgekehrt"). Fix unten:
--     die Kompatibilitaetszeile wird weiterhin angelegt (alte Client-
--     Versionen, die nur assigned_to kennen, bleiben unterstuetzt), aber
--     NIE MEHR mit aus dem Job-Status abgeleiteten Werten — weder
--     Zeitstempel noch attendance. Die MENGE-ERSETZEN-Logik (erweitertes
--     DELETE + Anonymisierungs-Ausnahme aus 20260729000000) bleibt
--     UNVERAENDERT — nur die INSERT-Werte der neu gespiegelten Zeile
--     aendern sich.
--
--   BEFUND 2 (start_own_job Terminal-Guard): der Nachzuegler-Zweig prüfte
--     `status <> 'open'`, was `completed` mit einschloss. Ein Start-Aufruf,
--     der (z. B. ueber die Offline-Queue oder eine Wettlaufsituation mit
--     Force Complete) erst nach dem Abschluss des Auftrags beim Server
--     ankommt, wurde bisher wie ein regulaerer Nachzuegler behandelt: OK,
--     eigene employee_started_at gestempelt, attendance auf 'started'
--     gehoben. Fix unten: expliziter Drei-Wege-Zweig (open / in_progress /
--     alles andere), `completed` wird jetzt hart abgelehnt, KEINE Mutation.
--
--   BEFUND 3 (admin_force_complete_job ohne Server-Gate): die Funktion
--     pruefte nie app_config.force_complete_enabled selbst — der Schalter
--     war rein clientseitig (JobDetailScreen.tsx). Heute ungefaehrlich,
--     weil die RPC auf Production noch nicht existiert; sobald Phase 16
--     backend-seitig live geht, koennte jeder Admin per direktem RPC-Aufruf
--     (REST/Postman) zwangsabschliessen, unabhaengig vom Schalterstand. Fix
--     unten: serverseitige Pruefung nach demselben Muster wie
--     enforce_min_client_version() (app_config-gestuetzt), VOR jeder
--     Mutation.
--
-- OBJEKTE (alle CREATE OR REPLACE, keine Signaturaenderung)
--   1. public.compat_sync_assignments_from_legacy()  (20260726000000,
--      MENGE-ERSETZEN seit 20260729000000)
--   2. public.start_own_job(uuid, timestamptz)        (20260917000000)
--   3. public.admin_force_complete_job(uuid, text)     (20260917000000)
--
-- NICHT TEIL DIESER MIGRATION
--   Keine Aenderung an RLS, an der Trigger-Definition selbst (nur der
--   Funktionskoerper), an compat_primary_assignee()/Richtung B (job_
--   assignments -> jobs.assigned_to), an set_job_assignments() oder an
--   app_config-Werten. enforcement_enabled/force_complete_enabled bleiben
--   nach dieser Migration unveraendert false — sie schaltet keine neue
--   Business-Logik frei, sie haertet nur bestehende Pfade ab.
-- =========================================================


-- =========================================================
-- 1. BEFUND 1 — compat_sync_assignments_from_legacy: keine abgeleiteten
--    Zeitstempel/Anwesenheit mehr aus dem Job-Status
-- =========================================================
-- Vollstaendiger Funktionskoerper aus 20260729000000 (der tatsaechlich
-- aktuellen Fassung — 20260726000000s DELETE war auf alleine
-- old.assigned_to eingeschraenkt, 20260729000000 hat das auf "ganze Menge
-- ersetzen" erweitert und ist seither unveraendert). Einzige inhaltliche
-- Aenderung steht im INSERT unten; DELETE/Anonymisierungs-Ausnahme/
-- Schleifenschutz bleiben BYTE-IDENTISCH zu 20260729000000.
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
      -- authentifizierte Aufrufer, sonst der Ersteller des Auftrags.
      select p.id into v_actor
      from public.profiles p
      where p.id = coalesce(auth.uid(), new.created_by);

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

comment on function public.compat_sync_assignments_from_legacy() is
'TEMPORAER (Phase 2-11). Spiegelt Schreibvorgaenge alter Clients auf '
'jobs.assigned_to in public.job_assignments. Ein Legacy-Schreibvorgang '
'bedeutet MENGE ERSETZEN (seit 20260729000000): alle spurenfreien '
'Zuweisungen ausser dem neuen Wert werden entfernt. Nachweise (Anwesenheit, '
'Review, Zeitstempel) und anonymisierte Zeilen bleiben unangetastet. '
'Feuert nur bei echter Aenderung von assigned_to. PATCH 20260918 '
'(Astra-Audit Befund 1): legt neue Zeilen IMMER mit attendance=''assigned'' '
'und employee_started_at/employee_completed_at=NULL an — leitet diese '
'Werte NICHT MEHR aus dem Job-Status/der geteilten Job-Uhr ab. Grund: der '
'Stundenzettel liest employee_started_at/employee_completed_at als '
'Nachweis eigener Arbeitszeit unabhängig vom Phase-1-Cutoff (siehe '
'services/timesheets/timesheet.service.ts); ein direkter '
'assigned_to-Schreibvorgang auf einen laufenden/abgeschlossenen Auftrag '
'darf so einem Mitarbeiter niemals stillschweigend Arbeitszeit '
'gutschreiben, die er nie selbst über start_own_job/complete_own_job '
'erzeugt hat.';

revoke all on function public.compat_sync_assignments_from_legacy() from public;
revoke all on function public.compat_sync_assignments_from_legacy() from anon, authenticated;


-- =========================================================
-- 2. BEFUND 2 — start_own_job: expliziter Drei-Wege-Statuszweig
-- =========================================================
-- Vollstaendiger Funktionskoerper aus 20260917000000/20260917000001 (beide
-- byte-identisch in dieser Funktion), unveraendert bis auf den
-- Nachzuegler-Zweig (Abschnitt "(c)" unten): statt der generischen
-- `status <> 'open'`-Bedingung jetzt ein expliziter open/in_progress/sonst-
-- Zweig. `completed` (und jeder andere, heute nicht existierende Status)
-- wird abgelehnt, BEVOR irgendeine Zeile geschrieben wird.
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
  v_job      public.jobs%rowtype;
  v_tz       text;
  v_local    timestamp;
  v_bdate    date;
  v_allowed  boolean;
  v_emp_name text;
begin
  -- Kompatibilitäts-Fundament (20260916120000): dieselbe Wächter-Klausel,
  -- unverändert fortgeführt, damit diese Migration die serverseitige
  -- Mindestversions-Durchsetzung nicht versehentlich entfernt.
  perform public.enforce_min_client_version();

  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- ── (a) Zeitstempel-Vertrauensfenster ────────────────────────────
  if started_at_input > now() + interval '5 minutes' then
    raise exception
      'Die Uhrzeit deines Geräts liegt in der Zukunft. Bitte prüfe die Zeiteinstellung.'
      using errcode = '22023';
  end if;

  if started_at_input < now() - interval '12 hours' then
    raise exception
      'Diese Aktion ist älter als 12 Stunden und kann nicht mehr übertragen werden. Bitte wende dich an deinen Administrator.'
      using errcode = '22023';
  end if;

  -- ── Auftrag sperren und Berechtigung pruefen ─────────────────────
  select * into v_job
  from public.jobs
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    )
  for update;

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  -- ── (b) Terminpruefung in der Zeitzone der Firma ─────────────────
  select coalesce(nullif(btrim(c.timezone), ''), 'Europe/Berlin')
    into v_tz
  from public.companies c
  where c.id = v_job.company_id;

  v_tz    := coalesce(v_tz, 'Europe/Berlin');
  v_local := started_at_input at time zone v_tz;
  v_bdate := v_local::date;

  -- Regel bewusst ausgelagert (siehe job_start_date_allowed): eine Definition,
  -- deterministisch testbar.
  v_allowed := public.job_start_date_allowed(v_job.date, v_job.start_time, v_local);

  if not v_allowed then
    if v_job.date is null then
      raise exception
        'Für diesen Auftrag ist kein Termin hinterlegt. Bitte wende dich an deinen Administrator.'
        using errcode = '22023';
    elsif v_job.date > v_bdate then
      raise exception
        'Dieser Einsatz ist für den % geplant und kann noch nicht gestartet werden.',
        to_char(v_job.date, 'DD.MM.YYYY')
        using errcode = '22023';
    else
      raise exception
        'Dieser Einsatz war für den % geplant und kann nicht mehr gestartet werden.',
        to_char(v_job.date, 'DD.MM.YYYY')
        using errcode = '22023';
    end if;
  end if;

  -- ── (c) PATCH 20260918 (Astra-Audit Befund 2): expliziter Drei-Wege-
  -- Zweig statt `status <> 'open'`. Vorher fiel `completed` mit unter den
  -- Nachzuegler-Zweig fuer `in_progress` — ein Start-Aufruf, der (Offline-
  -- Queue, Wettlauf mit Force Complete oder einer regulaeren Fremd-
  -- Fertigstellung) erst NACH dem Abschluss beim Server ankam, wurde
  -- klaglos als spaeter Beitritt behandelt: eigene employee_started_at
  -- gestempelt, attendance auf 'started' gehoben, kein Fehler. Das ist ein
  -- dauerhafter Geschaeftszustands-Konflikt, kein Nachzuegler-Fall, und
  -- muss abgelehnt werden, OHNE irgendeine Zeile zu schreiben.
  if v_job.status = 'in_progress' then
    -- Unveraendert: idempotenter Nachzuegler-Zweig. Stempelt die EIGENE
    -- Startzeit (COALESCE: der erste Wert gewinnt, ein Doppel-Tap
    -- verschiebt nichts) und hebt attendance genau einmal von 'assigned'
    -- auf 'started'.
    update public.job_assignments
    set employee_started_at = coalesce(employee_started_at, started_at_input),
        attendance = case when attendance = 'assigned' then 'started' else attendance end
    where job_id = job_id_input
      and employee_id = auth.uid();

    return coalesce(v_job.started_at, started_at_input);

  elsif v_job.status <> 'open' then
    -- completed (oder ein zukuenftiger, heute nicht existierender
    -- Terminalstatus): harte Ablehnung, KEINE Mutation an job_assignments
    -- oder jobs. Deutscher, nutzerseitig sicherer Text im Stil der
    -- uebrigen Ablehnungen dieser Funktion, derselbe Fehlercode (22023),
    -- damit der bestehende Client-Fehler-Klassifizierer ihn unveraendert
    -- als reguläre Ablehnung erkennt (kein neuer Fehlercode noetig).
    raise exception
      'Dieser Auftrag ist bereits abgeschlossen und kann nicht mehr gestartet werden.'
      using errcode = '22023';
  end if;

  -- ── Echter Uebergang open -> in_progress ─────────────────────────
  -- PAUSIERTE Dauerauftrags-Occurrence ausschliessen (20260829000000):
  -- eine generierte Occurrence, deren Parent-Regel deaktiviert wurde, ist
  -- keine aktionierbare Arbeit. Gewoehnliche Einzelauftraege haben
  -- parent_job_id IS NULL und sind strukturell ausgenommen.
  if v_job.parent_job_id is not null and coalesce(v_job.is_active, true) = false then
    raise exception 'Job not found or not allowed';
  end if;

  update public.jobs
  set status       = 'in_progress',
      started_at   = started_at_input,
      started_by   = auth.uid(),
      completed_at = null,
      completed_by = null
  where id = job_id_input;

  select full_name into v_emp_name from public.profiles where id = auth.uid();

  insert into public.notification_outbox (
    company_id, job_id, event_type, job_status,
    employee_id, employee_name, customer_name, service_name
  )
  values (
    v_job.company_id, v_job.id, 'job_started', 'in_progress',
    auth.uid(), v_emp_name, v_job.customer_name, v_job.service_name
  )
  on conflict (job_id, event_type) where event_type in ('job_started', 'job_completed')
  do nothing;

  update public.job_assignments
  set employee_started_at = coalesce(employee_started_at, started_at_input),
      attendance = case when attendance = 'assigned' then 'started' else attendance end
  where job_id = job_id_input
    and employee_id = auth.uid();

  return started_at_input;
end;
$$;

comment on function public.start_own_job(uuid, timestamptz) is
'Employee-Start eines Einzeltermins. Berechtigt ist JEDER ueber '
'job_assignments Zugewiesene sowie (Bestand) der Legacy-Primaer; nur '
'role=employee, nur job_type=single; pausierte Dauerauftrags-Occurrences '
'ausgeschlossen. PATCH 20260918 (Astra-Audit Befund 2): expliziter '
'open/in_progress/sonst-Zweig statt `status <> ''open''` — ein Start-'
'Versuch auf einen bereits ''completed''-Auftrag (Offline-Nachzuegler, '
'Wettlauf mit Force Complete oder Fremd-Abschluss) wird jetzt hart '
'abgelehnt (22023) und mutiert weder job_assignments noch jobs.';


-- =========================================================
-- 3. BEFUND 3 — admin_force_complete_job: server-seitiges Feature-Gate
-- =========================================================
-- Vollstaendiger Funktionskoerper aus 20260917000000, unveraendert bis auf
-- den neuen Block direkt nach der Admin-Rollenpruefung.
create or replace function public.admin_force_complete_job(
  job_id_input uuid,
  reason_input text
)
returns public.jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job              public.jobs%rowtype;
  v_reason           text;
  v_pending          text;
  v_force_complete_on jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- IS DISTINCT FROM statt <>: current_user_role() liefert fuer ein
  -- inaktives/fehlendes Profil NULL, und "NULL <> 'admin'" ist NULL — der
  -- Guard wuerde fuer einen deaktivierten Admin still uebersprungen.
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can force-complete a job' using errcode = '42501';
  end if;

  -- PATCH 20260918 (Astra-Audit Befund 3): app_config.force_complete_enabled
  -- wurde bisher NIE serverseitig gelesen — der Schalter war ausschliesslich
  -- ein UI-Gate (JobDetailScreen.tsx). Solange die RPC auf einer Umgebung
  -- gar nicht existierte, war das folgenlos; sobald sie deployt ist, koennte
  -- jeder Admin per direktem RPC-Aufruf (REST/Postman, an der App-UI vorbei)
  -- zwangsabschliessen, unabhaengig vom Schalterstand. Gleiches Muster wie
  -- enforce_min_client_version() (app_config-gestuetzt), aber ueber einen
  -- direkten jsonb-Vergleich statt eines Boolean-Casts: `value` koennte
  -- fehlen (kein Konfigurationszeile), ungueltig sein (kein valider
  -- boolescher JSON-Wert) oder explizit false sein — in ALLEN drei Faellen
  -- muss abgelehnt werden, und ein Cast-Fehler bei ungueltigem Inhalt darf
  -- nicht als unklassifizierte Postgres-Exception durchschlagen. IS
  -- DISTINCT FROM ist dafuer NULL-sicher und wirft nie: fehlt die Zeile,
  -- ist v_force_complete_on NULL, COALESCE liefert 'false'::jsonb, und der
  -- Vergleich mit 'true'::jsonb ist schlicht TRUE (abgelehnt). Nur der exakte
  -- JSON-Wert `true` laesst die Funktion weiterlaufen.
  select value into v_force_complete_on
  from public.app_config
  where key = 'force_complete_enabled';

  if coalesce(v_force_complete_on, 'false'::jsonb) is distinct from 'true'::jsonb then
    raise exception
      'Die administrative Abschlussfunktion ist derzeit nicht aktiviert.'
      using errcode = '42501';
  end if;

  v_reason := btrim(coalesce(reason_input, ''));
  if v_reason = '' then
    raise exception
      'Bitte gib einen Grund für den Abschluss durch den Administrator an.'
      using errcode = '23514';
  end if;

  select * into v_job
  from public.jobs
  where id         = job_id_input
    and company_id = public.current_user_company_id()
  for update;

  if not found then
    raise exception 'Job not found or not accessible' using errcode = '42501';
  end if;

  if v_job.status is distinct from 'in_progress' then
    raise exception
      'Nur laufende Aufträge können durch einen Administrator abgeschlossen werden.'
      using errcode = '22023';
  end if;

  -- Nie gestartete, LEBENDE Zuweisungen zuerst regulaer entfernen.
  select coalesce(string_agg(
           coalesce(nullif(btrim(p.full_name), ''), ja.employee_name_snapshot, 'Unbekannt'),
           ', ' order by ja.assigned_at), '')
    into v_pending
  from public.job_assignments ja
  left join public.profiles p on p.id = ja.employee_id
  where ja.job_id             = job_id_input
    and ja.employee_id       is not null
    and ja.employee_started_at is null;

  if v_pending <> '' then
    raise exception
      'Bitte entferne zuerst die Mitarbeiter, die nicht teilgenommen haben: %', v_pending
      using errcode = '22023';
  end if;

  -- Pruefpfad in DERSELBEN Transaktion wie der Statuswechsel.
  insert into public.job_completion_overrides (
    job_id, previous_status, overridden_by, reason
  )
  values (v_job.id, v_job.status, auth.uid(), v_reason);

  -- completed_by = der eingreifende Admin. Die Spalte bedeutet seit Phase 7
  -- ausdruecklich "wer hat diesen Uebergang ausgeloest" und ist KEINE
  -- Abrechnungsgrundlage — ein Admin ist hier die wahrheitsgemaesse Antwort.
  -- KEIN job_completed-Event: die bestehende Push-Kopie wuerde faelschlich
  -- behaupten, diese Person habe den Auftrag persoenlich abgeschlossen.
  update public.jobs
  set status       = 'completed',
      completed_at = now(),
      completed_by = auth.uid()
  where id = job_id_input
  returning * into v_job;

  return v_job;
end;
$$;

comment on function public.admin_force_complete_job(uuid, text) is
'Admin-Wiederherstellung fuer haengende Auftraege ("gestartet, Abschluss '
'vergessen") — nur Admin, nur eigene Firma, nur status=''in_progress'', '
'Begruendung PFLICHT, Pruefpfad in job_completion_overrides. PATCH 20260918 '
'(Astra-Audit Befund 3): prueft jetzt server-seitig VOR jeder Mutation, dass '
'app_config.force_complete_enabled exakt auf `true` steht (fehlende/'
'ungueltige/false Werte werden abgelehnt) — der Schalter war zuvor rein '
'clientseitig (UI-Gate in JobDetailScreen.tsx) und bot keinen Schutz gegen '
'einen direkten RPC-Aufruf. Schliesst weiterhin AUSSCHLIESSLICH den '
'Lebenszyklus: job_assignments wird NICHT angetastet, es wird KEINE '
'employee_completed_at erfunden. Lehnt ab, solange nie gestartete LEBENDE '
'Zuweisungen existieren (die gehoeren regulaer entfernt); anonymisierte, '
'nie gestartete Zeilen sind ausgenommen, weil sie niemand mehr entfernen '
'kann. Schreibt bewusst KEIN job_completed-Event.';

revoke all on function public.admin_force_complete_job(uuid, text) from public, anon;
grant execute on function public.admin_force_complete_job(uuid, text) to authenticated;
