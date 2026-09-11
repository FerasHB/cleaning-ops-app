-- =========================================================
-- MIGRATION: RPC public.get_job_comments(p_job_id uuid)
-- Datum: 2026-09-11
-- =========================================================
-- ZWECK
--   Ein Mitarbeiter, der einen Kommentar eines ADMINS (oder eines anderen
--   Mitarbeiters) liest, sah als Autorname "Unbekannt". Ursache:
--   getJobComments() (services/comments/comments.service.ts) laedt den Namen
--   ueber den eingebetteten PostgREST-Join
--       job_comments -> profiles:author_id ( full_name )
--   Dieser Embed laeuft unter der RLS DES AUFRUFERS. Die einzige
--   profiles-SELECT-Policy eines Mitarbeiters ist "employee read own profile"
--   (USING id = auth.uid()) — fremde profiles-Zeilen werden herausgefiltert,
--   full_name kommt als NULL zurueck, mapComment() setzt authorName = null und
--   die UI zeigt den Fallback "Unbekannt". Admins reproduzieren das nicht
--   (Policy "admin read profiles in own company").
--
--   Der Push-Text ist dagegen korrekt ("Feras Hababa"), weil
--   notify_job_comment() ein SECURITY-DEFINER-Trigger ist und profiles
--   ungefiltert liest — das isoliert den Fehler eindeutig auf den
--   client-seitigen, RLS-gefilterten Lesepfad, NICHT auf Daten/Frontend.
--
-- LOESUNG (kleinstmoeglich, ohne profiles-RLS anzufassen)
--   Eine schmale SECURITY-DEFINER-RPC, die AUSSCHLIESSLICH die fuer die
--   Kommentaranzeige noetigen Felder zurueckgibt
--     (id, job_id, author_id, author_name, message, created_at)
--   und ihre Sichtbarkeit EXAKT an das Praedikat der beiden bestehenden
--   job_comments-SELECT-Policies koppelt:
--
--     j.company_id = current_user_company_id()
--     AND (
--       current_user_role() = 'admin'
--       OR (
--         current_user_role() = 'employee'
--         AND ( j.assigned_to = auth.uid() OR is_assigned_to_job(j.id) )
--       )
--     )
--
--   Das ist WEDER eine Erweiterung NOCH eine Einengung der bestehenden
--   Sichtbarkeit — nur der profiles-Join wird aus der RLS-Zone des Aufrufers
--   herausgeholt. Es wird KEIN weiteres profiles-Feld exponiert
--   (nur full_name), und die profiles-RLS bleibt voellig unveraendert.
--
-- WAS SICH NICHT AENDERT
--   * job_comments-RLS, profiles-RLS, get_unread_comment_job_ids(),
--     notify_job_comment() / die gesamte Notification- und Ungelesen-Logik:
--     alle unveraendert.
--   * addJobComment(): unveraendert — der frisch eingefuegte Kommentar hat
--     author_id = auth.uid(), sein profiles-Embed loest also ohnehin auf.
--   * Autor geloescht/fehlend -> author_name = NULL -> UI-Fallback
--     "Unbekannt" wie bisher (LEFT JOIN, kein Filter auf profiles).
--   * Firmen-Isolation: current_user_company_id()/current_user_role() liefern
--     fuer inaktive/firmenlose Nutzer NULL -> keine Zeilen (fail-closed).
--     is_assigned_to_job() prueft company_id zusaetzlich intern
--     (SECURITY DEFINER, 20260727000000).
--
-- SICHERHEITSMODELL
--   SECURITY DEFINER, STABLE, LANGUAGE sql, SET search_path = public, pg_temp.
--   EXECUTE nur fuer authenticated + service_role; von PUBLIC UND anon
--   entzogen — identisch zum Muster in
--   20260723000002_harden_rpc_execute_grants.sql. Eine frisch angelegte
--   Funktion erbt Postgres' Default-ACL (EXECUTE fuer PUBLIC, das anon erbt),
--   deshalb REVOKE vor GRANT.
--
-- IDEMPOTENZ
--   create or replace; die Grants werden unbedingt (neu) gesetzt.
--
-- TESTS
--   supabase/tests/get_job_comments_rpc.test.sql
--
-- ANWENDUNG
--   Wie alle Schemaaenderungen hier: manuell im Supabase SQL Editor bzw. via
--   `supabase db push` (siehe CLAUDE.md).
-- =========================================================

create or replace function public.get_job_comments(p_job_id uuid)
returns table (
  id          uuid,
  job_id      uuid,
  author_id   uuid,
  author_name text,
  message     text,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.id,
    c.job_id,
    c.author_id,
    p.full_name as author_name,
    c.message,
    c.created_at
  from public.job_comments c
  join public.jobs j on j.id = c.job_id
  -- LEFT JOIN: ein geloeschter Autor (author_id -> NULL bzw. profiles-Zeile
  -- weg) darf den Kommentar nicht verschwinden lassen; author_name wird dann
  -- NULL und die UI zeigt "Unbekannt".
  left join public.profiles p on p.id = c.author_id
  where c.job_id = p_job_id
    -- Sichtbarkeits-Praedikat, 1:1 wie die job_comments-SELECT-Policies
    -- "admin read comments in own company" + "employee read comments on own
    -- jobs" (siehe 20260713000000 / 20260730000000).
    and j.company_id = public.current_user_company_id()
    and (
      public.current_user_role() = 'admin'
      or (
        public.current_user_role() = 'employee'
        and (
          j.assigned_to = auth.uid()
          or public.is_assigned_to_job(j.id)
        )
      )
    )
  order by c.created_at asc, c.id asc;
$$;

comment on function public.get_job_comments(uuid) is
'Job-Kommentare fuer die Anzeige inkl. Autorname (profiles.full_name). '
'SECURITY DEFINER, damit der Name auch dann sichtbar ist, wenn die '
'profiles-RLS des Aufrufers die fremde Zeile filtert (ein Mitarbeiter sah '
'sonst "Unbekannt" bei Admin-/Kollegen-Kommentaren). Sichtbarkeit exakt wie '
'die job_comments-SELECT-Policies: eigene Firma UND (Admin ODER zugewiesener '
'Mitarbeiter — volle Zuweisungsmenge job_assignments ODER Legacy-Zeiger). '
'Kein weiteres profiles-Feld wird exponiert.';

revoke execute on function public.get_job_comments(uuid) from public, anon;
grant  execute on function public.get_job_comments(uuid) to authenticated, service_role;

-- =========================================================
-- ROLLBACK
-- =========================================================
-- drop function if exists public.get_job_comments(uuid);
-- Danach faellt getJobComments() ohne Code-Rollback in einen harten Fehler
-- (RPC fehlt) — der Client-Change (services/comments/comments.service.ts)
-- muss also gemeinsam zurueckgenommen werden.
