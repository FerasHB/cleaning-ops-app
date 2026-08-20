-- =========================================================
-- Absence Notifications (Urlaub / Krankheit) über Outbox/Dispatcher
-- =========================================================
-- Erweitert die bestehende notification_outbox/notification_deliveries-
-- Pipeline um Abwesenheits-Events. Die Job-Events (job_assigned,
-- job_started, job_completed) bleiben in Verhalten UND Dedupe unverändert.
--
-- GENERALISIERUNG (bewusst minimal):
--   Bis hierher war die Outbox job-gebunden (job_id NOT NULL). Abwesenheiten
--   haben keinen Auftrag, deshalb:
--     * job_id / job_status werden NULLABLE (Bestandszeilen bleiben unberührt)
--     * entity_type/entity_id tragen die generische Identität ('job'|'absence')
--     * absence_start_date/absence_end_date sind Schnappschüsse für den
--       Push-Text — gleiche Bauform wie die bestehenden customer_name/
--       service_name-Schnappschüsse, damit der Dispatcher NICHT gegen
--       employee_absences joinen muss (und der Text stabil bleibt, auch wenn
--       die Abwesenheit später geändert wird).
--   KEIN separater idempotency_key: (entity_type, entity_id, event_type)
--   deckt vier der fünf Events ab, das fünfte (sickness_updated) braucht
--   bewusst gar keine Uniqueness — siehe DEDUPE unten.
--
-- DEDUPE:
--   * vacation_requested / sickness_reported: je Abwesenheitszeile genau ein
--     Event. Ein "Retry" des RPC legt eine NEUE Abwesenheit an (neue id) —
--     das ist ein echter neuer Antrag, kein Duplikat.
--   * vacation_approved / vacation_rejected: admin_review_vacation geht nur
--     aus status='requested' heraus; ein zweiter Aufruf wirft bereits heute.
--     Pro Anfrage also strukturell genau EIN Review-Event.
--   * sickness_updated: darf über die Lebensdauer EINER Krankmeldung
--     MEHRFACH auftreten (Ende gesetzt, verlängert, verkürzt). Ein Unique-
--     Index auf (entity_id, event_type) wäre hier FALSCH — er würde die
--     zweite echte Änderung verschlucken. Stattdessen: Zeilensperre
--     (FOR UPDATE) + expliziter Diff-Vergleich. Ein echter Retry ist damit
--     automatisch ein No-Op, weil der erste Aufruf den Wert bereits
--     geschrieben hat und der Diff dann leer ist.
--
-- FAN-OUT: unverändert. fanout_notification_events() fächert weiterhin an
--   alle aktiven Admins der Firma auf (ohne den Akteur) — genau das, was
--   vacation_requested/sickness_reported/sickness_updated brauchen. Die
--   mitarbeitergerichteten Events (vacation_approved/rejected) schreiben ihre
--   Zustellung direkt und setzen fanned_out_at sofort, exakt wie job_assigned.

-- ---------------------------------------------------------
-- 1. Outbox generisch machen (additiv, Bestand unberührt)
-- ---------------------------------------------------------

alter table public.notification_outbox alter column job_id     drop not null;
alter table public.notification_outbox alter column job_status drop not null;

alter table public.notification_outbox
  add column if not exists entity_type        text,
  add column if not exists entity_id          uuid,
  add column if not exists absence_start_date date,
  add column if not exists absence_end_date   date;

comment on column public.notification_outbox.entity_type is
'Generische Entitaetsart des Events: ''job'' | ''absence''. job_id bleibt fuer '
'Job-Events zusaetzlich gesetzt (Kompatibilitaet + bestehende Indizes).';
comment on column public.notification_outbox.entity_id is
'ID der Entitaet (jobs.id bzw. employee_absences.id).';
comment on column public.notification_outbox.absence_start_date is
'Schnappschuss fuer den Push-Text von Abwesenheits-Events (NULL bei Job-Events).';
comment on column public.notification_outbox.absence_end_date is
'Schnappschuss; NULL bedeutet bei Krankheit bewusst "Ende offen".';

-- Bestandszeilen deterministisch nachziehen (alle bisherigen Events sind Job-Events).
update public.notification_outbox
set entity_type = 'job', entity_id = job_id
where entity_type is null and job_id is not null;

-- KOMPATIBILITAET: die drei bestehenden Job-Event-Produzenten
-- (set_job_assignments, start_own_job, complete_own_job) kennen entity_type/
-- entity_id nicht und setzen sie nicht. Ohne diesen Trigger wuerde die
-- CHECK-Constraint unten JEDE Job-Zuweisung und jeden Statuswechsel
-- abbrechen. Der Trigger leitet die generische Identitaet fuer Job-Zeilen
-- deterministisch aus job_id ab, sodass die bestehenden RPCs UNVERAENDERT
-- bleiben koennen und trotzdem jede Zeile die Invariante erfuellt.
-- (Trigger sind hier ein etabliertes Muster, vgl. set_updated_at und
-- enforce_profile_field_guard.)
create or replace function public.notification_outbox_fill_entity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.entity_type is null and new.job_id is not null then
    new.entity_type := 'job';
    new.entity_id   := coalesce(new.entity_id, new.job_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notification_outbox_fill_entity on public.notification_outbox;
create trigger trg_notification_outbox_fill_entity
  before insert on public.notification_outbox
  for each row execute function public.notification_outbox_fill_entity();

comment on function public.notification_outbox_fill_entity() is
'Fuellt entity_type/entity_id fuer Job-Events automatisch aus job_id, damit '
'die bestehenden Job-RPCs ohne Aenderung weiterlaufen und chk_notification_'
'outbox_entity trotzdem fuer jede Zeile gilt.';

-- Ein Job-Event MUSS weiterhin einen job_id tragen; ein Abwesenheits-Event nie.
alter table public.notification_outbox
  drop constraint if exists chk_notification_outbox_entity;
alter table public.notification_outbox
  add constraint chk_notification_outbox_entity check (
    (entity_type = 'job'     and job_id is not null and entity_id is not null)
    or
    (entity_type = 'absence' and job_id is null     and entity_id is not null)
  );

-- Dedupe fuer Abwesenheits-Events — bewusst OHNE sickness_updated (s. Kopf).
create unique index if not exists uq_notification_outbox_absence_event
  on public.notification_outbox(entity_id, event_type)
  where entity_type = 'absence' and event_type <> 'sickness_updated';

create index if not exists idx_notif_outbox_entity
  on public.notification_outbox(entity_type, entity_id);

-- ---------------------------------------------------------
-- 2. Interner Helper: Outbox-Event + (optional) Direktzustellung
-- ---------------------------------------------------------
-- Kapselt das wiederkehrende Muster der vier Absence-RPCs. NICHT von
-- Clients aufrufbar (revoke unten) — nur aus SECURITY DEFINER-RPCs heraus.
--
-- p_recipient_id IS NULL  -> Admin-Event: fanned_out_at bleibt NULL, der
--                            bestehende Fan-out uebernimmt (alle aktiven Admins).
-- p_recipient_id NOT NULL -> Mitarbeiter-Event: Zustellung direkt schreiben und
--                            fanned_out_at sofort setzen (wie job_assigned).
create or replace function public.enqueue_absence_notification(
  p_company_id   uuid,
  p_absence_id   uuid,
  p_event_type   text,
  p_employee_id  uuid,
  p_employee_name text,
  p_start_date   date,
  p_end_date     date,
  p_recipient_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_outbox_id uuid;
begin
  insert into public.notification_outbox (
    company_id, job_id, event_type, job_status,
    employee_id, employee_name,
    entity_type, entity_id, absence_start_date, absence_end_date,
    fanned_out_at
  )
  values (
    p_company_id, null, p_event_type, null,
    p_employee_id, p_employee_name,
    'absence', p_absence_id, p_start_date, p_end_date,
    case when p_recipient_id is null then null else now() end
  )
  on conflict (entity_id, event_type)
    where entity_type = 'absence' and event_type <> 'sickness_updated'
  do nothing
  returning id into v_outbox_id;

  -- Kein Rueckgabewert -> Event existierte bereits (Dedupe griff).
  if v_outbox_id is null then
    return null;
  end if;

  if p_recipient_id is not null then
    insert into public.notification_deliveries (
      outbox_id, company_id, recipient_id, next_attempt_at
    )
    values (v_outbox_id, p_company_id, p_recipient_id, now())
    on conflict (outbox_id, recipient_id) do nothing;
  end if;

  return v_outbox_id;
end;
$$;

comment on function public.enqueue_absence_notification(uuid, uuid, text, uuid, text, date, date, uuid) is
'Interner Helper: schreibt ein Abwesenheits-Outbox-Event. Ohne p_recipient_id '
'uebernimmt der bestehende Admin-Fan-out; mit p_recipient_id wird die '
'Zustellung direkt geschrieben (Mitarbeiter-Event). Nur aus autorisierten '
'RPCs aufrufbar.';

revoke all on function public.enqueue_absence_notification(uuid, uuid, text, uuid, text, date, date, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------
-- 3. request_own_vacation: + vacation_requested (an Admins)
-- ---------------------------------------------------------
-- Unveraendert gegenueber 20260816000000 bis auf den Outbox-Aufruf am Ende;
-- dieser liegt in DERSELBEN Transaktion wie der INSERT der Abwesenheit.
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

  -- Admin-Benachrichtigung, transaktional mit dem INSERT oben.
  perform public.enqueue_absence_notification(
    v_company_id, v_new_id, 'vacation_requested', auth.uid(),
    coalesce(nullif(btrim(v_full_name), ''), 'Unbekannt'),
    start_date_input, end_date_input, null
  );

  return query select * from public.employee_absences where id = v_new_id;
end;
$$;

revoke all on function public.request_own_vacation(date, date, text) from public, anon;
grant execute on function public.request_own_vacation(date, date, text) to authenticated;


-- ---------------------------------------------------------
-- 4. report_own_sickness: + sickness_reported (an Admins)
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

  perform public.enqueue_absence_notification(
    v_company_id, v_new_id, 'sickness_reported', auth.uid(),
    coalesce(nullif(btrim(v_full_name), ''), 'Unbekannt'),
    start_date_input, end_date_input, null
  );

  return query select * from public.employee_absences where id = v_new_id;
end;
$$;

revoke all on function public.report_own_sickness(date, date, text) from public, anon;
grant execute on function public.report_own_sickness(date, date, text) to authenticated;


-- ---------------------------------------------------------
-- 5. update_own_sickness_end: + sickness_updated NUR bei echter Aenderung
-- ---------------------------------------------------------
-- Die Vorgaenger-Version schrieb end_date BEDINGUNGSLOS (kein Diff, kein
-- Lock) und las das alte Enddatum ueberhaupt nicht. Jetzt:
--   * Zeilensperre (FOR UPDATE) -> zwei gleichzeitige Aufrufe werden
--     serialisiert, der zweite sieht den bereits geschriebenen Wert
--   * Diff mit IS DISTINCT FROM -> NULL-sicher (offen -> Datum, Datum ->
--     offen, verlaengert, verkuerzt zaehlen alle als Aenderung)
--   * Nur bei echter Aenderung wird geschrieben UND benachrichtigt; ein
--     No-Op-Save (gleiches Datum) erzeugt weder UPDATE noch Event.
-- Damit ist ein Retry automatisch idempotent, ohne Uniqueness-Index.
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
  v_old_end    date;
  v_company_id uuid;
  v_name       text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'employee' then
    raise exception 'Only employees can update their own sickness report'
      using errcode = '42501';
  end if;

  select start_date, end_date, company_id, employee_name_snapshot
    into v_start_date, v_old_end, v_company_id, v_name
  from public.employee_absences
  where id = absence_id_input
    and employee_id = auth.uid()
    and type = 'sickness'
    and status = 'reported'
  for update;

  if not found then
    raise exception 'Sickness report not found, not yours, or already closed'
      using errcode = '42501';
  end if;

  if new_end_date_input is not null and new_end_date_input < v_start_date then
    raise exception 'end_date must not be before start_date'
      using errcode = '23514';
  end if;

  -- ECHTE Aenderung? IS DISTINCT FROM behandelt NULL korrekt als Wert.
  if v_old_end is distinct from new_end_date_input then
    update public.employee_absences
    set end_date = new_end_date_input, updated_at = now()
    where id = absence_id_input;

    perform public.enqueue_absence_notification(
      v_company_id, absence_id_input, 'sickness_updated', auth.uid(),
      v_name, v_start_date, new_end_date_input, null
    );
  end if;

  return query select * from public.employee_absences where id = absence_id_input;
end;
$$;

comment on function public.update_own_sickness_end(uuid, date) is
'Mitarbeiter setzt/aendert das Enddatum der eigenen aktiven Krankmeldung, '
'ohne eine zweite Zeile anzulegen. NULL macht sie wieder offen-endig. Seit '
'20260821000000: sperrt die Zeile, schreibt NUR bei echter Aenderung und '
'erzeugt dann genau ein sickness_updated-Event (No-Op-Save = kein Event).';

revoke all on function public.update_own_sickness_end(uuid, date) from public, anon;
grant execute on function public.update_own_sickness_end(uuid, date) to authenticated;


-- ---------------------------------------------------------
-- 6. admin_review_vacation: + vacation_approved/rejected (an Mitarbeiter)
-- ---------------------------------------------------------
-- Der Empfaenger ist der Eigentuemer der Abwesenheit — er kommt aus der
-- Tabellenzeile (RETURNING), NIE aus einem Client-Parameter. Das UPDATE ist
-- bereits firmenskopiert, der Empfaenger stammt also zwangslaeufig aus der
-- eigenen Firma.
--
-- INAKTIVER MITARBEITER (bewusste Entscheidung): Event + Zustellung werden
-- trotzdem geschrieben. Die Review ist eine legitime fachliche Aktion und
-- darf nicht an der Benachrichtigung haengen; der Dispatcher stuft einen
-- inaktiven Empfaenger ohnehin als permanent_fail ein (und der Push-Token
-- wird bei Deaktivierung geleert). So bleibt der Vorgang nachvollziehbar,
-- statt still zu verschwinden.
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
  v_status     public.absence_status;
  v_employee   uuid;
  v_company_id uuid;
  v_name       text;
  v_start      date;
  v_end        date;
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

  update public.employee_absences
  set status = v_status,
      admin_note = admin_note_input,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  where id = absence_id_input
    and company_id = public.current_user_company_id()
    and type = 'vacation'
    and status = 'requested'
  returning employee_id, company_id, employee_name_snapshot, start_date, end_date
    into v_employee, v_company_id, v_name, v_start, v_end;

  if not found then
    raise exception 'Vacation request not found, not in your company, or already reviewed'
      using errcode = '42501';
  end if;

  -- Nur der Mitarbeiter selbst wird benachrichtigt (kein Admin-Fan-out).
  if v_employee is not null then
    perform public.enqueue_absence_notification(
      v_company_id, absence_id_input,
      case when v_status = 'approved' then 'vacation_approved' else 'vacation_rejected' end,
      v_employee, v_name, v_start, v_end, v_employee
    );
  end if;

  return query select * from public.employee_absences where id = absence_id_input;
end;
$$;

comment on function public.admin_review_vacation(uuid, text, text) is
'Admin genehmigt/lehnt eine Urlaubsanfrage der eigenen Firma ab (nur aus '
'status=requested). Krankmeldungen sind hierueber NICHT review-faehig. Seit '
'20260821000000: erzeugt transaktional genau ein vacation_approved- bzw. '
'vacation_rejected-Event, zugestellt ausschliesslich an den Antragsteller.';

revoke all on function public.admin_review_vacation(uuid, text, text) from public, anon;
grant execute on function public.admin_review_vacation(uuid, text, text) to authenticated;


-- ---------------------------------------------------------
-- 7. claim_notification_deliveries: Abwesenheits-Felder mitliefern
-- ---------------------------------------------------------
-- Der Rueckgabetyp aendert sich (vier neue Spalten), deshalb DROP + CREATE
-- statt CREATE OR REPLACE. Logik (FOR UPDATE SKIP LOCKED, Timeout-Reclaim,
-- attempts++) ist UNVERAENDERT — nur die Projektion waechst.
drop function if exists public.claim_notification_deliveries(uuid, int, int);

create or replace function public.claim_notification_deliveries(
  company_id_filter uuid default null,
  max_rows int default 50,
  processing_timeout_seconds int default 120
)
returns table (
  delivery_id uuid, outbox_id uuid, recipient_id uuid, attempts int,
  event_type text, job_id uuid, company_id uuid, job_status text,
  employee_id uuid, employee_name text, customer_name text, service_name text,
  expo_push_token text, recipient_active boolean, recipient_role text,
  entity_type text, entity_id uuid,
  absence_start_date date, absence_end_date date
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select d.id
    from public.notification_deliveries d
    where (company_id_filter is null or d.company_id = company_id_filter)
      and (
        (d.status = 'pending' and d.next_attempt_at <= now())
        or (d.status = 'processing'
            and d.claimed_at < now() - make_interval(secs => processing_timeout_seconds))
      )
    order by d.next_attempt_at
    for update skip locked
    limit max_rows
  ),
  claimed as (
    update public.notification_deliveries d
    set status = 'processing', claimed_at = now(), attempts = d.attempts + 1
    from due
    where d.id = due.id
    returning d.id, d.outbox_id, d.recipient_id, d.attempts
  )
  select
    c.id, c.outbox_id, c.recipient_id, c.attempts,
    o.event_type, o.job_id, o.company_id, o.job_status,
    o.employee_id, o.employee_name, o.customer_name, o.service_name,
    p.expo_push_token, p.is_active, p.role::text,
    o.entity_type, o.entity_id, o.absence_start_date, o.absence_end_date
  from claimed c
  join public.notification_outbox o on o.id = c.outbox_id
  left join public.profiles p on p.id = c.recipient_id;
end;
$$;

revoke all on function public.claim_notification_deliveries(uuid, int, int) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(uuid, int, int) to service_role;
