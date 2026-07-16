-- =========================================================
-- ADMIN-PUSH bei Job-Statuswechsel durch Mitarbeiter
-- (Migration 20260717000000) — serverseitig, zustandsbehaftet
-- =========================================================
--
-- Ziel: Startet oder beendet ein Mitarbeiter einen Job, erhalten ALLE aktiven
-- Admins DERSELBEN Firma genau EINE Push-Benachrichtigung — zuverlässig, auch
-- wenn das Mitarbeitergerät unmittelbar nach dem Statuswechsel offline geht
-- oder die App geschlossen wird.
--
-- Architektur (vollständig server-first):
--   1. EVENT (transaktional):  start_own_job / complete_own_job schreiben beim
--      ECHTEN Statusübergang eine Zeile in public.notification_outbox — in
--      derselben Transaktion wie der jobs-UPDATE. Der Job-Status wird NIE
--      zurückgerollt, egal was beim späteren Versand passiert.
--   2. FAN-OUT:  fanout_notification_events() erzeugt pro Event eine
--      notification_deliveries-Zeile je aktivem Admin-Empfänger (ohne den
--      auslösenden Mitarbeiter, ohne deaktivierte Admins, ohne Admins ohne
--      Push-Token). PRO EMPFÄNGER, damit ein Teilerfolg (Admin A ok, Admin B
--      Fehler) NUR den fehlgeschlagenen Empfänger erneut versucht.
--   3. CLAIM:  claim_notification_deliveries() nimmt fällige Deliveries ATOMAR
--      per FOR UPDATE SKIP LOCKED (Zustand pending->processing). Mehrere
--      parallele Dispatcher können dieselbe Zeile nicht gleichzeitig senden.
--      Hängende processing-Zeilen werden nach Timeout erneut geclaimt (Crash
--      nach Claim, vor Versand -> Recovery).
--   4. VERSAND:  Die Edge Function (supabase/functions/dispatch-notifications)
--      sendet je Delivery genau EINEN Expo-Push, wertet das EINZELNE Ticket aus
--      und ruft complete_notification_delivery() mit dem Ergebnis auf.
--   5. AUSLÖSUNG:  serverseitig (Database Webhook auf INSERT + pg_cron-Sweeper
--      1x/Minute) — UNABHÄNGIG vom Mitarbeitergerät. Der optionale Client-Kick
--      bleibt nur als Beschleunigung. Einrichtung siehe
--      supabase/functions/dispatch-notifications/DEPLOY.md.
--
-- Zustandsmaschine (auf notification_deliveries, NICHT auf dem Event):
--   pending --claim--> processing --sent--> sent            (Erfolg)
--                              \--retry--> pending (Backoff) (temporärer Fehler)
--                              \--fail-->  failed            (endgültig / max Versuche)
--   sent_at wird AUSSCHLIESSLICH beim Übergang -> sent gesetzt (nach Erfolg).
--
-- Diese Migration ist additiv und idempotent. Wie alle Schemaänderungen hier
-- MANUELL im Supabase SQL Editor anwenden (siehe CLAUDE.md).

-- =========================================================
-- TABLE: notification_outbox  (Event-Log, transaktional)
-- =========================================================
create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  event_type text not null,                 -- 'job_started' | 'job_completed'
  job_status text not null,                 -- 'in_progress' | 'completed'
  employee_id uuid references public.profiles(id) on delete set null,
  employee_name text,
  customer_name text,
  service_name text,
  created_at timestamptz not null default now(),
  -- NULL = noch nicht in Deliveries aufgefächert. Wird von
  -- fanout_notification_events() gesetzt.
  fanned_out_at timestamptz,
  -- Idempotenz-Gürtel: pro Job höchstens EIN start- und EIN complete-Event.
  -- Korrekt unter der ANNAHME "kein Reopen" (siehe Kommentar am Dateiende).
  constraint uq_notification_outbox_job_event unique (job_id, event_type)
);

-- =========================================================
-- TABLE: notification_deliveries  (pro Empfänger, Zustandsmaschine)
-- =========================================================
create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.notification_outbox(id) on delete cascade,
  -- denormalisiert vom Event → einfache, indexierbare Company-Filterung im Claim
  company_id uuid not null references public.companies(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',
  attempts int not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,                       -- NUR nach erfolgreichem Versand
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  constraint uq_notification_deliveries_recipient unique (outbox_id, recipient_id),
  constraint chk_notification_deliveries_status
    check (status in ('pending', 'processing', 'sent', 'failed'))
);

-- =========================================================
-- INDEXES
-- =========================================================
create index if not exists idx_notif_outbox_unfanned
  on public.notification_outbox(created_at) where fanned_out_at is null;
create index if not exists idx_notif_outbox_job
  on public.notification_outbox(job_id);

create index if not exists idx_notif_deliveries_due
  on public.notification_deliveries(next_attempt_at)
  where status in ('pending', 'processing');
create index if not exists idx_notif_deliveries_outbox
  on public.notification_deliveries(outbox_id);
create index if not exists idx_notif_deliveries_company_status
  on public.notification_deliveries(company_id, status);

-- =========================================================
-- RLS: an, KEINE Policies + Grants entzogen
-- =========================================================
-- Normale (authenticated/anon) Clients haben KEINEN direkten Zugriff. Nur
-- SECURITY DEFINER-RPCs (Insert/Claim/Complete) und der Service-Role-Key der
-- Edge Function kommen daran vorbei.
alter table public.notification_outbox enable row level security;
alter table public.notification_deliveries enable row level security;
revoke all on public.notification_outbox from anon, authenticated;
revoke all on public.notification_deliveries from anon, authenticated;

comment on table public.notification_outbox is
'Event-Log für Admin-Push bei Job-Statuswechsel. Zeilen werden von start_own_job/complete_own_job (SECURITY DEFINER) NUR bei echtem Statusübergang transaktional geschrieben. fanned_out_at markiert die Auffächerung in notification_deliveries. UNIQUE(job_id,event_type) + Übergangs-Guard verhindern doppelte Events.';
comment on table public.notification_deliveries is
'Pro-Empfänger-Zustandsmaschine (pending|processing|sent|failed) für Admin-Push. sent_at wird erst NACH erfolgreichem Expo-Versand gesetzt. Getrennte Zeilen pro Admin -> Teilerfolg wird nicht erneut an bereits erreichte Admins gesendet.';

-- =========================================================
-- RPC: START OWN JOB (Event beim echten Übergang open->in_progress)
-- =========================================================
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
    completed_at = null
  where id = job_id_input
    and assigned_to = auth.uid()
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'   -- Parent-Recurring-Regeln dürfen nicht gestartet werden
    and status = 'open'       -- NUR der echte Übergang open -> in_progress
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

  -- Kein Übergang: idempotenter No-Op vs. nicht erlaubt unterscheiden.
  select * into existing_row
  from public.jobs
  where id = job_id_input
    and assigned_to = auth.uid()
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single';

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  -- Eigener Job, aber bereits in_progress/completed -> Start ist ein legitimer
  -- idempotenter No-Op (retry-/doppeltap-sicher), KEIN zweites Event.
  return coalesce(existing_row.started_at, started_at_input);
end;
$$;

grant execute on function public.start_own_job(uuid, timestamptz) to authenticated;

-- =========================================================
-- RPC: COMPLETE OWN JOB (Event beim echten Übergang in_progress->completed)
-- =========================================================
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
    completed_at = completed_at_input
  where id = job_id_input
    and assigned_to = auth.uid()
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single'          -- Parent-Recurring-Regeln nicht abschließbar
    and status = 'in_progress'       -- NUR der echte Übergang in_progress -> completed
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
    and assigned_to = auth.uid()
    and company_id = public.current_user_company_id()
    and public.current_user_role() = 'employee'
    and job_type = 'single';

  if not found then
    raise exception 'Job not found or not allowed';
  end if;

  -- Bereits abgeschlossen -> idempotenter No-Op (retry-sicher), KEIN zweites Event.
  if existing_row.status = 'completed' then
    return coalesce(existing_row.completed_at, completed_at_input);
  end if;

  -- Eigener Job, aber (noch) nicht in_progress (z. B. 'open'): NICHT als Erfolg
  -- vortäuschen. Ein Abschluss ohne vorherigen Start ist ein Anomaliefall und
  -- muss sichtbar scheitern (statt still einen falschen Erfolg zu liefern).
  raise exception 'Job not in progress (cannot complete)';
end;
$$;

grant execute on function public.complete_own_job(uuid, timestamptz) to authenticated;

-- =========================================================
-- RPC: FAN-OUT  (Event -> pro-Empfänger-Deliveries, idempotent)
-- =========================================================
-- Erzeugt für noch nicht aufgefächerte Events je eine Delivery-Zeile pro
-- aktivem Admin der Firma (ohne Auslöser, ohne Deaktivierte, nur mit Token).
-- FOR UPDATE SKIP LOCKED auf dem Event -> zwei parallele Dispatcher fächern
-- dasselbe Event nicht doppelt auf. on conflict do nothing -> Delivery-Insert
-- ist idempotent. company_id_filter = NULL heißt "alle Firmen" (Server-Sweep).
create or replace function public.fanout_notification_events(
  company_id_filter uuid default null,
  max_events int default 100
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  evt record;
  n int := 0;
begin
  for evt in
    select o.id, o.company_id, o.employee_id
    from public.notification_outbox o
    where o.fanned_out_at is null
      and (company_id_filter is null or o.company_id = company_id_filter)
    order by o.created_at
    for update skip locked
    limit max_events
  loop
    insert into public.notification_deliveries (
      outbox_id, company_id, recipient_id, next_attempt_at
    )
    select evt.id, evt.company_id, p.id, now()
    from public.profiles p
    where p.company_id = evt.company_id
      and p.role = 'admin'
      and p.is_active = true
      and p.expo_push_token is not null
      and (evt.employee_id is null or p.id <> evt.employee_id)
    on conflict (outbox_id, recipient_id) do nothing;

    update public.notification_outbox set fanned_out_at = now() where id = evt.id;
    n := n + 1;
  end loop;

  return n;
end;
$$;

-- =========================================================
-- RPC: CLAIM  (fällige Deliveries atomar übernehmen)
-- =========================================================
-- Nimmt fällige (pending & next_attempt_at<=now) ODER hängende (processing &
-- claimed_at älter als Timeout) Deliveries per FOR UPDATE SKIP LOCKED, setzt
-- sie auf processing, erhöht attempts und liefert alles zum Versand Nötige
-- inkl. AKTUELLEM Empfänger-Token/Status (Re-Read -> respektiert zwischen-
-- zeitliche Deaktivierung/Token-Wechsel). company_id_filter = NULL = alle Firmen.
create or replace function public.claim_notification_deliveries(
  company_id_filter uuid default null,
  max_rows int default 50,
  processing_timeout_seconds int default 120
)
returns table (
  delivery_id uuid,
  outbox_id uuid,
  recipient_id uuid,
  attempts int,
  event_type text,
  job_id uuid,
  company_id uuid,
  job_status text,
  employee_id uuid,
  employee_name text,
  customer_name text,
  service_name text,
  expo_push_token text,
  recipient_active boolean,
  recipient_role text
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
    set status = 'processing',
        claimed_at = now(),
        attempts = d.attempts + 1
    from due
    where d.id = due.id
    returning d.id, d.outbox_id, d.recipient_id, d.attempts
  )
  select
    c.id, c.outbox_id, c.recipient_id, c.attempts,
    o.event_type, o.job_id, o.company_id, o.job_status,
    o.employee_id, o.employee_name, o.customer_name, o.service_name,
    p.expo_push_token, p.is_active, p.role::text
  from claimed c
  join public.notification_outbox o on o.id = c.outbox_id
  left join public.profiles p on p.id = c.recipient_id;
end;
$$;

-- =========================================================
-- RPC: COMPLETE DELIVERY  (Zustandsübergang nach Sendeversuch)
-- =========================================================
-- outcome:
--   'sent'           -> status=sent, sent_at=now()  (Erfolg; sent_at NUR hier)
--   'permanent_fail' -> status=failed               (z. B. DeviceNotRegistered)
--   'retry'          -> attempts>=max ? failed : pending mit Backoff (next_attempt_at)
-- Backoff: 60s * 2^(attempts-1), gedeckelt auf 3600s (attempts wurde beim Claim
-- bereits erhöht). Rückgabe = resultierender Status.
create or replace function public.complete_notification_delivery(
  delivery_id_input uuid,
  outcome text,
  error_input text default null,
  max_attempts int default 5
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts int;
begin
  select attempts into v_attempts
  from public.notification_deliveries
  where id = delivery_id_input;

  if not found then
    return null;
  end if;

  if outcome = 'sent' then
    update public.notification_deliveries
      set status = 'sent', sent_at = now(), last_error = null
      where id = delivery_id_input;
    return 'sent';

  elsif outcome = 'permanent_fail' then
    update public.notification_deliveries
      set status = 'failed', last_error = error_input
      where id = delivery_id_input;
    return 'failed';

  elsif outcome = 'retry' then
    if v_attempts >= max_attempts then
      update public.notification_deliveries
        set status = 'failed',
            last_error = coalesce(error_input, 'max attempts reached')
        where id = delivery_id_input;
      return 'failed';
    end if;

    update public.notification_deliveries
      set status = 'pending',
          last_error = error_input,
          next_attempt_at = now()
            + make_interval(secs => least(3600, (60 * power(2, greatest(v_attempts - 1, 0)))::int))
      where id = delivery_id_input;
    return 'pending';

  else
    raise exception 'Unknown outcome: %', outcome;
  end if;
end;
$$;

-- Dispatcher-RPCs: nur für den Service-Role-Key der Edge Function bestimmt.
-- WICHTIG: explizit AUCH von anon/authenticated entziehen, NICHT nur von public.
-- Supabase vergibt EXECUTE auf neue Funktionen per Default-Privileges DIREKT an
-- anon/authenticated/service_role — ein reines "revoke from public" lässt diese
-- Direkt-Grants bestehen (sonst könnte ein anon-Client claim_notification_
-- deliveries(null,…) aufrufen und firmenübergreifend Push-Tokens/Namen lesen).
-- SQL-Tests laufen als postgres (Superuser) und sind davon unberührt.
revoke all on function public.fanout_notification_events(uuid, int) from public, anon, authenticated;
revoke all on function public.claim_notification_deliveries(uuid, int, int) from public, anon, authenticated;
revoke all on function public.complete_notification_delivery(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.fanout_notification_events(uuid, int) to service_role;
grant execute on function public.claim_notification_deliveries(uuid, int, int) to service_role;
grant execute on function public.complete_notification_delivery(uuid, text, text, int) to service_role;

comment on function public.start_own_job(uuid, timestamptz) is
'Employee startet nur eigenen zugewiesenen Single-Job der eigenen Firma. Nur der echte Übergang open->in_progress schreibt eine notification_outbox-Zeile. Bereits gestartet/abgeschlossen = idempotenter No-Op ohne Event.';
comment on function public.complete_own_job(uuid, timestamptz) is
'Employee schließt nur eigenen zugewiesenen Single-Job der eigenen Firma ab. Nur der echte Übergang in_progress->completed schreibt eine notification_outbox-Zeile. Bereits abgeschlossen = idempotenter No-Op. Abschluss eines nicht gestarteten (open) Jobs wirft bewusst (kein falscher Erfolg).';
comment on function public.fanout_notification_events(uuid, int) is
'Fächert offene Outbox-Events pro aktivem Admin-Empfänger in notification_deliveries auf (idempotent, FOR UPDATE SKIP LOCKED). Nur Service Role.';
comment on function public.claim_notification_deliveries(uuid, int, int) is
'Nimmt fällige/hängende Deliveries atomar (FOR UPDATE SKIP LOCKED), setzt processing + attempts, liefert aktuellen Empfänger-Token/Status. Nur Service Role.';
comment on function public.complete_notification_delivery(uuid, text, text, int) is
'Zustandsübergang nach Sendeversuch: sent | permanent_fail | retry(Backoff/failed bei max). sent_at NUR bei Erfolg. Nur Service Role.';

-- =========================================================
-- ANNAHMEN / ABWÄRTSKOMPATIBILITÄT
-- =========================================================
-- REOPEN NICHT UNTERSTÜTZT: Ein Job durchläuft open->in_progress->completed
--   GENAU EINMAL. Es gibt keinen Pfad, der einen abgeschlossenen Job wieder auf
--   'open' setzt (updateJob fasst status nicht an; Occurrences sind eigene
--   Zeilen mit eigener job_id). Daher ist UNIQUE(job_id, event_type) korrekt.
--   WIRD REOPEN EINGEFÜHRT, muss ein Übergangs-Diskriminator (z. B. eine
--   reopen_count/attempt-Spalte auf jobs) in den Event-Dedup-Key aufgenommen
--   werden, damit ein Neustart ein NEUES Event erzeugt. Der Übergangs-Guard in
--   start_own_job/complete_own_job würde einen Reopen->Neustart zwar zulassen,
--   die UNIQUE-Constraint würde das neue Event dann aber (fälschlich) schlucken.
-- ABWÄRTSKOMPATIBEL: Es werden nur Tabellen/RPCs hinzugefügt bzw. ersetzt; an
--   der jobs-Tabelle ändert sich NICHTS. Bestehende Jobs/Occurrences behalten
--   Status/started_at/completed_at. Vor dieser Migration abgeschlossene Jobs
--   erzeugen KEINE nachträglichen Events (nur zukünftige Übergänge zählen).
