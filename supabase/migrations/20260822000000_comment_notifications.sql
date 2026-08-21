-- =========================================================
-- Comment Notifications (job_comments) über Outbox/Dispatcher
-- =========================================================
-- Neue Kommentare erzeugen bisher nur den In-App-Ungelesen-Punkt, aber keine
-- Push-Benachrichtigung. Dieses Event schließt die Lücke über dieselbe
-- notification_outbox/notification_deliveries-Pipeline wie Job- und
-- Abwesenheits-Events.
--
-- WARUM TRIGGER STATT RPC (bewusste Abweichung von den bisherigen Events):
--   Job- und Abwesenheits-Events brauchten eine RPC, weil RLS den fachlichen
--   Schreibvorgang selbst blockierte (Employees duerfen jobs/employee_absences
--   nicht direkt schreiben). Kommentare sind anders: der Client INSERTet
--   bereits direkt in job_comments und die vier INSERT-Policies regeln die
--   Autorisierung vollstaendig und korrekt.
--   Eine neue RPC muesste diese Policy-Logik in SECURITY DEFINER-Code
--   nachbauen (und damit duplizieren/riskieren), oder den Schreibpfad an den
--   Policies vorbeifuehren. Ein AFTER-INSERT-Trigger ist dagegen
--   transaktional per Konstruktion, laesst den bestehenden, RLS-geschuetzten
--   Schreibpfad UNVERAENDERT und braucht keine Client-Aenderung.
--   Trigger sind hier ein etabliertes Muster (set_updated_at,
--   enforce_profile_field_guard, notification_outbox_fill_entity).
--
-- FAN-OUT (Option A: EIN Event, N Zustellungen):
--   Ein Kommentar = eine Outbox-Zeile + eine Zustellung je Empfaenger. Das
--   entspricht der bestehenden Architektur. fanout_notification_events() ist
--   allerdings fest auf Admins verdrahtet und kann die GEMISCHTE
--   Empfaengermenge (Admins UND zugewiesene Mitarbeiter) nicht abbilden —
--   deshalb schreibt der Trigger die Zustellungen direkt und setzt
--   fanned_out_at sofort, exakt wie job_assigned und die
--   mitarbeitergerichteten Abwesenheits-Events. fanout_notification_events
--   bleibt damit UNVERAENDERT.
--
-- DEDUPE: entity_id = job_comments.id. Jeder Kommentar ist eine eigene Zeile
--   mit eigener id, also erzeugt jeder Kommentar genau ein Event; zwei
--   verschiedene Kommentare am selben Job erzeugen zwei Events. Die
--   Zustellungs-Eindeutigkeit (outbox_id, recipient_id) verhindert zusaetzlich
--   doppelte Empfaenger, falls jemand in zwei Empfaengergruppen faellt.

-- ---------------------------------------------------------
-- 1. entity_type 'comment' erlauben
-- ---------------------------------------------------------
-- Ein Kommentar-Event traegt BEIDES: entity_id = Kommentar-ID (Dedupe) und
-- job_id (Deep-Link auf den Auftrag).
alter table public.notification_outbox
  drop constraint if exists chk_notification_outbox_entity;
alter table public.notification_outbox
  add constraint chk_notification_outbox_entity check (
    (entity_type = 'job'     and job_id is not null and entity_id is not null)
    or
    (entity_type = 'absence' and job_id is null     and entity_id is not null)
    or
    (entity_type = 'comment' and job_id is not null and entity_id is not null)
  );

create unique index if not exists uq_notification_outbox_comment_event
  on public.notification_outbox(entity_id, event_type)
  where entity_type = 'comment';

-- ---------------------------------------------------------
-- 2. Trigger: Kommentar -> Outbox-Event + Zustellungen
-- ---------------------------------------------------------
-- SECURITY DEFINER ist noetig, weil der Trigger als der EINFUEGENDE Nutzer
-- laeuft: ein Mitarbeiter darf weder fremde profiles-Zeilen lesen (um die
-- Admins zu finden) noch in die notification_*-Tabellen schreiben (RLS an,
-- keine Policies). Die Empfaengermenge wird ausschliesslich serverseitig aus
-- NEW.job_id / NEW.company_id / NEW.author_id abgeleitet — es gibt keinen
-- Client-Parameter, dem hier vertraut wird.
create or replace function public.notify_job_comment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_author_role   text;
  v_author_name   text;
  v_customer_name text;
  v_service_name  text;
  v_outbox_id     uuid;
begin
  select p.role::text, coalesce(nullif(btrim(p.full_name), ''), 'Unbekannt')
    into v_author_role, v_author_name
  from public.profiles p
  where p.id = new.author_id;

  -- Autor nicht auffindbar (z. B. geloeschtes Konto) -> kein Event, aber der
  -- Kommentar selbst bleibt bestehen. Die Benachrichtigung ist additiv und
  -- darf den fachlichen Schreibvorgang nie scheitern lassen.
  if v_author_role is null then
    return new;
  end if;

  select j.customer_name, j.service_name
    into v_customer_name, v_service_name
  from public.jobs j
  where j.id = new.job_id;

  insert into public.notification_outbox (
    company_id, job_id, event_type, job_status,
    employee_id, employee_name, customer_name, service_name,
    entity_type, entity_id, fanned_out_at
  )
  values (
    new.company_id, new.job_id, 'comment_added', null,
    new.author_id, v_author_name, v_customer_name, v_service_name,
    'comment', new.id, now()
  )
  on conflict (entity_id, event_type) where entity_type = 'comment'
  do nothing
  returning id into v_outbox_id;

  if v_outbox_id is null then
    return new;
  end if;

  -- Empfaenger A: alle AKTIVEN Mitarbeiter, die dem Auftrag zugewiesen sind
  -- (volle Zuweisungsmenge, nicht nur der Legacy-Primaer), ohne den Autor.
  -- Firmenscope doppelt geprueft (Verteidigung in der Tiefe).
  insert into public.notification_deliveries (
    outbox_id, company_id, recipient_id, next_attempt_at
  )
  select distinct v_outbox_id, new.company_id, p.id, now()
  from public.job_assignments ja
  join public.profiles p on p.id = ja.employee_id
  where ja.job_id      = new.job_id
    and ja.employee_id is not null
    and p.is_active    = true
    and p.role         = 'employee'
    and p.company_id   = new.company_id
    and p.id          <> new.author_id
  on conflict (outbox_id, recipient_id) do nothing;

  -- Empfaenger B: bei einem MITARBEITER-Kommentar zusaetzlich alle aktiven
  -- Admins der Firma. Kommentiert ein Admin, werden andere Admins bewusst
  -- NICHT benachrichtigt (Beta-Scope: keine Admin-zu-Admin-Benachrichtigung).
  if v_author_role = 'employee' then
    insert into public.notification_deliveries (
      outbox_id, company_id, recipient_id, next_attempt_at
    )
    select v_outbox_id, new.company_id, p.id, now()
    from public.profiles p
    where p.company_id = new.company_id
      and p.role       = 'admin'
      and p.is_active  = true
      and p.id        <> new.author_id
    on conflict (outbox_id, recipient_id) do nothing;
  end if;

  return new;
end;
$$;

comment on function public.notify_job_comment() is
'AFTER-INSERT-Trigger auf job_comments: erzeugt transaktional ein '
'comment_added-Outbox-Event (entity_type=''comment'', entity_id=Kommentar-ID, '
'job_id fuer den Deep-Link) und die Zustellungen. Empfaenger werden '
'ausschliesslich serverseitig abgeleitet: zugewiesene aktive Mitarbeiter, bei '
'Mitarbeiter-Autoren zusaetzlich alle aktiven Admins der Firma; der Autor '
'wird immer ausgeschlossen.';

revoke all on function public.notify_job_comment() from public, anon, authenticated;

drop trigger if exists trg_notify_job_comment on public.job_comments;
create trigger trg_notify_job_comment
  after insert on public.job_comments
  for each row execute function public.notify_job_comment();
