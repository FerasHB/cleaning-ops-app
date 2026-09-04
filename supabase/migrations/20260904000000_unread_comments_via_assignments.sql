-- =========================================================
-- MIGRATION: Ungelesen-Kennzeichnung folgt der Zuweisungsmenge
-- Datum: 2026-09-04   (letzter offener Baustein aus 20260730000000 /
--                      20260826000001)
-- =========================================================
-- ZWECK
--   public.get_unread_comment_job_ids() ist die EINZIGE verbliebene Stelle im
--   Kommentar-/Foto-Bereich, die einen Mitarbeiter noch über den Legacy-Zeiger
--   jobs.assigned_to autorisiert. Alle neun anderen Pfade folgen längst der
--   kanonischen Zuweisungsmenge:
--
--     LESEN  (20260730000000): job_comments, job_photos, jobs, storage.objects
--     SCHREIBEN (20260826000001): job_comments INSERT, job_photos INSERT,
--                                 job_comment_reads INSERT + UPDATE,
--                                 storage.objects INSERT
--
--   Folge heute: ein sekundär Zugewiesener (Mitglied von job_assignments, aber
--   nicht jobs.assigned_to) darf den Auftrag sehen, die Kommentare lesen,
--   selbst kommentieren, Fotos hochladen und seinen Read-State schreiben —
--   bekommt aber NIE den roten Ungelesen-Punkt. Er erfährt neue Kommentare
--   also nur zufällig beim Öffnen des Auftrags. Auf Produktion betrifft das
--   keine Randgruppe: 617 der 1544 Zuweisungszeilen sind sekundär.
--
-- WARUM DAS ERST JETZT KOMMT (und warum es jetzt sicher ist)
--   20260730000000 (Abschnitt 5) hat die RPC BEWUSST ausgenommen: das
--   Markieren als gelesen schreibt auf public.job_comment_reads, und dessen
--   INSERT/UPDATE-Policies verlangten damals noch den Legacy-Primär. Hätte man
--   nur die RPC erweitert, wäre ein dauerhaft hängender roter Punkt
--   entstanden — die RPC meldet ungelesen, das Markieren scheitert mit 42501,
--   der Punkt kommt nach jedem Refresh zurück. Diese Vorbedingung ist seit
--   20260826000001 erfüllt (Abschnitte 3./4.): der sekundär Zugewiesene DARF
--   seinen Read-State schreiben. Lokal verifiziert in CASE 12 des
--   zugehörigen Tests (ERLAUBT).
--
--   Der Kopfkommentar von 20260826000001 begründet das Nicht-Anfassen der RPC
--   allerdings damit, sie frage "bereits die volle Zuweisungsmenge ab (siehe
--   Phase 5)". Das trifft nachweislich nicht zu — Phase 5 hat sie explizit
--   ausgenommen. Diese Migration korrigiert genau diese eine falsche Annahme;
--   die dort erwartete Wirkung ("die Lücke verschwindet von selbst") tritt
--   erst hiermit ein.
--
-- ÄNDERUNG
--   Der Employee-Zweig wird von
--       j.assigned_to = auth.uid()
--   auf dasselbe Muster gehoben wie alle neun anderen Pfade:
--       j.assigned_to = auth.uid()  OR  public.is_assigned_to_job(j.id)
--
--   Das ist eine echte OBERMENGE — kein Mitarbeiter verliert eine Meldung.
--   Der Legacy-Zweig bleibt nötig: es kann Bestandszeilen mit assigned_to ohne
--   job_assignments-Zeile geben (der Phase-1-Backfill hat nicht-konforme
--   Zeilen bewusst erhalten). Fällt gemeinsam mit allen anderen Legacy-Zweigen
--   in Phase 11.
--
-- =========================================================
-- WAS SICH NICHT ÄNDERT
-- =========================================================
--   * Firmen-Isolation: j.company_id = public.current_user_company_id() steht
--     unverändert AUSSERHALB der Oder-Klammer. is_assigned_to_job() prüft
--     company_id zusätzlich intern (SECURITY DEFINER, 20260727000000).
--   * Admin-Verhalten: firmenweit, unverändert.
--   * Inaktiv-Schutz: current_user_company_id()/current_user_role() liefern für
--     is_active=false NULL, die RPC liefert dann nichts. Unverändert, und
--     is_assigned_to_job() fällt aus demselben Grund ebenfalls auf false.
--   * Autor-Ausschluss (c.author_id is distinct from auth.uid()) — unverändert.
--   * Read-State bleibt PRO BENUTZER (job_comment_reads PK job_id,user_id);
--     die RPC liest weiterhin nur die eigene Zeile.
--   * Keine Duplikate: group by c.job_id liefert je Auftrag genau eine Zeile,
--     auch wenn ein Nutzer auf BEIDE Oder-Zweige passt (Legacy-Primäre tun das
--     regelmäßig).
--   * Signatur, Rückgabetyp, STABLE, SECURITY DEFINER, search_path und die
--     EXECUTE-Grants aus 20260723000002 (authenticated + service_role, nicht
--     public/anon) bleiben identisch. CREATE OR REPLACE erhält bestehende
--     Grants; sie werden hier trotzdem nicht neu gesetzt, weil sich nichts an
--     ihnen ändert.
--   * KEINE RLS-Policy wird angefasst. Diese Migration ändert genau eine
--     Funktion.
--
-- IDEMPOTENZ
--   Vollständig wiederholbar (CREATE OR REPLACE FUNCTION).
--
-- TESTS
--   supabase/tests/secondary_assignee_unread_comments.test.sql (25 Fälle).
--   Vor dieser Migration: CASE 2, 20 und 25 FAIL. Danach: alle 25 PASS.
--
-- ANWENDUNG
--   Wie alle Schemaänderungen hier MANUELL im Supabase SQL Editor ausführen
--   (siehe CLAUDE.md).
-- =========================================================

create or replace function public.get_unread_comment_job_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.job_id
  from public.job_comments c
  join public.jobs j on j.id = c.job_id
  where j.company_id = public.current_user_company_id()
    and (
      public.current_user_role() = 'admin'
      or (
        public.current_user_role() = 'employee'
        -- Volle Zuweisungsmenge, identisch zu den vier Lese- und den fünf
        -- Schreib-Policies auf job_comments/job_photos/job_comment_reads/
        -- storage.objects. Der Legacy-Zweig deckt Bestandszeilen ohne
        -- job_assignments-Zeile ab.
        and (
          j.assigned_to = auth.uid()
          or public.is_assigned_to_job(j.id)
        )
      )
    )
    and c.author_id is distinct from auth.uid()
  group by c.job_id
  having max(c.created_at) > coalesce(
    (
      select r.last_seen_at
      from public.job_comment_reads r
      where r.job_id = c.job_id
        and r.user_id = auth.uid()
    ),
    'epoch'::timestamptz
  );
$$;

comment on function public.get_unread_comment_job_ids() is
'Liefert die Job-IDs mit ungelesenen Kommentaren fuer den aktuellen Nutzer '
'(juengster fremder Kommentar > eigenes last_seen_at). Admin: firmenweit; '
'Mitarbeiter: volle Zuweisungsmenge (job_assignments ODER Legacy-Zeiger '
'jobs.assigned_to), identisch zu den Kommentar-/Foto-Policies. Eigene '
'Kommentare zaehlen nie als ungelesen.';


-- =========================================================
-- ROLLBACK
-- =========================================================
-- Dieselbe Funktion ohne den Oder-Zweig neu anlegen, also
--   and j.assigned_to = auth.uid()
-- statt der Oder-Klammer (Wortlaut siehe 20260713000000_remote_baseline.sql).
-- Es gehen dabei keine Daten verloren: die Funktion ist rein lesend, und
-- job_comment_reads bleibt unberührt. Sekundär Zugewiesene, die in der
-- Zwischenzeit einen Read-State geschrieben haben, behalten ihn — er wird
-- danach lediglich nicht mehr ausgewertet.
