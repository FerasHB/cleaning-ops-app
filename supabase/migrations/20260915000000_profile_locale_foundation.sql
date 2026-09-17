-- Phase E: profiles.locale (server-seitig gespeicherte Sprachpräferenz).
--
-- WARUM: Push-Benachrichtigungen werden server-seitig (dispatch-notifications)
-- erzeugt und kennen daher weder AsyncStorage noch die aktuell im Client
-- aktive Sprache. Sprache ist PRO NUTZER, nicht pro Firma — unterschiedliche
-- Mitarbeiter derselben Firma können unterschiedliche Sprachen nutzen. Die
-- bestehende companies.locale (20260912000000) ist dafür bewusst UNGEEIGNET
-- und bleibt unverändert; sie beschreibt nur Firmen-Defaults (Rechnungen o.ä.),
-- nicht die Empfängersprache einzelner Push-Zustellungen.
--
-- Selbst editierbar wie phone/full_name: KEIN Eintrag in
-- enforce_profile_field_guard() nötig (locale ist kein sicherheitsrelevantes
-- Feld wie role/company_id/is_active/employment_*/vacation_*). Die bestehende
-- RLS-Policy "update own profile" (20260713000000_remote_baseline.sql, FOR
-- UPDATE USING/WITH CHECK id = auth.uid()) deckt den Schreibpfad bereits ab.
--
-- Bestandsnutzer: locale defaultet auf 'de' (Projekt-Kanon) und wird erst bei
-- explizitem Sprachwechsel im Client auf den tatsächlichen Wert aktualisiert
-- (kein Backfill) — siehe changeAppLanguage()/updateOwnLocale().

alter table public.profiles
  add column if not exists locale text not null default 'de';

alter table public.profiles
  drop constraint if exists chk_profiles_locale;

alter table public.profiles
  add constraint chk_profiles_locale check (locale in ('de', 'en', 'ar', 'tr'));

comment on column public.profiles.locale is
  'Bevorzugte Sprache des Nutzers (de/en/ar/tr, Default de). Steuert NUR '
  'server-seitig erzeugte Inhalte (Push-Benachrichtigungen); die Client-UI-'
  'Sprache wird weiterhin separat in AsyncStorage gehalten und bei explizitem '
  'Sprachwechsel hierher synchronisiert.';

-- claim_notification_deliveries: Empfänger-Locale mitliefern, damit
-- dispatch-notifications Titel/Text pro Empfänger lokalisieren kann.
drop function if exists public.claim_notification_deliveries(uuid, int, int);

create or replace function public.claim_notification_deliveries(
  company_id_filter uuid default null,
  max_rows int default 50,
  processing_timeout_seconds int default 120
)
returns table (
  delivery_id uuid, outbox_id uuid, recipient_id uuid, attempts int,
  event_type text, job_id uuid, company_id uuid, job_status text,
  employee_id uuid, employee_name text, customer_name text, service_name text,
  expo_push_token text, recipient_active boolean, recipient_role text,
  recipient_locale text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select d.id
    from public.notification_deliveries d
    where (company_id_filter is null or d.company_id = company_id_filter)
      and (
        (d.status = 'pending' and d.next_attempt_at <= now())
        or (d.status = 'processing'
            and d.claimed_at < now() - make_interval(secs => processing_timeout_seconds))
      )
    order by d.next_attempt_at
    for update skip locked
    limit max_rows
  ),
  claimed as (
    update public.notification_deliveries d
    set status = 'processing', claimed_at = now(), attempts = d.attempts + 1
    from due
    where d.id = due.id
    returning d.id, d.outbox_id, d.recipient_id, d.attempts
  )
  select
    c.id, c.outbox_id, c.recipient_id, c.attempts,
    o.event_type, o.job_id, o.company_id, o.job_status,
    o.employee_id, o.employee_name, o.customer_name, o.service_name,
    p.expo_push_token, p.is_active, p.role::text, p.locale
  from claimed c
  join public.notification_outbox o on o.id = c.outbox_id
  left join public.profiles p on p.id = c.recipient_id;
end;
$$;

revoke all on function public.claim_notification_deliveries(uuid, int, int) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(uuid, int, int) to service_role;
