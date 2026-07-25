-- =========================================================
-- MIGRATION: RLS und Zugriffsmodell für job_assignments
-- Datum: 2026-07-27   (Phase 3 von 11 — reine Datenschicht)
-- =========================================================
-- ZWECK
--   job_assignments ist seit Phase 1 fail-closed (RLS an, KEINE Policies,
--   keine Grants für anon/authenticated). Diese Migration öffnet exakt so
--   viel, wie die späteren Phasen brauchen — und keinen Deut mehr:
--     * LESEN über zwei eng gefasste SELECT-Policies
--     * SCHREIBEN ausschließlich über EINE transaktionale RPC
--     * anon: weiterhin komplett ohne Zugriff
--
-- REIN ADDITIV / KEINE DATENÄNDERUNG
--   Keine DML-Anweisung. Die 870 Bestandszeilen, die 6 historischen
--   Guard-Ausnahmen und sämtliche Anwesenheits-/Review-Nachweise bleiben
--   unverändert. Kein Realtime-Sturm beim Deploy.
--
-- BEWUSST NICHT TEIL DIESER MIGRATION
--   * Keine Änderung an public.jobs, an dessen Policies oder an
--     assigned_to.
--   * Keine Änderung an der Phase-2-Kompatibilitätsschicht.
--   * Keine Änderung an start_own_job/complete_own_job, an den
--     Recurring-RPCs oder an Benachrichtigungen.
--   * KEINE Verbreiterung der Policies von jobs/job_comments/job_photos/
--     job_comment_reads/storage.objects auf Mehrfachzuweisung. Das ändert,
--     WELCHE AUFTRÄGE ein Mitarbeiter überhaupt sieht, und darf erst
--     gemeinsam mit dem App-Lesepfad (Phase 5) ausgerollt werden. Bis
--     dahin bleibt jobs.assigned_to die maßgebliche Sichtbarkeitsquelle —
--     genau wie heute.
--   * Keine Propagierung von Zuweisungs-MENGEN auf Occurrences (Phase 4).
--
-- =========================================================
-- ARCHITEKTUR-BEFUND (am deployten Stand erhoben)
-- =========================================================
-- Autorisierung läuft im gesamten Schema über zwei SECURITY-DEFINER-
-- Helfer: current_user_role() und current_user_company_id(). Beide liefern
-- seit Migration 20260714000000 NULL für INAKTIVE Profile, wodurch jede
-- Policy, die sie verwendet, automatisch fail-closed wird. Diese Migration
-- verwendet ausschließlich dieselben Helfer — Deaktivierung wirkt damit
-- ohne Zusatzlogik auch hier.
--
-- Bestehende Policies auf public.jobs (6): Admin SELECT/INSERT/UPDATE/
-- DELETE firmenweit; Employee SELECT (job_type='single' AND
-- assigned_to = auth.uid()); Employee UPDATE (assigned_to = auth.uid()).
--
-- public.profiles: Admin liest die eigene Firma, ein Employee liest
-- AUSSCHLIESSLICH die eigene Zeile ("employee read own profile").
-- Daraus folgt die zentrale Design-Entscheidung weiter unten.
--
-- job_assignments vor dieser Migration: RLS an, 0 Policies, Grants nur für
-- service_role. Schreibzugriff hatten bisher nur die SECURITY-DEFINER-
-- Trigger aus Phase 2.
--
-- =========================================================
-- ENTSCHEIDUNG 1 — Lese-Umfang für Mitarbeiter: Variante B
-- =========================================================
-- Zur Wahl standen:
--   A) Ein Mitarbeiter sieht NUR seine eigene Zuweisungszeile.
--   B) Ein Mitarbeiter sieht ALLE Zuweisungszeilen der Aufträge, denen er
--      selbst zugewiesen ist.
--
-- Gewählt: B — und zwar, weil B hier die WENIGER weitreichende Öffnung
-- ist. Das ist nicht offensichtlich, deshalb ausführlich:
--
--   Die künftige Mehrfachzuweisungs-Oberfläche muss anzeigen, wer sonst
--   noch auf einem Auftrag ist. Unter Variante A müsste der Client diese
--   Namen anderswo herholen — und die einzige Quelle wäre public.profiles.
--   Dort darf ein Employee heute aber ausschließlich die EIGENE Zeile
--   lesen. Variante A würde also erzwingen, die profiles-Policy für
--   Mitarbeiter zu öffnen — eine deutlich breitere Rechteausweitung als
--   das, was B tut.
--
--   B braucht profiles überhaupt nicht: employee_name_snapshot steht
--   bereits AUF der Zuweisungszeile (angelegt in Phase 1 für den Fall der
--   Konto-Löschung). Die Kollegennamen kommen damit aus genau der Zeile,
--   die der Mitarbeiter ohnehin sehen darf.
--
--   Offengelegte Zusatzinformation gegenüber heute, vollständig: id,
--   Namens-Schnappschuss und Anwesenheits-/Review-Zustand der KollegInNEN
--   auf GENAU DEN Aufträgen, denen der Mitarbeiter selbst zugewiesen ist.
--   Nichts firmenweit, nichts über fremde Aufträge, nichts über andere
--   Firmen.
--
-- =========================================================
-- ENTSCHEIDUNG 2 — Schreiben über RPC statt direkter Policies
-- =========================================================
-- Direkte INSERT/UPDATE/DELETE-Policies für Admins wären möglich, sind
-- hier aber die schlechtere Lösung. Ausschlaggebend ist nicht die
-- Validierung (die könnte eine Policy leisten), sondern ATOMARITÄT:
--
--   Eine Zuweisungs-MENGE zu ändern heißt entfernen UND hinzufügen. Über
--   die REST-Schnittstelle wären das zwei getrennte Requests, also zwei
--   Transaktionen. Zwischen ihnen existiert ein Zustand, in dem der
--   Auftrag keine (oder die falschen) Zuweisungen hat. Die Phase-2-
--   Kompatibilitätsschicht reagiert darauf sofort: sie rechnet den
--   primären Mitarbeiter neu, schreibt jobs.assigned_to (womöglich auf
--   NULL) und löst ein Realtime-Event aus. Alte Clients zeigen den
--   Auftrag in diesem Fenster als "nicht zugewiesen". Ein Abbruch
--   zwischen den beiden Requests hinterlässt den Zustand dauerhaft falsch.
--
--   Zusätzlich kann nur eine RPC die Auftragszeile VOR der Änderung
--   sperren und sich damit sauber mit dem FOR-UPDATE der Phase-2-Trigger
--   serialisieren. Ein direkter DELETE über PostgREST kann das nicht.
--
--   Drittens: die vollständige Validierung der Eingabemenge passiert VOR
--   dem ersten Schreibvorgang. Ein ungültiger Mitarbeiter in der Liste
--   führt damit zu gar keiner Änderung statt zu einer halb angewandten.
--
-- Ergebnis: authenticated bekommt NUR SELECT. INSERT/UPDATE/DELETE bleiben
-- ohne Grant UND ohne Policy — doppelt verriegelt.
--
-- =========================================================
-- ENTSCHEIDUNG 3 — UPDATE bleibt in Phase 3 vollständig gesperrt
-- =========================================================
-- Es gibt derzeit keinen legitimen Anwendungsfall: Anwesenheit schreibt
-- ab Phase 7 die start/complete-RPC, das Manager-Review ab Phase 10 eine
-- eigene Review-RPC. Beide werden SECURITY DEFINER sein und brauchen
-- keine UPDATE-Policy. Eine Policy "auf Vorrat" wäre unbenutzte
-- Angriffsfläche und würde insbesondere erlauben, review/reviewed_by oder
-- employee_name_snapshot zu manipulieren.
--
-- =========================================================
-- ANWENDUNG
--   Wie alle Schemaänderungen hier MANUELL im Supabase SQL Editor
--   ausführen (siehe CLAUDE.md). Diese Migration wurde NICHT auf der
--   Produktionsdatenbank ausgeführt.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Policy-Helfer (SECURITY DEFINER — begründet)
-- ---------------------------------------------------------
-- BEIDE Helfer sind SECURITY DEFINER, und zwar aus einem konkreten,
-- nicht-kosmetischen Grund: Ausdrücke in einer RLS-Policy werden im
-- Rechtekontext des AUFRUFERS ausgewertet. Eine Unterabfrage auf
-- public.jobs innerhalb einer Policy unterläge damit der RLS von jobs —
-- und die beschränkt Mitarbeiter heute auf assigned_to = auth.uid().
-- Genau dieser Mitarbeiter ist bei Mehrfachzuweisung aber NICHT
-- zwangsläufig der Legacy-Primär. Die Policy würde also für die
-- Nicht-Primär-Zuweisungen still ins Leere laufen.
--
-- Ein Helfer auf job_assignments MUSS zusätzlich SECURITY DEFINER sein,
-- weil eine Policy AUF job_assignments, die job_assignments abfragt,
-- sonst unendlich rekursiv wäre (PostgreSQL bricht das mit einem Fehler
-- ab). SECURITY DEFINER (Eigentümer postgres, kein FORCE ROW LEVEL
-- SECURITY) umgeht RLS und beendet die Rekursion.
--
-- Beide Funktionen sind STABLE, nehmen nur eine job_id entgegen, schreiben
-- nichts, geben nur einen Skalar zurück, haben festen search_path und
-- bekommen unten EXECUTE entzogen.

-- ACHTUNG — HART ERARBEITETE REGEL (siehe Kommentarblock unter Abschnitt 2):
-- Policy-Helfer MÜSSEN für die Rollen ausführbar sein, für die die Policy
-- gilt. EXECUTE hier zu entziehen ist KEINE Härtung, sondern bricht die
-- Policy — in dieser PostgreSQL-Version sogar mit einem Absturz des
-- Backends. Deshalb erhalten beide Helfer unten GRANT EXECUTE für
-- authenticated, exakt wie die bestehenden current_user_role() /
-- current_user_company_id().

-- Gibt bewusst nur einen BOOLEAN zurück statt der Firmen-ID: da die
-- Funktion für Clients ausführbar sein muss, würde eine zurückgegebene
-- company_id verraten, welcher Firma ein beliebiger (erratener) Auftrag
-- gehört. Die Boolean-Variante beantwortet ausschließlich die Frage
-- „gehört dieser Auftrag ZU MEINER Firma?" und offenbart damit nichts
-- über fremde Firmen.
create or replace function public.job_in_current_company(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.jobs j
    where j.id         = p_job_id
      and j.company_id = public.current_user_company_id()
  );
$$;

comment on function public.job_in_current_company(uuid) is
'true, wenn der Auftrag zur Firma des Aufrufers gehört. RLS-unabhängig '
'(SECURITY DEFINER), weil eine Unterabfrage auf jobs innerhalb einer '
'Policy sonst der jobs-RLS des Aufrufers unterläge. Gibt bewusst nur einen '
'Boolean zurück, um keine fremden Firmenzugehörigkeiten preiszugeben.';

revoke all on function public.job_in_current_company(uuid) from public;
revoke all on function public.job_in_current_company(uuid) from anon;
grant execute on function public.job_in_current_company(uuid) to authenticated;

create or replace function public.is_assigned_to_job(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.job_assignments ja
    join public.jobs j on j.id = ja.job_id
    where ja.job_id      = p_job_id
      and ja.employee_id = auth.uid()
      and j.company_id   = public.current_user_company_id()
  );
$$;

comment on function public.is_assigned_to_job(uuid) is
'true, wenn der aufrufende Nutzer dem Auftrag zugewiesen ist (inkl. '
'Firmenprüfung). SECURITY DEFINER: verhindert die RLS-Rekursion einer '
'job_assignments-Policy, die job_assignments abfragt.';

revoke all on function public.is_assigned_to_job(uuid) from public;
revoke all on function public.is_assigned_to_job(uuid) from anon;
grant execute on function public.is_assigned_to_job(uuid) to authenticated;


-- ---------------------------------------------------------
-- WARUM DIE HELFER FÜR authenticated AUSFÜHRBAR SEIN MÜSSEN
-- ---------------------------------------------------------
-- Beim ersten Entwurf wurde EXECUTE auf beiden Helfern für anon UND
-- authenticated entzogen — analog zu den internen Trigger-Funktionen aus
-- Phase 1/2. Das ist hier FALSCH und war im Test sofort sichtbar:
--
--   Ausdrücke einer RLS-Policy werden im Rechtekontext des AUFRUFERS
--   ausgewertet, nicht im Kontext des Tabelleneigentümers. Fehlt dem
--   Aufrufer EXECUTE auf einer im Policy-Ausdruck verwendeten Funktion,
--   ist die Policy nicht auswertbar.
--
-- Fehlt das Recht, ist die Policy schlicht nicht auswertbar und der
-- Zugriff scheitert mit „permission denied for function".
--
-- NEBENBEFUND aus der lokalen Entwicklungsumgebung, bewusst NICHT als
-- PostgreSQL-Eigenschaft dargestellt: im lokalen Supabase-Container
-- (PostgreSQL 17.6, aarch64) fuehrt JEDER permission-denied-Fehler zu
-- einem Absturz des Backends (signal 11) statt zu einer sauberen
-- Fehlermeldung — reproduzierbar auch mit voellig unbeteiligten
-- Funktionen wie pg_read_file() und mit seit Monaten produktiv
-- laufenden Funktionen wie fanout_notification_events(). Das ist also
-- KEINE Eigenschaft dieser Migration und kein Schemafehler, sondern ein
-- Defekt der lokalen Umgebung. Auf Produktion wurde er bewusst NICHT
-- nachgestellt: ein Segfault startet den Postmaster neu und trennt alle
-- Verbindungen. Siehe Hinweis in den Tests.
--
-- Genau deshalb sind auch die BESTEHENDEN Policy-Helfer dieses Schemas,
-- current_user_role() und current_user_company_id(), für authenticated
-- (und sogar anon) ausführbar. Der Entzug von EXECUTE ist die richtige
-- Härtung für Trigger- und Dispatcher-Funktionen, NICHT für Funktionen,
-- die in einem Policy-Ausdruck vorkommen.
--
-- Beide Helfer sind auf diese Rolle hin ausgelegt: sie nehmen nur eine
-- job_id entgegen, geben ausschließlich einen Boolean zurück, beziehen
-- sich immer auf den AUFRUFER und geben keinerlei Information über fremde
-- Firmen oder fremde Zuweisungen preis.
-- ---------------------------------------------------------

-- ---------------------------------------------------------
-- 2. Grants: ausschließlich SELECT für authenticated
-- ---------------------------------------------------------
-- Ohne Grant greift keine SELECT-Policy. INSERT/UPDATE/DELETE bleiben
-- bewusst OHNE Grant — zusätzlich zum Fehlen entsprechender Policies.
-- Damit scheitert ein Schreibversuch bereits an der Privilegienprüfung,
-- also noch vor jeder Policy-Auswertung (Defense-in-Depth).
-- anon bleibt vollständig ausgeschlossen.
grant select on public.job_assignments to authenticated;
revoke all on public.job_assignments from anon;


-- ---------------------------------------------------------
-- 3. SELECT-Policies
-- ---------------------------------------------------------
-- Admin: alle Zuweisungen der eigenen Firma.
drop policy if exists "admin read assignments in own company" on public.job_assignments;
create policy "admin read assignments in own company"
on public.job_assignments
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and public.job_in_current_company(job_id)
);

-- Employee: alle Zuweisungen der Aufträge, denen er SELBST zugewiesen ist
-- (Variante B, siehe Entscheidung 1). Deckt sowohl die eigene Zeile als
-- auch die der Kolleginnen und Kollegen desselben Auftrags ab.
drop policy if exists "employee read assignments on assigned jobs" on public.job_assignments;
create policy "employee read assignments on assigned jobs"
on public.job_assignments
for select
to authenticated
using (
  public.current_user_role() = 'employee'
  and public.is_assigned_to_job(job_id)
);

-- KEINE INSERT-, UPDATE- oder DELETE-Policy. Schreibzugriff läuft
-- ausschließlich über set_job_assignments() (unten) sowie über die
-- SECURITY-DEFINER-Trigger aus Phase 2.


-- ---------------------------------------------------------
-- 4. Schreib-RPC: Zuweisungsmenge eines Auftrags ersetzen
-- ---------------------------------------------------------
-- SECURITY DEFINER — zwingend: authenticated hat auf job_assignments
-- absichtlich KEIN Schreibrecht. Die Funktion prüft Authentifizierung,
-- Rolle und Firmenzugehörigkeit selbst und ist damit fail-closed.
--
-- WICHTIG zur Aufgabenteilung mit Phase 2: diese RPC schreibt AUSSCHLIESS-
-- LICH job_assignments. Sie fasst jobs.assigned_to NICHT an. Welcher
-- Mitarbeiter primär wird, entscheidet allein
-- compat_sync_legacy_from_assignments() nach der dort dokumentierten,
-- deterministischen Regel. Damit gibt es weiterhin genau EINE Stelle, die
-- die Legacy-Spalte bestimmt.
--
-- EINGABEVALIDIERUNG vor jedem Schreibvorgang: Der Phase-2-Trigger und
-- enforce_active_assignment laufen als SECURITY DEFINER und umgehen RLS.
-- Auf sie darf man sich zur Eingabeprüfung deshalb NICHT verlassen. Die
-- RPC validiert die vollständige Zielmenge selbst, bevor sie irgendetwas
-- ändert — ein einziger ungültiger Eintrag führt zu null Änderungen.
create or replace function public.set_job_assignments(
  p_job_id       uuid,
  p_employee_ids uuid[] default '{}'::uuid[]
)
returns setof public.job_assignments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_ids     uuid[];
  v_invalid int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can change job assignments' using errcode = '42501';
  end if;

  -- Auftrag laden UND sperren. Die Sperre serialisiert konkurrierende
  -- Mengenänderungen für denselben Auftrag und greift in dieselbe
  -- Sperrreihenfolge wie compat_sync_legacy_from_assignments() (Phase 2)
  -- und update_job_occurrences() — damit entsteht kein Deadlock.
  select j.company_id
    into v_company
  from public.jobs j
  where j.id         = p_job_id
    and j.company_id = public.current_user_company_id()
  for update;

  if not found then
    raise exception 'Job not found or not accessible' using errcode = '42501';
  end if;

  -- Eingabe normalisieren: NULL-Einträge entfernen, Duplikate entfernen.
  -- Ein doppelt übergebener Mitarbeiter ist damit ein harmloser No-Op
  -- statt eines UNIQUE-Fehlers.
  select coalesce(array_agg(distinct x), '{}'::uuid[])
    into v_ids
  from unnest(coalesce(p_employee_ids, '{}'::uuid[])) as x
  where x is not null;

  -- VOLLSTÄNDIGE Validierung vor dem ersten Schreibvorgang:
  -- Profil existiert, ist aktiv, hat role='employee' und gehört zur
  -- Firma des Auftrags. Das schließt Fremdfirmen und Admin-Profile aus.
  select count(*)
    into v_invalid
  from unnest(v_ids) as x
  where not exists (
    select 1
    from public.profiles p
    where p.id         = x
      and p.is_active  = true
      and p.role       = 'employee'
      and p.company_id = v_company
  );

  if v_invalid > 0 then
    raise exception
      'Assignment rejected: % of % employee(s) are not active employees of this company',
      v_invalid, cardinality(v_ids)
      using errcode = '23514';
  end if;

  -- ── ENTFERNEN ──────────────────────────────────────────────────
  -- Nur SPURENFREIE Zeilen, die nicht mehr zur Zielmenge gehören.
  -- Geschützt bleiben damit:
  --   * Zeilen mit Anwesenheit (started/completed)
  --   * Zeilen mit Zeitstempeln
  --   * Zeilen mit Manager-Review (present/absent)
  --   * anonymisierte Zeilen aus Konto-Löschungen (employee_id IS NULL)
  -- Diese Zeilen bleiben als abgekoppelte Nachweise bestehen; die
  -- Phase-2-Primärregel macht sie nie automatisch wieder primär.
  delete from public.job_assignments ja
  where ja.job_id                 = p_job_id
    and ja.employee_id           is not null
    and not (ja.employee_id = any (v_ids))
    and ja.attendance             = 'assigned'
    and ja.review                is null
    and ja.employee_started_at   is null
    and ja.employee_completed_at is null;

  -- ── HINZUFÜGEN ─────────────────────────────────────────────────
  -- Fehlende Zuweisungen anlegen. ON CONFLICT DO NOTHING sorgt dafür,
  -- dass eine bereits bestehende Zeile UNVERÄNDERT bleibt — insbesondere
  -- werden vorhandene Anwesenheits- und Review-Daten nicht überschrieben.
  insert into public.job_assignments (
    job_id, employee_id, employee_name_snapshot, assigned_by
  )
  select
    p_job_id,
    x,
    coalesce(nullif(btrim(p.full_name), ''), 'Unbekannt'),
    auth.uid()
  from unnest(v_ids) as x
  join public.profiles p on p.id = x
  on conflict (job_id, employee_id) do nothing;

  -- Ergebnis: die resultierende Menge, stabil sortiert.
  return query
  select ja.*
  from public.job_assignments ja
  where ja.job_id = p_job_id
  order by ja.assigned_at, ja.id;
end;
$$;

comment on function public.set_job_assignments(uuid, uuid[]) is
'Ersetzt die Zuweisungsmenge EINES Auftrags transaktional (nur Admin, nur '
'eigene Firma). Validiert die gesamte Zielmenge vor dem ersten Schreib'
'vorgang, sperrt die Auftragszeile, entfernt ausschließlich spurenfreie '
'Zuweisungen und legt fehlende an. Bewahrt Anwesenheit, Review, '
'Zeitstempel und anonymisierte Zeilen. jobs.assigned_to wird NICHT '
'angefasst — den primären Mitarbeiter bestimmt allein die '
'Phase-2-Kompatibilitätsschicht.';

-- Nur eingeloggte Nutzer dürfen die RPC überhaupt aufrufen; die
-- Admin-Prüfung passiert intern. anon und PUBLIC bleiben ausgeschlossen.
revoke all on function public.set_job_assignments(uuid, uuid[]) from public;
revoke all on function public.set_job_assignments(uuid, uuid[]) from anon;
grant execute on function public.set_job_assignments(uuid, uuid[]) to authenticated;


-- =========================================================
-- ZUSAMMENSPIEL MIT DEN LIVE-TRIGGERN AUS PHASE 2
-- =========================================================
--   * Jede von der RPC geschriebene Zeile löst
--     compat_sync_legacy_from_assignments() aus. Dieser bestimmt den
--     primären Mitarbeiter neu und schreibt jobs.assigned_to nur bei
--     echter Änderung (IS DISTINCT FROM). Die RPC hält die Auftragszeile
--     zu diesem Zeitpunkt bereits gesperrt — dieselbe Sperre, die der
--     Trigger selbst anfordert, also ein reiner No-Op ohne Deadlock.
--   * Rekursion ist ausgeschlossen: die RPC schreibt ausschließlich
--     job_assignments; der Rückweg nach jobs läuft über den Trigger, und
--     dessen Gegenrichtung ist über das transaktionslokale Sync-Flag
--     abgesichert.
--   * BEKANNTE, BEGRENZTE SCHREIBVERSTÄRKUNG: Die Trigger sind
--     zeilenbasiert. Eine Mengenänderung mit n Zeilen löst bis zu n
--     Primär-Neuberechnungen und bis zu n Touch-Updates auf derselben
--     jobs-Zeile aus (und damit ebenso viele Realtime-Events). Das ist
--     durch die Größe der Zuweisungsmenge nach oben begrenzt — also eine
--     einstellige Zahl pro Admin-Aktion, keine Mengenoperation. Bewusst
--     nicht optimiert: eine Unterdrückung müsste das interne Sync-Flag
--     der Phase 2 von außen setzen und würde beide Phasen fest
--     aneinanderkoppeln. Zusammengeführt wird das in Phase 6, wenn der
--     Schreibpfad der App ohnehin neu gebaut wird.
--   * Die Phase-2-Trigger umgehen als SECURITY DEFINER die RLS. Diese
--     Migration verlässt sich an keiner Stelle darauf, dass RLS deren
--     Verhalten einschränkt — die Eingabevalidierung liegt vollständig in
--     set_job_assignments(), also VOR der Trigger-Ausführung.
-- =========================================================


-- =========================================================
-- ROLLBACK (vollständig, nicht destruktiv)
-- =========================================================
-- Reihenfolge unkritisch: keine der neuen Funktionen wird von einem
-- bestehenden Trigger aufgerufen (im Gegensatz zu Phase 2).
--
--   drop policy if exists "employee read assignments on assigned jobs" on public.job_assignments;
--   drop policy if exists "admin read assignments in own company"      on public.job_assignments;
--   revoke select on public.job_assignments from authenticated;
--   drop function if exists public.set_job_assignments(uuid, uuid[]);
--   drop function if exists public.is_assigned_to_job(uuid);
--   drop function if exists public.job_in_current_company(uuid);
--
-- Danach ist job_assignments wieder exakt im Phase-2-Zustand: RLS an,
-- keine Policies, keine Grants für anon/authenticated. Es gehen keine
-- Daten verloren — diese Migration besitzt keine eigenen Daten. Die
-- Phase-2-Kompatibilitätsschicht und jobs.assigned_to bleiben unberührt
-- und voll funktionsfähig.
-- =========================================================
