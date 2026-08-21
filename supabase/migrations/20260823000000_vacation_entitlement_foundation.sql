-- =========================================================
-- Urlaubsanspruch-Konfiguration — Grundlage (NUR Konfiguration)
-- =========================================================
-- Legt die Beschäftigungs- und Urlaubs-KONFIGURATION an. BEWUSST NICHT
-- enthalten: Saldo, verbrauchter/verbleibender Urlaub, Übertrag,
-- Snapshot-bei-Genehmigung, AU-Nachweise, Anteilsberechnung. Diese gehören in
-- das nachfolgende Ledger-Arbeitspaket.
--
-- KERNENTSCHEIDUNG — Beschäftigungsart ist REIN BESCHREIBEND:
--   employment_type steuert NICHTS. Kein Urlaubsanspruch wird daraus
--   abgeleitet, kein Default, keine Verzweigung. Minijob und Aushilfe haben
--   in Deutschland sehr wohl gesetzlichen Urlaubsanspruch — eine automatische
--   Ableitung "Minijob => 0 Tage" wäre schlicht falsch. Deshalb sind
--   Beschäftigungsart und Urlaubsverwaltung zwei UNABHÄNGIGE Konzepte:
--   jede Kombination ist gültig (Vollzeit ohne Urlaubskonto, Minijob mit
--   Urlaubskonto, …).
--
-- VERERBUNG (bewusst einfach):
--   Mitarbeiter-Override NULL  -> Firmen-Default gilt.
--   Mitarbeiter-Override gesetzt -> gewinnt.
--   Es wird NICHTS beim Speichern materialisiert; die effektive Konfiguration
--   wird immer frisch aufgelöst (utils/vacationConfig.ts). Damit wirkt eine
--   Änderung des Firmen-Defaults sofort für alle, die keinen Override haben.
--
-- SICHERHEIT: keine neuen Policies, keine neue RPC. profiles hat bewusst
--   KEINE "update own profile"-Policy — ein Mitarbeiter kann seine eigene
--   Zeile ueberhaupt nicht per UPDATE anfassen. Die einzige UPDATE-Policy ist
--   "admin update profiles in own company" (firmengescopet in USING UND WITH
--   CHECK). Die neuen Spalten erben diesen Schutz vollstaendig. Zusaetzlich
--   wird der bestehende Feld-Guard unten ERWEITERT (nie abgeschwaecht).

-- ---------------------------------------------------------
-- 1. Beschäftigungsart (rein beschreibend)
-- ---------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'employment_type') then
    create type public.employment_type as enum
      ('vollzeit', 'teilzeit', 'minijob', 'aushilfe', 'sonstiges');
  end if;
end $$;

comment on type public.employment_type is
'Beschäftigungsart — REIN BESCHREIBEND. Steuert ausdruecklich KEINE '
'Urlaubslogik: kein Anspruch, kein Default, keine Verzweigung wird daraus '
'abgeleitet (Minijob/Aushilfe haben gesetzlichen Urlaubsanspruch).';

-- ---------------------------------------------------------
-- 2. profiles: Beschäftigung + Urlaubs-Konfiguration
-- ---------------------------------------------------------
-- Alles nullable bzw. mit sicherem Default -> Bestandszeilen bleiben ohne
-- Backfill gueltig. vacation_management_enabled ist bewusst DEFAULT false:
-- Urlaubskonto ist ein Opt-in je Mitarbeiter.
alter table public.profiles
  add column if not exists employment_type       public.employment_type,
  add column if not exists employment_start_date date,
  add column if not exists employment_end_date   date,
  add column if not exists vacation_management_enabled boolean not null default false,
  -- numeric, nicht int: halbe Tage (27.5) und Teilzeit-Referenzwerte (2.5
  -- Tage/Woche) sind fachlich realistisch und spaeter im Ledger noetig.
  add column if not exists vacation_annual_entitlement_days numeric(5,2),
  add column if not exists vacation_reference_days_per_week numeric(3,2);

comment on column public.profiles.employment_type is
'Beschäftigungsart, rein beschreibend (siehe Typkommentar). NIE Grundlage fuer Urlaubslogik.';
comment on column public.profiles.vacation_management_enabled is
'Rechnet/zeigt TaskOps fuer diesen Mitarbeiter ein Urlaubskonto? Opt-in. '
'FALSE heisst NICHT "kein gesetzlicher Anspruch" — nur, dass die App ihn '
'nicht fuehrt. Der Antrags-/Genehmigungs-Flow funktioniert unabhaengig davon.';
comment on column public.profiles.vacation_annual_entitlement_days is
'Individueller Jahresanspruch in Tagen. NULL = Firmen-Default gilt.';
comment on column public.profiles.vacation_reference_days_per_week is
'Individuelle Referenz-Arbeitstage/Woche. NULL = Firmen-Default gilt.';

-- ---------------------------------------------------------
-- 3. companies: Defaults
-- ---------------------------------------------------------
alter table public.companies
  add column if not exists default_vacation_annual_entitlement_days numeric(5,2),
  add column if not exists default_vacation_reference_days_per_week numeric(3,2),
  add column if not exists default_vacation_management_enabled boolean not null default false;

comment on column public.companies.default_vacation_annual_entitlement_days is
'Firmen-Default Jahresanspruch. Greift fuer jeden Mitarbeiter ohne eigenen Wert.';
comment on column public.companies.default_vacation_reference_days_per_week is
'Firmen-Default Referenz-Arbeitstage/Woche. Greift ohne eigenen Wert.';
comment on column public.companies.default_vacation_management_enabled is
'Vorschlagswert fuer neu angelegte Mitarbeiter. Aktiviert NICHT rueckwirkend '
'bestehende Mitarbeiter — deren profiles-Wert bleibt massgeblich.';

-- ---------------------------------------------------------
-- 4. Validierung (greift bei JEDEM Schreibpfad)
-- ---------------------------------------------------------
-- Bewusst KEINE Regel, die einen Anspruch aus employment_type ableitet.
alter table public.profiles
  drop constraint if exists chk_profiles_vacation_entitlement;
alter table public.profiles
  add constraint chk_profiles_vacation_entitlement check (
    vacation_annual_entitlement_days is null
    or (vacation_annual_entitlement_days >= 0 and vacation_annual_entitlement_days <= 365)
  );

-- > 0: null Referenztage waeren als Divisor im spaeteren Ledger sinnlos.
-- <= 7: mehr Arbeitstage als Kalendertage/Woche gibt es nicht.
alter table public.profiles
  drop constraint if exists chk_profiles_vacation_reference_days;
alter table public.profiles
  add constraint chk_profiles_vacation_reference_days check (
    vacation_reference_days_per_week is null
    or (vacation_reference_days_per_week > 0 and vacation_reference_days_per_week <= 7)
  );

alter table public.profiles
  drop constraint if exists chk_profiles_employment_dates;
alter table public.profiles
  add constraint chk_profiles_employment_dates check (
    employment_start_date is null
    or employment_end_date is null
    or employment_end_date >= employment_start_date
  );

alter table public.companies
  drop constraint if exists chk_companies_vacation_defaults;
alter table public.companies
  add constraint chk_companies_vacation_defaults check (
    (default_vacation_annual_entitlement_days is null
      or (default_vacation_annual_entitlement_days >= 0 and default_vacation_annual_entitlement_days <= 365))
    and
    (default_vacation_reference_days_per_week is null
      or (default_vacation_reference_days_per_week > 0 and default_vacation_reference_days_per_week <= 7))
  );

-- ---------------------------------------------------------
-- 5. Feld-Guard ERWEITERN (Verteidigung in der Tiefe)
-- ---------------------------------------------------------
-- Heute koennen Mitarbeiter ihre profiles-Zeile ohnehin nicht per UPDATE
-- anfassen (es gibt keine Self-Update-Policy). Sollte je eine solche Policy
-- ergaenzt werden, sollen diese Felder trotzdem Admin-only bleiben — deshalb
-- wandern sie jetzt in denselben Guard wie role/company_id/is_active.
-- Logik und Ausnahmen (service_role, DEFINER-Funktionen) UNVERAENDERT.
create or replace function public.enforce_profile_field_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.role       is not distinct from old.role
     and new.company_id is not distinct from old.company_id
     and new.is_active  is not distinct from old.is_active
     -- Beschäftigungs-/Urlaubskonfiguration (20260823000000)
     and new.employment_type       is not distinct from old.employment_type
     and new.employment_start_date is not distinct from old.employment_start_date
     and new.employment_end_date   is not distinct from old.employment_end_date
     and new.vacation_management_enabled is not distinct from old.vacation_management_enabled
     and new.vacation_annual_entitlement_days is not distinct from old.vacation_annual_entitlement_days
     and new.vacation_reference_days_per_week is not distinct from old.vacation_reference_days_per_week
  then
    return new;
  end if;

  if public.current_user_role() = 'admin'
     and old.company_id is not distinct from public.current_user_company_id() then
    return new;
  end if;

  raise exception
    'Nicht erlaubt: role, company_id, is_active sowie Beschäftigungs- und Urlaubskonfiguration dürfen nur von einem Admin derselben Firma geändert werden.'
    using errcode = '42501';
end;
$$;

alter function public.enforce_profile_field_guard() owner to postgres;

comment on function public.enforce_profile_field_guard() is
'BEFORE UPDATE Guard auf profiles: blockiert Änderungen an role/company_id/'
'is_active sowie an der Beschäftigungs-/Urlaubskonfiguration aus einem '
'direkten authenticated-Schreibvorgang, außer der Aufrufer ist ein aktiver '
'Admin der Firma der betroffenen Zeile. service_role und SECURITY DEFINER-'
'Funktionen (anderer current_user) sind ausgenommen.';
