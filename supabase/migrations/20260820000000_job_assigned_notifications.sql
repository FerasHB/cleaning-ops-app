-- =========================================================
-- Job-Assigned Notifications — reliable outbox/dispatcher path
-- =========================================================
-- Ziel: die bisherige Job-Zuweisungs-Push (direkter Client-Fetch, NUR an
-- employeeIds[0]) durch dieselbe notification_outbox/notification_deliveries-
-- Pipeline ersetzen, die job_started/job_completed bereits zuverlässig nutzt.
-- ALLE neu zugewiesenen Mitarbeiter erhalten künftig genau EINE Zustellung.
--
-- Architekturentscheidung (siehe Implementierungsbericht, Teil 2):
-- job_id bleibt NOT NULL / unverändert. job_assigned ist wie job_started/
-- job_completed ein job-gebundenes Event — eine generische entity_type/
-- entity_id-Spalte (für später denkbare, NICHT job-gebundene Events wie
-- Urlaub/Krankheit) wird HIER bewusst NICHT eingeführt, weil sie in diesem
-- Arbeitspaket niemand liest (Urlaub/Krankheit/Kommentare sind explizit NICHT
-- Teil dieses Auftrags). Generalisiert werden nur die zwei Dinge, die
-- job_assigned tatsächlich braucht: das Dedupe-Modell (Teil 3) und das
-- Fan-out-Modell (Teil 7).
--
-- Dedupe-Modell:
--   * job_started/job_completed: UNVERÄNDERTES Verhalten — weiterhin exakt
--     eine Outbox-Zeile pro (job_id, event_type), jetzt als PARTIELLER Index
--     nur für diese beiden Event-Typen (vorher ein globaler Constraint, der
--     versehentlich auch job_assigned auf eine Zeile pro Job begrenzt hätte).
--   * job_assigned: dedupliziert über die neue Spalte assignment_id (FK auf
--     job_assignments.id) — EINE Outbox-Zeile pro tatsächlich neu
--     angelegter Zuweisungszeile. Das ist sowohl (a) retry-sicher (ein
--     erneuter Aufruf von set_job_assignments mit derselben Zielmenge legt
--     keine neue job_assignments-Zeile an, also entsteht auch keine neue
--     Outbox-Zeile) als auch (b) korrekt bei Entfernen+Wiederzuweisen
--     (eine neue job_assignments-Zeile bekommt eine neue assignment_id →
--     neue, berechtigte Benachrichtigung).
--
-- Fan-out-Modell:
--   * job_started/job_completed: UNVERÄNDERT über fanout_notification_events
--     (alle aktiven Admins der Firma, außer dem handelnden Mitarbeiter).
--   * job_assigned: KEIN Rollen-Fan-out nötig — der/die Empfänger (neu
--     zugewiesene(r) Mitarbeiter) ist zum Schreibzeitpunkt bereits exakt
--     bekannt (und in set_job_assignments bereits als aktiver Mitarbeiter
--     DERSELBEN Firma validiert, siehe v_invalid-Prüfung weiter oben in der
--     Funktion). set_job_assignments schreibt deshalb die zugehörige
--     notification_deliveries-Zeile DIREKT und setzt fanned_out_at sofort —
--     fanout_notification_events bleibt für job_assigned ungenutzt und
--     unverändert.
--
-- Transaktionssicherheit (Teil 5): die Outbox-/Delivery-Zeilen entstehen in
-- DERSELBEN Transaktion wie der job_assignments-INSERT (beides innerhalb von
-- set_job_assignments) — der Fehlermodus "Zuweisung erfolgreich, Push-Versand
-- schlägt still fehl" ist damit für die Erzeugung des Events strukturell
-- ausgeschlossen (nicht nur "meistens funktionierend" wie beim alten
-- Client-Fetch). Der tatsächliche Versand (Edge Function → Expo) bleibt wie
-- bisher async/retry-fähig über notification_deliveries.

-- ── 1) notification_outbox: assignment_id + Dedupe-Modell ──────────────

alter table public.notification_outbox
  add column if not exists assignment_id uuid
    references public.job_assignments(id) on delete set null;

comment on column public.notification_outbox.assignment_id is
'NUR für event_type=''job_assigned'': FK auf die job_assignments-Zeile, die '
'dieses Event ausgelöst hat. Dedupe-Schlüssel für Zuweisungs-Events (siehe '
'uq_notification_outbox_assignment) — NULL für job_started/job_completed.';

-- Alter, globaler Constraint hätte job_assigned fälschlich auf EINE Zeile
-- pro Job begrenzt (unabhängig vom Mitarbeiter). Ersetzt durch einen
-- partiellen Index, der NUR die beiden bestehenden Lifecycle-Events wie
-- bisher dedupliziert. Bestehende Zeilen verletzen den neuen (schwächeren)
-- Index nicht — jede alte (job_id, event_type)-Kombination war bereits
-- eindeutig.
alter table public.notification_outbox
  drop constraint if exists uq_notification_outbox_job_event;

create unique index if not exists uq_notification_outbox_job_lifecycle_event
  on public.notification_outbox(job_id, event_type)
  where event_type in ('job_started', 'job_completed');

create unique index if not exists uq_notification_outbox_assignment
  on public.notification_outbox(assignment_id)
  where assignment_id is not null;

-- ── 2) start_own_job / complete_own_job: nur die ON CONFLICT-Klausel ───
-- angepasst (partieller Index statt gelöschtem globalen Constraint).
-- Verhalten sonst UNVERÄNDERT gegenüber lib/schema.sql.

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

-- ── 3) set_job_assignments: job_assigned-Events für NEU eingefügte ─────
-- Zuweisungszeilen, in derselben Transaktion. Struktur/Validierung/Sperren
-- sonst UNVERÄNDERT gegenüber
-- supabase/migrations/20260728000000_occurrence_assignment_inheritance.sql.

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

comment on function public.set_job_assignments(uuid, uuid[]) is
'Ersetzt die Zuweisungsmenge EINES Auftrags transaktional (nur Admin, nur '
'eigene Firma). Validiert die gesamte Zielmenge vor dem ersten Schreibvorgang, '
'sperrt bei Terminen zuerst die Regel und dann den Termin, entfernt '
'ausschliesslich spurenfreie Zuweisungen und legt fehlende an. Markiert einen '
'Termin als individuell angepasst, sodass die Regel-Synchronisierung ihn nicht '
'mehr ueberschreibt. jobs.assigned_to wird nicht angefasst. Seit '
'20260820000000: schreibt fuer jede NEU angelegte Zuweisungszeile transaktional '
'ein job_assigned-Outbox-Event + eine direkte Zustellung (siehe '
'notification_outbox.assignment_id) — inherit_occurrence_assignments (Vererbung '
'auf Recurring-Occurrences) bleibt bewusst UNVERAENDERT und loest KEINE '
'Benachrichtigung aus, um bei der Termin-Materialisierung keinen '
'Benachrichtigungs-Sturm zu erzeugen.';

revoke all on function public.set_job_assignments(uuid, uuid[]) from public;
revoke all on function public.set_job_assignments(uuid, uuid[]) from anon;
grant execute on function public.set_job_assignments(uuid, uuid[]) to authenticated;
