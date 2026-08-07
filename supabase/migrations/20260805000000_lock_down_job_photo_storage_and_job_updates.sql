-- =========================================================
-- MIGRATION: Foto-Speicher abdichten + direktes Employee-UPDATE auf jobs entziehen
-- Datum: 2026-08-05
-- =========================================================
-- Dies ist der in 20260730000000_employee_read_via_assignments.sql
-- angekuendigte „eigene Storage-PR". Dort wurden die beiden zu weiten
-- Policies auf public.job_photos bereits entfernt; die entsprechenden
-- Policies auf storage.objects wurden ausdruecklich vertagt. Sie werden
-- hier entfernt.
--
-- Zusaetzlich wird die Policy "employee update own assigned jobs" auf
-- public.jobs entzogen (Abschnitt 3).
--
-- =========================================================
-- BEFUND (empirisch auf PRODUKTION nachgewiesen, 2026-08-05)
-- =========================================================
-- Nachgewiesen mit einer synthetischen Fixture in einer garantiert
-- zurueckgerollten Transaktion (BEGIN … RAISE EXCEPTION), Rueckstaende
-- danach mit 0 verifiziert. Rollen wurden per SET ROLE authenticated +
-- request.jwt.claims gesetzt, also exakt der PostgREST-Pfad der App:
--
--   T1  Mitarbeiter E2, NICHT auf Auftrag J1 zugewiesen, liest das
--       storage-Objekt eines J1-Fotos                     -> 1 Zeile  (LECK)
--   T2  derselbe E2 laedt in den Ordner <firma>/<J1>/ hoch -> ERLAUBT   (LECK)
--   T3  derselbe E2 liest die jobs-Zeile J1               -> 0 Zeilen (korrekt)
--   T4  E1 (Legacy-Primaer von J1) setzt per direktem UPDATE
--       started_at = now()-9h, completed_at = now(),
--       status = 'completed'                              -> ERLAUBT   (LECK)
--
-- T3 zeigt: die Firmen-Isolation ist intakt. Gebrochen ist ausschliesslich
-- die Isolation ZWISCHEN MITARBEITERN DERSELBEN FIRMA.
--
-- =========================================================
-- URSACHE
-- =========================================================
-- RLS-Policies desselben Kommandos sind PERMISSIVE und werden mit ODER
-- verknuepft. In Produktion existieren auf storage.objects fuenf Policies,
-- davon zwei ohne jeden Auftragsbezug:
--
--   "job-photos storage: Lesen aus eigenem Firma-Ordner"    (SELECT)
--   "job-photos storage: Hochladen in eigenen Firma-Ordner" (INSERT)
--
-- Beide pruefen NUR bucket_id und (storage.foldername(name))[1] =
-- current_user_company_id(). Da sie mit ODER neben den strengen Policies
-- stehen, sind die strengen Policies FAKTISCH WIRKUNGSLOS: jeder
-- Mitarbeiter der Firma kommt an jeden Auftragsordner der Firma.
--
-- DRIFT: Diese beiden Policies werden von KEINER Migration im Repository
-- erzeugt. Sie existieren ausschliesslich in der Produktionsdatenbank
-- (vermutlich per Dashboard angelegt) und sind bislang nur als Kommentar
-- in 20260730000000 beschrieben. Gleiches gilt fuer
-- "job-photos insert allowed" und "job-photos delete own upload" — beide
-- sind in Produktion aktiv, aber in keiner Migration definiert. Nur
-- "job-photos read allowed" stammt aus einer Migration (20260730000000).
--
-- Abschnitt 2 holt diese Drift deshalb ins Repository nach: die drei
-- korrekten Policies werden mit ihrer EXAKTEN Produktionsdefinition neu
-- angelegt. Auf Produktion ist das ein No-Op (identischer Wortlaut); auf
-- einer aus Migrationen gebauten Datenbank stellt es erstmals denselben
-- Stand her. Ab dieser Migration beschreibt das Repository den Storage-
-- Zustand vollstaendig.


-- =========================================================
-- 1. DIE BEIDEN ZU WEITEN STORAGE-POLICIES ENTFERNEN
-- =========================================================
-- Ersatzlos: der von ihnen legitim abgedeckte Personenkreis (Admin der
-- Firma, zugewiesener Mitarbeiter) ist von den Policies in Abschnitt 2
-- vollstaendig abgedeckt. Was wegfaellt, ist ausschliesslich der Zugriff
-- auf Auftragsordner OHNE Auftragsbezug — also genau das Leck.
--
-- "if exists", weil sie in aus Migrationen gebauten Datenbanken (Staging,
-- lokal, CI) gar nicht existieren. Dort laufen die DROPs ins Leere und die
-- Migration ist ein reiner No-Op fuer diesen Abschnitt.
drop policy if exists "job-photos storage: Lesen aus eigenem Firma-Ordner"    on storage.objects;
drop policy if exists "job-photos storage: Hochladen in eigenen Firma-Ordner" on storage.objects;


-- =========================================================
-- 2. DIE DREI KORREKTEN STORAGE-POLICIES IM REPOSITORY VERANKERN
-- =========================================================
-- Wortlaut identisch zum heutigen Produktionsstand (ausgelesen aus
-- pg_policies am 2026-08-05). drop+create statt „create if not exists",
-- weil Postgres fuer Policies kein CREATE OR REPLACE kennt und der
-- Wortlaut damit deterministisch wird — unabhaengig davon, was in der
-- jeweiligen Umgebung vorher stand.
--
-- Pfadkonvention im Bucket: <company_id>/<job_id>/<datei>
--   foldername(name)[1] = company_id
--   foldername(name)[2] = job_id
--
-- WARUM `j.id::text = (storage.foldername(name))[2]` UND NICHT
-- `j.id = ((storage.foldername(name))[2])::uuid`:
--
-- Der Bucket enthaelt beliebige, von aussen benennbare Objekte. Liegt dort
-- auch nur EIN Objekt, dessen zweites Pfadsegment kein gueltiges UUID ist
-- (Altlast, Fehl-Upload, gezielt angelegt), dann wirft die Cast-Variante
-- beim Auswerten der Policy 22P02 „invalid input syntax for type uuid".
-- Postgres garantiert KEINE Auswertungsreihenfolge der AND-Glieder — der
-- vorgelagerte Firmen-Ordner-Vergleich schuetzt also nicht zuverlaessig
-- davor. Ein solcher Fehler bricht die GESAMTE Abfrage ab, statt nur die
-- eine Zeile abzulehnen: ein einziges kaputt benanntes Objekt koennte so
-- das Laden JEDER Fotoliste der Firma lahmlegen (und waere, absichtlich
-- platziert, ein billiger DoS gegen die eigene Firma).
--
-- Der Textvergleich ist dagegen total: er liefert fuer jeden Unsinn im
-- Pfad schlicht `false` und lehnt damit genau dieses eine Objekt ab. Die
-- Isolationswirkung ist identisch — j.id ist ein UUID und seine
-- Textdarstellung ist kanonisch (klein geschrieben, mit Bindestrichen),
-- ein zufaelliger Treffer ist also ausgeschlossen.
--
-- PREIS, DER HIER BEWUSST BEZAHLT WIRD: `j.id::text = …` ist nicht
-- sargable, der Primaerschluessel-Index auf jobs.id wird fuer diesen
-- Vergleich nicht genutzt. Bei aktuell ~900 jobs-Zeilen ist der Seq Scan
-- pro Policy-Auswertung ohne Bedeutung. Sollte die Tabelle je in die
-- Hunderttausende wachsen, ist der saubere Ausweg ein funktionaler Index
-- (`create index on public.jobs ((id::text))`) — NICHT die Rueckkehr zum
-- Cast.

-- ── LESEN ──
-- Admin: alle Auftraege der eigenen Firma.
-- Mitarbeiter: nur Auftraege der eigenen ZUWEISUNGSMENGE — Legacy-Zeiger
-- assigned_to ODER job_assignments (is_assigned_to_job). Sekundaer
-- Zugewiesene lesen also weiterhin mit; das ist der Stand seit
-- 20260730000000 und wird hier NICHT veraendert.
drop policy if exists "job-photos read allowed" on storage.objects;
create policy "job-photos read allowed"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'job-photos'
  and (storage.foldername(name))[1] = public.current_user_company_id()::text
  and exists (
    select 1
    from public.jobs j
    where j.id::text = (storage.foldername(name))[2]
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
  )
);

-- ── HOCHLADEN ──
-- ACHTUNG, BEWUSSTE ENTSCHEIDUNG — hier steht assigned_to, NICHT
-- is_assigned_to_job:
--
-- Der Schreibpfad fuer Fotos und Kommentare haengt projektweit am
-- Legacy-PRIMAER, nicht an der vollen Zuweisungsmenge. Das ist in
-- CLAUDE.md als gewollte Asymmetrie dokumentiert, die Client-Seite gated
-- exakt genauso (JobDetailScreen.tsx:306 nutzt isPrimaryAssignee, nicht
-- isAssignedTo), und die INSERT-Policy auf public.job_photos verlangt
-- ebenfalls assigned_to = auth.uid().
--
-- FOLGE DIESER MIGRATION, DIE MAN KENNEN MUSS: ein SEKUNDAER Zugewiesener
-- kann heute — allein durch die weite Drift-Policy — Dateien hochladen.
-- Nach dieser Migration kann er das nicht mehr. Das ist KEIN Verlust eines
-- genutzten Rechts: die App bietet ihm den Upload gar nicht an, und die
-- zugehoerige job_photos-ZEILE haette er ohnehin nie anlegen koennen (die
-- Tabellen-Policy blockiert das seit jeher) — er haette also nur eine
-- verwaiste Datei ohne DB-Zeile erzeugen koennen.
--
-- Die Angleichung des Schreibpfads an die volle Zuweisungsmenge
-- (job_photos + job_comments + job_comment_reads + storage, konsistent in
-- einem Zug) ist eine FACHLICHE Erweiterung und gehoert in einen eigenen
-- PR — nicht in eine Sicherheitsabdichtung.
drop policy if exists "job-photos insert allowed" on storage.objects;
create policy "job-photos insert allowed"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'job-photos'
  and (storage.foldername(name))[1] = public.current_user_company_id()::text
  and exists (
    select 1
    from public.jobs j
    where j.id::text = (storage.foldername(name))[2]
      and j.company_id = public.current_user_company_id()
      and (
        public.current_user_role() = 'admin'
        or (
          public.current_user_role() = 'employee'
          and j.assigned_to = auth.uid()
        )
      )
  )
);

-- ── LOESCHEN ──
-- Nur die EIGENE hochgeladene Datei (owner = auth.uid()) und nur innerhalb
-- der eigenen Firma. Unveraendert zum Produktionsstand.
drop policy if exists "job-photos delete own upload" on storage.objects;
create policy "job-photos delete own upload"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'job-photos'
  and owner = auth.uid()
  and (storage.foldername(name))[1] = public.current_user_company_id()::text
  and exists (
    select 1
    from public.jobs j
    where j.id::text = (storage.foldername(name))[2]
      and j.company_id = public.current_user_company_id()
  )
);


-- =========================================================
-- 3. "employee update own assigned jobs" ENTZIEHEN
-- =========================================================
-- Diese Policy stammt aus der Baseline 20260713000000 und erlaubt dem
-- Legacy-Primaer ein direktes UPDATE auf SEINER jobs-Zeile:
--
--   USING/CHECK: current_user_role() = 'employee'
--                and assigned_to = auth.uid()
--                and company_id = current_user_company_id()
--
-- RLS ist ZEILEN-, nicht spaltenbasiert: die Policy kann nicht zwischen
-- „Notiz aendern" und „started_at faelschen" unterscheiden. Ein
-- Mitarbeiter kann damit per PATCH /rest/v1/jobs?id=eq.<seinauftrag>
-- started_at, completed_at und status frei setzen. Da der Stundenzettel
-- die offizielle Dauer als completed_at - started_at berechnet, ist das
-- ein direkter Manipulationspfad auf die Lohnabrechnung (T4 oben).
--
-- ENTZOGEN STATT EINGESCHRAENKT — Begruendung:
--
--   a) Spaltenweise Einschraenkung ginge nur ueber column-level REVOKE auf
--      der Rolle `authenticated`. Admins nutzen DIESELBE Rolle, ihre
--      Schreibpfade wuerden mitbrechen. Keine Option.
--   b) Ein BEFORE-UPDATE-Trigger koennte den Akteur nicht unterscheiden:
--      auth.uid() liefert innerhalb der SECURITY-DEFINER-RPCs weiterhin
--      den Mitarbeiter, der Trigger wuerde also start_own_job/
--      complete_own_job mit abwuergen. Keine Option.
--   c) Es gibt keinen Aufrufer. Verifiziert im gesamten Client:
--      - services/jobs/jobs.service.ts kennt genau drei jobs-Schreibpfade
--        (createJob/updateJob/deleteJob), alle mit
--        `if (profile.role !== "admin") throw` davor;
--      - setRecurringRuleActive laeuft laut eigenem Kommentar unter der
--        Admin-Policy;
--      - jede Employee-Aktion laeuft ueber rpc("start_own_job") /
--        rpc("complete_own_job").
--      Kein einziger .update() auf jobs haengt an dieser Policy.
--
-- Die beiden RPCs sind NACHWEISLICH SECURITY DEFINER (pg_proc.prosecdef =
-- true, ebenso set_job_assignments, update_job_occurrences,
-- generate_job_occurrences, inherit_occurrence_assignments). Sie umgehen
-- RLS vollstaendig und sind von diesem DROP nicht betroffen — die
-- Statusuebergaenge bleiben exakt wie sie sind, inklusive geteilter
-- Job-Uhr.
--
-- NACH DIESER MIGRATION ist der Statuswechsel fuer Mitarbeiter
-- AUSSCHLIESSLICH ueber die beiden RPCs erreichbar. Genau so war es
-- immer gemeint.
--
-- Admins bleiben unberuehrt: "admin update jobs in own company" wird
-- nicht angefasst.
drop policy if exists "employee update own assigned jobs" on public.jobs;


-- =========================================================
-- ROLLBACK (manuell, in dieser Reihenfolge)
-- =========================================================
-- Stellt exakt den Stand VOR dieser Migration wieder her — inklusive der
-- beiden Lecks. Nur im Notfall und nur mit ausdruecklicher Freigabe:
--
--   create policy "job-photos storage: Lesen aus eigenem Firma-Ordner"
--   on storage.objects for select to authenticated
--   using (
--     bucket_id = 'job-photos'
--     and (storage.foldername(name))[1] = public.current_user_company_id()::text
--   );
--
--   create policy "job-photos storage: Hochladen in eigenen Firma-Ordner"
--   on storage.objects for insert to authenticated
--   with check (
--     bucket_id = 'job-photos'
--     and (storage.foldername(name))[1] = public.current_user_company_id()::text
--   );
--
--   create policy "employee update own assigned jobs"
--   on public.jobs for update to authenticated
--   using (
--     public.current_user_role() = 'employee'
--     and assigned_to = auth.uid()
--     and company_id = public.current_user_company_id()
--   )
--   with check (
--     public.current_user_role() = 'employee'
--     and assigned_to = auth.uid()
--     and company_id = public.current_user_company_id()
--   );
--
-- Die drei in Abschnitt 2 neu angelegten Policies brauchen KEIN Rollback:
-- ihr Wortlaut ist mit dem vorherigen Produktionsstand identisch.
--
-- =========================================================
-- WAS DIESE MIGRATION NICHT TUT
-- =========================================================
--   * Sie aendert NICHTS an public.job_photos / public.job_comments /
--     public.job_comment_reads. Deren Policies sind bereits korrekt.
--   * Sie aendert NICHTS an den beiden RPCs.
--   * Sie weitet den Foto-SCHREIBPFAD NICHT auf die volle
--     Zuweisungsmenge aus (siehe Begruendung in Abschnitt 2).
--   * Sie fasst die uebrige bekannte Produktions-Drift NICHT an: den
--     Database-Webhook-Trigger "dispatch-admin-notifications" auf
--     notification_outbox und die Mitgliedschaft in der Publication
--     supabase_realtime. Beides gehoert in einen eigenen PR.
