-- Work-Recovery S1.5: Lösch- und Export-Sicherheit (Phase 3).
--
-- Freigegebene Geschäftsregeln (Inhaber, vor S2):
--   A) Eine Firma darf NICHT gelöscht werden, solange sie offene
--      Recovery-Fälle hat (state open/under_review) — serverseitig erzwungen.
--   B) Vor der Löschung müssen die Recovery-Datensätze in einem autorisierten
--      Export enthalten sein, und der Admin muss den erfolgreichen Export
--      ausdrücklich bestätigen, bevor gelöscht werden darf.
--   C) Keine stille Vernichtung von Nachweisen.
--   D) Keine erfundene Aufbewahrungsfrist. Export-Erlaubnis ist keine
--      allgemeine Löscherlaubnis für rechtlich relevante Datensätze; die
--      Aufbewahrungsfrage bleibt offen (siehe docs/work-recovery-deletion-safety.md).
--
-- Bisher (20261120000000) löschte purge_company_for_last_admin() alle
-- work_recovery_*-Zeilen ohne jede Prüfung, und die Export-Bestätigung war
-- eine reine Client-Checkbox. Diese Migration:
--   1) legt company_deletion_exports an — serverseitiger Nachweis "Export
--      erzeugt" + "Export bestätigt", gebunden an Firma, Admin und einen
--      SHA-256-Fingerabdruck des exportierten Inhalts,
--   2) legt den Recovery-Export an (get_company_recovery_export) — der
--      Fingerabdruck wird über EXAKT das Dokument gebildet, das der Client
--      erhält (ein Statement, ein Snapshot),
--   3) legt die Bestätigung an (acknowledge_company_recovery_export) — nur
--      der exportierende Admin, nur seine Firma, nur wenn sich seither
--      nichts geändert hat,
--   4) ersetzt purge_company_for_last_admin() (gleiche Signatur, Edge
--      Function bleibt kompatibel): offene Fälle → 'open_recovery_cases';
--      sonst, sobald überhaupt Recovery-Zeilen existieren, ist eine
--      bestätigte, NICHT veraltete Export-Bestätigung DIESES Admins Pflicht
--      ('recovery_export_required' / 'recovery_export_stale').
--      Firmen ohne Recovery-Zeilen (heute: alle — S2 existiert noch nicht)
--      werden exakt wie bisher gelöscht; ältere App-Builds funktionieren
--      also unverändert.
--
-- Nebenläufigkeit: Der Purge sperrt companies FOR UPDATE. Jedes INSERT in
-- work_recovery_cases/_submissions/_action_refs/_events nimmt über den FK
-- company_id ein FOR KEY SHARE auf dieselbe Firmenzeile — beides kollidiert
-- (PostgreSQL-Doku "Conflicting Row-Level Locks"). Ein vorher committeter
-- Fall wird also von den folgenden Purge-Statements gesehen (READ COMMITTED:
-- neuer Snapshot je Statement), ein späterer scheitert am FK. Fall-UPDATEs
-- (künftige Entscheidungs-RPCs) und FK-SET-NULL-Updates nach Konto-Löschungen
-- sperren die Firmenzeile nicht; deshalb sperrt der Purge zusätzlich alle
-- Recovery-Zeilen der Firma FOR UPDATE, bevor er prüft. VERTRAG FÜR S2+: jede Recovery-schreibende RPC sperrt zuerst
-- "select 1 from companies where id = … for share" (Reihenfolge Firma → Fall,
-- nie Admin-Profile vor der Firma).
--
-- Nicht Teil von S1.5 (bewusst, siehe Doku): automatische Zuweisungs-
-- Synchronisation (inherit_occurrence_assignments, compat_sync_…,
-- update_job_occurrences-PRUNE) gegen den Zuweisungs-Löschschutz — vor S2
-- in einem eigenen Slice. Keine Auth-/Session-Änderungen. Keine Änderung an
-- Arbeitszeit, Job-Abschluss oder get_company_worktime_export().

-- =========================================================
-- 1) Export-Nachweis
-- =========================================================
create table public.company_deletion_exports (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  exported_by      uuid not null references public.profiles(id) on delete cascade,
  export_kind      text not null default 'work_recovery'
                   check (export_kind in ('work_recovery')),
  fingerprint      text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  record_counts    jsonb not null check (jsonb_typeof(record_counts) = 'object'),
  created_at       timestamptz not null default now(),
  acknowledged_at  timestamptz,
  constraint company_deletion_exports_ack_after_export
    check (acknowledged_at is null or acknowledged_at >= created_at)
);

comment on table public.company_deletion_exports is
'Work-Recovery S1.5: serverseitiger Nachweis, dass ein Admin den Recovery-Export (Fingerabdruck) erzeugt und bestätigt hat. Voraussetzung für die Firmenlöschung, sobald Recovery-Zeilen existieren. Kein Client-Zugriff (nur SECURITY-DEFINER-RPCs). Wird mit der Firma gelöscht.';

create index company_deletion_exports_company_admin_idx
  on public.company_deletion_exports (company_id, exported_by, acknowledged_at);
create index company_deletion_exports_exported_by_idx
  on public.company_deletion_exports (exported_by);

alter table public.company_deletion_exports enable row level security;
revoke all on table public.company_deletion_exports from public, anon, authenticated, service_role;

-- =========================================================
-- 2) Kanonisches Recovery-Dokument + Fingerabdruck (intern)
-- =========================================================
-- EIN Statement (ein Snapshot) → Dokument und Fingerabdruck können nie aus
-- verschiedenen Ständen stammen. Enthält ALLE Spalten aller vier Tabellen
-- (auch admin_note — nur für aktive Admins derselben Firma, s. u.). Kein
-- Zeitstempel der Erzeugung im Dokument, sonst wäre jeder Export "anders".
-- TimeZone fest auf UTC: to_jsonb(timestamptz) rendert in der Sitzungs-
-- Zeitzone — ohne feste Zone ergäben Export (PostgREST-Sitzung) und Purge
-- (service_role-Sitzung) bei abweichender Zone verschiedene Fingerabdrücke.
create or replace function public._work_recovery_export_doc(p_company_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
set "TimeZone" = 'UTC'
as $$
  select jsonb_build_object(
    'format', 'work_recovery_export_v1',
    'company_id', p_company_id,
    'cases', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.created_at, c.id)
      from public.work_recovery_cases c where c.company_id = p_company_id), '[]'::jsonb),
    'submissions', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.received_at, s.id)
      from public.work_recovery_submissions s where s.company_id = p_company_id), '[]'::jsonb),
    'action_refs', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.submission_id, r.client_action_id)
      from public.work_recovery_action_refs r where r.company_id = p_company_id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.id)
      from public.work_recovery_events e where e.company_id = p_company_id), '[]'::jsonb)
  );
$$;

create or replace function public._work_recovery_fingerprint(p_doc jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(sha256(convert_to(p_doc::text, 'UTF8')), 'hex');
$$;

revoke all on function public._work_recovery_export_doc(uuid) from public, anon, authenticated, service_role;
revoke all on function public._work_recovery_fingerprint(jsonb) from public, anon, authenticated, service_role;

comment on function public._work_recovery_export_doc(uuid) is
'Work-Recovery S1.5 (intern): kanonisches Export-Dokument aller Recovery-Zeilen einer Firma (ein Snapshot). Basis für Export, Bestätigung und Purge-Prüfung.';
comment on function public._work_recovery_fingerprint(jsonb) is
'Work-Recovery S1.5 (intern): SHA-256 (hex) über die jsonb-Textform des Export-Dokuments.';

-- =========================================================
-- 3) Recovery-Export für Admins der eigenen Firma
-- =========================================================
-- Nur aktive Admins, Firma IMMER aus dem Profil des Aufrufers (nie aus einem
-- Parameter). Legt einen unbestätigten Export-Nachweis an und liefert
-- Dokument + Fingerabdruck. 'people' (Namen zu IDs) liegt bewusst AUSSERHALB
-- des Fingerabdrucks: eine Namensänderung soll keinen Export entwerten.
create or replace function public.get_company_recovery_export()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_role text;
  v_company_id uuid;
  v_is_active boolean;
  v_doc jsonb;
  v_fp text;
  v_counts jsonb;
  v_open int;
  v_export_id uuid;
  v_created_at timestamptz;
  v_people jsonb;
begin
  if v_caller is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select p.role, p.company_id, p.is_active
    into v_role, v_company_id, v_is_active
  from public.profiles p
  where p.id = v_caller;

  if not found or v_role is distinct from 'admin' or v_company_id is null
     or v_is_active is distinct from true then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  v_doc := public._work_recovery_export_doc(v_company_id);
  v_fp := public._work_recovery_fingerprint(v_doc);
  v_counts := jsonb_build_object(
    'cases', jsonb_array_length(v_doc -> 'cases'),
    'submissions', jsonb_array_length(v_doc -> 'submissions'),
    'action_refs', jsonb_array_length(v_doc -> 'action_refs'),
    'events', jsonb_array_length(v_doc -> 'events'));
  select count(*)::int into v_open
  from jsonb_array_elements(v_doc -> 'cases') c
  where c ->> 'state' in ('open', 'under_review');

  -- Unveränderter Stand → vorhandenen Nachweis wiederverwenden (kein
  -- unbegrenztes Wachstum bei wiederholtem Export).
  select e.id, e.created_at
    into v_export_id, v_created_at
  from public.company_deletion_exports e
  where e.company_id = v_company_id
    and e.exported_by = v_caller
    and e.fingerprint = v_fp
  order by e.created_at desc
  limit 1;

  if v_export_id is null then
    insert into public.company_deletion_exports (company_id, exported_by, fingerprint, record_counts)
    values (v_company_id, v_caller, v_fp, v_counts)
    returning id, created_at into v_export_id, v_created_at;
  end if;

  select coalesce(jsonb_object_agg(p.id, p.full_name), '{}'::jsonb)
    into v_people
  from public.profiles p
  where p.company_id = v_company_id;

  return jsonb_build_object(
    'export_id', v_export_id,
    'fingerprint', v_fp,
    'generated_at', v_created_at,
    'record_counts', v_counts,
    'open_case_count', v_open,
    'recovery', v_doc,
    'people', v_people);
end;
$$;

comment on function public.get_company_recovery_export() is
'Work-Recovery S1.5: Export aller Recovery-Fälle/-Einreichungen/-Referenzen/-Events der eigenen Firma (inkl. interner Admin-Notizen) für aktive Admins. Legt einen unbestätigten Export-Nachweis mit Fingerabdruck an. Bestätigung: acknowledge_company_recovery_export(export_id).';

revoke all on function public.get_company_recovery_export() from public, anon, authenticated, service_role;
grant execute on function public.get_company_recovery_export() to authenticated;

-- =========================================================
-- 4) Bestätigung des Exports
-- =========================================================
-- Nur der Admin, der exportiert hat, nur in seiner aktuellen Firma. Der
-- Fingerabdruck wird NEU berechnet: hat sich seit dem Export etwas geändert
-- (neuer Fall/Einreichung/Event, Zustandswechsel, FK-SET-NULL nach einer
-- Konto-Löschung …), ist der Export veraltet und muss neu erzeugt werden.
-- Idempotent: eine bereits bestätigte, noch aktuelle Bestätigung bleibt.
create or replace function public.acknowledge_company_recovery_export(p_export_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_role text;
  v_company_id uuid;
  v_is_active boolean;
  v_row public.company_deletion_exports%rowtype;
  v_current_fp text;
begin
  if v_caller is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select p.role, p.company_id, p.is_active
    into v_role, v_company_id, v_is_active
  from public.profiles p
  where p.id = v_caller;

  if not found or v_role is distinct from 'admin' or v_company_id is null
     or v_is_active is distinct from true then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- Fremde Firma, fremder Admin und unbekannte ID sehen gleich aus (kein
  -- Existenz-Orakel über Firmengrenzen).
  select * into v_row
  from public.company_deletion_exports e
  where e.id = p_export_id
    and e.company_id = v_company_id
    and e.exported_by = v_caller
  for update;

  if not found then
    raise exception 'export_not_found' using errcode = '42501';
  end if;

  v_current_fp := public._work_recovery_fingerprint(
    public._work_recovery_export_doc(v_company_id));

  if v_current_fp is distinct from v_row.fingerprint then
    raise exception 'recovery_export_stale'
      using errcode = 'P0001',
            hint = 'Recovery-Daten haben sich seit dem Export geändert — bitte neu exportieren.';
  end if;

  if v_row.acknowledged_at is null then
    update public.company_deletion_exports
       set acknowledged_at = now()
     where id = v_row.id
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'export_id', v_row.id,
    'fingerprint', v_row.fingerprint,
    'acknowledged_at', v_row.acknowledged_at);
end;
$$;

comment on function public.acknowledge_company_recovery_export(uuid) is
'Work-Recovery S1.5: der exportierende Admin bestätigt den Recovery-Export. Prüft serverseitig, dass sich seit dem Export nichts geändert hat (Fingerabdruck), sonst recovery_export_stale.';

revoke all on function public.acknowledge_company_recovery_export(uuid) from public, anon, authenticated, service_role;
grant execute on function public.acknowledge_company_recovery_export(uuid) to authenticated;

-- =========================================================
-- 5) Firmen-Purge mit Recovery-Sperre
-- =========================================================
-- Fassung aus 20261120000000; einzige Änderung: Block "Work-Recovery S1.5"
-- nach den Sperren + Letzter-Admin-Prüfung und VOR dem Setzen des
-- Purge-Flags (das die Append-only-/Zuweisungs-Trigger entschärft).
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
  v_open_cases int;
  v_has_recovery boolean;
  v_ack_fp text;
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

  -- Work-Recovery S1.5 (Regeln A/B/C). Neue Fälle/Einreichungen/Events
  -- blockieren ab hier am FK (KEY SHARE vs. FOR UPDATE auf companies);
  -- Fall-UPDATEs sperren wir selbst, damit zwischen Prüfung und Löschen
  -- nichts mehr unbemerkt geändert werden kann.
  perform 1
  from public.work_recovery_cases
  where company_id = v_company_id
  order by id
  for update;
  -- Auch die Kind-Zeilen sperren: eine parallele Konto-Löschung (FK SET NULL
  -- auf submitted_by/employee_id/actor_id) darf zwischen Prüfung und Löschen
  -- nichts mehr ändern, was der Admin nicht exportiert hat.
  perform 1 from public.work_recovery_submissions
   where company_id = v_company_id order by id for update;
  perform 1 from public.work_recovery_action_refs
   where company_id = v_company_id order by submission_id, client_action_id for update;
  perform 1 from public.work_recovery_events
   where company_id = v_company_id order by id for update;

  select count(*) filter (where state in ('open', 'under_review')),
         count(*) > 0
    into v_open_cases, v_has_recovery
  from public.work_recovery_cases
  where company_id = v_company_id;

  -- Regel A: offene Fälle blockieren immer (unabhängig vom Export).
  if v_open_cases > 0 then
    raise exception 'open_recovery_cases'
      using detail = format('open_cases=%s', v_open_cases);
  end if;

  -- Regel B: sobald Recovery-Zeilen existieren (Einreichungen/Referenzen/
  -- Events hängen per NOT-NULL-FK immer an einem Fall), muss DIESER Admin
  -- einen Export bestätigt haben, dessen Fingerabdruck dem JETZIGEN Stand
  -- entspricht. Maßgeblich ist seine jüngste Bestätigung.
  if v_has_recovery then
    select e.fingerprint
      into v_ack_fp
    from public.company_deletion_exports e
    where e.company_id = v_company_id
      and e.exported_by = p_caller
      and e.acknowledged_at is not null
    order by e.acknowledged_at desc, e.created_at desc
    limit 1;

    if v_ack_fp is null then
      raise exception 'recovery_export_required';
    end if;

    if v_ack_fp is distinct from public._work_recovery_fingerprint(
         public._work_recovery_export_doc(v_company_id)) then
      raise exception 'recovery_export_stale';
    end if;
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

  -- Work-Recovery: Kinder vor Eltern löschen (job_id/assignment_id/case_id
  -- sind RESTRICT). Erreichbar nur noch ohne offene Fälle und nach einer
  -- aktuellen, serverseitig geprüften Export-Bestätigung (Regel B). Eine
  -- Aufbewahrungsfrist darüber hinaus ist NICHT beschlossen (Regel D).
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
  -- restliche Outbox/Deliveries, Kommentare/Fotos, Export-Nachweise).
  -- profiles.company_id würde hier auf NULL gesetzt — die Konten werden
  -- direkt danach gelöscht.
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
'Store-Compliance: letzter aktiver Admin löscht Konto + Firma + alle Mandantendaten und -konten (eine Transaktion, KEIN Archiv). Nur service_role (Edge Function delete-account). Gibt Storage-Pfade zum Aufräumen zurück. Export vorher: get_company_worktime_export(). Work-Recovery (S1.5): blockiert bei offenen Fällen (open_recovery_cases); existieren Recovery-Zeilen, ist eine aktuelle, bestätigte Recovery-Export-Bestätigung des Aufrufers Pflicht (recovery_export_required / recovery_export_stale). Aufbewahrungsfrist: offene Rechtsfrage, nicht beschlossen.';

revoke all on function public.purge_company_for_last_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.purge_company_for_last_admin(uuid, uuid) to service_role;
