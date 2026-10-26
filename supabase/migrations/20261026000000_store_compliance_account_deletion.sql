-- Store-Compliance: Kontolöschung für den letzten Admin + ehrliche
-- Behandlung von Namens-Snapshots.
--
-- Hintergrund (Apple 5.1.1(v) / Google-Play-Account-Deletion): Jeder, der in
-- der App ein Konto anlegen kann, muss es dort auch löschen können. Bisher
-- lehnte prepare_self_account_deletion() den LETZTEN aktiven Admin mit
-- 'last_admin' ab und verwies auf "Firma auflösen / weiteren Admin ernennen" —
-- beides gibt es in der App nicht. Da jede Selbstregistrierung eine Firma mit
-- genau einem Admin anlegt, konnte praktisch kein selbst registriertes Konto
-- gelöscht werden.
--
-- Produktentscheidung: Löscht der letzte aktive Admin sein Konto, werden die
-- Firma und ALLE Mandantendaten mitgelöscht (inkl. der Mitarbeiterkonten der
-- Firma). Der Client muss das ausdrücklich bestätigen (doppelte Bestätigung in
-- der UI + confirmCompanyId im Request), der Server prüft alles erneut.
--
-- Warum eine eigene Purge-Funktion statt "delete from companies" + Kaskade:
-- die Kaskade scheitert heute an mehreren Stellen —
--   * work_sessions / work_operation_receipts -> job_assignments: RESTRICT
--   * session_time_corrections -> jobs / job_assignments / work_sessions: RESTRICT
--   * guard_work_session_write / guard_session_time_correction_write lehnen
--     JEDES DELETE ab (append-only Arbeitszeit-Nachweis)
--   * guard_session_assignment / guard_job_with_work_sessions lehnen das
--     Löschen erfasster Zuweisungen/Aufträge ab
--   * protect_recurring_job_history lehnt Dauerauftrag-Regeln mit
--     gestarteten/abgeschlossenen Terminen ab
--   * profiles.company_id ist ON DELETE SET NULL — Mitarbeiterkonten blieben
--     firmenlos mit Name/Telefon zurück.
-- Diese Schutzmechanismen bleiben für den normalen Betrieb unverändert. Sie
-- bekommen nur einen eng begrenzten Bypass, der ausschließlich innerhalb von
-- purge_company_for_last_admin() (nur service_role) per transaktionslokalem
-- Flag taskops.company_purge aktiv ist — dasselbe Vertrauensmodell wie das
-- bestehende Flag taskops.work_session_rpc (PostgREST exponiert set_config
-- nicht, Clients können das Flag nicht setzen).

-- =========================================================
-- 1) Bypass-Helfer
-- =========================================================
create or replace function public.company_purge_active()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(current_setting('taskops.company_purge', true), '') = 'on';
$$;

comment on function public.company_purge_active() is
'TRUE nur innerhalb von purge_company_for_last_admin() (transaktionslokales Flag). Erlaubt dort das Löschen sonst geschützter Arbeitszeit-/Historienzeilen.';

-- =========================================================
-- 2) Guards: Bypass NUR für DELETE während des Firmen-Purges
-- =========================================================
-- Funktionskörper 1:1 vom aktuellen Stand (Staging = Prod = 20261018000002)
-- übernommen; einzige Änderung ist jeweils der vorangestellte Purge-Zweig.

create or replace function public.guard_work_session_write()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_employee uuid; v_mode text;
begin
  if tg_op = 'DELETE' then
    if public.company_purge_active() then
      return old;
    end if;
    raise exception 'Recorded work sessions cannot be deleted' using errcode = '23503';
  end if;
  if tg_op = 'INSERT' then
    if current_setting('taskops.work_session_rpc', true) is distinct from 'on' then
      raise exception 'Work sessions are written only by execution RPCs' using errcode = '42501';
    end if;
    select employee_id, time_tracking_mode into v_employee, v_mode
    from public.job_assignments where id = new.job_assignment_id;
    if not found or v_mode <> 'sessions' or v_employee is null
       or new.employee_id is distinct from v_employee then
      raise exception 'Session owner does not match assignment' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.job_assignment_id is distinct from old.job_assignment_id
     or new.started_at is distinct from old.started_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Session identity and start are immutable' using errcode = '23514';
  end if;
  -- FK ON DELETE SET NULL is the sole ordinary non-RPC identity change.
  if new.employee_id is distinct from old.employee_id then
    if not (old.employee_id is not null and new.employee_id is null) then
      raise exception 'Session employee identity is immutable' using errcode = '23514';
    end if;
  end if;
  if new.ended_at is distinct from old.ended_at then
    if current_setting('taskops.work_session_rpc', true) is distinct from 'on'
       or old.ended_at is not null or new.ended_at is null then
      raise exception 'Session end can only be set once by an execution RPC' using errcode = '42501';
    end if;
    select employee_id into v_employee from public.job_assignments
    where id = old.job_assignment_id;
    if new.employee_id is distinct from v_employee then
      raise exception 'Session owner does not match assignment' using errcode = '23514';
    end if;
  end if;
  return new;
end $function$;

create or replace function public.guard_session_time_correction_write()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'DELETE' and public.company_purge_active() then
    return old;
  end if;
  raise exception 'Session time corrections are append-only' using errcode = '42501';
end $function$;

create or replace function public.guard_session_assignment()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'DELETE' then
    if public.company_purge_active() then
      return old;
    end if;
    if old.time_tracking_mode = 'sessions' or exists
      (select 1 from public.work_sessions where job_assignment_id = old.id) then
      raise exception 'Recorded work assignment cannot be deleted' using errcode = '23503';
    end if;
    return old;
  end if;
  if new.time_tracking_mode = 'legacy' and old.time_tracking_mode = 'sessions' then
    raise exception 'Session tracking cannot revert to legacy' using errcode = '23514';
  end if;
  if new.time_tracking_mode = 'sessions' and old.time_tracking_mode = 'legacy' then
    if current_setting('taskops.work_session_rpc', true) is distinct from 'on'
       or old.employee_started_at is not null or old.employee_completed_at is not null
       or new.employee_id is null then
      raise exception 'Only a fresh assignment may enter session mode' using errcode = '23514';
    end if;
  end if;
  if old.time_tracking_mode = 'sessions' then
    if new.employee_completed_at is not null
       and old.employee_completed_at is null
       and exists (select 1 from public.work_sessions
                   where job_assignment_id = old.id and ended_at is null) then
      raise exception 'Completed assignment cannot retain an active session'
        using errcode = '23514';
    end if;
    if new.job_id is distinct from old.job_id or
       (new.employee_id is distinct from old.employee_id and new.employee_id is not null) then
      raise exception 'Recorded work assignment cannot be reassigned' using errcode = '23514';
    end if;
    if (new.employee_started_at is distinct from old.employee_started_at
        or new.employee_completed_at is distinct from old.employee_completed_at
        or new.work_revision is distinct from old.work_revision
        or new.work_review_required is distinct from old.work_review_required
        or new.attendance is distinct from old.attendance)
       and current_setting('taskops.work_session_rpc', true) is distinct from 'on' then
      raise exception 'Session-aware assignment requires a controlled RPC' using errcode = '42501';
    end if;
  end if;
  return new;
end $function$;

create or replace function public.guard_job_with_work_sessions()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if public.company_purge_active() then
    return old;
  end if;
  if exists (select 1 from public.job_assignments ja
             join public.work_sessions ws on ws.job_assignment_id = ja.id
             where ja.job_id = old.id) then
    raise exception 'Job has recorded work sessions' using errcode = '23503';
  end if;
  return old;
end $function$;

create or replace function public.protect_recurring_job_history()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  protected_count int;
begin
  -- Firmen-Purge (letzter Admin löscht Konto + Firma): die Historie wird
  -- bewusst mitgelöscht, siehe purge_company_for_last_admin().
  if public.company_purge_active() then
    return old;
  end if;

  -- Nur Parent-Regeln wiederkehrender Aufträge sind hier relevant.
  -- Konkrete Occurrences (parent_job_id IS NOT NULL) und normale
  -- Einzel-Jobs laufen unverändert durch — auch dann, wenn sie selbst
  -- über den CASCADE-Pfad dieser Tabelle gelöscht werden.
  if old.job_type is distinct from 'recurring' or old.parent_job_id is not null then
    return old;
  end if;

  select count(*)
    into protected_count
  from public.jobs c
  where c.parent_job_id = old.id
    and c.status in ('in_progress', 'completed');

  if protected_count > 0 then
    raise exception
      'Dauerauftrag kann nicht gelöscht werden: % bereits gestartete oder abgeschlossene Termine hängen daran.',
      protected_count
      using
        detail =
          'Das Löschen würde diese Termine samt Arbeitszeiten (Stundenzettel), '
          || 'Kommentaren und Fotos unwiederbringlich entfernen.',
        hint =
          'Setze den Dauerauftrag stattdessen auf inaktiv (is_active = false). '
          || 'Zukünftige Termine entfallen damit, die Historie bleibt erhalten.';
  end if;

  return old;
end;
$function$;

-- =========================================================
-- 3) Namens-Snapshots bei Kontolöschung (Mitarbeiter-/Admin-Pfad)
-- =========================================================
-- Bewusste Entscheidung (Store-Compliance-Audit 2026-10-26):
--   * job_assignments.employee_name_snapshot und
--     employee_absences.employee_name_snapshot BLEIBEN erhalten. Sie sind
--     der Arbeitszeit-/Abwesenheitsnachweis des Arbeitgebers für Konten, die
--     es nicht mehr gibt (Stundenzettel-Beleg, siehe job_assignments.test.sql
--     Fall 18). Für die Gebäudereinigung bestehen gesetzliche
--     Aufzeichnungspflichten (§ 17 MiLoG i. V. m. § 2a SchwarzArbG) —
--     anonymisierte Arbeitszeitzeilen wären als Nachweis wertlos. Die
--     Lösch-UI sagt das jetzt ausdrücklich, statt Anonymisierung zu
--     versprechen.
--   * notification_outbox.employee_name ist dagegen nur Text für eine
--     (meist längst zugestellte) Push-Nachricht — kein Nachweis, keine
--     Aufbewahrungspflicht. Er wird beim Löschen ersetzt.
-- BEFORE DELETE auf profiles deckt jeden Löschpfad ab (auth.admin.deleteUser
-- kaskadiert auf profiles, ebenso der Firmen-Purge).
create or replace function public.anonymize_deleted_profile_snapshots()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.notification_outbox
     set employee_name = 'Gelöschtes Konto'
   where employee_id = old.id
     and employee_name is distinct from 'Gelöschtes Konto';

  return old;
end;
$$;

comment on function public.anonymize_deleted_profile_snapshots() is
'BEFORE DELETE auf profiles: ersetzt den Namen des gelöschten Kontos in notification_outbox. Arbeitszeit-/Abwesenheits-Snapshots bleiben bewusst erhalten (Aufzeichnungspflicht), siehe Migration 20261026000000.';

revoke all on function public.anonymize_deleted_profile_snapshots() from public, anon, authenticated;

drop trigger if exists anonymize_deleted_profile_snapshots_trg on public.profiles;
create trigger anonymize_deleted_profile_snapshots_trg
  before delete on public.profiles
  for each row execute function public.anonymize_deleted_profile_snapshots();

-- =========================================================
-- 4) RPC: Lösch-Kontext für die UI (authenticated)
-- =========================================================
-- Sagt dem Client VOR dem Löschen, welcher Pfad gilt. Rein informativ — die
-- Edge Function / purge_company_for_last_admin() prüfen alles erneut.
-- "Letzter Admin" exakt wie in prepare_self_account_deletion(): kein weiterer
-- aktiver Admin ohne eigene laufende Löschreservierung.
create or replace function public.get_account_deletion_context()
returns jsonb
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
  v_company_name text;
  v_is_last_admin boolean := false;
  v_other_members int := 0;
begin
  if v_caller is null then
    raise exception 'unauthenticated';
  end if;

  select role, company_id, is_active
    into v_role, v_company_id, v_is_active
  from public.profiles
  where id = v_caller;

  if not found then
    raise exception 'profile_not_found';
  end if;

  if v_company_id is not null then
    select name into v_company_name from public.companies where id = v_company_id;

    select count(*) into v_other_members
    from public.profiles
    where company_id = v_company_id and id <> v_caller;
  end if;

  if v_role = 'admin' and v_company_id is not null then
    v_is_last_admin := not exists (
      select 1 from public.profiles
      where company_id = v_company_id
        and role = 'admin'
        and is_active = true
        and account_deletion_token is null
        and id <> v_caller
    );
  end if;

  return jsonb_build_object(
    'role', v_role,
    'is_active', v_is_active,
    'company_id', v_company_id,
    'company_name', v_company_name,
    'is_last_admin', v_is_last_admin,
    'other_member_count', v_other_members
  );
end;
$$;

revoke all on function public.get_account_deletion_context() from public, anon;
grant execute on function public.get_account_deletion_context() to authenticated;

-- =========================================================
-- 5) RPC: Firma + Konto des letzten Admins löschen (nur service_role)
-- =========================================================
-- Aufruf ausschließlich aus der Edge Function delete-account. p_caller kommt
-- dort aus der verifizierten Session (auth.getUser), NIE aus dem Body.
-- p_confirm_company_id ist die Bestätigung des Clients ("ich lösche GENAU
-- diese Firma") und muss mit der Firma des Aufrufers übereinstimmen — eine
-- fremde/gefälschte ID bewirkt nichts ('company_mismatch').
--
-- Alles in EINER Transaktion: entweder ist die Firma samt Daten und Konten
-- weg, oder es bleibt alles unverändert. Storage-Dateien kann SQL nicht
-- entfernen (storage.protect_delete) — die Funktion gibt die Pfade zurück,
-- die Edge Function räumt sie danach über die Storage-API ab.
--
-- Fehlertexte (maschinenlesbar): unauthenticated, profile_not_found,
-- inactive_account, not_admin, company_mismatch, not_last_admin.
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
'Store-Compliance: letzter aktiver Admin löscht Konto + Firma + alle Mandantendaten und -konten (eine Transaktion). Nur service_role (Edge Function delete-account). Gibt Storage-Pfade zum Aufräumen zurück.';

revoke all on function public.purge_company_for_last_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.purge_company_for_last_admin(uuid, uuid) to service_role;
