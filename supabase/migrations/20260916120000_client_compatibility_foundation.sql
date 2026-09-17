-- =========================================================
-- MIGRATION: Client-Compatibility-Fundament
-- =========================================================
-- BEFUND (Rollout-Kompatibilitaetspruefung, Phase-16-Vorlauf)
--   Der aktuelle Client hat KEINE Mindestversions-Durchsetzung. Ein
--   client-seitiges Update-Gate (app_config, geprueft beim Bootstrap) kann
--   bereits installierte ALTE Clients nicht rueckwirkend blockieren — sie
--   enthalten den neuen Routing-Code schlicht nicht und werden ihn nie
--   laden. Ohne serverseitige Durchsetzung bliebe der bestaetigte Dead-End
--   (alter Client + neues Backend: zweiter Zugewiesener sieht "Abschliessen"
--   ohne je gestartet zu haben, keine Rueckmeldung, warum) ungeschuetzt.
--
--   Diese Migration fuegt eine serverseitige, per Request-Header
--   identifizierte Mindestversions-Pruefung EIN, OHNE die Phase-16-
--   Geschaeftsregeln vorwegzunehmen: start_own_job/complete_own_job/
--   set_job_assignments behalten hier bewusst ihre AKTUELLE, auf Production
--   verifiziert live stehende Logik (vor 20260917000000) — nur um eine
--   Wächter-Klausel ergaenzt. Migration 20260917000000 (Phase 16) wird
--   separat um dieselbe Wächter-Klausel ergaenzt, damit ihre Aktivierung
--   die Durchsetzung nicht versehentlich wieder entfernt.
--
-- MECHANISMUS (empirisch gegen Staging verifiziert, nicht nur dokumentiert)
--   PostgREST legt saemtliche eingehenden Request-Header als JSON in der GUC
--   request.headers ab — current_setting('request.headers', true)::jsonb.
--   Ein Test mit einer temporaeren, sofort wieder entfernten Sonden-Funktion
--   bestaetigte: Header-Keys kommen KLEINGESCHRIEBEN an, Werte als
--   JSON-Strings. Der Supabase-JS-Client haengt globale Header
--   (createClient(..., { global: { headers: {...} } })) an JEDEN
--   REST/RPC-Aufruf an — exakt der Kanal, den auth.uid() selbst schon fuer
--   JWT-Claims nutzt.
--
-- GEPRUEFTE AUFRUFER (kein Blindfleck)
--   Einziger echter Aufrufer aller drei erweiterten RPCs ist der Mobile-
--   Client (services/jobs/jobs.service.ts). Kein Edge-Function-, Cron- oder
--   interner SQL-Aufruf gefunden (dispatch-notifications erwaehnt die Namen
--   nur in einem Kommentar). Die bestehenden SQL-Testsuiten rufen diese RPCs
--   per pg_temp.act_as() direkt auf — OHNE PostgREST-Kontext, also ohne
--   Header. Solange enforcement_enabled=false bleibt (Ausgangszustand
--   dieser Migration), sind Tests davon nicht betroffen.
--
-- SICHERHEITSHALTUNG
--   Diese Migration allein aendert AUSSER der neuen Waechter-Klausel keine
--   Geschaeftslogik. enforcement_enabled startet auf false — die Migration
--   ist beim Anwenden ein reines No-Op fuer jeden echten Aufruf, bis
--   jemand die Konfiguration bewusst per SQL-Editor-Update umschaltet.
-- =========================================================


-- ---------------------------------------------------------
-- 1. app_config — minimales globales Plattform-Konfigurationsfundament
-- ---------------------------------------------------------
-- Bewusst ein generisches Key-Value-Fundament statt mehrerer
-- zweckgebundener Tabellen: deckt sowohl die Versions-/Enforcement-Werte
-- als auch das Force-Complete-Capability-Flag und die Update-URLs mit
-- EINER Tabelle ab, ohne ein Remote-Config-System zu werden (kein Targeting,
-- keine Admin-UI, kein Rollout-Prozentsatz — nur globale Schluessel/Werte).
-- Firmenspezifisch ist hier nichts: das ist ein Plattform-/Betreiber-Hebel,
-- kein Mandanten-Setting, deshalb bewusst NICHT in companies.
create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.app_config is
  'Globales Plattform-Konfigurationsfundament (Key-Value). Oeffentlich '
  'lesbar, nur per SQL Editor/service_role schreibbar — bewusst kein '
  'Schreibpfad fuer anon/authenticated, da dies ein Betreiber-Hebel ist, '
  'kein firmenspezifisches Setting.';

alter table public.app_config enable row level security;

drop policy if exists "app_config is publicly readable" on public.app_config;
create policy "app_config is publicly readable"
  on public.app_config
  for select
  to anon, authenticated
  using (true);

-- Keine INSERT/UPDATE/DELETE-Policy fuer anon/authenticated — absichtlich.

create or replace function public._app_config_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_app_config_updated_at on public.app_config;
create trigger trg_app_config_updated_at
  before update on public.app_config
  for each row
  execute function public._app_config_set_updated_at();

-- Startwerte: Rollout blockiert niemanden, bis bewusst umgeschaltet wird.
insert into public.app_config (key, value) values
  ('enforcement_enabled',    'false'::jsonb),
  ('force_complete_enabled', 'false'::jsonb),
  ('min_build_ios',          '1'::jsonb),
  ('min_build_android',      '1'::jsonb),
  ('update_url_ios',         'null'::jsonb),
  ('update_url_android',     'null'::jsonb)
on conflict (key) do nothing;


-- ---------------------------------------------------------
-- 2. profiles: Build-Adoptions-Telemetrie (nur beratend)
-- ---------------------------------------------------------
-- Pro NUTZER, nicht pro GERAET — ein Nutzer mit zwei Geraeten ueberschreibt
-- denselben Wert mit dem zuletzt synchronisierten. Taugt fuer einen groben
-- Flotten-Adoptions-Trend ("wann ist es vermutlich sicher, Enforcement
-- einzuschalten"), NICHT als Autorisierungsgrundlage fuer eine einzelne
-- Anfrage — das leisten ausschliesslich die Request-Header (siehe
-- enforce_min_client_version unten).
alter table public.profiles
  add column if not exists last_seen_app_build integer;

alter table public.profiles
  add column if not exists last_seen_app_platform text;

alter table public.profiles
  drop constraint if exists chk_profiles_last_seen_app_platform;

alter table public.profiles
  add constraint chk_profiles_last_seen_app_platform
  check (last_seen_app_platform is null or last_seen_app_platform in ('ios', 'android'));

comment on column public.profiles.last_seen_app_build is
  'Beratende Adoptions-Telemetrie (letzter update_my_push_token-Aufruf). '
  'Pro Nutzer, nicht pro Geraet — niemals als Autorisierung fuer eine '
  'einzelne Anfrage verwenden.';


-- ---------------------------------------------------------
-- 3. update_my_push_token — abwaertskompatibel erweitert
-- ---------------------------------------------------------
-- Zwei neue OPTIONALE Parameter mit Default null: ein alter Client, der
-- weiterhin nur new_token uebergibt, ruft dieselbe Funktion unveraendert
-- auf. Bestehende Logik 1:1 uebernommen (verifiziert gegen die aktuell auf
-- Production live stehende Fassung vor dieser Migration) — nur die zweite
-- UPDATE-Klausel schreibt jetzt zusaetzlich die Telemetrie-Spalten, per
-- COALESCE niemals mit null ueberschreibend.
--
-- WICHTIG — beim lokalen Rehearsal gefunden, nicht nur vermutet: Postgres
-- identifiziert Funktionen ueber Name+Parameter-TYPEN, nicht ueber Defaults.
-- Zusaetzliche (auch defaultete) Parameter machen CREATE OR REPLACE zu einer
-- ZWEITEN, PARALLELEN Overload statt eines echten Ersatzes — ein 1-Parameter-
-- Aufruf eines Alt-Clients wurde dadurch zwischen der alten 1-Parameter- und
-- der neuen 3-Parameter-Fassung zweideutig ("is not unique") und schlug fehl,
-- nicht "abwaertskompatibel" wie beabsichtigt. Der alte 1-Parameter-Overload
-- muss deshalb explizit entfernt werden, bevor die neue Fassung entsteht.
drop function if exists public.update_my_push_token(text);

create or replace function public.update_my_push_token(
  new_token text,
  app_build_number int default null,
  app_platform text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_token text := nullif(btrim(new_token), '');
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if v_token is null then
    raise exception 'Push token is required';
  end if;

  if v_token !~ '^ExponentPushToken\[[A-Za-z0-9_-]+\]$'
     and v_token !~ '^ExpoPushToken\[[A-Za-z0-9_-]+\]$' then
    raise exception 'Invalid Expo push token';
  end if;

  if not exists (
    select 1
    from public.profiles
    where id = v_user_id
      and is_active = true
  ) then
    raise exception 'Active profile not found';
  end if;

  update public.profiles
  set expo_push_token = null
  where expo_push_token = v_token
    and id <> v_user_id;

  update public.profiles
  set expo_push_token         = v_token,
      last_seen_app_build     = coalesce(app_build_number, last_seen_app_build),
      last_seen_app_platform  = coalesce(app_platform, last_seen_app_platform)
  where id = v_user_id
    and is_active = true;

  if not found then
    raise exception 'Active profile not found';
  end if;

  update public.notification_deliveries
  set next_attempt_at = now(),
      last_error = null
  where recipient_id = v_user_id
    and status = 'pending'
    and last_error = 'missing_push_token';
end;
$$;


-- ---------------------------------------------------------
-- 4. Versions-Durchsetzung: Helfer
-- ---------------------------------------------------------
-- Reine Wächter-Klausel, kein Rueckgabewert — wird als ERSTE Anweisung in
-- start_own_job/complete_own_job/set_job_assignments aufgerufen (siehe
-- unten) und in der Phase-16-Migration (20260917000000) unveraendert
-- fortgefuehrt, damit deren Aktivierung die Durchsetzung nicht entfernt.
--
-- Reihenfolge der Ablehnungsgruende (jede fuehrt zur SELBEN Meldung, damit
-- ein alter Client ohne jede neue Routing-Logik nur EINEN, immer gleichen,
-- bereits sicher durchgereichten deutschen Text sieht):
--   1. Enforcement aus              -> erlaubt (Uebergangsphase)
--   2. Plattform fehlt/unbekannt    -> abgelehnt
--   3. Build fehlt/nicht numerisch  -> abgelehnt
--   4. Build unter Minimum          -> abgelehnt
create or replace function public.enforce_min_client_version()
returns void
language plpgsql
stable
as $$
declare
  v_enabled    boolean;
  v_headers    jsonb;
  v_platform   text;
  v_build_text text;
  v_build      int;
  v_min        int;
begin
  select (value #>> '{}')::boolean into v_enabled
  from public.app_config
  where key = 'enforcement_enabled';

  if not coalesce(v_enabled, false) then
    return;
  end if;

  v_headers := current_setting('request.headers', true)::jsonb;

  v_platform := v_headers ->> 'x-taskops-platform';

  if v_platform is null or v_platform not in ('ios', 'android') then
    raise exception
      'Diese App-Version wird nicht mehr unterstützt. Bitte aktualisiere die App.'
      using errcode = '22023';
  end if;

  v_build_text := v_headers ->> 'x-taskops-build';

  -- Bis zu 9 Ziffern: sicher innerhalb int4, kein Ueberlauf-Risiko beim Cast.
  if v_build_text is null or v_build_text !~ '^[0-9]{1,9}$' then
    raise exception
      'Diese App-Version wird nicht mehr unterstützt. Bitte aktualisiere die App.'
      using errcode = '22023';
  end if;

  v_build := v_build_text::int;

  if v_build <= 0 then
    raise exception
      'Diese App-Version wird nicht mehr unterstützt. Bitte aktualisiere die App.'
      using errcode = '22023';
  end if;

  select (value #>> '{}')::int into v_min
  from public.app_config
  where key = ('min_build_' || v_platform);

  if v_min is null or v_build < v_min then
    raise exception
      'Diese App-Version wird nicht mehr unterstützt. Bitte aktualisiere die App.'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.enforce_min_client_version() from public;
grant execute on function public.enforce_min_client_version() to anon, authenticated;


-- ---------------------------------------------------------
-- 5. start_own_job — aktuell auf Production live stehende Fassung
--    (VOR 20260917000000), nur um die Waechter-Klausel ergaenzt
-- ---------------------------------------------------------
-- Koerper 1:1 verifiziert gegen pg_get_functiondef auf Production. Keine
-- Phase-16-Geschaeftslogik hier — die kommt ausschliesslich mit der
-- (separat um dieselbe Waechter-Klausel ergaenzten) Migration 20260917000000.
create or replace function public.start_own_job(
  job_id_input uuid,
  started_at_input timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  updated_row  public.jobs%rowtype;
  existing_row public.jobs%rowtype;
  emp_name     text;
begin
  perform public.enforce_min_client_version();

  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.jobs
  set
    status = 'in_progress',
    started_at = started_at_input,
    started_by = auth.uid(),
    completed_at = null,
    completed_by = null
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and status = 'open'
    -- PAUSIERTE Dauerauftrags-Occurrence ausschließen (siehe Kopfkommentar).
    -- Gewöhnliche Einzelaufträge: parent_job_id IS NULL -> Bedingung erfüllt.
    and (parent_job_id is null or coalesce(is_active, true))
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
      updated_row.company_id, updated_row.id, 'job_started', 'in_progress',
      auth.uid(), emp_name, updated_row.customer_name, updated_row.service_name
    )
    on conflict (job_id, event_type) where event_type in ('job_started', 'job_completed')
    do nothing;

    update public.job_assignments
    set
      employee_started_at = coalesce(employee_started_at, started_at_input),
      attendance = case when attendance = 'assigned' then 'started' else attendance end
    where job_id = job_id_input
      and employee_id = auth.uid();

    return started_at_input;
  end if;

  -- Idempotenter Rückfall (geteilter Arbeits-Timer): NUR wenn der Auftrag
  -- bereits NICHT MEHR offen ist. Ein pausierter (offener) Termin fällt damit
  -- durch bis zur Ausnahme unten — kein Scheinerfolg, keine Stempel auf der
  -- Zuweisungszeile.
  select * into existing_row
  from public.jobs
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and status <> 'open'
    and (
      assigned_to = auth.uid()
      or public.is_assigned_to_job(job_id_input)
    );

  if found then
    update public.job_assignments
    set
      employee_started_at = coalesce(employee_started_at, started_at_input),
      attendance = case when attendance = 'assigned' then 'started' else attendance end
    where job_id = job_id_input
      and employee_id = auth.uid();

    return coalesce(existing_row.started_at, started_at_input);
  end if;

  raise exception 'Job not found or not allowed';
end;
$$;


-- ---------------------------------------------------------
-- 6. complete_own_job — aktuell auf Production live stehende Fassung
--    (VOR 20260917000000), nur um die Waechter-Klausel ergaenzt
-- ---------------------------------------------------------
create or replace function public.complete_own_job(
  job_id_input uuid,
  completed_at_input timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  updated_row  public.jobs%rowtype;
  existing_row public.jobs%rowtype;
  emp_name     text;
begin
  perform public.enforce_min_client_version();

  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.jobs
  set
    status = 'completed',
    completed_at = completed_at_input,
    completed_by = auth.uid()
  where id = job_id_input
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'
    and status = 'in_progress'
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
    on conflict (job_id, event_type) where event_type in ('job_started', 'job_completed')
    do nothing;

    update public.job_assignments
    set
      employee_completed_at = coalesce(employee_completed_at, completed_at_input),
      attendance = 'completed'
    where job_id = job_id_input
      and employee_id = auth.uid();

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

  if existing_row.status = 'completed' then
    update public.job_assignments
    set
      employee_completed_at = coalesce(employee_completed_at, completed_at_input),
      attendance = 'completed'
    where job_id = job_id_input
      and employee_id = auth.uid();

    return coalesce(existing_row.completed_at, completed_at_input);
  end if;

  raise exception 'Job not in progress (cannot complete)';
end;
$$;


-- ---------------------------------------------------------
-- 7. set_job_assignments — aktuell auf Production live stehende Fassung
--    (VOR 20260917000000), nur um die Waechter-Klausel ergaenzt
-- ---------------------------------------------------------
create or replace function public.set_job_assignments(p_job_id uuid, p_employee_ids uuid[] default '{}'::uuid[])
returns setof job_assignments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_company       uuid;
  v_customer_name text;
  v_service_name  text;
  v_parent        uuid;
  v_ids           uuid[];
  v_parent_ids    uuid[];
  v_invalid       int;
  v_actor         uuid;
  new_row         public.job_assignments%rowtype;
  v_outbox_id     uuid;
begin
  perform public.enforce_min_client_version();

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
  select j.company_id, j.customer_name, j.service_name
    into v_company, v_customer_name, v_service_name
  from public.jobs j
  where j.id         = p_job_id
    and j.company_id = public.current_user_company_id()
  for update;

  if not found then
    raise exception 'Job not found or not accessible' using errcode = '42501';
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

  return query
  select ja.*
  from public.job_assignments ja
  where ja.job_id = p_job_id
  order by ja.assigned_at, ja.id;
end;
$$;
