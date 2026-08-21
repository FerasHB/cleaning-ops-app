-- =========================================================
-- Urlaubskonto: Jahres-Container + Ledger + erklärbarer Saldo
-- =========================================================
-- ABZUGS-MODELL — BEWUSSTE ENTSCHEIDUNG GEGEN AUTOMATIK:
--   Es gibt heute KEINE deterministische Grundlage, um zu berechnen, welche
--   konkreten Tage eines Urlaubs Anspruch verbrauchen:
--     * vacation_reference_days_per_week ist eine ANZAHL (z. B. 3), nicht die
--       konkreten Wochentage. Bei Urlaub 10.–14.08. ist damit unbekannt,
--       WELCHE 3 Tage gearbeitet worden wären.
--     * Eine Formel wie kalendertage * referenztage / 7 ergibt 5 * 3/7 =
--       2,14 Tage — ein Bruchwert ohne rechtliche Grundlage, den niemand
--       einem Mitarbeiter erklären kann.
--     * Job-Occurrences taugen NICHT als Quelle: sie sind nach der
--       Genehmigung weiterhin änderbar (Admin legt Jobs an/verschiebt sie)
--       und werden nur ~3 Monate im Voraus materialisiert (hartes Maximum
--       730 Tage). Ein für nächstes Jahr genehmigter Urlaub ergäbe 0 Tage,
--       und spätere Planänderungen würden verbrauchten Urlaub RÜCKWIRKEND
--       verändern.
--   DESHALB: der Admin bestätigt den Abzug bei der Genehmigung explizit. Der
--   bestätigte Wert wird als unveränderlicher Schnappschuss festgeschrieben
--   (employee_absences.vacation_deducted_days_snapshot + Ledger-Zeile).
--   NICHTS rechnet ihn je neu — spätere Planänderungen können die Historie
--   damit strukturell nicht mehr anfassen.
--
-- SALDO: ausschließlich SUM(vacation_ledger.amount_days). Es gibt bewusst
--   KEINE veränderliche remaining_days-Spalte. Jede Zahl im UI ist damit
--   zeilenweise belegbar ("warum 28,0?").
--
-- JAHRESGRENZE: Abzüge werden IMMER als Zuordnung Jahr -> Tage übergeben
--   (jsonb). Ein Urlaub über den Jahreswechsel muss deshalb explizit
--   aufgeteilt werden; es ist strukturell unmöglich, versehentlich alle Tage
--   ins Startjahr zu buchen.
--
-- KRANKHEIT: eine Krankmeldung verändert das Urlaubskonto NICHT. Es gibt in
--   dieser Migration keinen Pfad, der aus 'reported' eine Gutschrift erzeugt.
--   Eine spätere, ärztlich bestätigte AU wird das über eine eigene
--   Kompensationszeile lösen — hier ausdrücklich NICHT enthalten.

-- ---------------------------------------------------------
-- 1. Ereignisarten
-- ---------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'vacation_ledger_entry_type') then
    create type public.vacation_ledger_entry_type as enum (
      'annual_entitlement',    -- Jahresanspruch (positiv), genau 1x je Jahr
      'approved_vacation',     -- genehmigter Urlaub (negativ)
      'vacation_cancellation', -- Storno eines genehmigten Urlaubs (positiv, kompensierend)
      'manual_adjustment',     -- Admin-Korrektur (vorzeichenbehaftet)
      'carry_over',            -- RESERVIERT: Übertrag — keine Logik in diesem PR
      'au_restoration'         -- RESERVIERT: Gutschrift nach bestätigter AU — keine Logik
    );
  end if;
end $$;

comment on type public.vacation_ledger_entry_type is
'Ereignisarten des Urlaubskontos. carry_over und au_restoration sind bewusst '
'nur als Werte reserviert — es gibt in diesem Stand KEINE Geschäftslogik '
'dafür (kein automatischer Übertrag, keine Rückgabe bei Krankheit).';

-- ---------------------------------------------------------
-- 2. Jahres-Container
-- ---------------------------------------------------------
-- BEWUSST OHNE entitlement_days: der Betrag steht ausschließlich als
-- annual_entitlement-Zeile im Ledger. Zwei Orte für dieselbe Zahl wären genau
-- die veränderliche Zweitquelle, die dieses Design vermeiden soll.
create table if not exists public.vacation_years (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  year int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_vacation_years_employee_year unique (employee_id, year),
  constraint chk_vacation_years_year check (year between 2000 and 2100)
);

comment on table public.vacation_years is
'Ein Urlaubsjahr-Konto je Mitarbeiter und Kalenderjahr. Reiner Container — '
'die Beträge liegen im Ledger. Historische Jahre bleiben dadurch stabil.';

create index if not exists idx_vacation_years_company on public.vacation_years(company_id);
create index if not exists idx_vacation_years_employee on public.vacation_years(employee_id, year);

-- ---------------------------------------------------------
-- 3. Ledger (append-only)
-- ---------------------------------------------------------
create table if not exists public.vacation_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  vacation_year_id uuid not null references public.vacation_years(id) on delete cascade,
  entry_type public.vacation_ledger_entry_type not null,
  amount_days numeric(6,2) not null,
  absence_id uuid references public.employee_absences(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  -- Vorzeichen je Art erzwingen: ein "genehmigter Urlaub" mit positivem
  -- Betrag waere ein stiller Buchungsfehler.
  constraint chk_vacation_ledger_sign check (
    (entry_type = 'annual_entitlement'    and amount_days >= 0)
    or (entry_type = 'approved_vacation'     and amount_days <= 0)
    or (entry_type = 'vacation_cancellation' and amount_days >= 0)
    or (entry_type = 'carry_over'            and amount_days >= 0)
    or (entry_type = 'au_restoration'        and amount_days >= 0)
    or (entry_type = 'manual_adjustment')
  ),
  -- Korrekturen muessen begruendet sein (Nachvollziehbarkeit).
  constraint chk_vacation_ledger_manual_note check (
    entry_type <> 'manual_adjustment'
    or (note is not null and length(btrim(note)) > 0)
  )
);

comment on table public.vacation_ledger is
'Append-only Buchungszeilen des Urlaubskontos. Resturlaub = SUM(amount_days). '
'Zeilen werden NIE geaendert oder geloescht — Korrekturen entstehen '
'ausschliesslich als neue, kompensierende Zeilen.';

create index if not exists idx_vacation_ledger_year on public.vacation_ledger(vacation_year_id);
create index if not exists idx_vacation_ledger_employee on public.vacation_ledger(employee_id, created_at);
create index if not exists idx_vacation_ledger_company on public.vacation_ledger(company_id);
create index if not exists idx_vacation_ledger_absence on public.vacation_ledger(absence_id) where absence_id is not null;

-- Genau EINE Jahresanspruch-Zeile je Jahr (Idempotenz bei Retry).
create unique index if not exists uq_vacation_ledger_annual
  on public.vacation_ledger(vacation_year_id)
  where entry_type = 'annual_entitlement';

-- Genau EIN Abzug je Abwesenheit UND Jahr (Jahresuebergang => zwei Zeilen,
-- aber pro Jahr nur eine). Verhindert Doppelabzug bei Retry.
create unique index if not exists uq_vacation_ledger_absence_deduction
  on public.vacation_ledger(absence_id, vacation_year_id)
  where entry_type = 'approved_vacation';

-- Genau EINE Storno-Gutschrift je Abwesenheit und Jahr.
create unique index if not exists uq_vacation_ledger_absence_cancellation
  on public.vacation_ledger(absence_id, vacation_year_id)
  where entry_type = 'vacation_cancellation';

-- ---------------------------------------------------------
-- 4. Unveraenderlicher Schnappschuss an der Abwesenheit
-- ---------------------------------------------------------
alter table public.employee_absences
  add column if not exists vacation_deducted_days_snapshot numeric(6,2);

comment on column public.employee_absences.vacation_deducted_days_snapshot is
'Vom Admin bei der Genehmigung BESTAETIGTE Abzugsmenge in Tagen (Summe ueber '
'alle betroffenen Jahre). Historischer Schnappschuss — wird nie neu berechnet, '
'auch nicht wenn sich die Einsatzplanung spaeter aendert. NULL, wenn fuer '
'diesen Mitarbeiter kein Urlaubskonto gefuehrt wird.';

-- ---------------------------------------------------------
-- 5. RLS — Lesen nach Rolle, Schreiben ausschliesslich per RPC
-- ---------------------------------------------------------
alter table public.vacation_years  enable row level security;
alter table public.vacation_ledger enable row level security;
revoke all on public.vacation_years  from anon, authenticated;
revoke all on public.vacation_ledger from anon, authenticated;
grant select on public.vacation_years  to authenticated;
grant select on public.vacation_ledger to authenticated;

drop policy if exists "employee read own vacation years" on public.vacation_years;
create policy "employee read own vacation years"
on public.vacation_years for select to authenticated
using (employee_id = auth.uid() and company_id = public.current_user_company_id());

drop policy if exists "admin read company vacation years" on public.vacation_years;
create policy "admin read company vacation years"
on public.vacation_years for select to authenticated
using (public.current_user_role() = 'admin' and company_id = public.current_user_company_id());

drop policy if exists "employee read own vacation ledger" on public.vacation_ledger;
create policy "employee read own vacation ledger"
on public.vacation_ledger for select to authenticated
using (employee_id = auth.uid() and company_id = public.current_user_company_id());

drop policy if exists "admin read company vacation ledger" on public.vacation_ledger;
create policy "admin read company vacation ledger"
on public.vacation_ledger for select to authenticated
using (public.current_user_role() = 'admin' and company_id = public.current_user_company_id());

-- ABSICHTLICH KEINE insert/update/delete-Policy auf beiden Tabellen:
-- jede Buchung laeuft ueber die SECURITY DEFINER-RPCs unten. Damit kann
-- weder ein Mitarbeiter noch ein Admin am Client eine Zeile frei schreiben,
-- aendern oder loeschen (append-only ist strukturell erzwungen).


-- ---------------------------------------------------------
-- 6. RPC: Urlaubsjahr anlegen (explizite Admin-Aktion, idempotent)
-- ---------------------------------------------------------
-- BEWUSST KEINE Automatik: waere die Initialisierung ein Nebeneffekt (z. B.
-- beim Aktivieren des Urlaubskontos), wuerde eine spaetere Aenderung des
-- Jahresanspruchs mehrdeutig — hat sie die Historie zu aendern oder nicht?
-- Mit einer expliziten Aktion ist die Antwort eindeutig: die bestehende Zeile
-- bleibt, eine Anpassung ist eine SICHTBARE Korrektur (siehe RPC unten).
--
-- Idempotent auf zwei Ebenen: on conflict beim Jahres-Container UND der
-- partielle Unique-Index auf der annual_entitlement-Zeile.
create or replace function public.admin_initialize_vacation_year(
  p_employee_id uuid,
  p_year int
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company     uuid;
  v_enabled     boolean;
  v_entitlement numeric(5,2);
  v_year_id     uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can initialize a vacation year' using errcode = '42501';
  end if;

  if p_year is null or p_year < 2000 or p_year > 2100 then
    raise exception 'Invalid year' using errcode = '22023';
  end if;

  -- Mitarbeiter MUSS zur Firma des Admins gehoeren (Firmenscope).
  -- Effektiver Anspruch: Override, sonst Firmen-Default — exakt dieselbe
  -- Regel wie utils/vacationConfig.ts, hier serverseitig aufgeloest, damit
  -- kein Client einen Betrag vorgeben kann.
  select p.company_id, p.vacation_management_enabled,
         coalesce(p.vacation_annual_entitlement_days, c.default_vacation_annual_entitlement_days)
    into v_company, v_enabled, v_entitlement
  from public.profiles p
  join public.companies c on c.id = p.company_id
  where p.id = p_employee_id
    and p.company_id = public.current_user_company_id();

  if not found then
    raise exception 'Employee not found in your company' using errcode = '42501';
  end if;

  if v_enabled is not true then
    raise exception 'Vacation management is disabled for this employee' using errcode = '42501';
  end if;

  -- KEIN stiller 0-Wert: fehlt der Anspruch komplett, ist das ein
  -- Konfigurationsfehler und muss sichtbar scheitern.
  if v_entitlement is null then
    raise exception 'No annual entitlement configured (neither employee override nor company default)'
      using errcode = '23514';
  end if;

  insert into public.vacation_years (company_id, employee_id, year)
  values (v_company, p_employee_id, p_year)
  on conflict (employee_id, year) do nothing
  returning id into v_year_id;

  if v_year_id is null then
    select id into v_year_id from public.vacation_years
    where employee_id = p_employee_id and year = p_year;
  end if;

  -- Retry-sicher: die zweite Ausfuehrung prallt am partiellen Unique-Index ab.
  insert into public.vacation_ledger (
    company_id, employee_id, vacation_year_id, entry_type, amount_days, created_by, note
  )
  values (
    v_company, p_employee_id, v_year_id, 'annual_entitlement', v_entitlement, auth.uid(),
    'Jahresanspruch ' || p_year::text
  )
  on conflict (vacation_year_id) where entry_type = 'annual_entitlement' do nothing;

  return v_year_id;
end;
$$;

comment on function public.admin_initialize_vacation_year(uuid, int) is
'Legt das Urlaubsjahr eines Mitarbeiters an und bucht den Jahresanspruch '
'(Override oder Firmen-Default, serverseitig aufgeloest). Idempotent: ein '
'zweiter Aufruf erzeugt weder ein zweites Jahr noch eine zweite '
'Anspruchszeile. Aendert NIEMALS eine bereits gebuchte Zeile.';

revoke all on function public.admin_initialize_vacation_year(uuid, int) from public, anon;
grant execute on function public.admin_initialize_vacation_year(uuid, int) to authenticated;


-- ---------------------------------------------------------
-- 7. RPC: manuelle Korrektur
-- ---------------------------------------------------------
-- Kein Bearbeiten/Loeschen alter Zeilen — eine falsche Korrektur wird durch
-- eine weitere, gegenlaeufige Korrektur geheilt. Begruendung ist Pflicht
-- (CHECK auf der Tabelle, hier zusaetzlich frueh und verstaendlich gepruaeft).
create or replace function public.admin_add_vacation_adjustment(
  p_employee_id uuid,
  p_year int,
  p_amount_days numeric,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_year_id uuid;
  v_entry   uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can adjust a vacation account' using errcode = '42501';
  end if;

  if p_amount_days is null or p_amount_days = 0 then
    raise exception 'Adjustment amount must be a non-zero number' using errcode = '23514';
  end if;

  if p_note is null or length(btrim(p_note)) = 0 then
    raise exception 'A reason is required for a manual adjustment' using errcode = '23514';
  end if;

  select vy.id, vy.company_id into v_year_id, v_company
  from public.vacation_years vy
  join public.profiles p on p.id = vy.employee_id
  where vy.employee_id = p_employee_id
    and vy.year = p_year
    and p.company_id = public.current_user_company_id();

  if not found then
    raise exception 'Vacation year not initialized for this employee/year'
      using errcode = '42501';
  end if;

  insert into public.vacation_ledger (
    company_id, employee_id, vacation_year_id, entry_type, amount_days, created_by, note
  )
  values (v_company, p_employee_id, v_year_id, 'manual_adjustment', p_amount_days, auth.uid(), btrim(p_note))
  returning id into v_entry;

  return v_entry;
end;
$$;

comment on function public.admin_add_vacation_adjustment(uuid, int, numeric, text) is
'Bucht eine vorzeichenbehaftete Admin-Korrektur mit Pflicht-Begruendung. '
'Bestehende Zeilen bleiben unangetastet; eine falsche Korrektur wird durch '
'eine weitere Gegenbuchung korrigiert.';

revoke all on function public.admin_add_vacation_adjustment(uuid, int, numeric, text) from public, anon;
grant execute on function public.admin_add_vacation_adjustment(uuid, int, numeric, text) to authenticated;


-- ---------------------------------------------------------
-- 8. RPC: Genehmigung MIT bestaetigtem Abzug
-- ---------------------------------------------------------
-- p_deductions ist eine EXPLIZITE Zuordnung Jahr -> Tage, z. B.
--   {"2026": 3}                 (einfacher Fall)
--   {"2026": 2, "2027": 3}      (Urlaub ueber den Jahreswechsel)
-- Der Admin bestaetigt die Menge; die App darf einen Vorschlag anzeigen,
-- aber nichts stillschweigend annehmen (siehe Migrationskopf).
--
-- Wird das Urlaubskonto fuer den Mitarbeiter nicht gefuehrt, bleibt die
-- Genehmigung exakt wie bisher (kein Ledger, kein Schnappschuss, p_deductions
-- wird ignoriert) — der bestehende Ablauf darf durch die Buchhaltung nicht
-- blockiert werden.
--
-- Alles in EINER Transaktion: Statuswechsel, Schnappschuss, Ledger-Zeilen und
-- die (seit 20260821000000) bestehende Benachrichtigung.
create or replace function public.admin_review_vacation(
  absence_id_input uuid,
  decision_input text,
  admin_note_input text default null,
  p_deductions jsonb default null
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
  v_enabled    boolean;
  v_total      numeric(6,2) := 0;
  v_key        text;
  v_days       numeric;
  v_year_id    uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can review vacation requests' using errcode = '42501';
  end if;

  if decision_input not in ('approved', 'rejected') then
    raise exception 'decision must be ''approved'' or ''rejected''' using errcode = '22023';
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

  -- ── Buchhaltung NUR bei Genehmigung und aktivem Urlaubskonto ──
  if v_status = 'approved' and v_employee is not null then
    select vacation_management_enabled into v_enabled
    from public.profiles where id = v_employee;

    if v_enabled is true then
      if p_deductions is null or jsonb_typeof(p_deductions) <> 'object'
         or p_deductions = '{}'::jsonb then
        raise exception
          'Vacation accounting is enabled for this employee: a confirmed deduction per year is required'
          using errcode = '23514';
      end if;

      for v_key, v_days in select * from jsonb_each_text(p_deductions)
      loop
        if v_key !~ '^\d{4}$' then
          raise exception 'Invalid year key in deductions: %', v_key using errcode = '22023';
        end if;
        if v_days is null or v_days < 0 then
          raise exception 'Deduction for % must be >= 0', v_key using errcode = '23514';
        end if;

        -- Das Jahr MUSS vom Urlaubszeitraum beruehrt werden — verhindert,
        -- dass Tage in ein voellig fremdes Jahr gebucht werden.
        if v_key::int < extract(year from v_start)::int
           or v_key::int > extract(year from v_end)::int then
          raise exception 'Year % is outside the vacation range', v_key using errcode = '23514';
        end if;

        select id into v_year_id from public.vacation_years
        where employee_id = v_employee and year = v_key::int;

        if v_year_id is null then
          raise exception 'Vacation year % is not initialized for this employee', v_key
            using errcode = '42501';
        end if;

        if v_days > 0 then
          insert into public.vacation_ledger (
            company_id, employee_id, vacation_year_id, entry_type, amount_days,
            absence_id, created_by, note
          )
          values (
            v_company_id, v_employee, v_year_id, 'approved_vacation', -v_days,
            absence_id_input, auth.uid(),
            'Urlaub ' || to_char(v_start, 'DD.MM.YYYY') || '–' || to_char(v_end, 'DD.MM.YYYY')
          )
          on conflict (absence_id, vacation_year_id) where entry_type = 'approved_vacation'
          do nothing;
        end if;

        v_total := v_total + v_days;
      end loop;

      -- Unveraenderlicher Schnappschuss der bestaetigten Gesamtmenge.
      update public.employee_absences
      set vacation_deducted_days_snapshot = v_total
      where id = absence_id_input;
    end if;
  end if;

  -- Benachrichtigung (unveraendert seit 20260821000000)
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

comment on function public.admin_review_vacation(uuid, text, text, jsonb) is
'Admin genehmigt/lehnt eine Urlaubsanfrage ab (nur aus status=requested). Bei '
'Genehmigung und aktivem Urlaubskonto ist p_deductions (Jahr -> Tage) PFLICHT '
'— der Abzug wird vom Admin bestaetigt, nicht berechnet, und als '
'unveraenderlicher Schnappschuss samt Ledger-Zeile(n) festgeschrieben. Ein '
'Jahresuebergang muss explizit aufgeteilt werden. Ohne Urlaubskonto laeuft die '
'Genehmigung unveraendert ohne Buchhaltung.';

revoke all on function public.admin_review_vacation(uuid, text, text, jsonb) from public, anon;
grant execute on function public.admin_review_vacation(uuid, text, text, jsonb) to authenticated;

-- Alte 3-Argument-Signatur entfernen, damit kein Aufrufer versehentlich an
-- der Buchhaltung vorbei genehmigt (PostgREST wuerde sonst nach Argumenten
-- aufloesen und still die alte Variante treffen).
drop function if exists public.admin_review_vacation(uuid, text, text);


-- ---------------------------------------------------------
-- 9. RPC: Storno eines genehmigten Urlaubs -> Gegenbuchung
-- ---------------------------------------------------------
-- Die alte Abzugszeile bleibt UNANGETASTET. Storniert der Mitarbeiter einen
-- bereits genehmigten Urlaub, entsteht je betroffenem Jahr eine
-- kompensierende Gutschrift in identischer Hoehe. Damit bleibt sowohl der
-- urspruengliche Abzug als auch seine Aufhebung im Verlauf sichtbar.
create or replace function public.cancel_own_vacation(
  absence_id_input uuid
)
returns setof public.employee_absences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'employee' then
    raise exception 'Only employees can cancel their own vacation' using errcode = '42501';
  end if;

  update public.employee_absences
  set status = 'cancelled', updated_at = now()
  where id = absence_id_input
    and employee_id = auth.uid()
    and type = 'vacation'
    and status in ('requested', 'approved')
    and start_date > current_date;

  if not found then
    raise exception 'Vacation not found, not yours, or no longer cancellable'
      using errcode = '42501';
  end if;

  -- Gegenbuchung je bereits gebuchtem Abzug dieser Abwesenheit. Bei einem
  -- lediglich beantragten (nie genehmigten) Urlaub existiert kein Abzug —
  -- dann passiert hier nichts.
  for v_row in
    select vl.company_id, vl.employee_id, vl.vacation_year_id, vl.amount_days
    from public.vacation_ledger vl
    where vl.absence_id = absence_id_input
      and vl.entry_type = 'approved_vacation'
  loop
    insert into public.vacation_ledger (
      company_id, employee_id, vacation_year_id, entry_type, amount_days,
      absence_id, created_by, note
    )
    values (
      v_row.company_id, v_row.employee_id, v_row.vacation_year_id,
      'vacation_cancellation', abs(v_row.amount_days),
      absence_id_input, auth.uid(), 'Storno des genehmigten Urlaubs'
    )
    on conflict (absence_id, vacation_year_id) where entry_type = 'vacation_cancellation'
    do nothing;
  end loop;

  return query select * from public.employee_absences where id = absence_id_input;
end;
$$;

comment on function public.cancel_own_vacation(uuid) is
'Mitarbeiter storniert eigenen, noch nicht begonnenen Urlaub (requested/'
'approved, start_date > heute). Seit 20260824000000: war der Urlaub bereits '
'genehmigt und gebucht, entsteht je Jahr eine kompensierende Gutschrift — die '
'urspruengliche Abzugszeile bleibt zur Nachvollziehbarkeit erhalten.';

revoke all on function public.cancel_own_vacation(uuid) from public, anon;
grant execute on function public.cancel_own_vacation(uuid) to authenticated;
