-- =========================================================
-- MIGRATION: Client-Compatibility-Finalizer
-- =========================================================
-- WOZU DIESE MIGRATION EXISTIERT
--   Production und Staging haben Phase 16 in unterschiedlicher Reihenfolge
--   erreicht:
--     Production: ... -> 20260916000000 -> (hier)                -> [noch nicht: Kompat-Fundament, 0917]
--     Staging:    ... -> 20260913/15/16  -> 20260917000000 (Phase 16, OHNE Waechter-Klausel) -> app_config fehlt komplett
--
--   20260916120000 (Kompat-Fundament) legt start_own_job/complete_own_job/
--   set_job_assignments auf Production bewusst mit der VOR-Phase-16-Fassung
--   an (siehe dortiger Kopfkommentar) — auf Staging, das Phase 16 bereits
--   hat, waere dieselbe Datei ein RUECKSCHRITT. Diese Migration schliesst
--   die Luecke fuer BEIDE Ausgangszustaende mit EINER Datei:
--
--   AUF STAGING (heute): app_config/Telemetrie-Spalten/Waechter-Helfer
--   existieren nicht, start_own_job/complete_own_job/set_job_assignments
--   haben die Phase-16-Geschaeftslogik OHNE Waechter-Klausel. Diese
--   Migration legt alles NEU an und ergaenzt die Waechter-Klausel in den
--   drei RPCs — echte, notwendige Arbeit.
--
--   AUF EINER PRODUCTION, DIE BEREITS 20260916120000 UND DAS AMENDIERTE
--   20260917000000 IN DIESER REIHENFOLGE ERHALTEN HAT (Zukunft, sobald
--   Production regulaer aufholt): app_config existiert bereits (IF NOT
--   EXISTS/ON CONFLICT DO NOTHING greifen), die Telemetrie-Spalten
--   existieren bereits (IF NOT EXISTS greift), und die drei RPC-Koerper
--   unten sind BYTE-IDENTISCH zu dem, was 20260917000000 dort bereits
--   angelegt hat — CREATE OR REPLACE mit identischem Koerper ist ein
--   echter No-Op. Empirisch lokal verifiziert (siehe Kompat-Fundament-
--   Report): diese Migration aendert auf einer bereits vollstaendigen
--   Datenbank exakt NICHTS.
--
--   WICHTIG: insert ... on conflict (key) do nothing fuer app_config
--   stellt sicher, dass ein zwischenzeitlich bewusst umgeschaltetes
--   enforcement_enabled/force_complete_enabled auf einer solchen
--   Production NICHT auf den inerten Startwert zurueckgesetzt wird.
--
-- NICHT TEIL DIESER MIGRATION
--   job_start_date_allowed, job_assignment_unresolved, maybe_complete_job,
--   admin_force_complete_job — unveraendert, brauchen die Waechter-Klausel
--   nicht (siehe genehmigte Architektur: admin_force_complete_job ist ueber
--   kein Alt-Client erreichbar und wird separat per force_complete_enabled
--   gesteuert).
-- =========================================================


-- ---------------------------------------------------------
-- 1. app_config — idempotent, No-Op falls bereits vorhanden
-- ---------------------------------------------------------
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

-- ON CONFLICT DO NOTHING: siehe Kopfkommentar — setzt einen bereits bewusst
-- umgeschalteten Wert auf einer aufgeholten Production NICHT zurueck.
insert into public.app_config (key, value) values
  ('enforcement_enabled',    'false'::jsonb),
  ('force_complete_enabled', 'false'::jsonb),
  ('min_build_ios',          '1'::jsonb),
  ('min_build_android',      '1'::jsonb),
  ('update_url_ios',         'null'::jsonb),
  ('update_url_android',     'null'::jsonb)
on conflict (key) do nothing;


-- ---------------------------------------------------------
-- 2. profiles: Build-Adoptions-Telemetrie — idempotent
-- ---------------------------------------------------------
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
-- 3. update_my_push_token — DROP + CREATE, dann Grants EXPLIZIT restauriert
-- ---------------------------------------------------------
-- Sicher auf BEIDEN Ausgangszustaenden: existiert nur die alte 1-Parameter-
-- Fassung (Staging heute), entfernt DROP IF EXISTS genau sie. Existiert
-- bereits die neue 3-Parameter-Fassung (Production, nachdem 20260916120000
-- gelaufen ist), findet DROP IF EXISTS fuer die ALTE Signatur nichts mehr
-- (No-Op) und CREATE OR REPLACE ersetzt die neue Fassung durch eine
-- inhaltsgleiche Kopie ihrer selbst.
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

-- WICHTIG (siehe Kompat-Fundament-Migration): DROP entfernt ALLE Grants
-- des alten Objekts, eine neue Signatur beginnt ohne jeden. Explizit
-- restaurieren statt auf einen Datenbank-Default zu vertrauen — empirisch
-- ueber einen echten HTTP-Aufruf als "authenticated" verifiziert (nicht nur
-- per SQL-Superuser-Sitzung, die jede GRANT-Pruefung umgeht).
revoke execute on function public.update_my_push_token(text, int, text) from public, anon;
grant  execute on function public.update_my_push_token(text, int, text) to authenticated, service_role;


-- ---------------------------------------------------------
-- 4. Versions-Durchsetzung: Helfer — idempotent (create or replace)
-- ---------------------------------------------------------
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
-- 5. start_own_job — byte-identisch zur Fassung in 20260917000000
-- ---------------------------------------------------------
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
  -- Mindestversions-Durchsetzung nicht versehentlich entfernt, sobald sie
  -- start_own_job neu erstellt.
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


-- ---------------------------------------------------------
-- 6. complete_own_job — byte-identisch zur Fassung in 20260917000000
-- ---------------------------------------------------------
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
  -- Kompatibilitäts-Fundament (20260916120000): siehe start_own_job oben.
  perform public.enforce_min_client_version();

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


-- ---------------------------------------------------------
-- 7. set_job_assignments — byte-identisch zur Fassung in 20260917000000
-- ---------------------------------------------------------
create or replace function public.set_job_assignments(p_job_id uuid, p_employee_ids uuid[] default '{}'::uuid[])
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
  -- Kompatibilitäts-Fundament (20260916120000): siehe start_own_job oben.
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

revoke all on function public.set_job_assignments(uuid, uuid[]) from public, anon;
grant execute on function public.set_job_assignments(uuid, uuid[]) to authenticated;
