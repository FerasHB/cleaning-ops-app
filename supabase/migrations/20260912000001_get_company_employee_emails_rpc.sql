-- =========================================================
-- MIGRATION: RPC public.get_company_employee_emails()
-- Datum: 2026-09-12
-- =========================================================
-- ZWECK
--   Admin sieht in der Mitarbeiter-Liste und in EmployeeDetailScreen keine
--   E-Mail-Adresse ("Nicht hinterlegt"), obwohl die UI an beiden Stellen
--   bereits eine E-Mail-Zeile rendert (app/(admin-tabs)/employees.tsx,
--   features/employees/EmployeeDetailScreen.tsx). Ursache: public.profiles
--   hat KEINE email-Spalte (bewusst, siehe CLAUDE.md) — die E-Mail liegt
--   ausschliesslich in auth.users. getEmployees()
--   (services/jobs/jobs.service.ts) setzt email deshalb hart auf null; die
--   E-Mail aus der create-employee-Antwort wird nirgends persistiert und ist
--   nach dem Verlassen des Einladungs-Dialogs verloren.
--
-- LOESUNG (kleinstmoeglich, ohne profiles-RLS anzufassen, kein auth.users-Grant)
--   Eine schmale SECURITY-DEFINER-RPC, die AUSSCHLIESSLICH (id, email) fuer
--   die MITARBEITER (role = 'employee') der EIGENEN Firma des aufrufenden
--   Admins zurueckgibt. Das Sichtbarkeits-Praedikat ist eine ECHTE
--   Verengung der bestehenden Policy "admin read profiles in own company"
--   (20260713000000_remote_baseline.sql, die alle Rollen der Firma erlaubt):
--
--     p.role = 'employee'
--     AND p.company_id = current_user_company_id()
--     AND current_user_role() = 'admin'
--
--   Die zusaetzliche role='employee'-Klausel ist bewusst enger als die
--   RLS-Policy noetig haette: der Admin kennt die eigene E-Mail (bzw. die
--   anderer Admins derselben Firma) bereits ueber die eigene Session und
--   braucht dafuer keine RPC — diese RPC deckt ausschliesslich den
--   Feature-Bedarf ("Mitarbeiter-E-Mail in Liste/Detail anzeigen") ab, nicht
--   mehr. Kein Firmen-Parameter — die Firma kommt ausschliesslich aus
--   current_user_company_id() des Aufrufers, ein Admin kann also niemals
--   eine fremde company_id uebergeben, um fremde E-Mails abzufragen.
--
--   profiles-RLS bleibt voellig unveraendert; auth.users bekommt KEIN neues
--   Grant fuer authenticated/anon (die Funktion liest auth.users nur
--   INTERN als SECURITY-DEFINER-Owner).
--
-- WAS SICH NICHT AENDERT
--   * profiles-RLS, auth.users-Berechtigungen, alle anderen RPCs:
--     unveraendert.
--   * getEmployees() bleibt bei einer einzigen profiles-Abfrage fuer
--     id/full_name/phone/role/is_active/invited_at/invite_accepted_at;
--     diese RPC wird zusaetzlich (einmalig pro Listen-Ladevorgang, NICHT pro
--     Mitarbeiter) aufgerufen und das Ergebnis per id gemerged.
--   * Nicht-Admin-Aufrufer (Mitarbeiter, kein Profil, keine Firma) erhalten
--     ueber die WHERE-Klausel eine leere Ergebnismenge — fail-closed, kein
--     Fehler, der etwas ueber die Existenz von Zeilen verraet.
--
-- SICHERHEITSMODELL
--   SECURITY DEFINER, STABLE, LANGUAGE sql, SET search_path = public, pg_temp.
--   EXECUTE nur fuer authenticated + service_role; von PUBLIC UND anon
--   entzogen — identisch zum Muster in
--   20260723000002_harden_rpc_execute_grants.sql und
--   20260911000000_get_job_comments_rpc.sql. Eine frisch angelegte Funktion
--   erbt Postgres' Default-ACL (EXECUTE fuer PUBLIC, das anon erbt), deshalb
--   REVOKE vor GRANT.
--
-- IDEMPOTENZ
--   create or replace; die Grants werden unbedingt (neu) gesetzt.
--
-- TESTS
--   supabase/tests/get_company_employee_emails_rpc.test.sql
--
-- ANWENDUNG
--   Wie alle Schemaaenderungen hier: manuell im Supabase SQL Editor bzw. via
--   `supabase db push` (siehe CLAUDE.md).
-- =========================================================

create or replace function public.get_company_employee_emails()
returns table (
  id    uuid,
  email text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    u.email
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'employee'
    and public.current_user_role() = 'admin'
    and p.company_id = public.current_user_company_id();
$$;

comment on function public.get_company_employee_emails() is
  'Schmale SECURITY-DEFINER-RPC: liefert (id, email) fuer die Mitarbeiter '
  '(role=employee) der eigenen Firma des aufrufenden Admins. Sichtbarkeit '
  'eine Verengung der Policy "admin read profiles in own company" (zusaetzlich '
  'role=employee). Keine anderen Felder, kein auth.users-Grant fuer den '
  'Client, kein Firmen-Parameter.';

revoke execute on function public.get_company_employee_emails() from public, anon;
grant  execute on function public.get_company_employee_emails() to authenticated, service_role;
