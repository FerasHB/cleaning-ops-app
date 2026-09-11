-- =========================================================
-- MIGRATION: Company Identity & Contact Foundation (Phase 15)
-- Datum: 2026-09-12
-- =========================================================
-- ZWECK
--   Die App speichert bisher fast keine Firmen-Kontaktdaten (companies hat nur
--   name + slug). Fuer Rechnungen, Support, Kundenkommunikation, Exporte und
--   spaetere E-Mail-/Telefon-Verifizierung ist das zu wenig. Diese Migration
--   legt das minimale, formatstabile Fundament:
--
--   companies:
--     + contact_email  text   (Firmen-Kontakt-/Absender-Adresse; KEINE
--                              Auth-Identitaet, unabhaengig von der Login-Mail
--                              des Admins)
--     + contact_phone  text   (Firmen-Rufnummer, E.164)
--     + timezone       text NOT NULL DEFAULT 'Europe/Berlin'  (Reserve —
--                              Periodengrenzen, "heute"-Logik, Notification-
--                              Fenster; sicherer Default, kein UI)
--     + locale         text NOT NULL DEFAULT 'de'  (Reserve — Mail-/Rechnungs-
--                              sprache, kuenftige i18n; CHECK in ('de','en'))
--
--   profiles:
--     + phone_verified_at timestamptz  (Reserve fuer die kuenftige Telefon-
--                              verifizierung/OTP — nullable, kein UI)
--     + CHECK auf phone (E.164) — sicher: 0 bestehende Werte auf Prod/Staging.
--
--   BEWUSST NICHT TEIL DIESER MIGRATION (eigene Migration, wenn das jeweilige
--   Feature startet): Adresse (eigenes Sub-Modell), Logo (Storage-Feature),
--   vat_id/tax_number/website (Rechnungs-Feature), contact_email_verified_at
--   (E-Mail-Verifizierungs-Feature).
--
-- WRITE-PFADE
--   companies bleibt client-schreibgeschuetzt wie bisher (nur SELECT-Policy
--   "read own company", KEINE UPDATE-Policy). Aenderungen laufen ausschliesslich
--   ueber SECURITY-DEFINER-RPCs:
--     * update_own_company(name, contact_email, contact_phone) — NEU, nur
--       Admin der eigenen Firma, explizite 3-Feld-Allowlist (kein id/slug/
--       created_at/timezone/locale).
--     * setup_company_for_admin(...) — ERWEITERT um optionale Kontaktfelder +
--       optionale Admin-Telefonnummer (Signatur-Aenderung -> DROP + CREATE +
--       Re-Grant, exakt wie 20260906000000).
--
--   profiles.full_name / profiles.phone sind bereits per RLS "update own
--   profile" selbst editierbar (enforce_profile_field_guard schuetzt nur
--   role/company_id/is_active/employment_*/vacation_* — NICHT phone/full_name).
--   Diese Migration aendert daran NICHTS.
--
-- VALIDIERUNG — DREI SCHICHTEN
--   Client (nur UX) -> RPC/Edge-Function re-normalisiert (lower/trim, E.164) ->
--   DB-CHECK (die harte Grenze).
--
-- IDEMPOTENZ
--   add column if not exists; drop constraint if exists + add constraint;
--   RPCs create or replace bzw. drop + create.
--
-- TESTS
--   supabase/tests/company_contact_foundation.test.sql
--
-- ANWENDUNG
--   Wie alle Schemaaenderungen: manuell im Supabase SQL Editor bzw.
--   `supabase db push` (siehe CLAUDE.md).
-- =========================================================

-- ---------------------------------------------------------
-- 1. Spalten
-- ---------------------------------------------------------
alter table public.companies
  add column if not exists contact_email text,
  add column if not exists contact_phone text,
  add column if not exists timezone text not null default 'Europe/Berlin',
  add column if not exists locale   text not null default 'de';

alter table public.profiles
  add column if not exists phone_verified_at timestamptz;

-- ---------------------------------------------------------
-- 2. CHECK-Constraints (drop+add = idempotent)
-- ---------------------------------------------------------
-- Bewusst permissive E-Mail-/E.164-Muster (Client + RPC validieren feiner);
-- Ziel ist, offensichtlichen Muell serverseitig hart abzuweisen.
alter table public.companies drop constraint if exists chk_companies_contact_email;
alter table public.companies add  constraint chk_companies_contact_email
  check (contact_email is null or contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

alter table public.companies drop constraint if exists chk_companies_contact_phone;
alter table public.companies add  constraint chk_companies_contact_phone
  check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{6,14}$');

alter table public.companies drop constraint if exists chk_companies_locale;
alter table public.companies add  constraint chk_companies_locale
  check (locale in ('de', 'en'));

alter table public.profiles drop constraint if exists chk_profiles_phone;
alter table public.profiles add  constraint chk_profiles_phone
  check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$');

-- ---------------------------------------------------------
-- 3. RPC: update_own_company (NEU)
-- ---------------------------------------------------------
-- Der EINZIGE client-erreichbare Schreibpfad auf companies. Explizite
-- Feld-Allowlist (name/contact_email/contact_phone) — es gibt strukturell
-- keine Moeglichkeit, id/slug/created_at/timezone/locale/vacation ueber diese
-- RPC zu aendern. Firmen-Isolation + Rolle serverseitig geprueft.
create or replace function public.update_own_company(
  p_name          text,
  p_contact_email text,
  p_contact_phone text
)
returns public.companies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_user_company_id();
  v_role       text := public.current_user_role();
  v_email      text;
  v_phone      text;
  v_row        public.companies;
begin
  if v_company_id is null then
    raise exception 'Keine Firma zugeordnet' using errcode = '42501';
  end if;
  if v_role is distinct from 'admin' then
    raise exception 'Nur Admins duerfen Firmendaten aendern' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'Firmenname ist erforderlich';
  end if;

  v_email := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
  -- Sicherheitsnetz: uebliche Trenner entfernen. Die Laender-Prefix-Logik
  -- (0->+49, 00->+) macht der Client (utils/phone.ts) — hier nur E.164-Guard.
  v_phone := nullif(regexp_replace(btrim(coalesce(p_contact_phone, '')), '[[:space:]/().-]', '', 'g'), '');

  if v_email is not null and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Ungueltige E-Mail-Adresse';
  end if;
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'Ungueltige Telefonnummer (Format +49...)';
  end if;

  update public.companies
     set name          = btrim(p_name),
         contact_email = v_email,
         contact_phone = v_phone
   where id = v_company_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.update_own_company(text, text, text) is
'Aktualisiert Name + Kontaktdaten der eigenen Firma. Nur Admin der eigenen '
'Firma; explizite Feld-Allowlist (name/contact_email/contact_phone). companies '
'hat bewusst keine UPDATE-RLS-Policy — dies ist der einzige client-Schreibpfad.';

revoke execute on function public.update_own_company(text, text, text) from public, anon;
grant  execute on function public.update_own_company(text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------
-- 4. RPC: setup_company_for_admin — ERWEITERT
-- ---------------------------------------------------------
-- Signatur aendert sich (text -> text,text,text,text) -> DROP + CREATE + Re-Grant
-- (exakt das Muster aus 20260906000000_accept_own_invite_recovery_completion).
-- Bestehender Aufrufer services/company/setupCompanyForAdmin.ts ruft per
-- PostgREST mit Named-Arg { company_name } auf; die drei neuen Parameter haben
-- DEFAULT NULL und bleiben damit rueckwaerts-kompatibel.
drop function if exists public.setup_company_for_admin(text);

create function public.setup_company_for_admin(
  company_name    text,
  p_contact_email text default null,
  p_contact_phone text default null,
  p_admin_phone   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_company_id uuid;
  existing_company_id uuid;
  new_slug text;
  v_email  text;
  v_cphone text;
  v_aphone text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if trim(company_name) = '' then
    raise exception 'Company name is required';
  end if;

  select company_id into existing_company_id
  from public.profiles
  where id = auth.uid();

  if existing_company_id is not null then
    raise exception 'User already belongs to a company';
  end if;

  v_email  := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
  -- Sicherheitsnetz gegen Trenner; Laender-Prefix-Logik macht der Client.
  v_cphone := nullif(regexp_replace(btrim(coalesce(p_contact_phone, '')), '[[:space:]/().-]', '', 'g'), '');
  v_aphone := nullif(regexp_replace(btrim(coalesce(p_admin_phone, '')),   '[[:space:]/().-]', '', 'g'), '');

  if v_email is not null and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Ungueltige Firmen-E-Mail';
  end if;
  if v_cphone is not null and v_cphone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'Ungueltige Firmen-Telefonnummer';
  end if;
  if v_aphone is not null and v_aphone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'Ungueltige Telefonnummer';
  end if;

  new_slug := lower(trim(company_name));
  new_slug := regexp_replace(new_slug, '\s+', '-', 'g');
  new_slug := regexp_replace(new_slug, '[^a-z0-9\-]', '', 'g');
  new_slug := new_slug || '-' ||
    substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6);

  insert into public.companies (name, slug, contact_email, contact_phone)
  values (trim(company_name), new_slug, v_email, v_cphone)
  returning id into new_company_id;

  update public.profiles
     set company_id = new_company_id,
         role       = 'admin',
         phone      = coalesce(v_aphone, phone)
   where id = auth.uid();

  return new_company_id;
end;
$$;

revoke execute on function public.setup_company_for_admin(text, text, text, text) from public, anon;
grant  execute on function public.setup_company_for_admin(text, text, text, text) to authenticated, service_role;

-- =========================================================
-- ROLLBACK (Referenz — nicht Teil der Anwendung)
-- =========================================================
-- drop function if exists public.update_own_company(text, text, text);
-- drop function if exists public.setup_company_for_admin(text, text, text, text);
-- create function public.setup_company_for_admin(company_name text) ...  -- 1-arg-Original
--   (Wortlaut siehe 20260713000000_remote_baseline.sql)
-- alter table public.companies drop constraint if exists chk_companies_contact_email;
-- alter table public.companies drop constraint if exists chk_companies_contact_phone;
-- alter table public.companies drop constraint if exists chk_companies_locale;
-- alter table public.profiles  drop constraint if exists chk_profiles_phone;
-- alter table public.companies drop column if exists contact_email, drop column if exists contact_phone,
--   drop column if exists timezone, drop column if exists locale;
-- alter table public.profiles  drop column if exists phone_verified_at;
