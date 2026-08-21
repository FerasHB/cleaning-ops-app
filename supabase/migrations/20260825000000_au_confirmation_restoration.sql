-- =========================================================
-- AU-Bestätigung + Urlaubs-Rückgabe
-- =========================================================
-- KERNREGEL (unverhandelbar): eine blosse Krankmeldung gibt NIEMALS Urlaub
--   zurueck. Eine Gutschrift entsteht ausschliesslich nach einer separaten,
--   ausdruecklich vom Admin BESTAETIGTEN Arbeitsunfaehigkeit. Die bestehende
--   Anzeige-Prioritaet 'Krankheit > Urlaub' (resolveEffectiveAbsenceDays)
--   bleibt reine Darstellungs-/Berechnungslogik und erzeugt selbst keine
--   Buchung.
--
-- MODELL: eigene Entitaet absence_evidence statt Felder auf
--   employee_absences. Gruende:
--     * employee_absences.status ist per CHECK an den Typ gekoppelt
--       (vacation: requested/approved/rejected/cancelled, sickness:
--       reported/cancelled). AU-Zustaende dort einzuhaengen wuerde entweder
--       den Status ueberladen oder Spalten erzeugen, die fuer Urlaubszeilen
--       bedeutungslos sind.
--     * Die AU-Pruefung ist ein EIGENER Vorgang mit eigenem Akteur, eigenen
--       Zeitstempeln und eigenem Lebenszyklus.
--     * document_path kann spaeter ergaenzt werden, ohne die
--       Abwesenheitstabelle anzufassen.
--
-- RUECKGABE-MENGE — BEWUSST KEINE AUTOMATIK BEI TEILUEBERSCHNEIDUNG:
--   Der Abzug liegt als AGGREGAT je (Urlaub, Jahr) im Ledger — es gibt KEINE
--   Zuordnung Tag -> abgezogener Tag. Deckt eine AU nur einen Teil des
--   Urlaubs ab (z. B. AU 12.–13.08. bei Urlaub 10.–14.08. mit 3 Tagen
--   Abzug), ist schlicht unbekannt, wie viele der 3 Tage auf 12.–13. fallen.
--   Eine Verhaeltnisrechnung (ueberschneidung/kalendertage * abzug) waere
--   geraten. Deshalb bestaetigt der Admin die Menge je Urlaub und Jahr
--   explizit; nur bei VOLLSTAENDIGER Abdeckung schlaegt die App den vollen
--   Abzug vor (dort ist die Menge eindeutig).
--
-- DOPPELTE RUECKGABE ist auf DB-Ebene ausgeschlossen:
--   (a) Unique-Index je (Nachweis, Urlaub, Jahr)
--   (b) serverseitige Obergrenze: Summe aller Rueckgaben je (Urlaub, Jahr)
--       darf den urspruenglichen Abzug nie uebersteigen — auch nicht ueber
--       ZWEI verschiedene Krankmeldungen hinweg.

-- ---------------------------------------------------------
-- 1. AU-Zustaende
-- ---------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'au_evidence_status') then
    create type public.au_evidence_status as enum ('pending', 'confirmed', 'rejected');
  end if;
end $$;

comment on type public.au_evidence_status is
'Zustand der AU-Pruefung. BEWUSST getrennt von employee_absences.status: die '
'Krankmeldung bleibt reported/cancelled, die aerztliche Bestaetigung ist ein '
'eigener Vorgang.';

-- ---------------------------------------------------------
-- 2. Nachweis-Entitaet
-- ---------------------------------------------------------
-- Genau EIN Nachweis je Krankmeldung (unique absence_id). Damit kann eine
-- Krankmeldung nicht ueber zwei Nachweiszeilen doppelt zurueckgeben.
create table if not exists public.absence_evidence (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  absence_id uuid not null references public.employee_absences(id) on delete cascade,
  status public.au_evidence_status not null default 'pending',
  submitted_at timestamptz not null default now(),
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz,
  note text,
  -- RESERVIERT: es gibt in diesem Stand keinen Upload-Pfad. Bewusst schon
  -- vorhanden, damit ein spaeterer Datei-Upload die Tabelle nicht aendern muss.
  document_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_absence_evidence_absence unique (absence_id),
  -- Ein entschiedener Nachweis traegt immer Akteur UND Zeitpunkt.
  constraint chk_absence_evidence_decided check (
    status = 'pending'
    or (confirmed_by is not null and confirmed_at is not null)
  )
);

comment on table public.absence_evidence is
'AU-Nachweis zu EINER Krankmeldung. Nur ein bestaetigter Nachweis '
'(status=confirmed) berechtigt zu einer Urlaubs-Rueckgabe — eine blosse '
'Krankmeldung nie.';

create index if not exists idx_absence_evidence_company on public.absence_evidence(company_id);
create index if not exists idx_absence_evidence_absence on public.absence_evidence(absence_id);

-- ---------------------------------------------------------
-- 3. Ledger: Herkunft der Rueckgabe
-- ---------------------------------------------------------
-- absence_id zeigt bei einer Rueckgabe auf den URLAUB (wie bei
-- approved_vacation/vacation_cancellation) — dadurch stehen Abzug und
-- Rueckgabe derselben Abwesenheit zusammen. evidence_id haelt fest, WELCHE
-- AU sie ausgeloest hat.
alter table public.vacation_ledger
  add column if not exists evidence_id uuid references public.absence_evidence(id) on delete set null;

comment on column public.vacation_ledger.evidence_id is
'Nur bei entry_type=''au_restoration'': der bestaetigte AU-Nachweis, der die '
'Gutschrift begruendet. absence_id zeigt weiterhin auf den URLAUB, dessen '
'Abzug teilweise oder ganz zurueckgegeben wird.';

-- Eine Rueckgabe je (Nachweis, Urlaub, Jahr) — Retry-sicher.
create unique index if not exists uq_vacation_ledger_au_restoration
  on public.vacation_ledger(evidence_id, absence_id, vacation_year_id)
  where entry_type = 'au_restoration';

create index if not exists idx_vacation_ledger_evidence
  on public.vacation_ledger(evidence_id) where evidence_id is not null;

-- ---------------------------------------------------------
-- 4. RLS — lesen nach Rolle, schreiben nur ueber RPC
-- ---------------------------------------------------------
alter table public.absence_evidence enable row level security;
revoke all on public.absence_evidence from anon, authenticated;
grant select on public.absence_evidence to authenticated;

drop policy if exists "employee read own absence evidence" on public.absence_evidence;
create policy "employee read own absence evidence"
on public.absence_evidence for select to authenticated
using (
  company_id = public.current_user_company_id()
  and exists (
    select 1 from public.employee_absences ea
    where ea.id = absence_evidence.absence_id
      and ea.employee_id = auth.uid()
  )
);

drop policy if exists "admin read company absence evidence" on public.absence_evidence;
create policy "admin read company absence evidence"
on public.absence_evidence for select to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

-- ABSICHTLICH keine insert/update/delete-Policy: jede Aenderung laeuft ueber
-- die SECURITY DEFINER-RPCs unten. Ein Mitarbeiter kann seine eigene AU
-- damit strukturell nicht bestaetigen.


-- ---------------------------------------------------------
-- 5. RPC: AU bestaetigen / ablehnen
-- ---------------------------------------------------------
-- Idempotent: ein erneutes Bestaetigen aendert nichts und erzeugt insbesondere
-- keine zweite Nachweiszeile (unique absence_id + Zustandspruefung).
-- Eine STORNIERTE Krankmeldung ist nicht pruefbar.
create or replace function public.admin_review_au(
  p_absence_id uuid,
  p_decision text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_status  public.absence_status;
  v_type    public.absence_type;
  v_new     public.au_evidence_status;
  v_id      uuid;
  v_current public.au_evidence_status;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can review an AU' using errcode = '42501';
  end if;

  if p_decision not in ('confirmed', 'rejected') then
    raise exception 'decision must be ''confirmed'' or ''rejected''' using errcode = '22023';
  end if;
  v_new := p_decision::public.au_evidence_status;

  -- Firmenscope + Typ/Status der Krankmeldung pruefen; Zeile sperren, damit
  -- zwei gleichzeitige Bestaetigungen serialisiert werden.
  select ea.company_id, ea.status, ea.type
    into v_company, v_status, v_type
  from public.employee_absences ea
  where ea.id = p_absence_id
    and ea.company_id = public.current_user_company_id()
  for update;

  if not found then
    raise exception 'Absence not found or not in your company' using errcode = '42501';
  end if;

  if v_type <> 'sickness' then
    raise exception 'Only sickness absences can carry an AU' using errcode = '23514';
  end if;

  if v_status = 'cancelled' then
    raise exception 'A cancelled sickness report cannot be reviewed' using errcode = '23514';
  end if;

  select id, status into v_id, v_current
  from public.absence_evidence where absence_id = p_absence_id for update;

  if v_id is null then
    insert into public.absence_evidence (
      company_id, absence_id, status, confirmed_by, confirmed_at, note
    )
    values (v_company, p_absence_id, v_new, auth.uid(), now(), p_note)
    returning id into v_id;
    return v_id;
  end if;

  -- Bereits derselbe Zustand -> echter No-Op (Retry-sicher).
  if v_current = v_new then
    return v_id;
  end if;

  -- Eine bereits bestaetigte AU, auf der Rueckgaben gebucht sind, darf nicht
  -- einfach umgeschaltet werden — sonst haetten gebuchte Gutschriften
  -- ploetzlich keine Grundlage mehr. Korrektur laeuft dann bewusst ueber eine
  -- sichtbare manuelle Anpassung im Urlaubskonto.
  if v_current = 'confirmed' and exists (
    select 1 from public.vacation_ledger
    where evidence_id = v_id and entry_type = 'au_restoration'
  ) then
    raise exception
      'This AU already has posted vacation restorations and can no longer be changed; correct the vacation account instead'
      using errcode = '42501';
  end if;

  update public.absence_evidence
  set status = v_new, confirmed_by = auth.uid(), confirmed_at = now(),
      note = coalesce(p_note, note), updated_at = now()
  where id = v_id;

  return v_id;
end;
$$;

comment on function public.admin_review_au(uuid, text, text) is
'Admin bestaetigt/lehnt die Arbeitsunfaehigkeit zu einer Krankmeldung ab. '
'Idempotent; eine stornierte Krankmeldung ist nicht pruefbar; eine bereits '
'bestaetigte AU mit gebuchten Rueckgaben ist gesperrt.';

revoke all on function public.admin_review_au(uuid, text, text) from public, anon;
grant execute on function public.admin_review_au(uuid, text, text) to authenticated;


-- ---------------------------------------------------------
-- 6. RPC: Rueckgabe-Kandidaten zu einer bestaetigten AU
-- ---------------------------------------------------------
-- Liefert je betroffenem (Urlaub, Jahr): den urspruenglichen Abzug, die
-- bereits zurueckgegebene Menge, den Rest und die Ueberschneidungstage.
-- full_coverage sagt, ob die AU den GESAMTEN Urlaub abdeckt — nur dann ist
-- die Rueckgabemenge eindeutig und die App darf sie vorbelegen.
--
-- Grundlage sind ausschliesslich TATSAECHLICH GEBUCHTE Abzuege im Ledger,
-- nie ein blosser Urlaubszeitraum und nie Einsatzplanung.
create or replace function public.get_au_restoration_candidates(
  p_absence_id uuid
)
returns table (
  vacation_absence_id uuid,
  vacation_start date,
  vacation_end date,
  year int,
  deducted_days numeric,
  already_restored numeric,
  restorable_days numeric,
  overlap_start date,
  overlap_end date,
  full_coverage boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_start   date;
  v_end     date;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can inspect restoration candidates' using errcode = '42501';
  end if;

  select ea.company_id, ea.start_date, coalesce(ea.end_date, 'infinity'::date)
    into v_company, v_start, v_end
  from public.employee_absences ea
  where ea.id = p_absence_id
    and ea.company_id = public.current_user_company_id()
    and ea.type = 'sickness'
    and ea.status = 'reported';

  if not found then
    raise exception 'Sickness report not found or not in your company' using errcode = '42501';
  end if;

  return query
  select
    va.id,
    va.start_date,
    va.end_date,
    vy.year,
    abs(vl.amount_days)::numeric,
    coalesce(restored.total, 0)::numeric,
    (abs(vl.amount_days) - coalesce(restored.total, 0))::numeric,
    greatest(va.start_date, v_start),
    least(va.end_date, v_end),
    (v_start <= va.start_date and v_end >= va.end_date)
  from public.vacation_ledger vl
  join public.employee_absences va on va.id = vl.absence_id
  join public.vacation_years vy on vy.id = vl.vacation_year_id
  left join lateral (
    select sum(r.amount_days) total
    from public.vacation_ledger r
    where r.absence_id = vl.absence_id
      and r.vacation_year_id = vl.vacation_year_id
      and r.entry_type = 'au_restoration'
  ) restored on true
  where vl.entry_type = 'approved_vacation'
    and vl.company_id = v_company
    and va.type = 'vacation'
    and va.status = 'approved'
    -- echte Ueberschneidung der Zeitraeume
    and va.start_date <= v_end
    and va.end_date   >= v_start
    -- der Urlaub muss demselben Mitarbeiter gehoeren wie die Krankmeldung
    and va.employee_id = (select employee_id from public.employee_absences where id = p_absence_id)
  order by va.start_date, vy.year;
end;
$$;

comment on function public.get_au_restoration_candidates(uuid) is
'Listet je (genehmigtem Urlaub, Jahr) den gebuchten Abzug, bereits '
'zurueckgegebene Tage, den verbleibenden Rest und die Ueberschneidung mit der '
'Krankmeldung. full_coverage=true nur bei vollstaendiger Abdeckung — nur dann '
'ist die Rueckgabemenge eindeutig.';

revoke all on function public.get_au_restoration_candidates(uuid) from public, anon;
grant execute on function public.get_au_restoration_candidates(uuid) to authenticated;


-- ---------------------------------------------------------
-- 7. RPC: Urlaubstage aufgrund bestaetigter AU zurueckgeben
-- ---------------------------------------------------------
-- p_restorations ist ein ARRAY expliziter Posten, je Urlaub UND Jahr:
--   [{"vacation_absence_id":"…","year":2026,"days":1.0}, …]
-- Getrennte Posten je Urlaub sind Absicht (Nachvollziehbarkeit): eine
-- Krankmeldung kann mehrere Urlaube beruehren, und jede Gutschrift bleibt
-- ihrem Abzug zuordenbar statt in einer undurchsichtigen Sammelbuchung.
--
-- OBERGRENZE: je (Urlaub, Jahr) darf die Summe ALLER Rueckgaben — auch ueber
-- verschiedene Krankmeldungen hinweg — den urspruenglichen Abzug nie
-- uebersteigen. Serverseitig geprueft, mit Sperre auf den Abzugszeilen.
create or replace function public.admin_restore_vacation_from_au(
  p_evidence_id uuid,
  p_restorations jsonb
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company    uuid;
  v_ev_status  public.au_evidence_status;
  v_sick_id     uuid;
  v_sick_start  date;
  v_sick_end    date;
  -- eigene Variable: die Krankmeldung traegt absence_status, NICHT
  -- au_evidence_status — die beiden Enums duerfen sich nicht vermischen.
  v_sick_status public.absence_status;
  v_employee   uuid;
  item         jsonb;
  v_vac_id     uuid;
  v_year       int;
  v_days       numeric;
  v_year_id    uuid;
  v_deducted   numeric;
  v_restored   numeric;
  v_count      int := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can restore vacation days' using errcode = '42501';
  end if;

  select ae.company_id, ae.status, ae.absence_id
    into v_company, v_ev_status, v_sick_id
  from public.absence_evidence ae
  where ae.id = p_evidence_id
    and ae.company_id = public.current_user_company_id()
  for update;

  if not found then
    raise exception 'Evidence not found or not in your company' using errcode = '42501';
  end if;

  -- KERNREGEL: ohne bestaetigte AU gibt es keine Gutschrift.
  if v_ev_status is distinct from 'confirmed' then
    raise exception 'Vacation can only be restored for a CONFIRMED AU' using errcode = '42501';
  end if;

  select ea.start_date, coalesce(ea.end_date, 'infinity'::date), ea.employee_id, ea.status
    into v_sick_start, v_sick_end, v_employee, v_sick_status
  from public.employee_absences ea where ea.id = v_sick_id;

  if v_sick_status = 'cancelled' then
    raise exception 'The sickness report was cancelled' using errcode = '23514';
  end if;

  if p_restorations is null or jsonb_typeof(p_restorations) <> 'array'
     or jsonb_array_length(p_restorations) = 0 then
    raise exception 'At least one restoration item is required' using errcode = '23514';
  end if;

  for item in select * from jsonb_array_elements(p_restorations)
  loop
    v_vac_id := (item ->> 'vacation_absence_id')::uuid;
    v_year   := (item ->> 'year')::int;
    v_days   := (item ->> 'days')::numeric;

    if v_vac_id is null or v_year is null or v_days is null then
      raise exception 'Each item needs vacation_absence_id, year and days' using errcode = '23514';
    end if;

    if v_days <= 0 then
      raise exception 'Restoration days must be greater than 0' using errcode = '23514';
    end if;

    select id into v_year_id from public.vacation_years
    where employee_id = v_employee and year = v_year;

    if v_year_id is null then
      raise exception 'Vacation year % is not initialized', v_year using errcode = '42501';
    end if;

    -- Abzugszeile SPERREN: verhindert, dass zwei gleichzeitige Rueckgaben die
    -- Obergrenze gemeinsam ueberschreiten.
    select abs(amount_days) into v_deducted
    from public.vacation_ledger
    where absence_id = v_vac_id
      and vacation_year_id = v_year_id
      and entry_type = 'approved_vacation'
      and company_id = v_company
    for update;

    if v_deducted is null then
      raise exception 'No approved vacation deduction found for this vacation/year'
        using errcode = '42501';
    end if;

    -- Der Urlaub MUSS sich wirklich mit der Krankmeldung ueberschneiden.
    if not exists (
      select 1 from public.employee_absences va
      where va.id = v_vac_id
        and va.employee_id = v_employee
        and va.type = 'vacation'
        and va.status = 'approved'
        and va.start_date <= v_sick_end
        and va.end_date   >= v_sick_start
    ) then
      raise exception 'Vacation does not overlap the sickness period' using errcode = '23514';
    end if;

    -- Summe ALLER bisherigen Rueckgaben fuer diesen (Urlaub, Jahr) —
    -- unabhaengig davon, aus welcher Krankmeldung sie stammen.
    select coalesce(sum(amount_days), 0) into v_restored
    from public.vacation_ledger
    where absence_id = v_vac_id
      and vacation_year_id = v_year_id
      and entry_type = 'au_restoration';

    if v_restored + v_days > v_deducted then
      raise exception
        'Restoration exceeds the original deduction (deducted %, already restored %, requested %)',
        v_deducted, v_restored, v_days
        using errcode = '23514';
    end if;

    insert into public.vacation_ledger (
      company_id, employee_id, vacation_year_id, entry_type, amount_days,
      absence_id, evidence_id, created_by, note
    )
    values (
      v_company, v_employee, v_year_id, 'au_restoration', v_days,
      v_vac_id, p_evidence_id, auth.uid(),
      'AU-Wiederherstellung (Krankmeldung ab ' || to_char(v_sick_start, 'DD.MM.YYYY') || ')'
    )
    on conflict (evidence_id, absence_id, vacation_year_id)
      where entry_type = 'au_restoration'
    do nothing;

    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

comment on function public.admin_restore_vacation_from_au(uuid, jsonb) is
'Bucht Urlaubs-Gutschriften aufgrund einer BESTAETIGTEN AU. Menge je Urlaub '
'und Jahr wird vom Admin bestaetigt (bei Teilueberschneidung nicht berechenbar). '
'Serverseitige Obergrenze: die Summe aller Rueckgaben je (Urlaub, Jahr) kann '
'den urspruenglichen Abzug nie uebersteigen, auch nicht ueber mehrere '
'Krankmeldungen hinweg. Retry erzeugt keine zweite Gutschrift.';

revoke all on function public.admin_restore_vacation_from_au(uuid, jsonb) from public, anon;
grant execute on function public.admin_restore_vacation_from_au(uuid, jsonb) to authenticated;


-- ---------------------------------------------------------
-- 8. Storno einer Krankmeldung mit gebuchter Rueckgabe blockieren
-- ---------------------------------------------------------
-- Sonst stuende eine Gutschrift auf einer Krankmeldung, die es offiziell
-- nicht mehr gibt. Historie wird NICHT still geloescht — die Korrektur laeuft
-- bewusst ueber eine sichtbare manuelle Anpassung im Urlaubskonto.
create or replace function public.cancel_own_sickness(
  absence_id_input uuid
)
returns setof public.employee_absences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'employee' then
    raise exception 'Only employees can cancel their own sickness report'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.absence_evidence ae
    join public.vacation_ledger vl on vl.evidence_id = ae.id
    where ae.absence_id = absence_id_input
      and vl.entry_type = 'au_restoration'
  ) then
    raise exception
      'This sickness report already led to restored vacation days and can no longer be cancelled; please contact your admin'
      using errcode = '42501';
  end if;

  update public.employee_absences
  set status = 'cancelled', updated_at = now()
  where id = absence_id_input
    and employee_id = auth.uid()
    and type = 'sickness'
    and status = 'reported';

  if not found then
    raise exception 'Sickness report not found, not yours, or already closed'
      using errcode = '42501';
  end if;

  return query select * from public.employee_absences where id = absence_id_input;
end;
$$;

comment on function public.cancel_own_sickness(uuid) is
'Mitarbeiter storniert eigene aktive Krankmeldung. Seit 20260825000000 '
'gesperrt, sobald daraus bereits Urlaubstage zurueckgegeben wurden — die '
'Gutschrift bliebe sonst ohne Grundlage. Korrektur dann ueber eine sichtbare '
'manuelle Anpassung im Urlaubskonto.';

revoke all on function public.cancel_own_sickness(uuid) from public, anon;
grant execute on function public.cancel_own_sickness(uuid) to authenticated;
