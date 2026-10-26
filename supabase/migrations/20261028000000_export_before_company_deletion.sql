-- Export → Bestätigen → Löschen (Produktentscheidung 2026-10-27, erster
-- öffentlicher Release). Ersetzt das Compliance-Archiv aus 20261027000000.
--
-- Begründung: Gesetzliche Aufbewahrungspflichten für Arbeitszeitnachweise
-- treffen den ARBEITGEBER (Verantwortlicher). Für eine eigenständige
-- Aufbewahrung durch NovaFlow (Auftragsverarbeiter) nach Ende der Firma und
-- der Verarbeitung gibt es derzeit keine bestätigte Rechtsgrundlage. Statt
-- eines Archivs bekommt der letzte Admin VOR der Löschung einen Export der
-- erfassten Arbeitszeiten (get_company_worktime_export, CSV/PDF wird auf dem
-- Gerät erzeugt — keine Datei auf dem Server) und bestätigt, dass er für
-- seine Aufbewahrungspflichten selbst verantwortlich ist.
--
-- Diese Migration:
--   1) setzt purge_company_for_last_admin() auf die Fassung OHNE
--      Archivierung zurück (identisch mit 20261026000000),
--   2) entfernt die Archiv-Funktionen und die Archivtabelle — nur wenn sie
--      leer ist (sonst Abbruch, damit nie still Nachweise vernichtet werden),
--   3) legt den Admin-Export get_company_worktime_export() an.
-- 20261027000000 bleibt unverändert (bereits auf Staging angewandt; keine
-- Migrations-Drift). Auf einer frischen Kette legt 27 die Tabelle an und 28
-- entfernt sie wieder, bevor jemals ein Datensatz geschrieben werden kann.
-- Das Archiv-Design bleibt in der Git-Historie für eine spätere rechtliche
-- Prüfung erhalten.

-- =========================================================
-- 1) Purge ohne Archivierung (Fassung aus 20261026000000)
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
'Store-Compliance: letzter aktiver Admin löscht Konto + Firma + alle Mandantendaten und -konten (eine Transaktion, KEIN Archiv). Nur service_role (Edge Function delete-account). Gibt Storage-Pfade zum Aufräumen zurück. Export vorher: get_company_worktime_export().';

revoke all on function public.purge_company_for_last_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.purge_company_for_last_admin(uuid, uuid) to service_role;

-- =========================================================
-- 2) Archiv entfernen (nur wenn leer)
-- =========================================================
drop function if exists public.set_compliance_retain_until(uuid, date, text[]);
drop function if exists public.purge_expired_compliance_records();
drop function if exists public.purge_compliance_records_for_company(uuid, text[]);

do $$
begin
  if to_regclass('public.compliance_retention_records') is not null then
    if exists (select 1 from public.compliance_retention_records) then
      raise exception 'compliance_retention_records enthält Daten — Archiv wird NICHT automatisch gelöscht. Erst rechtlich klären und manuell behandeln.';
    end if;
    drop table public.compliance_retention_records;
  end if;
end $$;

-- =========================================================
-- 3) Arbeitszeit-Export für Admins der eigenen Firma
-- =========================================================
-- Nur aktive Admins, nur die eigene Firma (aus dem Profil des Aufrufers, nie
-- aus einem Parameter). Liefert ausschließlich Arbeitszeit-Fakten:
--   * record_kind 'session'    — je Arbeitssitzung (Sessions-Modus), mit
--                                 Roh- und effektiven Zeiten (letzte
--                                 Korrektur) und Korrektur-Metadaten
--   * record_kind 'assignment' — je Zuweisung im Legacy-Modus mit erfasster
--                                 Zeit (Mitarbeiter-Start/-Ende, sonst die
--                                 geteilte Job-Uhr), mit Anzahl der
--                                 Admin-Zeitanpassungen
-- NICHT enthalten: Abwesenheiten/Krankmeldungen, Urlaub, Notizen,
-- Begründungstexte, Kommentare, Fotos, Kunde/Adresse/Service, Kontaktdaten,
-- Push-Daten. Lokale Zeiten in der Zeitzone der Firma.
create or replace function public.get_company_worktime_export()
returns table (
  record_kind text,
  employee_id uuid,
  employee_name text,
  work_date date,
  start_local text,
  end_local text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_minutes integer,
  raw_started_at timestamptz,
  raw_ended_at timestamptz,
  corrected boolean,
  correction_count integer,
  last_correction_origin text,
  last_corrected_at timestamptz,
  time_adjustment_count integer,
  job_id uuid,
  assignment_id uuid,
  timezone text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_role text;
  v_company_id uuid;
  v_is_active boolean;
  v_tz text;
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

  select coalesce(nullif(c.timezone, ''), 'Europe/Berlin')
    into v_tz
  from public.companies c
  where c.id = v_company_id;

  return query
  with company_assignments as (
    select ja.id, ja.job_id, ja.employee_id, ja.employee_name_snapshot,
           ja.time_tracking_mode, ja.employee_started_at, ja.employee_completed_at,
           j.started_at as job_started_at, j.completed_at as job_completed_at
    from public.job_assignments ja
    join public.jobs j on j.id = ja.job_id
    where j.company_id = v_company_id
  ),
  sessions as (
    select 'session'::text as kind, ca.employee_id as emp,
           coalesce(p.full_name, ca.employee_name_snapshot) as emp_name,
           e.effective_started_at as s, e.effective_ended_at as f,
           e.raw_started_at as rs, e.raw_ended_at as rf,
           e.reviewed as corr,
           (select count(*)::int from public.session_time_corrections stc
             where stc.work_session_id = e.session_id) as corr_count,
           lc.origin as corr_origin, lc.created_at as corr_at,
           0 as adj_count,
           ca.job_id as jid, ca.id as aid
    from public._effective_sessions(
           (select coalesce(array_agg(id), '{}') from company_assignments)) e
    join company_assignments ca on ca.id = e.job_assignment_id
    left join public.profiles p on p.id = ca.employee_id
    left join lateral (
      select stc.origin, stc.created_at
      from public.session_time_corrections stc
      where stc.work_session_id = e.session_id
      order by stc.revision_no desc
      limit 1
    ) lc on true
  ),
  legacy as (
    select 'assignment'::text as kind, ca.employee_id as emp,
           coalesce(p.full_name, ca.employee_name_snapshot) as emp_name,
           coalesce(ca.employee_started_at, ca.job_started_at) as s,
           coalesce(ca.employee_completed_at, ca.job_completed_at) as f,
           null::timestamptz as rs, null::timestamptz as rf,
           false as corr, 0 as corr_count,
           null::text as corr_origin, null::timestamptz as corr_at,
           (select count(*)::int from public.employee_time_adjustments eta
             where eta.assignment_id = ca.id) as adj_count,
           ca.job_id as jid, ca.id as aid
    from company_assignments ca
    left join public.profiles p on p.id = ca.employee_id
    where ca.time_tracking_mode = 'legacy'
      and coalesce(ca.employee_started_at, ca.job_started_at) is not null
  )
  select r.kind, r.emp, r.emp_name,
         (r.s at time zone v_tz)::date,
         to_char(r.s at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
         to_char(r.f at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
         r.s, r.f,
         case when r.f is null then null
              else greatest(0, round(extract(epoch from (r.f - r.s)) / 60))::int end,
         r.rs, r.rf, r.corr, r.corr_count, r.corr_origin, r.corr_at, r.adj_count,
         r.jid, r.aid, v_tz
  from (select * from sessions union all select * from legacy) r
  order by r.emp_name nulls last, r.s, r.aid;
end;
$$;

comment on function public.get_company_worktime_export() is
'Arbeitszeit-Export der eigenen Firma für aktive Admins (vor der Firmenlöschung). Nur Arbeitszeit-Fakten; keine Abwesenheiten/Gesundheitsdaten, Notizen, Kommentare, Fotos, Kundendaten.';

revoke all on function public.get_company_worktime_export() from public, anon;
grant execute on function public.get_company_worktime_export() to authenticated;
