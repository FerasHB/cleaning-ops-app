-- =========================================================
-- ENFORCE: deaktivierte Profile (profiles.is_active = false)
-- verlieren serverseitig sämtlichen Zugriff — nicht nur ein UI-Flag.
-- =========================================================
--
-- Zentraler Ansatz statt Policy-für-Policy-Duplikation:
-- current_user_role() und current_user_company_id() lösen für ein
-- inaktives (oder fehlendes) Profil bewusst NULL auf. Da praktisch
-- jede RLS-Policy und jede SECURITY DEFINER-RPC in diesem Schema über
-- genau diese beiden Helper läuft, propagiert NULL automatisch durch
-- alle WHERE/USING/WITH CHECK-Klauseln (`NULL = x` → NULL → Zeile wird
-- nicht zurückgegeben / nicht getroffen). Betroffen sind damit ohne
-- weitere Änderung: jobs (Read/Insert/Update/Delete), job_comments,
-- job_comment_reads, job_photos, storage.objects (job-photos),
-- get_unread_comment_job_ids, start_own_job, complete_own_job,
-- generate_job_occurrences, update_job_occurrences.
--
-- Bewusste Ausnahme: "employee read own profile" (id = auth.uid())
-- bleibt unverändert — ein deaktivierter Nutzer muss sein eigenes
-- is_active weiterhin lesen können, damit Client-seitig ein sauberer
-- Logout mit klarer Meldung ausgelöst werden kann (kein toter Nutzer,
-- der nie erfährt, warum nichts mehr funktioniert).
--
-- Realtime: "employee read own profile" erlaubt weiterhin das Lesen
-- der eigenen Zeile unabhängig von is_active → ein Postgres-Changes-
-- Abo auf die eigene profiles-Zeile empfängt das UPDATE, das is_active
-- auf false setzt, auch dann noch zuverlässig (siehe AuthContext.tsx).
--
-- Diese Migration ändert nur Funktionsdefinitionen (CREATE OR REPLACE)
-- und Policies (DROP + CREATE) — keine bereits angewandte Migration
-- wird rückwirkend editiert.

-- =========================================================
-- 1) current_user_role() / current_user_company_id()
--    → NULL für inaktive Profile
-- =========================================================

create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
    and is_active = true
  limit 1;
$$;

create or replace function public.current_user_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id
  from public.profiles
  where id = auth.uid()
    and is_active = true
  limit 1;
$$;

-- Defensive Bereinigung: frühere Migrationen (20260624_fix_generate_
-- occurrences_conflict.sql, 20260624_recurrence_date_range.sql) haben je
-- nach Ausführungsreihenfolge potenziell einen zweiten Overload
-- generate_job_occurrences(uuid, int)/update_job_occurrences(uuid, int)
-- hinterlassen (derselbe Bug-Typ, den 20260624_drop_old_weeks_ahead_rpc_
-- overloads.sql schon einmal beheben sollte). "CREATE OR REPLACE FUNCTION"
-- unten ersetzt NUR die exakt gleiche (uuid)-Signatur, ein evtl.
-- verbliebener (uuid, int)-Overload würde sonst weiter existieren und
-- Aufrufe mit nur einem Argument mehrdeutig machen (SQLSTATE 42725).
-- Sicher/idempotent: "drop ... if exists" ist ein no-op, falls der
-- Overload gar nicht (mehr) existiert.
drop function if exists public.generate_job_occurrences(uuid, int);
drop function if exists public.update_job_occurrences(uuid, int);

-- =========================================================
-- 2) generate_job_occurrences / update_job_occurrences
--    a) "!= 'admin'" → "IS DISTINCT FROM 'admin'"
--       (NULL-sicher: current_user_role() liefert jetzt bei inaktiven
--       Profilen NULL. "NULL != 'admin'" ist NULL, und "IF NULL THEN"
--       löst in PL/pgSQL NICHT aus — der Admin-Guard würde für ein
--       inaktives/gelöschtes Profil sonst still übersprungen.)
--    b) neu generierte Occurrences werden NICHT an einen inzwischen
--       inaktiven Mitarbeiter gebunden, sondern offen (unassigned)
--       erzeugt — konsistent mit "keine neuen Jobs an inaktive
--       Mitarbeiter" (siehe Trigger unten für create/update).
-- =========================================================

create or replace function public.generate_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public
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

  -- Ist der zugewiesene Mitarbeiter inzwischen deaktiviert, werden neue
  -- Occurrences offen (unassigned) statt an ihn gebunden erzeugt.
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

  -- Startpunkt: frühestens heute, damit keine Alttermine entstehen
  generation_start := greatest(
    coalesce(parent.recurrence_start_date, current_date),
    current_date
  );

  -- Hartes Maximum: 730 Tage ab Startpunkt
  hard_limit := generation_start + interval '730 days';

  -- Endpunkt: Enddatum des Parents (begrenzt durch hard_limit)
  -- Kein Enddatum → 3 Monate voraus
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

    -- extract(isodow) ist locale-unabhängig: 1=Mo, 2=Di, ..., 7=So
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

  return inserted_count;
end;
$$;

comment on function public.generate_job_occurrences(uuid) is
'Erzeugt konkrete Single-Jobs aus Recurring-Regel. Zeitraum aus recurrence_start/end_date. '
'Hartes Maximum: 730 Tage. Idempotent. Weist keine Occurrence einem inaktiven Mitarbeiter zu.';

create or replace function public.update_job_occurrences(
  parent_job_id_input uuid
)
returns int
language plpgsql
security definer
set search_path = public
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
    and parent_job_id is null;

  if not found then
    raise exception 'Recurring parent job not found';
  end if;

  delete from public.jobs
  where parent_job_id = parent_job_id_input
    and status        = 'open'
    and date          >= current_date;

  select public.generate_job_occurrences(parent_job_id_input)
  into new_count;

  return new_count;
end;
$$;

-- =========================================================
-- 3) Push-Token-RPCs
--    a) update_my_push_token: schlägt jetzt explizit fehl, wenn das
--       Profil inaktiv ist (verhindert, dass ein deaktivierter
--       Mitarbeiter sich durch bloßen App-Neustart einen frischen
--       Push-Token registriert und weiter Benachrichtigungen erhält).
--    b) clear_my_push_token (NEU): löscht den eigenen Token IMMER,
--       unabhängig von is_active — wird beim Logout aufgerufen, auch
--       wenn der Nutzer inzwischen deaktiviert wurde. Darf nie hart
--       fehlschlagen (best effort, damit Logout nicht blockiert wird).
-- =========================================================

create or replace function public.update_my_push_token(new_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.profiles
  set expo_push_token = new_token
  where id = auth.uid()
    and is_active = true;

  if not found then
    raise exception 'Account is inactive or not found';
  end if;
end;
$$;

create or replace function public.clear_my_push_token()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  update public.profiles
  set expo_push_token = null
  where id = auth.uid();
end;
$$;

grant execute on function public.clear_my_push_token() to authenticated;

comment on function public.update_my_push_token(text) is
'Updates only the current user expo push token safely via RPC. Fails if the caller profile is inactive.';

comment on function public.clear_my_push_token() is
'Clears only the current user expo push token. Always succeeds for any authenticated caller (active or not) — used on logout so a shared device never keeps a stale token bound to the previous user.';

-- =========================================================
-- 4) Trigger: inaktive Mitarbeiter können keinem Job (mehr) zugewiesen
--    werden — weder neu (INSERT) noch durch nachträgliche Umzuweisung
--    (UPDATE, nur wenn assigned_to sich tatsächlich ändert). Läuft auf
--    Tabellenebene, greift also unabhängig davon, ob der Schreibzugriff
--    über RLS (Admin-Client) oder über eine SECURITY DEFINER-RPC
--    (z. B. generate_job_occurrences) erfolgt.
-- =========================================================

create or replace function public.enforce_active_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- INSERT und UPDATE getrennt behandelt (statt einer kombinierten
  -- Bedingung mit "TG_OP = 'INSERT' OR NEW.x IS DISTINCT FROM OLD.x"):
  -- OLD existiert bei INSERT schlicht nicht — ein separater Zweig
  -- vermeidet jeden Zugriff auf OLD in diesem Fall.
  if tg_op = 'INSERT' then
    if new.assigned_to is not null and not exists (
      select 1 from public.profiles p
      where p.id = new.assigned_to
        and p.is_active = true
    ) then
      raise exception 'Employee is inactive and cannot be assigned to a job';
    end if;

    return new;
  end if;

  if new.assigned_to is not null
     and new.assigned_to is distinct from old.assigned_to
     and not exists (
       select 1 from public.profiles p
       where p.id = new.assigned_to
         and p.is_active = true
     )
  then
    raise exception 'Employee is inactive and cannot be assigned to a job';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_active_assignee_on_jobs on public.jobs;
create trigger enforce_active_assignee_on_jobs
before insert or update on public.jobs
for each row
execute function public.enforce_active_assignee();

comment on function public.enforce_active_assignee() is
'BEFORE INSERT/UPDATE Guard auf jobs: verhindert (Neu-)Zuweisung an einen inaktiven Mitarbeiter, unabhängig vom schreibenden Pfad (RLS oder SECURITY DEFINER RPC).';
