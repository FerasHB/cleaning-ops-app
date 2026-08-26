-- =========================================================
-- MIGRATION: admin_create_absence respektiert das Urlaubskonto
-- =========================================================
-- BEFUND (QA vor Beta, verifiziert auf Staging)
--   admin_create_absence(type='vacation') hat Urlaub bisher IMMER direkt bei
--   status='approved' angelegt — unabhaengig davon, ob fuer den Mitarbeiter
--   ein Urlaubskonto gefuehrt wird (profiles.vacation_management_enabled).
--   Damit entstand fuer Konto-Mitarbeiter:
--     * ein als "genehmigt" gefuehrter Urlaub,
--     * der in Stundenzettel/Uebersicht als wirksame Abwesenheit zaehlt
--       (isOperationallyActiveAbsence prueft nur status='approved'),
--     * OHNE jede vacation_ledger-Zeile und OHNE
--       vacation_deducted_days_snapshot.
--   Das Urlaubskonto-Design (20260824000000) geht davon aus, dass "approved"
--   ausschliesslich ueber admin_review_vacation erreicht wird — genau dort
--   sitzt die einzige Stelle, die den Abzug bestaetigt und festschreibt.
--   admin_create_absence ist in KEINER der drei Ledger-Migrationen
--   (20260823/24/25) auch nur erwaehnt; der zweite Weg zu "approved" wurde
--   beim Entwurf des Kontos schlicht nicht mitgedacht.
--
--   Empirisch auf Staging reproduziert: 5-Tage-Urlaub ueber
--   admin_create_absence fuer einen Konto-Mitarbeiter -> status=approved,
--   vacation_deducted_days_snapshot=NULL, 0 Ledger-Zeilen, Saldo
--   unveraendert, aber vom Stundenzettel als 5 wirksame Urlaubstage gezaehlt.
--
-- =========================================================
-- FIX (kleinstmoeglich, keine Logik-Duplikation)
-- =========================================================
--   admin_create_absence liest zusaetzlich profiles.vacation_management_enabled
--   des Ziel-Mitarbeiters — GENAU dieselbe Spalte, GENAU derselbe direkte
--   Zugriff (kein Firmen-Default-Fallback), den admin_review_vacation bereits
--   fuer dieselbe Entscheidung verwendet ("if v_enabled is true then ...").
--   Beide RPCs stimmen dadurch strukturell IMMER ueberein, welches Regime
--   fuer einen Mitarbeiter gilt.
--
--   Fuer type='vacation':
--     * vacation_management_enabled = true  -> status='requested',
--       reviewed_by/reviewed_at bleiben NULL (kein Genehmigungsschritt
--       vorweggenommen). Der Admin genehmigt anschliessend ueber die
--       BESTEHENDE admin_review_vacation()-UI (AdminAbsenceRow zeigt
--       Genehmigen/Ablehnen fuer jede status='requested'-Zeile, unabhaengig
--       davon, wer sie angelegt hat) — dort laeuft die Abzugsbestaetigung,
--       die Ledger-Zeile und der Snapshot exakt wie fuer einen
--       Mitarbeiter-Antrag.
--     * vacation_management_enabled = false/NULL -> unveraendertes
--       Verhalten (status='approved', reviewed_by/at = erfassender Admin).
--
--   Fuer type='sickness': VOLLSTAENDIG UNVERAENDERT (status='reported',
--   reviewed_by/at bleiben NULL) — Krankheit beruehrt das Urlaubskonto nie,
--   unabhaengig vom Erfassungsweg.
--
--   KEINE neue Ledger-Logik in dieser Funktion: admin_review_vacation bleibt
--   die EINZIGE Stelle, die vacation_ledger-Zeilen und
--   vacation_deducted_days_snapshot schreibt (siehe deren Kommentarblock,
--   20260824000000). Diese Migration fasst admin_review_vacation nicht an.
--
--   UNVERAENDERT: Rollenpruefung, Firmenscope (inkl. is_active-loser
--   Mitarbeitersuche fuer historische Nacherfassung), Ueberschneidungs-
--   pruefung, Enddatum-Validierung, employee_name_snapshot, Benachrichtigung
--   (keine — admin_create_absence hat nie enqueue_absence_notification
--   aufgerufen; das aendert sich hier nicht), RLS-Modell (weiterhin
--   ausschliesslich diese SECURITY-DEFINER-RPC als Schreibpfad).
--
-- IDEMPOTENZ
--   CREATE OR REPLACE FUNCTION — vollstaendig wiederholbar.
--
-- ANWENDUNG
--   Wie alle Schemaaenderungen hier MANUELL im Supabase SQL Editor
--   ausfuehren (siehe CLAUDE.md).
-- =========================================================

create or replace function public.admin_create_absence(
  employee_id_input uuid,
  type_input public.absence_type,
  start_date_input date,
  end_date_input date default null,
  note_input text default null
)
returns setof public.employee_absences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id        uuid;
  v_full_name         text;
  v_vacation_enabled  boolean;
  v_status            public.absence_status;
  v_new_id            uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can manually record an absence'
      using errcode = '42501';
  end if;

  v_company_id := public.current_user_company_id();
  if v_company_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Mitarbeiter muss in derselben Firma sein. BEWUSST OHNE is_active-
  -- Bedingung: ein Admin muss eine historische Abwesenheit auch fuer einen
  -- inzwischen deaktivierten Mitarbeiter nachtragen koennen (z. B.
  -- Krankmeldung kurz vor Austritt), ohne dass ein Datensatz verloren geht.
  -- Das entspricht dem Muster von admin_correct_assignment_time, das
  -- ebenfalls keine is_active-Bedingung an der betroffenen Person kennt.
  --
  -- NEU: vacation_management_enabled wird hier zusaetzlich gelesen — exakt
  -- derselbe direkte Spaltenzugriff wie in admin_review_vacation, damit
  -- beide RPCs fuer denselben Mitarbeiter niemals unterschiedlich
  -- entscheiden koennen.
  select full_name, vacation_management_enabled
    into v_full_name, v_vacation_enabled
  from public.profiles
  where id = employee_id_input
    and company_id = v_company_id;

  if not found then
    raise exception 'Employee not found in your company'
      using errcode = '42501';
  end if;

  if start_date_input is null then
    raise exception 'start_date is required' using errcode = '23514';
  end if;

  if type_input = 'vacation' then
    if end_date_input is null then
      raise exception 'end_date is required for vacation'
        using errcode = '23514';
    end if;
    if end_date_input < start_date_input then
      raise exception 'end_date must not be before start_date'
        using errcode = '23514';
    end if;

    if exists (
      select 1 from public.employee_absences ea
      where ea.employee_id = employee_id_input
        and ea.type = 'vacation'
        and ea.status in ('requested', 'approved')
        and ea.start_date <= end_date_input
        and ea.end_date   >= start_date_input
    ) then
      raise exception 'Overlaps an existing vacation request'
        using errcode = '23514';
    end if;

    -- KERNAENDERUNG: fuer einen gefuehrten Urlaubskonto-Mitarbeiter NICHT
    -- direkt genehmigen. admin_review_vacation bleibt das einzige Tor zu
    -- 'approved' fuer diese Gruppe — dort wird der Abzug erzwungen bestaetigt
    -- und als Ledger-Zeile + Snapshot festgeschrieben.
    v_status := case when v_vacation_enabled is true then 'requested' else 'approved' end;
  elsif type_input = 'sickness' then
    if end_date_input is not null and end_date_input < start_date_input then
      raise exception 'end_date must not be before start_date'
        using errcode = '23514';
    end if;

    if exists (
      select 1 from public.employee_absences ea
      where ea.employee_id = employee_id_input
        and ea.type = 'sickness'
        and ea.status = 'reported'
        and ea.start_date <= coalesce(end_date_input, 'infinity'::date)
        and coalesce(ea.end_date, 'infinity'::date) >= start_date_input
    ) then
      raise exception 'Overlaps an existing active sickness report'
        using errcode = '23514';
    end if;

    v_status := 'reported';
  else
    raise exception 'Unknown absence type' using errcode = '22023';
  end if;

  insert into public.employee_absences (
    company_id, employee_id, employee_name_snapshot,
    type, status, start_date, end_date, admin_note, created_by,
    reviewed_by, reviewed_at
  )
  values (
    v_company_id, employee_id_input, coalesce(nullif(btrim(v_full_name), ''), 'Unbekannt'),
    type_input, v_status, start_date_input, end_date_input, note_input, auth.uid(),
    -- reviewed_by/at werden NUR gesetzt, wenn diese Zeile bereits final
    -- genehmigt ist (Urlaub ohne Konto). Ein 'requested'-Urlaub (Konto
    -- aktiv) durchlaeuft die Genehmigung noch — reviewed_by/at bleiben dafuer
    -- NULL, exakt wie bei einem Mitarbeiter-Antrag ueber
    -- request_own_vacation(). Krankheit kennt ohnehin keinen
    -- Genehmigungsschritt und bleibt bei NULL/NULL.
    case when type_input = 'vacation' and v_status = 'approved' then auth.uid() else null end,
    case when type_input = 'vacation' and v_status = 'approved' then now() else null end
  )
  returning id into v_new_id;

  return query select * from public.employee_absences where id = v_new_id;
end;
$$;

comment on function public.admin_create_absence(uuid, public.absence_type, date, date, text) is
'Admin erfasst eine Abwesenheit manuell fuer einen Mitarbeiter der eigenen '
'Firma (Telefon-Krankmeldung, ausserhalb der App vereinbarter Urlaub). '
'Krankheit landet immer direkt bei status=reported (kein Genehmigungsschritt). '
'Urlaub landet bei status=approved (reviewed_by/at = der erfassende Admin) '
'NUR wenn fuer den Mitarbeiter KEIN Urlaubskonto gefuehrt wird '
'(profiles.vacation_management_enabled=false/NULL) — sonst bei '
'status=requested, ohne reviewed_by/at, damit die Genehmigung samt '
'Abzugsbestaetigung ausschliesslich ueber admin_review_vacation laeuft '
'(einzige Quelle fuer vacation_ledger-Zeilen und '
'vacation_deducted_days_snapshot, siehe 20260824000000). '
'created_by <> employee_id markiert die Zeile als manuell erfasst. Erlaubt '
'auch fuer inzwischen deaktivierte Mitarbeiter (historische Nacherfassung).';

revoke all on function public.admin_create_absence(uuid, public.absence_type, date, date, text) from public, anon;
grant execute on function public.admin_create_absence(uuid, public.absence_type, date, date, text) to authenticated;
