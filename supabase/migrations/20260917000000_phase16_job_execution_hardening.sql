-- =========================================================
-- MIGRATION: Phase 16 — Job Execution Hardening
-- Datum: 2026-09-17
-- =========================================================
-- ZWECK
--   Zwei im Feld belegte Probleme schliessen (siehe Vorfall 2026-09-16,
--   Aufträge 5ca1b43b… / 8452d630…):
--
--   P1  Ein Zugewiesener konnte einen Auftrag ABSCHLIESSEN, ohne ihn selbst
--       gestartet zu haben. Der Auftrag galt damit fuer ALLE als erledigt,
--       obwohl ein Kollege noch arbeitete.
--   P2  Ein Auftrag war an JEDEM Kalendertag startbar — auch einen Tag vor
--       seinem Termin. Es gab serverseitig keinerlei Datumspruefung.
--
--   Zusaetzlich: der Auftrags-Lebenszyklus wird aus der Zuweisungsmenge
--   abgeleitet (statt "der erste Abschluss gewinnt"), und es entsteht ein
--   auditierter Admin-Wiederherstellungspfad fuer haengende Auftraege.
--
-- LEITSATZ (gilt in dieser ganzen Migration)
--   Auftrags-Lebenszyklus (jobs.started_at/completed_at/status) und
--   MITARBEITER-ARBEITSZEIT (job_assignments.employee_started_at/
--   employee_completed_at) sind GETRENNTE Konzepte. Keine Funktion hier
--   leitet Arbeitszeit aus der Auftragsuhr ab oder umgekehrt. Der
--   Stundenzettel (services/timesheets/timesheet.service.ts) bleibt
--   unveraendert und liest weiterhin ausschliesslich die Zuweisungszeile.
--
-- OBJEKTE
--   1. public.job_completion_overrides      (neu, append-only Pruefpfad)
--   2. public.job_assignment_unresolved     (neu, internes Praedikat)
--   3. public.maybe_complete_job            (neu, interner Lebenszyklus-Helfer)
--   4. public.start_own_job                 (ersetzt)
--   5. public.complete_own_job              (ersetzt)
--   6. public.set_job_assignments           (ersetzt)
--   7. public.admin_force_complete_job      (neu, Admin-Wiederherstellung)
--
-- RUECKGABETYPEN UNVERAENDERT
--   start_own_job/complete_own_job behalten `returns timestamptz`.
--   PostgreSQL kann den Rueckgabetyp per CREATE OR REPLACE nicht aendern
--   (42P13), und ein DROP/CREATE wuerde alle GRANTs verlieren. Der Client
--   liest den Auftragsstatus nach dem Abschluss frisch nach, statt ihn aus
--   dem Rueckgabewert zu lesen.
--
-- IDEMPOTENZ
--   Tabelle via IF NOT EXISTS, Policies via DROP+CREATE, Funktionen via
--   CREATE OR REPLACE — vollstaendig wiederholbar.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Pruefpfad fuer den Admin-Zwangsabschluss
-- ---------------------------------------------------------
-- APPEND-ONLY, exakt nach dem Muster von employee_time_adjustments
-- (20260814000000): weder UPDATE- noch DELETE-Policy, weder UPDATE- noch
-- DELETE-Grant. Ein Zwangsabschluss ist ein Ereignis, kein Zustand.
--
-- ON DELETE je Spalte:
--   * job_id        -> CASCADE. Ohne den Auftrag ist der Nachweis
--                      gegenstandslos (wie job_comments/job_photos).
--   * overridden_by -> SET NULL. Ein Konto muss loeschbar bleiben, OHNE dass
--                      der Nachweis verschwindet (derselbe Fehler wie einst
--                      bei job_photos.uploaded_by, 20260722000000).
create table if not exists public.job_completion_overrides (
  id uuid primary key default gen_random_uuid(),

  job_id          uuid        not null references public.jobs(id)     on delete cascade,
  previous_status job_status  not null,
  -- NULL = das Admin-Konto wurde nach dem Eingriff geloescht.
  overridden_by   uuid                 references public.profiles(id) on delete set null,

  -- PFLICHT. Ein Lebenszyklus-Eingriff ohne Begruendung ist genau die
  -- Luecke, die eine Pruefung beanstanden wuerde.
  reason text not null,

  created_at timestamptz not null default now(),

  constraint chk_job_completion_overrides_reason
    check (length(btrim(reason)) > 0)
);

comment on table public.job_completion_overrides is
'Append-only Pruefpfad fuer den administrativen Zwangsabschluss haengender '
'Auftraege (admin_force_complete_job). Eine Zeile je Eingriff mit '
'Vorzustand, Admin, Begruendung und Zeitpunkt. Traegt KEINE Abrechnungs'
'bedeutung: der Eingriff schliesst ausschliesslich den Auftrags-Lebenszyklus '
'und laesst job_assignments unberuehrt — die Mitarbeiter-Arbeitszeit bleibt '
'damit unvollstaendig und im Stundenzettel korrekturbeduerftig.';

create index if not exists idx_job_completion_overrides_job
  on public.job_completion_overrides (job_id, created_at desc);

-- FK-Rueckwaertsindex, damit eine Kontoloeschung (SET NULL) nicht ueber
-- einen Seq Scan laeuft. Partiell, Bauform wie idx_jobs_started_by.
create index if not exists idx_job_completion_overrides_overridden_by
  on public.job_completion_overrides (overridden_by) where overridden_by is not null;

-- REIHENFOLGE IST SICHERHEITSRELEVANT: Supabase vergibt ueber ALTER DEFAULT
-- PRIVILEGES auf neue Tabellen im public-Schema automatisch ALLE Rechte an
-- anon und authenticated. Erst vollstaendig entziehen, dann gezielt SELECT
-- vergeben (gleiche Reihenfolge wie 20260814000000).
alter table public.job_completion_overrides enable row level security;

revoke all on public.job_completion_overrides from anon, authenticated;
grant select on public.job_completion_overrides to authenticated;

drop policy if exists "admin read completion overrides in own company" on public.job_completion_overrides;
create policy "admin read completion overrides in own company"
on public.job_completion_overrides
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and public.job_in_current_company(job_id)
);

-- KEINE INSERT-, UPDATE- oder DELETE-Policy. Beabsichtigt: geschrieben wird
-- ausschliesslich durch admin_force_complete_job (SECURITY DEFINER).


-- ---------------------------------------------------------
-- 2. Praedikat: ist eine Zuweisungszeile UNGELOEST?
-- ---------------------------------------------------------
-- DIE zentrale Definition des Phase-16-Lebenszyklus. Steht bewusst genau
-- EINMAL im Schema — complete_own_job, set_job_assignments und
-- admin_force_complete_job muessen dieselbe Antwort sehen, sonst haengen
-- Auftraege aus nicht nachvollziehbaren Gruenden.
--
--   ungeloest  <=>  employee_completed_at IS NULL
--                   AND (employee_id IS NOT NULL OR employee_started_at IS NOT NULL)
--
-- WARUM DIE ZWEITE KLAMMER (Produktentscheidung 2026-09-17):
--   Eine ANONYMISIERTE Zeile (employee_id IS NULL nach Kontoloeschung, der
--   Namens-Schnappschuss bleibt) kann von niemandem mehr bedient werden.
--     * anonymisiert UND nie gestartet -> historischer Grabstein. Blockiert
--       NICHT. Es existiert keine Arbeitszeit, die verloren gehen koennte,
--       und keine Teilnahme, die umgangen wuerde. Auf Produktion betrifft
--       das 610 aktionierbare Auftraege (607 davon mit echten, lebenden
--       Zugewiesenen) — ohne diese Ausnahme wuerde JEDER davon beim ersten
--       Start dauerhaft haengen: entfernen kann set_job_assignments solche
--       Zeilen nicht (employee_id IS NOT NULL vorausgesetzt) und
--       admin_force_complete_job lehnt bei nie gestarteten Zeilen ab.
--     * anonymisiert UND gestartet -> es WURDE gearbeitet, die eigene Zeit
--       fehlt. Bleibt ungeloest und damit ein Fall fuer den auditierten
--       Admin-Pfad. Kontoloeschung darf kein stiller Ausweg aus dem
--       Lebenszyklus sein.
--   Historische Zeilen werden dabei WEDER geloescht NOCH veraendert.
create or replace function public.job_assignment_unresolved(
  p_employee_id           uuid,
  p_employee_started_at   timestamptz,
  p_employee_completed_at timestamptz
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_employee_completed_at is null
     and (p_employee_id is not null or p_employee_started_at is not null);
$$;

comment on function public.job_assignment_unresolved(uuid, timestamptz, timestamptz) is
'Phase 16: ist diese Zuweisungszeile fuer den Auftrags-Lebenszyklus UNGELOEST? '
'Ungeloest = kein eigener Abschluss UND (Konto lebt ODER es wurde selbst '
'gestartet). Anonymisierte, nie gestartete Zeilen sind damit historische '
'Grabsteine und blockieren den Abschluss nicht; anonymisierte GESTARTETE '
'Zeilen bleiben ungeloest und gehoeren in den auditierten Admin-Pfad. '
'IMMUTABLE und rein funktional — kein Tabellenzugriff, damit sie in '
'WHERE/EXISTS beliebig verwendet werden kann.';

revoke all on function public.job_assignment_unresolved(uuid, timestamptz, timestamptz) from public, anon, authenticated;


-- ---------------------------------------------------------
-- 2b. Praedikat: darf an diesem Ortszeit-Zeitpunkt gestartet werden?
-- ---------------------------------------------------------
-- Die Terminregel aus Phase 16 als REINE Funktion — bewusst getrennt von
-- start_own_job:
--   * Sie ist damit deterministisch testbar (synthetische Ortszeit statt
--     "wann laeuft die Testsuite gerade"), was fuer den Nachtzuschlag
--     zwingend ist: sein Verhalten haengt an der Tageszeit.
--   * Die Regel steht genau einmal im Schema.
--
-- ERWARTET ORTSZEIT: p_action_local ist der Aktionszeitpunkt bereits in der
-- Zeitzone der Firma (timestamp OHNE Zone). Die Umrechnung macht der
-- Aufrufer — so bleibt diese Funktion IMMUTABLE und zonenunabhaengig.
--
--   Normalfall    : jobs.date = Kalendertag der Aktion
--   Nachtzuschlag : Spaetdienst (start_time >= 20:00) darf bis 02:00 des
--                   FOLGETAGS erstmals gestartet werden. Bewusst NICHT auf
--                   Tagesauftraege ausgeweitet.
--   Fail-closed   : ohne jobs.date niemals erlaubt.
create or replace function public.job_start_date_allowed(
  p_job_date       date,
  p_job_start_time time,
  p_action_local   timestamp
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    p_job_date = p_action_local::date
    or (
      p_job_start_time is not null
      and p_job_start_time >= time '20:00'
      and p_job_date       =  p_action_local::date - 1
      and p_action_local::time < time '02:00'
    ),
    false
  );
$$;

comment on function public.job_start_date_allowed(date, time, timestamp) is
'Phase 16: darf ein Auftrag zu diesem ORTSZEIT-Zeitpunkt gestartet werden? '
'Erlaubt am Kalendertag des Termins und — nur fuer Spaetdienste ab 20:00 — '
'bis 02:00 des Folgetags (Nachtzuschlag). Ohne Termin (jobs.date IS NULL) '
'nie. p_action_local MUSS bereits in der Zeitzone der Firma vorliegen; die '
'Umrechnung bleibt beim Aufrufer, damit diese Funktion IMMUTABLE und '
'deterministisch testbar ist.';

revoke all on function public.job_start_date_allowed(date, time, timestamp) from public, anon, authenticated;


-- ---------------------------------------------------------
-- 3. Interner Lebenszyklus-Helfer
-- ---------------------------------------------------------
-- Schliesst den Auftrag GENAU DANN, wenn keine ungeloeste Zuweisungszeile
-- mehr existiert. Wird von zwei Stellen gerufen (complete_own_job und
-- set_job_assignments), damit das Aggregat nicht zweimal im Schema steht.
--
-- SPERRE: der Aufrufer MUSS die jobs-Zeile bereits FOR UPDATE halten. Beide
-- Aufrufer tun das; ohne diese Disziplin koennten zwei gleichzeitige letzte
-- Abschluesse einander uebersehen (READ COMMITTED sieht die noch nicht
-- committete Fremdaenderung nicht) und der Auftrag bliebe offen.
--
-- p_emit_event: nur der MITARBEITER-Abschlusspfad darf das bestehende
-- job_completed-Event schreiben. Die Push-Kopie lautet "<Name> hat <X> bei
-- <Y> abgeschlossen" (supabase/functions/dispatch-notifications/index.ts) —
-- bei einem administrativ verursachten Abschluss waere das eine falsche
-- Tatsachenbehauptung ueber eine Person. Fuer Admin-Faelle daher false; der
-- Pruefpfad (job_completion_overrides) ist der Nachweis.
create or replace function public.maybe_complete_job(
  p_job_id     uuid,
  p_actor      uuid,
  p_at         timestamptz,
  p_emit_event boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job      public.jobs%rowtype;
  v_pending  boolean;
  v_emp_name text;
begin
  -- Kein FOR UPDATE: der Aufrufer haelt die Sperre bereits (siehe Kopf).
  select * into v_job from public.jobs where id = p_job_id;

  if not found or v_job.status <> 'in_progress' then
    return false;
  end if;

  select exists (
    select 1
    from public.job_assignments ja
    where ja.job_id = p_job_id
      and public.job_assignment_unresolved(
            ja.employee_id, ja.employee_started_at, ja.employee_completed_at)
  ) into v_pending;

  if v_pending then
    return false;
  end if;

  update public.jobs
  set status       = 'completed',
      completed_at = p_at,
      completed_by = p_actor
  where id = p_job_id
    and status = 'in_progress';

  if not found then
    return false;
  end if;

  if p_emit_event then
    select full_name into v_emp_name from public.profiles where id = p_actor;

    insert into public.notification_outbox (
      company_id, job_id, event_type, job_status,
      employee_id, employee_name, customer_name, service_name
    )
    values (
      v_job.company_id, v_job.id, 'job_completed', 'completed',
      p_actor, v_emp_name, v_job.customer_name, v_job.service_name
    )
    on conflict (job_id, event_type) where event_type in ('job_started', 'job_completed')
    do nothing;
  end if;

  return true;
end;
$$;

comment on function public.maybe_complete_job(uuid, uuid, timestamptz, boolean) is
'Phase 16 (INTERN, nicht fuer Clients): schliesst den Auftrag, wenn keine '
'ungeloeste Zuweisungszeile mehr existiert (siehe job_assignment_unresolved). '
'Der Aufrufer MUSS die jobs-Zeile bereits FOR UPDATE halten — sonst koennen '
'zwei gleichzeitige letzte Abschluesse einander uebersehen. p_emit_event=false '
'unterdrueckt das job_completed-Event fuer administrativ verursachte '
'Abschluesse, deren Push-Kopie sonst faelschlich eine Person als Abschliessende '
'benennen wuerde. Gibt true zurueck, wenn der Auftrag in diesem Aufruf '
'geschlossen wurde.';

-- Nur ueber die SECURITY-DEFINER-Einstiegspunkte erreichbar, nie direkt.
revoke all on function public.maybe_complete_job(uuid, uuid, timestamptz, boolean) from public, anon, authenticated;


-- ---------------------------------------------------------
-- 4. RPC: START OWN JOB
-- ---------------------------------------------------------
-- NEU gegenueber 20260829000000:
--   a) ZEITSTEMPEL-VERTRAUEN: started_at_input ist clientseitig geliefert.
--      Akzeptiert wird nur [now() - 12h, now() + 5min]. Ausserhalb ->
--      Ablehnung. Der akzeptierte Wert wird UNVERAENDERT geschrieben (kein
--      stilles Ersetzen durch now()), damit Offline-Nachtraege die echte
--      Aktionszeit behalten.
--   b) TERMINPRUEFUNG in der Zeitzone der Firma (companies.timezone,
--      Fallback Europe/Berlin — NIE rohes UTC):
--        Normalfall      : jobs.date = Geschaeftsdatum der Aktion
--        Nachtzuschlag   : jobs.start_time >= 20:00 UND Aktion am Folgetag
--                          vor 02:00 Ortszeit
--      Fail-closed: ohne jobs.date ist kein Start moeglich.
--   c) Die Pruefungen (a)+(b) gelten fuer BEIDE Zweige — auch fuer den
--      idempotenten Nachzuegler-Zweig, denn auch dort wird die EIGENE
--      Startzeit (employee_started_at) gestempelt und die ist
--      abrechnungsrelevant.
--
-- Umbau von "UPDATE … WHERE (compare-and-swap)" auf "SELECT … FOR UPDATE,
-- dann UPDATE": nur so lassen sich die drei Ablehnungsgruende (zu alt /
-- Zukunft / falscher Tag) mit einer verstaendlichen Meldung unterscheiden.
-- Die Sperre serialisiert zusaetzlich gleichzeitige Starts — der erste
-- gewinnt, der zweite sieht in_progress und faellt in den Nachzuegler-Zweig.
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

  -- ── (c) Nachzuegler-Zweig: Auftrag laeuft/lief bereits ───────────
  -- Idempotent. Stempelt die EIGENE Startzeit (COALESCE: der erste Wert
  -- gewinnt, ein Doppel-Tap verschiebt nichts) und hebt attendance genau
  -- einmal von 'assigned' auf 'started'.
  if v_job.status <> 'open' then
    update public.job_assignments
    set employee_started_at = coalesce(employee_started_at, started_at_input),
        attendance = case when attendance = 'assigned' then 'started' else attendance end
    where job_id = job_id_input
      and employee_id = auth.uid();

    return coalesce(v_job.started_at, started_at_input);
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

revoke all on function public.start_own_job(uuid, timestamptz) from public, anon;
grant execute on function public.start_own_job(uuid, timestamptz) to authenticated;

comment on function public.start_own_job(uuid, timestamptz) is
'Employee-Start eines Einzeltermins. Berechtigt ist JEDER ueber '
'job_assignments Zugewiesene sowie (Bestand) der Legacy-Primaer; nur '
'role=employee, nur job_type=single; pausierte Dauerauftrags-Occurrences '
'bleiben ausgeschlossen (20260829000000). Phase 16: akzeptiert '
'started_at_input nur im Fenster [now()-12h, now()+5min] und schreibt den '
'akzeptierten Wert UNVERAENDERT (Offline-Nachtrag behaelt die echte '
'Aktionszeit); erlaubt den Start nur am Geschaeftstermin des Auftrags in der '
'Zeitzone der Firma (companies.timezone, Fallback Europe/Berlin), mit '
'Nachtzuschlag fuer Spaetdienste ab 20:00 bis 02:00 des Folgetags. Beide '
'Pruefungen gelten auch fuer den idempotenten Nachzuegler-Zweig, weil dort '
'ebenfalls die abrechnungsrelevante eigene Startzeit gestempelt wird. Ohne '
'jobs.date ist kein Start moeglich (fail-closed).';


-- ---------------------------------------------------------
-- 5. RPC: COMPLETE OWN JOB
-- ---------------------------------------------------------
-- NEU gegenueber 20260812000000:
--   a) Zeitstempel-Vertrauensfenster wie bei start_own_job.
--   b) EIGENER START ERFORDERLICH: employee_started_at der AUFRUFENDEN
--      Zuweisungszeile muss gesetzt sein. Der Start eines KOLLEGEN
--      berechtigt niemanden mehr zum Abschluss — das war die Ursache des
--      Vorfalls vom 2026-09-16.
--   c) completed_at_input >= eigenem employee_started_at (serverseitig,
--      nicht dem Client geglaubt).
--   d) Eigene Sitzung <= 12h, sonst Ablehnung mit Verweis auf die
--      Admin-Pruefung. KEIN erfundener Ersatz-Zeitstempel.
--   e) KEINE Terminpruefung: ein um 22:00 begonnener Auftrag darf um 00:03
--      des Folgetags abgeschlossen werden. Anker ist der EIGENE Start.
--   f) Der Auftrag wird nur noch geschlossen, wenn KEINE ungeloeste
--      Zuweisungszeile mehr existiert (maybe_complete_job).
--   g) SPAETER OFFLINE-ABSCHLUSS NACH ADMIN-ZWANGSABSCHLUSS: ist der
--      Auftrag bereits 'completed', wird die eigene Abschlusszeit TROTZDEM
--      erfasst (sonst ginge echte Arbeitszeit verloren, nur weil der
--      Lebenszyklus administrativ geschlossen wurde). Dabei wird die
--      jobs-Zeile NICHT angetastet, kein Event geschrieben, der Auftrag
--      nicht wiedereroeffnet und der Pruefpfad nicht veraendert.
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
  v_job          public.jobs%rowtype;
  v_assignment   public.job_assignments%rowtype;
  v_own_complete timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- ── (a) Zeitstempel-Vertrauensfenster ────────────────────────────
  if completed_at_input > now() + interval '5 minutes' then
    raise exception
      'Die Uhrzeit deines Geräts liegt in der Zukunft. Bitte prüfe die Zeiteinstellung.'
      using errcode = '22023';
  end if;

  if completed_at_input < now() - interval '12 hours' then
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

  if v_job.status = 'open' then
    raise exception 'Job not in progress (cannot complete)';
  end if;

  -- ── (b) Eigener Start erforderlich ───────────────────────────────
  select * into v_assignment
  from public.job_assignments
  where job_id = job_id_input
    and employee_id = auth.uid();

  if not found or v_assignment.employee_started_at is null then
    raise exception
      'Du musst diesen Auftrag zuerst selbst starten, bevor du ihn abschließen kannst.'
      using errcode = '22023';
  end if;

  -- ── (c) Abschluss nicht vor dem eigenen Start ────────────────────
  if completed_at_input < v_assignment.employee_started_at then
    raise exception
      'Der Abschluss liegt vor deinem eigenen Start. Bitte prüfe die Zeiteinstellung deines Geräts.'
      using errcode = '22023';
  end if;

  -- ── (d) Plausible Sitzungslaenge ─────────────────────────────────
  if completed_at_input - v_assignment.employee_started_at > interval '12 hours' then
    raise exception
      'Die Arbeitszeit ist ungewöhnlich lang und muss durch einen Administrator geprüft werden.'
      using errcode = '22023';
  end if;

  -- ── Eigene Abschlusszeit erfassen (idempotent, der erste gewinnt) ─
  update public.job_assignments
  set employee_completed_at = coalesce(employee_completed_at, completed_at_input),
      attendance            = 'completed'
  where job_id = job_id_input
    and employee_id = auth.uid()
  returning employee_completed_at into v_own_complete;

  -- ── (f)/(g) Lebenszyklus ─────────────────────────────────────────
  -- Nur bei laufendem Auftrag. Ist er bereits 'completed' (Admin-Eingriff
  -- oder regulaerer Abschluss), bleibt die jobs-Zeile unberuehrt: keine
  -- Wiedereroeffnung, kein zweites Event, kein Eingriff in den Pruefpfad.
  if v_job.status = 'in_progress' then
    perform public.maybe_complete_job(
      job_id_input, auth.uid(), completed_at_input, true);
  end if;

  return coalesce(v_own_complete, completed_at_input);
end;
$$;

revoke all on function public.complete_own_job(uuid, timestamptz) from public, anon;
grant execute on function public.complete_own_job(uuid, timestamptz) to authenticated;

comment on function public.complete_own_job(uuid, timestamptz) is
'Employee-Abschluss der EIGENEN Teilnahme. Phase 16: verlangt einen eigenen '
'Start (employee_started_at der aufrufenden Zeile) — der Start eines Kollegen '
'berechtigt NICHT mehr zum Abschluss; verlangt completed_at_input >= eigenem '
'Start und eine Sitzung <= 12h (sonst Admin-Pruefung, ohne erfundenen '
'Ersatzzeitstempel); akzeptiert den Zeitstempel nur im Fenster [now()-12h, '
'now()+5min]. KEINE Terminpruefung: Abschluss darf den Kalendertag des Starts '
'ueberschreiten. Der AUFTRAG wird nur geschlossen, wenn keine ungeloeste '
'Zuweisungszeile mehr existiert (maybe_complete_job/job_assignment_unresolved). '
'Ist der Auftrag bereits abgeschlossen (z. B. Admin-Zwangsabschluss), wird die '
'eigene Abschlusszeit dennoch erfasst, ohne den Auftrag wiederzuoeffnen, ein '
'zweites Event zu schreiben oder den Pruefpfad zu veraendern. Rueckgabetyp '
'unveraendert timestamptz — der Client liest den Auftragsstatus frisch nach.';


-- ---------------------------------------------------------
-- 6. RPC: SET JOB ASSIGNMENTS
-- ---------------------------------------------------------
-- Unveraendert uebernommen aus 20260820000000, PLUS drei Phase-16-Ergaenzungen:
--   A) ABGESCHLOSSENE AUFTRAEGE SIND GESPERRT. Ohne das entstuende ein
--      widerspruechlicher Zustand: status='completed' mit einer neuen
--      ungeloesten Zuweisungszeile. Der Stundenzettel zeigte fuer diese
--      Person dann eine Phantom-Luecke (job.status='completed' passiert den
--      Filter in timesheet.service.ts), die ueber
--      admin_correct_assignment_time sogar mit erfundenen Zeiten "korrigiert"
--      werden koennte.
--   B) BEREITS GESTARTETE ZUWEISUNGEN SIND NICHT ENTFERNBAR — und das wird
--      jetzt LAUT abgelehnt. Bisher fiel eine solche Zeile stillschweigend
--      aus der DELETE-Bedingung (employee_started_at IS NULL), die RPC
--      meldete Erfolg und der Admin glaubte, entfernt zu haben. Alles oder
--      nichts: der ganze Aufruf wird abgelehnt, der Admin muss die Person
--      bewusst in der Zielmenge behalten.
--   C) ENTFERNEN KANN DEN AUFTRAG ABSCHLIESSEN. Hat A seine Teilnahme
--      abgeschlossen und der Admin entfernt den nie gestarteten B, ist
--      danach nichts mehr ungeloest — es gibt aber keinen weiteren
--      complete_own_job-Aufruf, der das bemerken wuerde. Ohne diesen Schritt
--      blieben solche Auftraege dauerhaft 'in_progress'.
--      p_emit_event=false: der Abschluss geht auf eine Admin-Aktion zurueck,
--      die bestehende Push-Kopie wuerde faelschlich eine Person als
--      Abschliessende benennen.
--
-- Die jobs-Zeile ist ab dem SELECT … FOR UPDATE weiter unten gesperrt;
-- maybe_complete_job laeuft damit unter derselben Sperre (Vorbedingung
-- dieses Helfers) und in derselben Transaktion.
create or replace function public.set_job_assignments(
  p_job_id uuid,
  p_employee_ids uuid[] default '{}'::uuid[]
)
returns setof public.job_assignments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company       uuid;
  v_customer_name text;
  v_service_name  text;
  v_status        job_status;
  v_parent        uuid;
  v_ids           uuid[];
  v_parent_ids    uuid[];
  v_invalid       int;
  v_actor         uuid;
  v_locked_names  text;
  new_row         public.job_assignments%rowtype;
  v_outbox_id     uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can change job assignments' using errcode = '42501';
  end if;

  select j.parent_job_id into v_parent
  from public.jobs j
  where j.id = p_job_id;

  if v_parent is not null then
    perform 1 from public.jobs where id = v_parent for update;
  end if;

  -- customer_name/service_name zusätzlich mitgesperrt/gelesen — Kontext
  -- für die job_assigned-Push, ohne einen zweiten Roundtrip.
  -- Phase 16: status kommt mit, fuer Ergaenzung (A).
  select j.company_id, j.customer_name, j.service_name, j.status
    into v_company, v_customer_name, v_service_name, v_status
  from public.jobs j
  where j.id         = p_job_id
    and j.company_id = public.current_user_company_id()
  for update;

  if not found then
    raise exception 'Job not found or not accessible' using errcode = '42501';
  end if;

  -- ── (A) Abgeschlossene Auftraege: keine Zuweisungsaenderung ──────
  if v_status = 'completed' then
    raise exception
      'Zuweisungen können bei einem abgeschlossenen Auftrag nicht mehr geändert werden.'
      using errcode = '22023';
  end if;

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

  -- ── (B) Bereits gestartete Zuweisungen sind nicht entfernbar ─────
  -- Spiegelt die DELETE-Bedingung unten, aber invertiert: wer wegen eines
  -- eigenen Starts NICHT geloescht werden koennte, fuehrt jetzt zu einer
  -- klaren Ablehnung statt zu einem stillen Teilerfolg.
  select coalesce(string_agg(
           coalesce(nullif(btrim(p.full_name), ''), ja.employee_name_snapshot, 'Unbekannt'),
           ', ' order by ja.assigned_at), '')
    into v_locked_names
  from public.job_assignments ja
  left join public.profiles p on p.id = ja.employee_id
  where ja.job_id               = p_job_id
    and ja.employee_id         is not null
    and not (ja.employee_id = any (v_ids))
    and ja.employee_started_at is not null;

  if v_locked_names <> '' then
    raise exception
      'Bereits gestartet – kann nicht entfernt werden: %', v_locked_names
      using errcode = '22023';
  end if;

  delete from public.job_assignments ja
  where ja.job_id                 = p_job_id
    and ja.employee_id           is not null
    and not (ja.employee_id = any (v_ids))
    and ja.attendance             = 'assigned'
    and ja.review                is null
    and ja.employee_started_at   is null
    and ja.employee_completed_at is null;

  -- Ersetzt den früheren einfachen INSERT: RETURNING treibt jetzt eine
  -- Schleife, die für JEDE tatsächlich neu angelegte Zuweisungszeile (nicht
  -- für unveränderte/bereits vorhandene) genau ein job_assigned-Event +
  -- eine Zustellung schreibt. ON CONFLICT DO NOTHING sorgt weiterhin dafür,
  -- dass ein No-Op-Save (identische Zielmenge) keine neue Zeile — und damit
  -- auch keine neue Benachrichtigung — erzeugt.
  for new_row in
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
    on conflict (job_id, employee_id) do nothing
    returning *
  loop
    v_outbox_id := null;

    insert into public.notification_outbox (
      company_id, job_id, event_type, job_status,
      employee_id, employee_name, customer_name, service_name,
      assignment_id, fanned_out_at
    )
    values (
      v_company, p_job_id, 'job_assigned', 'assigned',
      new_row.employee_id, new_row.employee_name_snapshot,
      v_customer_name, v_service_name, new_row.id, now()
    )
    on conflict (assignment_id) where assignment_id is not null do nothing
    returning id into v_outbox_id;

    if v_outbox_id is not null then
      insert into public.notification_deliveries (
        outbox_id, company_id, recipient_id, next_attempt_at
      )
      values (v_outbox_id, v_company, new_row.employee_id, now())
      on conflict (outbox_id, recipient_id) do nothing;
    end if;
  end loop;

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

  -- ── (C) Entfernen kann die letzte offene Teilnahme aufgeloest haben ─
  -- Unbedingt aufgerufen: der Helfer prueft selbst auf status='in_progress'
  -- und auf ungeloeste Zeilen, ist also im Regelfall ein billiger No-Op.
  perform public.maybe_complete_job(p_job_id, auth.uid(), now(), false);

  return query
  select ja.*
  from public.job_assignments ja
  where ja.job_id = p_job_id
  order by ja.assigned_at, ja.id;
end;
$$;

comment on function public.set_job_assignments(uuid, uuid[]) is
'Ersetzt die Zuweisungsmenge eines Auftrags transaktional (nur Admin, nur '
'eigene Firma) und schreibt je NEUER Zeile ein job_assigned-Event. Phase 16: '
'(A) bei status=''completed'' wird jede Aenderung abgelehnt — sonst entstuende '
'ein abgeschlossener Auftrag mit neuer ungeloester Zuweisung und einer '
'Phantom-Luecke im Stundenzettel; (B) der Versuch, eine BEREITS GESTARTETE '
'Zuweisung zu entfernen, lehnt den GESAMTEN Aufruf ab (vorher: stiller '
'Teilerfolg, die Zeile blieb unbemerkt stehen); (C) nach dem Entfernen wird '
'der Lebenszyklus neu bewertet — war der entfernte, nie gestartete '
'Mitarbeiter die letzte ungeloeste Teilnahme, wird der Auftrag geschlossen, '
'bewusst OHNE job_completed-Event (Admin-Aktion, die bestehende Push-Kopie '
'wuerde faelschlich eine Person benennen).';

revoke all on function public.set_job_assignments(uuid, uuid[]) from public, anon;
grant execute on function public.set_job_assignments(uuid, uuid[]) to authenticated;


-- ---------------------------------------------------------
-- 7. RPC: ADMIN FORCE COMPLETE JOB
-- ---------------------------------------------------------
-- Wiederherstellungspfad fuer den Fall "gestartet, Abschluss vergessen".
-- Seit Phase 16 ist er STRUKTURELL notwendig: eine gestartete Zuweisung ist
-- per set_job_assignments nicht entfernbar (Ergaenzung B) und blockiert den
-- Abschluss (job_assignment_unresolved) — ohne diesen Eingriff bliebe ein
-- solcher Auftrag dauerhaft 'in_progress'.
--
-- TRENNUNG VON LEBENSZYKLUS UND ABRECHNUNG (zentral):
--   Diese Funktion fasst job_assignments NICHT an. Sie erfindet KEINE
--   employee_completed_at und verwendet den Auftrags-Abschlusszeitpunkt NICHT
--   als bezahlte Mitarbeiterzeit. Wessen eigenes Zeitpaar unvollstaendig ist,
--   bleibt im Stundenzettel eine Luecke (needsAttention) und muss ueber
--   admin_correct_assignment_time (20260814000000) mit der ECHTEN Zeit
--   korrigiert werden.
--
-- NIE GESTARTETE, LEBENDE ZUWEISUNGEN BLOCKIEREN DEN EINGRIFF:
--   Wer nie gestartet hat, hat nicht teilgenommen und gehoert regulaer
--   entfernt (set_job_assignments) — nicht als Phantom-Zuweisung in einem
--   abgeschlossenen Auftrag stehen gelassen. Anonymisierte, nie gestartete
--   Zeilen sind davon ausgenommen: sie sind historische Grabsteine, die
--   niemand mehr entfernen kann (siehe job_assignment_unresolved).
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
  v_job     public.jobs%rowtype;
  v_reason  text;
  v_pending text;
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
'Begruendung PFLICHT, Pruefpfad in job_completion_overrides. Schliesst '
'AUSSCHLIESSLICH den Lebenszyklus: job_assignments wird NICHT angetastet, es '
'wird KEINE employee_completed_at erfunden und der Auftrags-Abschlusszeitpunkt '
'ist NICHT die bezahlte Mitarbeiterzeit — unvollstaendige Zeitpaare bleiben '
'eine Stundenzettel-Luecke und gehoeren ueber admin_correct_assignment_time '
'korrigiert. Lehnt ab, solange nie gestartete LEBENDE Zuweisungen existieren '
'(die gehoeren regulaer entfernt); anonymisierte, nie gestartete Zeilen sind '
'ausgenommen, weil sie niemand mehr entfernen kann. Schreibt bewusst KEIN '
'job_completed-Event.';

revoke all on function public.admin_force_complete_job(uuid, text) from public, anon;
grant execute on function public.admin_force_complete_job(uuid, text) to authenticated;


-- =========================================================
-- ABWAERTSKOMPATIBILITAET / ROLLBACK
-- =========================================================
-- Rueckgabetypen und Signaturen von start_own_job/complete_own_job/
-- set_job_assignments sind unveraendert — bestehende Clients im Feld rufen
-- weiter genau dieselben RPCs mit denselben Parametern auf. Sie erhalten bei
-- den neuen Ablehnungen eine Fehlermeldung (deutsche RPC-Texte reicht
-- utils/userMessages.ts unveraendert durch) statt eines stillen Erfolgs; das
-- ist der beabsichtigte Effekt. Ein alter Client kann lediglich den Fall
-- "eigene Teilnahme erledigt, Auftrag laeuft weiter" nicht darstellen und
-- zeigt bis zum naechsten Nachladen weiter "abgeschlossen" an.
--
-- ROLLBACK (Funktionen zuerst, dann Objekte):
--   Die vier ersetzten/neuen Funktionen auf den Stand von 20260829000000
--   (start_own_job), 20260812000000 (complete_own_job) und 20260820000000
--   (set_job_assignments) zuruecksetzen, dann:
--     drop function if exists public.admin_force_complete_job(uuid, text);
--     drop function if exists public.maybe_complete_job(uuid, uuid, timestamptz, boolean);
--     drop function if exists public.job_assignment_unresolved(uuid, timestamptz, timestamptz);
--     drop policy if exists "admin read completion overrides in own company" on public.job_completion_overrides;
--     drop table if exists public.job_completion_overrides;
--   Bereits erfasste employee_started_at/employee_completed_at bleiben dabei
--   unveraendert erhalten; nur der Pruefpfad der Zwangsabschluesse ginge
--   verloren.
-- =========================================================
