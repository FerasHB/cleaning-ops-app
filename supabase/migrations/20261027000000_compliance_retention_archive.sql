-- Compliance-Retention für die Firmenlöschung durch den letzten Admin.
--
-- Korrigiert 20261026000000: purge_company_for_last_admin() hat Arbeitszeit-
-- Sessions, Zeitkorrekturen, Zuweisungszeiten, Abwesenheiten und Urlaubs-
-- buchungen sofort mitgelöscht. Diese Datensätze können Beschäftigungs-/
-- Arbeitszeitnachweise sein, für die gesetzliche Aufbewahrungsfristen gelten
-- können. Die Kontolöschung (Apple 5.1.1(v), Google Play) verlangt nur, dass
-- das KONTO und nicht benötigte Daten gelöscht werden — sie erlaubt die
-- Aufbewahrung von Daten, die aus rechtlichen Gründen behalten werden müssen.
--
-- Modell: Vor dem Löschen kopiert der Purge eine MINIMALE, feldweise
-- freigegebene (Whitelist) Fassung dieser Nachweise in die separate Tabelle
-- public.compliance_retention_records. Danach wird der aktive Mandant wie
-- bisher vollständig gelöscht (Konten, Firma, Aufträge, Kommentare, Fotos,
-- Benachrichtigungen, ...). Die Archivtabelle:
--   * hat KEINE Fremdschlüssel in den aktiven Mandanten (überlebt dessen
--     Löschung, blockiert nichts),
--   * ist für anon/authenticated komplett gesperrt (RLS an, keine Policy,
--     keine Grants) — kein App-Pfad, kein PostgREST-Zugriff außer
--     service_role,
--   * enthält keine E-Mail, keine Telefonnummer, keinen Push-Token, keine
--     Zugangsdaten, keine Freitexte (Notizen/Begründungen), keine
--     Kundendaten,
--   * trägt retain_until (NULL = Frist noch nicht festgelegt, wird NICHT
--     automatisch gelöscht) und kann gezielt gelöscht werden
--     (set_/purge_-Funktionen unten, nur service_role).
--
-- Bewusst KEINE Aussage, dass ein bestimmtes Feld (z. B. der Name) gesetzlich
-- vorgeschrieben ist. employee_name ist die minimale menschenlesbare
-- Zuordnung: nach der Konto-Löschung ist employee_ref (ehemalige User-ID)
-- nirgends mehr auflösbar. Ob Name, Pseudonym oder etwas anderes nötig ist,
-- ist eine Rechtsfrage (siehe docs/store-compliance.md).

-- =========================================================
-- 1) Archivtabelle
-- =========================================================
create table if not exists public.compliance_retention_records (
  id uuid primary key default gen_random_uuid(),
  record_type text not null
    constraint compliance_retention_records_type_chk check (record_type in (
      'work_session',
      'session_time_correction',
      'assignment_work_time',
      'time_adjustment',
      'absence',
      'vacation_ledger_entry'
    )),
  -- ID der Ursprungszeile (Nachvollziehbarkeit, Idempotenz). Kein FK.
  source_id uuid not null,
  -- Arbeitgeber-Referenz (ehemalige Firma). Kein FK.
  company_id uuid not null,
  company_name text not null,
  -- Arbeitnehmer-Referenz: ehemalige profiles.id (kann NULL sein, wenn das
  -- Konto schon früher gelöscht wurde) + Namens-Snapshot als einzige
  -- menschenlesbare Zuordnung.
  employee_ref uuid,
  employee_name text,
  -- Fachliches Datum des Nachweises (Arbeitstag / Abwesenheitsbeginn) in der
  -- Zeitzone der Firma — Grundlage für spätere Fristberechnung.
  record_date date,
  -- Nur freigegebene Felder je record_type, siehe purge_company_for_last_admin().
  payload jsonb not null,
  archived_at timestamptz not null default now(),
  archived_reason text not null default 'last_admin_account_deletion',
  -- NULL = Aufbewahrungsfrist noch nicht festgelegt (kein automatisches
  -- Löschen). Festlegen: set_compliance_retain_until().
  retain_until date,
  constraint compliance_retention_records_source_uq unique (record_type, source_id)
);

comment on table public.compliance_retention_records is
'Gesperrtes Archiv minimaler Arbeitszeit-/Beschäftigungsnachweise gelöschter Firmen (letzter Admin hat Konto + Firma gelöscht). Kein App-Zugriff (RLS ohne Policy, nur service_role). Löschbar über purge_expired_compliance_records() / purge_compliance_records_for_company().';

create index if not exists compliance_retention_records_company_idx
  on public.compliance_retention_records (company_id);
create index if not exists compliance_retention_records_retain_until_idx
  on public.compliance_retention_records (retain_until)
  where retain_until is not null;

alter table public.compliance_retention_records enable row level security;
revoke all on table public.compliance_retention_records from public, anon, authenticated;
grant select, insert, update, delete on table public.compliance_retention_records to service_role;

-- =========================================================
-- 2) Purge mit vorheriger Archivierung (ersetzt 20261026000000)
-- =========================================================
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
  v_company_name text;
  v_tz text;
  v_retained int;
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

  select name, coalesce(nullif(timezone, ''), 'Europe/Berlin')
    into v_company_name, v_tz
  from public.companies
  where id = v_company_id;

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

  -- ── Archivierung (Whitelist je Typ; KEINE Notizen/Begründungen,
  --    KEINE Kundendaten, KEINE Kontaktdaten) ──────────────────────────

  -- Arbeitszeit-Sessions
  insert into public.compliance_retention_records
    (record_type, source_id, company_id, company_name, employee_ref, employee_name, record_date, payload)
  select 'work_session', ws.id, v_company_id, v_company_name,
         ws.employee_id, ja.employee_name_snapshot,
         (ws.started_at at time zone v_tz)::date,
         jsonb_build_object(
           'assignment_id', ws.job_assignment_id,
           'job_id', ja.job_id,
           'started_at', ws.started_at,
           'ended_at', ws.ended_at)
  from public.work_sessions ws
  join public.job_assignments ja on ja.id = ws.job_assignment_id
  join public.jobs j on j.id = ja.job_id
  where j.company_id = v_company_id
  on conflict (record_type, source_id) do nothing;

  -- Zeitkorrekturen (Zeiten + Herkunft; Freitext-Begründung und
  -- ausführender Admin werden NICHT übernommen)
  insert into public.compliance_retention_records
    (record_type, source_id, company_id, company_name, employee_ref, employee_name, record_date, payload)
  select 'session_time_correction', stc.correction_id, v_company_id, v_company_name,
         stc.employee_id, ja.employee_name_snapshot,
         (stc.raw_started_at at time zone v_tz)::date,
         jsonb_build_object(
           'work_session_id', stc.work_session_id,
           'assignment_id', stc.job_assignment_id,
           'job_id', stc.job_id,
           'revision_no', stc.revision_no,
           'origin', stc.origin,
           'raw_started_at', stc.raw_started_at,
           'raw_ended_at', stc.raw_ended_at,
           'raw_duration_seconds', stc.raw_duration_seconds,
           'effective_started_at', stc.effective_started_at,
           'effective_ended_at', stc.effective_ended_at,
           'effective_duration_seconds', stc.effective_duration_seconds,
           'corrected_at', stc.created_at)
  from public.session_time_corrections stc
  join public.job_assignments ja on ja.id = stc.job_assignment_id
  join public.jobs j on j.id = stc.job_id
  where j.company_id = v_company_id
  on conflict (record_type, source_id) do nothing;

  -- Zuweisungszeiten (Stundenzettel-Quelle) — nur Zuweisungen mit
  -- tatsächlich erfasster Arbeit. Ohne Kunde/Adresse/Service.
  insert into public.compliance_retention_records
    (record_type, source_id, company_id, company_name, employee_ref, employee_name, record_date, payload)
  select 'assignment_work_time', ja.id, v_company_id, v_company_name,
         ja.employee_id, ja.employee_name_snapshot,
         coalesce(j.occurrence_date, j.date,
                  (coalesce(ja.employee_started_at, j.started_at) at time zone v_tz)::date),
         jsonb_build_object(
           'job_id', j.id,
           'job_started_at', j.started_at,
           'job_completed_at', j.completed_at,
           'employee_started_at', ja.employee_started_at,
           'employee_completed_at', ja.employee_completed_at,
           'attendance', ja.attendance,
           'time_tracking_mode', ja.time_tracking_mode,
           'counts_for_timesheet', ja.counts_for_timesheet,
           'work_revision', ja.work_revision)
  from public.job_assignments ja
  join public.jobs j on j.id = ja.job_id
  where j.company_id = v_company_id
    and (ja.employee_started_at is not null
         or j.started_at is not null
         or exists (select 1 from public.work_sessions ws where ws.job_assignment_id = ja.id))
  on conflict (record_type, source_id) do nothing;

  -- Admin-Zeitanpassungen (alt/neu; ohne Begründung/Akteur)
  insert into public.compliance_retention_records
    (record_type, source_id, company_id, company_name, employee_ref, employee_name, record_date, payload)
  select 'time_adjustment', eta.id, v_company_id, v_company_name,
         eta.employee_id, ja.employee_name_snapshot,
         (coalesce(eta.new_started_at, eta.old_started_at, eta.created_at) at time zone v_tz)::date,
         jsonb_build_object(
           'assignment_id', eta.assignment_id,
           'job_id', eta.job_id,
           'old_started_at', eta.old_started_at,
           'old_completed_at', eta.old_completed_at,
           'new_started_at', eta.new_started_at,
           'new_completed_at', eta.new_completed_at,
           'adjusted_at', eta.created_at)
  from public.employee_time_adjustments eta
  join public.job_assignments ja on ja.id = eta.assignment_id
  join public.jobs j on j.id = eta.job_id
  where j.company_id = v_company_id
  on conflict (record_type, source_id) do nothing;

  -- Abwesenheiten (Art, Status, Zeitraum, Nachweis-Status; ohne Notizen,
  -- ohne Dokumentpfad)
  insert into public.compliance_retention_records
    (record_type, source_id, company_id, company_name, employee_ref, employee_name, record_date, payload)
  select 'absence', a.id, v_company_id, v_company_name,
         a.employee_id, a.employee_name_snapshot, a.start_date,
         jsonb_build_object(
           'type', a.type,
           'status', a.status,
           'start_date', a.start_date,
           'end_date', a.end_date,
           'vacation_deducted_days', a.vacation_deducted_days_snapshot,
           'reviewed_at', a.reviewed_at,
           'created_at', a.created_at,
           'evidence_status', ev.status,
           'evidence_confirmed_at', ev.confirmed_at)
  from public.employee_absences a
  left join public.absence_evidence ev on ev.absence_id = a.id
  where a.company_id = v_company_id
  on conflict (record_type, source_id) do nothing;

  -- Urlaubsbuchungen (Jahr, Art, Tage; ohne Notiz)
  insert into public.compliance_retention_records
    (record_type, source_id, company_id, company_name, employee_ref, employee_name, record_date, payload)
  select 'vacation_ledger_entry', vl.id, v_company_id, v_company_name,
         vl.employee_id, p.full_name, make_date(vy.year, 1, 1),
         jsonb_build_object(
           'year', vy.year,
           'entry_type', vl.entry_type,
           'amount_days', vl.amount_days,
           'absence_id', vl.absence_id,
           'created_at', vl.created_at)
  from public.vacation_ledger vl
  join public.vacation_years vy on vy.id = vl.vacation_year_id
  left join public.profiles p on p.id = vl.employee_id
  where vl.company_id = v_company_id
  on conflict (record_type, source_id) do nothing;

  select count(*) into v_retained
  from public.compliance_retention_records
  where company_id = v_company_id;

  -- ── Aktiven Mandanten löschen (unverändert ggü. 20261026000000) ──────
  perform set_config('taskops.company_purge', 'on', true);
  perform set_config('app.series_sync', 'on', true);

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

  delete from public.jobs where company_id = v_company_id;

  delete from public.companies where id = v_company_id;

  delete from auth.users where id = any(v_member_ids);

  perform set_config('taskops.company_purge', '', true);
  perform set_config('app.series_sync', '', true);

  return jsonb_build_object(
    'company_id', v_company_id,
    'deleted_user_ids', to_jsonb(v_member_ids),
    'storage_paths', to_jsonb(v_storage_paths),
    'retained_record_count', v_retained
  );
end;
$$;

comment on function public.purge_company_for_last_admin(uuid, uuid) is
'Store-Compliance: letzter aktiver Admin löscht Konto + Firma. Archiviert vorher minimale Arbeitszeit-/Beschäftigungsnachweise in compliance_retention_records (gesperrt), löscht dann Mandant, alle Firmenkonten und meldet Storage-Pfade. Nur service_role.';

revoke all on function public.purge_company_for_last_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.purge_company_for_last_admin(uuid, uuid) to service_role;

-- =========================================================
-- 3) Frist setzen / Archiv löschen (nur service_role)
-- =========================================================
-- Frist je Firma (optional je Typ) festlegen — erst, wenn sie rechtlich
-- geklärt ist. NULL setzt die Frist zurück (kein automatisches Löschen).
create or replace function public.set_compliance_retain_until(
  p_company_id uuid,
  p_retain_until date,
  p_record_types text[] default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows int;
begin
  if p_company_id is null then
    raise exception 'company_required';
  end if;
  update public.compliance_retention_records
     set retain_until = p_retain_until
   where company_id = p_company_id
     and (p_record_types is null or record_type = any(p_record_types));
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Löscht alle Archivzeilen, deren Frist abgelaufen ist (retain_until <
-- heute). Zeilen ohne Frist bleiben. Für einen späteren Cron-Job geeignet.
create or replace function public.purge_expired_compliance_records()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows int;
begin
  delete from public.compliance_retention_records
   where retain_until is not null
     and retain_until < current_date;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Gezielte Löschung einer ehemaligen Firma (optional je Typ), z. B. nach
-- rechtlicher Freigabe oder auf Anordnung.
create or replace function public.purge_compliance_records_for_company(
  p_company_id uuid,
  p_record_types text[] default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows int;
begin
  if p_company_id is null then
    raise exception 'company_required';
  end if;
  delete from public.compliance_retention_records
   where company_id = p_company_id
     and (p_record_types is null or record_type = any(p_record_types));
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.set_compliance_retain_until(uuid, date, text[]) from public, anon, authenticated;
revoke all on function public.purge_expired_compliance_records() from public, anon, authenticated;
revoke all on function public.purge_compliance_records_for_company(uuid, text[]) from public, anon, authenticated;
grant execute on function public.set_compliance_retain_until(uuid, date, text[]) to service_role;
grant execute on function public.purge_expired_compliance_records() to service_role;
grant execute on function public.purge_compliance_records_for_company(uuid, text[]) to service_role;

-- =========================================================
-- 4) Kommentar der Snapshot-Funktion neutral formulieren
-- =========================================================
comment on function public.anonymize_deleted_profile_snapshots() is
'BEFORE DELETE auf profiles: ersetzt den Namen des gelöschten Kontos in notification_outbox. Namens-Snapshots in job_assignments/employee_absences bleiben als Referenz der Firmen-Nachweise erhalten (Produktentscheidung, rechtlich zu prüfen; siehe docs/store-compliance.md).';
