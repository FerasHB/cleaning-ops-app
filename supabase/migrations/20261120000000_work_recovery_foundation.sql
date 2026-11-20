-- Phase 3 / Slice S1 — Work-Recovery-Fundament (nur Schema, keine RPCs).
--
-- Ziel: abgelehnte Offline-Arbeit (z. B. eingereihter Start, den der Server
-- dauerhaft abgelehnt hat) soll künftig als NACHWEIS beim Server landen und
-- von einem Admin geprüft werden, statt auf dem Gerät verworfen zu werden.
-- Diese Migration legt NUR das Fundament an:
--
--   1) work_recovery_cases        — ein offener Fall je Zuweisung
--   2) work_recovery_submissions  — beliebig viele, unveränderliche Einreichungen je Fall
--   3) work_recovery_action_refs  — jede Client-Aktion höchstens einmal beansprucht
--   4) work_recovery_events       — append-only Audit-Log
--   5) Schutz-Trigger (append-only, Identität unveränderlich, Konsistenz)
--   6) Zuweisungs-Löschschutz bei offenem Fall
--   7) purge_company_for_last_admin() löscht die neuen Tabellen mit
--   8) profiles.deactivated_at (trigger-gepflegt)
--
-- BEWUSST NICHT in dieser Migration (spätere Slices / Releases):
--   - keine Einreichungs-/Lese-/Entscheidungs-RPCs, keine Client-Grants —
--     ohne S2 kann also KEIN Fall entstehen
--   - keine automatische Anerkennung von Arbeitszeit, kein Schreiben in
--     job_assignments/employee_time_adjustments, kein maybe_complete_job()
--   - KEINE Änderung an Anmeldung/Sessions: kein Zugriff auf auth.sessions/
--     auth.refresh_tokens, keine Sperre (banned_until). Der Entzug von
--     Zugangsdaten bei Deaktivierung ist ein eigenes, späteres Release —
--     erst wenn die App widerrufene Sessions behandeln und Offline-Nachweise
--     sicher bewahren kann (Sicherheitsreview PR #147, 2026-11-20)
--   - keine Aufbewahrungsfrist / legal_hold (keine festgelegte Richtlinie —
--     Entscheidung O7 offen), kein Namens-Snapshot (Entscheidung O6 offen)
--   - keine Geräte-Kennungen, IP-Adressen oder Gerätemodelle
--
-- Personenbezug: employee_id/submitted_by/actor_id/decided_by sind FKs auf
-- profiles mit ON DELETE SET NULL — gleiche, bereits festgelegte Regel wie
-- work_sessions/session_time_corrections/employee_time_adjustments
-- (docs/store-compliance.md).
--
-- OFFENE ENTSCHEIDUNG — Firmenlöschung und Recovery-Nachweise:
-- Die bestehende Entscheidung "Export → Bestätigen → Löschen" (20261028000000)
-- deckt die ERFASSTE Arbeitszeit ab; der Export enthält keine Recovery-Fälle.
-- Ob ungeprüfte/strittige Nachweise mit der Firma gelöscht, exportiert oder
-- die Löschung blockiert werden darf, ist eine NOCH NICHT getroffene
-- Geschäfts-/Rechtsentscheidung und MUSS vor S2 (erste Funktion, die echte
-- Fälle anlegt) entschieden werden. Die Lösch-Anweisungen im Purge unten sind
-- KEINE beschlossene Aufbewahrungsregel: sie verhindern nur, dass der Purge an
-- den RESTRICT-FKs scheitert, und laufen ohne S2 nie auf echte Daten.

-- =========================================================
-- 1) Tabellen
-- =========================================================
create table public.work_recovery_cases (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  -- RESTRICT: offene Nachweise dürfen nicht über eine Auftrags-/Zuweisungs-
  -- löschung verschwinden (Präzedenz: work_sessions, 20260919000000).
  job_id            uuid not null references public.jobs(id) on delete restrict,
  assignment_id     uuid not null references public.job_assignments(id) on delete restrict,
  employee_id       uuid references public.profiles(id) on delete set null,
  source            text not null
                    check (source in ('legacy_queue', 'work_journal', 'stale_legacy', 'admin_opened')),
  state             text not null default 'open'
                    check (state in ('open', 'under_review', 'approved',
                                     'partially_approved', 'declined', 'superseded')),
  revision          bigint not null default 0 check (revision >= 0),
  -- Entscheidung (in S1 ungenutzt; erst der Resolve-Slice schreibt sie).
  decided_by        uuid references public.profiles(id) on delete set null,
  decided_at        timestamptz,
  -- Für den Mitarbeiter sichtbare Begründung (Anforderung R11) — getrennt
  -- von der internen Admin-Notiz.
  employee_message  text check (employee_message is null
                                or char_length(btrim(employee_message)) between 10 and 1000),
  admin_note        text check (admin_note is null or char_length(admin_note) <= 2000),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint work_recovery_cases_state_shape check (
    case
      when state in ('open', 'under_review') then decided_at is null
      when state in ('partially_approved', 'declined') then
        decided_at is not null and employee_message is not null
      else decided_at is not null
    end
  )
);

comment on table public.work_recovery_cases is
'Work-Recovery (S1): ein Prüffall je Zuweisung für vom Server abgelehnte Offline-Arbeit. Nachweis, NIE offizielle Arbeitszeit. Kein Client-Zugriff (nur spätere SECURITY-DEFINER-RPCs).';

-- Höchstens EIN offener Fall je Zuweisung; weitere Einreichungen hängen sich an.
create unique index work_recovery_cases_one_open_per_assignment
  on public.work_recovery_cases (assignment_id)
  where state in ('open', 'under_review');
create index work_recovery_cases_company_state_idx
  on public.work_recovery_cases (company_id, state, created_at);
create index work_recovery_cases_job_idx on public.work_recovery_cases (job_id);
create index work_recovery_cases_employee_idx
  on public.work_recovery_cases (employee_id) where employee_id is not null;
create index work_recovery_cases_decided_by_idx
  on public.work_recovery_cases (decided_by) where decided_by is not null;

create table public.work_recovery_submissions (
  -- Vom Client erzeugt, VOR dem ersten Senden persistiert: Idempotenzschlüssel.
  id               uuid primary key,
  case_id          uuid not null references public.work_recovery_cases(id) on delete restrict,
  company_id       uuid not null references public.companies(id) on delete cascade,
  submitted_by     uuid references public.profiles(id) on delete set null,
  -- Geordnete Roh-Operationen (Typ, Geräte-Zeitstempel, Pausen …) — Nachweis.
  claimed_ops      jsonb not null
                   check (jsonb_typeof(claimed_ops) = 'array'
                          and jsonb_array_length(claimed_ops) between 1 and 200
                          and pg_column_size(claimed_ops) <= 65536),
  -- Nur Plattform + Build (wie die x-taskops-* Header) — keine Gerätekennung.
  client_platform  text check (client_platform is null or client_platform in ('ios', 'android')),
  client_build     text check (client_build is null or char_length(client_build) between 1 and 32),
  failure_code     text check (failure_code is null or char_length(failure_code) between 1 and 64),
  failure_message  text check (failure_message is null or char_length(failure_message) <= 1000),
  request_hash     text not null check (char_length(request_hash) between 16 and 128),
  received_at      timestamptz not null default now()
);

comment on table public.work_recovery_submissions is
'Work-Recovery (S1): unveränderliche Einreichung eines Mitarbeiters zu einem Fall (Roh-Nachweis). id = Client-Idempotenzschlüssel.';

create index work_recovery_submissions_case_idx
  on public.work_recovery_submissions (case_id, received_at);
create index work_recovery_submissions_company_idx
  on public.work_recovery_submissions (company_id);
create index work_recovery_submissions_submitted_by_idx
  on public.work_recovery_submissions (submitted_by) where submitted_by is not null;

create table public.work_recovery_action_refs (
  submission_id     uuid not null references public.work_recovery_submissions(id) on delete cascade,
  -- Abgeleitet (Trigger), nie vom Aufrufer übernommen.
  company_id        uuid not null references public.companies(id) on delete cascade,
  employee_id       uuid references public.profiles(id) on delete set null,
  client_action_id  text not null check (char_length(client_action_id) between 1 and 128),
  primary key (submission_id, client_action_id)
);

comment on table public.work_recovery_action_refs is
'Work-Recovery (S1): jede lokale Client-Aktion eines Mitarbeiters darf höchstens EINMAL als Nachweis beansprucht werden (je Firma + Mitarbeiter).';

-- Eindeutig je Mitarbeiter — ein fremder Mitarbeiter kann so keine Aktions-ID
-- eines Kollegen "vorab belegen".
create unique index work_recovery_action_refs_once
  on public.work_recovery_action_refs (company_id, employee_id, client_action_id);
create index work_recovery_action_refs_employee_idx
  on public.work_recovery_action_refs (employee_id) where employee_id is not null;

create table public.work_recovery_events (
  id          bigint generated always as identity primary key,
  case_id     uuid not null references public.work_recovery_cases(id) on delete restrict,
  company_id  uuid not null references public.companies(id) on delete cascade,
  event_type  text not null check (event_type in (
                'case_opened', 'submission_received', 'state_changed',
                'server_state_changed', 'system_detected', 'note_added')),
  actor_id    uuid references public.profiles(id) on delete set null,
  from_state  text,
  to_state    text,
  detail      jsonb not null default '{}'::jsonb
              check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 4096),
  created_at  timestamptz not null default now()
);

comment on table public.work_recovery_events is
'Work-Recovery (S1): append-only Audit-Log je Fall. UPDATE/DELETE nur über FK-SET-NULL bzw. Firmen-Purge.';

create index work_recovery_events_case_idx on public.work_recovery_events (case_id, created_at);
create index work_recovery_events_company_idx on public.work_recovery_events (company_id);
create index work_recovery_events_actor_idx
  on public.work_recovery_events (actor_id) where actor_id is not null;

-- Kein Client-Zugriff: RLS an, KEINE Policies, KEINE Grants. Lesen/Schreiben
-- später ausschließlich über SECURITY-DEFINER-RPCs (Muster 20260919000000).
alter table public.work_recovery_cases       enable row level security;
alter table public.work_recovery_submissions enable row level security;
alter table public.work_recovery_action_refs enable row level security;
alter table public.work_recovery_events      enable row level security;

revoke all on table public.work_recovery_cases       from public, anon, authenticated, service_role;
revoke all on table public.work_recovery_submissions from public, anon, authenticated, service_role;
revoke all on table public.work_recovery_action_refs from public, anon, authenticated, service_role;
revoke all on table public.work_recovery_events      from public, anon, authenticated, service_role;

-- =========================================================
-- 2) Konsistenz beim Einfügen (keine zusammengesetzten FKs vorhanden)
-- =========================================================
create or replace function public.work_recovery_case_before_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_job_company uuid;
  v_ja_job uuid;
  v_ja_employee uuid;
begin
  select j.company_id into v_job_company from public.jobs j where j.id = new.job_id;
  select ja.job_id, ja.employee_id into v_ja_job, v_ja_employee
    from public.job_assignments ja where ja.id = new.assignment_id;

  if v_job_company is distinct from new.company_id then
    raise exception 'Recovery case company does not match job' using errcode = '23514';
  end if;
  if v_ja_job is distinct from new.job_id then
    raise exception 'Recovery case assignment does not belong to job' using errcode = '23514';
  end if;
  if new.employee_id is distinct from v_ja_employee then
    raise exception 'Recovery case employee does not match assignment' using errcode = '23514';
  end if;
  if new.state <> 'open' or new.revision <> 0
     or new.decided_by is not null or new.decided_at is not null then
    raise exception 'Recovery case must start open at revision 0' using errcode = '23514';
  end if;

  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.work_recovery_submission_before_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_employee uuid;
  v_state text;
begin
  select c.company_id, c.employee_id, c.state into v_company, v_employee, v_state
    from public.work_recovery_cases c where c.id = new.case_id;

  if v_company is distinct from new.company_id then
    raise exception 'Recovery submission company does not match case' using errcode = '23514';
  end if;
  if v_state is distinct from 'open' and v_state is distinct from 'under_review' then
    raise exception 'Recovery case is closed' using errcode = '23514';
  end if;
  if new.submitted_by is not null and new.submitted_by is distinct from v_employee then
    raise exception 'Recovery submission must come from the case employee' using errcode = '23514';
  end if;

  new.received_at := now();
  return new;
end;
$$;

create or replace function public.work_recovery_action_ref_before_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Firma/Mitarbeiter immer aus dem Fall ableiten (nie Aufruferwerte).
  select c.company_id, c.employee_id into new.company_id, new.employee_id
    from public.work_recovery_submissions s
    join public.work_recovery_cases c on c.id = s.case_id
   where s.id = new.submission_id;
  return new;
end;
$$;

create or replace function public.work_recovery_event_before_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
begin
  select c.company_id into v_company from public.work_recovery_cases c where c.id = new.case_id;
  if v_company is distinct from new.company_id then
    raise exception 'Recovery event company does not match case' using errcode = '23514';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger work_recovery_case_before_insert_trg
  before insert on public.work_recovery_cases
  for each row execute function public.work_recovery_case_before_insert();
create trigger work_recovery_submission_before_insert_trg
  before insert on public.work_recovery_submissions
  for each row execute function public.work_recovery_submission_before_insert();
create trigger work_recovery_action_ref_before_insert_trg
  before insert on public.work_recovery_action_refs
  for each row execute function public.work_recovery_action_ref_before_insert();
create trigger work_recovery_event_before_insert_trg
  before insert on public.work_recovery_events
  for each row execute function public.work_recovery_event_before_insert();

-- =========================================================
-- 3) Append-only-Schutz
-- =========================================================
-- Einreichungen, Aktions-Referenzen, Events: unveränderlich.
--   UPDATE: einzig erlaubt ist das FK-ON-DELETE-SET-NULL der Personen-Spalte
--           (Konto-Löschung, Store-Compliance) — alle übrigen Spalten gleich.
--   DELETE: nur innerhalb des Firmen-Purge (company_purge_active()).
-- TG_ARGV[0] = Name der Personen-Spalte.
create or replace function public.guard_work_recovery_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_col text := tg_argv[0];
begin
  if tg_op = 'DELETE' then
    if public.company_purge_active() then
      return old;
    end if;
    raise exception '% is append-only', tg_table_name using errcode = '23514';
  end if;

  if (to_jsonb(new) - v_col) = (to_jsonb(old) - v_col)
     and (to_jsonb(old) ->> v_col) is not null
     and (to_jsonb(new) ->> v_col) is null then
    return new;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '23514';
end;
$$;

create trigger guard_work_recovery_submissions_trg
  before update or delete on public.work_recovery_submissions
  for each row execute function public.guard_work_recovery_append_only('submitted_by');
create trigger guard_work_recovery_action_refs_trg
  before update or delete on public.work_recovery_action_refs
  for each row execute function public.guard_work_recovery_append_only('employee_id');
create trigger guard_work_recovery_events_trg
  before update or delete on public.work_recovery_events
  for each row execute function public.guard_work_recovery_append_only('actor_id');

-- Fälle: Identität unveränderlich; Zustandsänderungen nur über künftige RPCs
-- (transaktionslokales Flag taskops.work_recovery_rpc, über PostgREST nicht
-- setzbar — Muster taskops.work_session_rpc). In S1 setzt keine Funktion
-- dieses Flag: Fälle sind hier also faktisch unveränderlich.
create or replace function public.guard_work_recovery_case_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  if tg_op = 'DELETE' then
    if public.company_purge_active() then
      return old;
    end if;
    raise exception 'work_recovery_cases rows cannot be deleted' using errcode = '23514';
  end if;

  -- FK ON DELETE SET NULL (Konto-Löschung): nur employee_id/decided_by
  -- dürfen von gesetzt auf NULL gehen, sonst nichts.
  if (v_new - 'employee_id' - 'decided_by') = (v_old - 'employee_id' - 'decided_by')
     and (new.employee_id is not distinct from old.employee_id
          or (old.employee_id is not null and new.employee_id is null))
     and (new.decided_by is not distinct from old.decided_by
          or (old.decided_by is not null and new.decided_by is null)) then
    return new;
  end if;

  if coalesce(current_setting('taskops.work_recovery_rpc', true), '') <> 'on' then
    raise exception 'work_recovery_cases may only change through recovery RPCs'
      using errcode = '23514';
  end if;

  if new.id is distinct from old.id
     or new.company_id is distinct from old.company_id
     or new.job_id is distinct from old.job_id
     or new.assignment_id is distinct from old.assignment_id
     or new.source is distinct from old.source
     or new.created_at is distinct from old.created_at
     or new.employee_id is distinct from old.employee_id then
    raise exception 'Recovery case identity is immutable' using errcode = '23514';
  end if;
  if old.state not in ('open', 'under_review') then
    raise exception 'Recovery case is final' using errcode = '23514';
  end if;
  if new.revision is distinct from old.revision + 1 then
    raise exception 'Recovery case revision must increase by one' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger guard_work_recovery_cases_trg
  before update or delete on public.work_recovery_cases
  for each row execute function public.guard_work_recovery_case_write();

-- =========================================================
-- 4) Zuweisungs-Löschschutz bei offenem Fall
-- =========================================================
-- Deckt JEDEN Löschpfad ab (set_job_assignments, Auftragslöschung per
-- Kaskade, Occurrence-Abgleich, Legacy-Kompat-Trigger): eine Zuweisung mit
-- offenem Prüffall darf nicht verschwinden — ein offline nie synchronisierter
-- Start hinterlässt employee_started_at = NULL, die "Bereits gestartet"-
-- Sperre in set_job_assignments greift dort also nicht. Klare Meldung statt
-- des generischen FK-Fehlers. Geschlossene Fälle hält zusätzlich der
-- RESTRICT-FK fest (ob das so bleiben soll, entscheidet der Resolve-Slice).
create or replace function public.guard_assignment_open_recovery_case()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if public.company_purge_active() then
    return old;
  end if;
  if exists (
    select 1 from public.work_recovery_cases c
     where c.assignment_id = old.id
       and c.state in ('open', 'under_review')
  ) then
    raise exception 'Zuweisung hat eine offene Nacharbeitung (Prüffall) und kann nicht entfernt werden.'
      using errcode = '22023';
  end if;
  return old;
end;
$$;

create trigger guard_assignment_open_recovery_case_trg
  before delete on public.job_assignments
  for each row execute function public.guard_assignment_open_recovery_case();

-- =========================================================
-- 5) Firmen-Purge: Recovery-Daten vor den Aufträgen löschen
-- =========================================================
-- Fassung aus 20261028000000, einzige Änderung: Block "Work-Recovery" vor
-- dem Löschen der Aufträge (job_id/assignment_id sind RESTRICT).
create or replace function public.purge_company_for_last_admin(
  p_caller uuid,
  p_confirm_company_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_company_id uuid;
  v_is_active boolean;
  v_other_available_admins int;
  v_member_ids uuid[];
  v_storage_paths text[];
begin
  if p_caller is null then
    raise exception 'unauthenticated';
  end if;

  select role, company_id, is_active
    into v_role, v_company_id, v_is_active
  from public.profiles
  where id = p_caller;

  if not found then
    raise exception 'profile_not_found';
  end if;

  if v_is_active is distinct from true then
    raise exception 'inactive_account';
  end if;

  if v_role <> 'admin' or v_company_id is null then
    raise exception 'not_admin';
  end if;

  if p_confirm_company_id is distinct from v_company_id then
    raise exception 'company_mismatch';
  end if;

  -- Firmenzeile sperren: serialisiert parallele Purge-Versuche derselben
  -- Firma. Danach dieselbe Admin-Sperre wie prepare_self_account_deletion()
  -- (alle Admin-Zeilen, sortiert) — prepare sperrt nie die Firmenzeile, die
  -- Reihenfolge Firma -> Admins kann also keinen Zyklus bilden.
  perform 1 from public.companies where id = v_company_id for update;

  perform 1
  from public.profiles
  where company_id = v_company_id
    and role = 'admin'
  order by id
  for update;

  select count(*)
    into v_other_available_admins
  from public.profiles
  where company_id = v_company_id
    and role = 'admin'
    and is_active = true
    and account_deletion_token is null
    and id <> p_caller;

  if v_other_available_admins > 0 then
    raise exception 'not_last_admin';
  end if;

  select coalesce(array_agg(id order by id), '{}')
    into v_member_ids
  from public.profiles
  where company_id = v_company_id;

  select coalesce(array_agg(p), '{}')
    into v_storage_paths
  from (
    select storage_path as p from public.job_photos where company_id = v_company_id
    union
    select document_path from public.absence_evidence
     where company_id = v_company_id and document_path is not null
  ) s;

  perform set_config('taskops.company_purge', 'on', true);
  -- Keine Occurrence-Tombstones für Termine, die gerade mitgelöscht werden.
  perform set_config('app.series_sync', 'on', true);

  -- Work-Recovery (20261120000000): Kinder vor Eltern löschen, damit der
  -- Purge nicht an den RESTRICT-FKs (job_id/assignment_id) scheitert.
  -- KEINE beschlossene Aufbewahrungsregel für Nachweise — offene
  -- Geschäfts-/Rechtsentscheidung, vor S2 zu treffen (siehe Kopfkommentar).
  delete from public.work_recovery_events where company_id = v_company_id;
  delete from public.work_recovery_action_refs where company_id = v_company_id;
  delete from public.work_recovery_submissions where company_id = v_company_id;
  delete from public.work_recovery_cases where company_id = v_company_id;

  -- RESTRICT-Kinder der Zuweisungen zuerst (append-only Arbeitszeit).
  delete from public.session_time_corrections stc
   using public.jobs j
   where j.id = stc.job_id and j.company_id = v_company_id;

  delete from public.work_operation_receipts r
   using public.job_assignments ja, public.jobs j
   where ja.id = r.job_assignment_id and j.id = ja.job_id
     and j.company_id = v_company_id;

  delete from public.work_sessions ws
   using public.job_assignments ja, public.jobs j
   where ja.id = ws.job_assignment_id and j.id = ja.job_id
     and j.company_id = v_company_id;

  -- Aufträge (kaskadiert: Zuweisungen, Kommentare, Fotos-Zeilen, Reads,
  -- Overrides, Skips, Horizonte, Zeit-Anpassungen, Outbox-Zeilen).
  delete from public.jobs where company_id = v_company_id;

  -- Firma (kaskadiert: Abwesenheiten, AU-Nachweise, Urlaubsjahre/-buchungen,
  -- restliche Outbox/Deliveries, Kommentare/Fotos). profiles.company_id
  -- würde hier auf NULL gesetzt — die Konten werden direkt danach gelöscht.
  delete from public.companies where id = v_company_id;

  -- Alle Konten der Firma (inkl. Aufrufer). auth.users -> profiles CASCADE;
  -- Sessions/Refresh-Tokens/Identities hängen per FK an auth.users.
  delete from auth.users where id = any(v_member_ids);

  perform set_config('taskops.company_purge', '', true);
  perform set_config('app.series_sync', '', true);

  return jsonb_build_object(
    'company_id', v_company_id,
    'deleted_user_ids', to_jsonb(v_member_ids),
    'storage_paths', to_jsonb(v_storage_paths)
  );
end;
$$;

comment on function public.purge_company_for_last_admin(uuid, uuid) is
'Store-Compliance: letzter aktiver Admin löscht Konto + Firma + alle Mandantendaten und -konten (eine Transaktion, KEIN Archiv). Nur service_role (Edge Function delete-account). Gibt Storage-Pfade zum Aufräumen zurück. Export vorher: get_company_worktime_export(). Work-Recovery-Nachweise: Umgang bei Firmenlöschung ist eine offene Geschäfts-/Rechtsentscheidung (vor S2) — das Löschen hier ist keine beschlossene Aufbewahrungsregel.';

revoke all on function public.purge_company_for_last_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.purge_company_for_last_admin(uuid, uuid) to service_role;

-- =========================================================
-- 6) profiles.deactivated_at
-- =========================================================
-- Zeitpunkt der letzten Deaktivierung. Immer vom Trigger aus OLD/NEW.is_active
-- abgeleitet — ein direkt mitgesendeter Wert wird ignoriert. Kein Backfill:
-- für bereits inaktive Konten ist der Zeitpunkt unbekannt (NULL ist ehrlich).
alter table public.profiles add column deactivated_at timestamptz;

comment on column public.profiles.deactivated_at is
'Zeitpunkt der letzten Deaktivierung (Trigger, nicht schreibbar). NULL = aktiv ODER vor 20261120000000 deaktiviert (Zeitpunkt unbekannt).';

create or replace function public.set_profile_deactivated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.deactivated_at := case when new.is_active = false then now() else null end;
    return new;
  end if;

  if old.is_active is distinct from false and new.is_active = false then
    new.deactivated_at := now();
  elsif new.is_active is distinct from false then
    new.deactivated_at := null;
  else
    new.deactivated_at := old.deactivated_at;
  end if;
  return new;
end;
$$;

create trigger set_profile_deactivated_at_trg
  before insert or update on public.profiles
  for each row execute function public.set_profile_deactivated_at();

-- =========================================================
-- 7) Funktionsrechte (Supabase-Default-Privilegien erteilen EXECUTE)
-- =========================================================
revoke all on function public.work_recovery_case_before_insert() from public, anon, authenticated;
revoke all on function public.work_recovery_submission_before_insert() from public, anon, authenticated;
revoke all on function public.work_recovery_action_ref_before_insert() from public, anon, authenticated;
revoke all on function public.work_recovery_event_before_insert() from public, anon, authenticated;
revoke all on function public.guard_work_recovery_append_only() from public, anon, authenticated;
revoke all on function public.guard_work_recovery_case_write() from public, anon, authenticated;
revoke all on function public.guard_assignment_open_recovery_case() from public, anon, authenticated;
revoke all on function public.set_profile_deactivated_at() from public, anon, authenticated;
