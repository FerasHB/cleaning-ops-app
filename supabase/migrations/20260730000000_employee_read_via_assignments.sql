-- =========================================================
-- MIGRATION: Employee-LESEZUGRIFF ueber job_assignments
-- Datum: 2026-07-30   (Phase 5 von 11 — begleitende Sicherheitsschicht)
-- =========================================================
-- ZWECK
--   Phase 5 stellt den React-Native-LESEPFAD von jobs.assigned_to auf die
--   Zuweisungsmenge (job_assignments) um. Ohne diese Migration liefe die
--   Umstellung ins Leere: ein Mitarbeiter, der einem Auftrag zugewiesen
--   ist, ohne der von der Kompatibilitaetsschicht bestimmte PRIMAER zu
--   sein, sieht die jobs-Zeile ueberhaupt nicht — er darf zwar die
--   job_assignments-Zeilen lesen (Phase 3), aber die zugehoerige
--   jobs-Zeile bleibt ihm durch die Employee-SELECT-Policy verborgen.
--
--   Genau diese Policies haengen bis heute an der Einzel-Spalte
--   jobs.assigned_to. Keine der Migrationen aus Phase 1 bis 4.1 hat sie
--   angefasst (verifiziert: kein "create policy ... on public.jobs" in
--   supabase/migrations/).
--
-- =========================================================
-- DIESE MIGRATION IST AUSSCHLIESSLICH EINE LESE-AENDERUNG
-- =========================================================
-- Geaendert werden GENAU VIER Policies, alle rein lesend:
--
--   1. public.jobs          Policy "employee read own assigned jobs"   (SELECT)
--   2. public.job_comments  Policy "employee read comments on own jobs"(SELECT)
--   3. public.job_photos    Policy "employee read photos on own jobs"  (SELECT)
--   4. storage.objects      Policy "job-photos read allowed"           (SELECT)
--
-- Dazu kommt in Abschnitt 6 das Entfernen zweier redundanter, ZU WEITER
-- Bestands-Policies auf public.job_photos — ohne das waere die Migration
-- NICHT lesend (Begruendung dort, mit reproduziertem Testfall).
--
-- BEWUSST NICHT ANGEFASST — alle Schreibpfade bleiben exakt wie sie sind
-- und haengen weiterhin an jobs.assigned_to:
--
--   * "employee insert comments on own jobs"   (job_comments INSERT)
--   * "employee insert photos on own jobs"     (job_photos  INSERT)
--   * "insert/update own comment-read state"   (job_comment_reads)
--   * "job-photos insert allowed"              (storage     INSERT)
--   * public.start_own_job() / public.complete_own_job()
--   * public.get_unread_comment_job_ids()      (siehe Abschnitt 5)
--   * saemtliche Admin-Policies auf jobs/job_comments/job_photos
--   * saemtliche Policies und Grants auf public.job_assignments (Phase 3)
--
-- KEIN neuer GRANT, KEINE neue Funktion, KEINE Tabellen-, Trigger- oder
-- Enum-Aenderung, KEINE einzige DML-Anweisung.
--
-- =========================================================
-- EINE BEKANNTE, NICHT HIER BEHOBENE NEBENWIRKUNG
-- =========================================================
-- Die Storage-Policy "job-photos delete own upload" (existiert nur in der
-- Produktionsdatenbank, in keiner Migration) prueft
--     owner = auth.uid()  AND  EXISTS (select 1 from jobs j
--                                      where j.id = <aus dem Pfad>
--                                        and j.company_id = <eigene Firma>)
-- Der jobs-Teilausdruck ist NUR auf die Firma eingeschraenkt und laeuft
-- unter der jobs-RLS des Aufrufers. Abschnitt 1 erweitert genau diese
-- Sichtbarkeit — ein sekundaer Zugewiesener kann danach also eine SELBST
-- hochgeladene Datei auch an einem Auftrag loeschen, an dem er nicht der
-- Legacy-Primaer ist. Betroffen sind ausschliesslich eigene Uploads.
--
-- Diese Policy wird hier BEWUSST NICHT angefasst: sie gehoert zur
-- Produktions-Drift des storage-Schemas (dort existieren weitere, in
-- keiner Migration gefuehrte Policies), die in einem eigenen PR
-- aufgearbeitet wird. Die Aussage "diese Migration aendert keinerlei
-- Schreibrechte" waere ohne diesen Hinweis unzutreffend.
--
-- =========================================================
-- BEWUSSTE ASYMMETRIE (dokumentiert, kein Versehen)
-- =========================================================
-- Nach dieser Migration kann ein NICHT-primaerer Zugewiesener einen
-- Auftrag, seine Kommentare und seine Fotos LESEN, aber
--   * keinen Kommentar schreiben,
--   * kein Foto hochladen,
--   * den Auftrag nicht starten/abschliessen.
-- Das ist fuer eine reine Lese-Phase korrekt und beabsichtigt. Die
-- Schreibpfade folgen in Phase 6/7 zusammen mit der Umstellung von
-- start_own_job/complete_own_job. Bis dahin muss der Client seine
-- Aktions-Buttons weiterhin am Legacy-Primaer (jobs.assigned_to)
-- ausrichten, NICHT an der Zuweisungsmenge — sonst bietet er einem
-- sekundaeren Zugewiesenen einen Button an, der serverseitig mit
-- "Job not found or not allowed" fehlschlaegt.
--
-- =========================================================
-- DREI TRAGENDE ENTWURFSENTSCHEIDUNGEN
-- =========================================================
-- (A) DER LEGACY-VERGLEICH BLEIBT STEHEN.
--     Das Praedikat lautet ueberall
--         assigned_to = auth.uid()  OR  public.is_assigned_to_job(<job>)
--     also eine echte OBERMENGE des heutigen Verhaltens. Kein Mitarbeiter
--     kann durch diese Migration Zugriff VERLIEREN — auch nicht in den
--     Bestandsfaellen, die der Guard aus Phase 1 heute nicht mehr
--     erzeugen wuerde (im Backfill als "nicht konform" ausgewiesen) und
--     fuer die deshalb keine Garantie besteht, dass jede assigned_to-
--     Zuweisung eine passende job_assignments-Zeile besitzt. Der
--     Legacy-Zweig faellt erst in Phase 11 mit der Spalte selbst.
--
-- (B) job_type = 'single' MUSS AUSSERHALB DER ODER-KLAMMER BLEIBEN.
--     Das ist die eigentliche Falle dieser Migration: Recurring-PARENT-
--     Regeln tragen seit Phase 4 SELBST Zuweisungen (sie sind die
--     Vorlage, von der Occurrences erben). is_assigned_to_job() kennt
--     job_type nicht und liefert fuer eine Parent-Regel deshalb true.
--     Wuerde man die neue Bedingung naiv an die bestehende Policy
--     anhaengen, saehen Mitarbeiter ab sofort Parent-Regeln in ihrer
--     Jobliste — eine stille Ausweitung, die es heute nicht gibt und die
--     das gesamte Modell "Employees sehen nur ausfuehrbare Termine"
--     bricht. Die Einschraenkung steht daher als eigenstaendiges AND
--     VOR der Klammer.
--
-- (C) KEINE REKURSION.
--     public.is_assigned_to_job(uuid) ist SECURITY DEFINER (Phase 3,
--     20260727000000). Ihre Lesezugriffe auf job_assignments und jobs
--     laufen im Rechtekontext des Eigentuemers und unterliegen keiner
--     RLS — sie kann die Policy, die sie aufruft, also nicht erneut
--     betreten. Die Funktion ist bereits fuer authenticated ausfuehrbar
--     (grant execute in Phase 3); diese Migration vergibt KEIN neues
--     Recht. Zur Begruendung, warum Policy-Helfer fuer authenticated
--     ausfuehrbar sein MUESSEN, siehe den Kommentarblock in
--     20260727000000_job_assignments_rls.sql.
--
-- IDEMPOTENZ
--   Vollstaendig wiederholbar: alle Policies via DROP IF EXISTS + CREATE,
--   die Funktion via CREATE OR REPLACE.
--
-- ANWENDUNG
--   Wie alle Schemaaenderungen hier MANUELL im Supabase SQL Editor
--   ausfuehren (siehe CLAUDE.md).
-- =========================================================


-- ---------------------------------------------------------
-- 1. public.jobs — Employee-Lesepolicy
-- ---------------------------------------------------------
-- Vorher:  ... and assigned_to = auth.uid() and company_id = ...
-- Nachher: identisch, plus ODER-Zweig ueber die Zuweisungsmenge.
-- job_type = 'single' bleibt eigenstaendige Bedingung (siehe (B)).
drop policy if exists "employee read own assigned jobs" on public.jobs;
create policy "employee read own assigned jobs"
on public.jobs
for select
to authenticated
using (
  public.current_user_role() = 'employee'
  and job_type = 'single'
  and company_id = public.current_user_company_id()
  and (
    assigned_to = auth.uid()
    or public.is_assigned_to_job(id)
  )
);


-- ---------------------------------------------------------
-- 2. public.job_comments — Employee-Lesepolicy
-- ---------------------------------------------------------
-- Der EXISTS-Block auf jobs bleibt erhalten (er traegt die Verknuepfung
-- Kommentar -> Auftrag); erweitert wird ausschliesslich die Bedingung,
-- WER als zugewiesen gilt.
--
-- Hier ist KEINE job_type-Einschraenkung noetig und es waere falsch, eine
-- einzufuehren: an einer Parent-Regel existieren fachlich keine
-- Kommentare fuer Mitarbeiter, und die bestehende Policy kennt die
-- Einschraenkung ebenfalls nicht. Sichtbarkeit entsteht ohnehin erst
-- ueber einen konkreten Kommentar zu einem konkreten Auftrag.
drop policy if exists "employee read comments on own jobs" on public.job_comments;
create policy "employee read comments on own jobs"
on public.job_comments
for select
to authenticated
using (
  public.current_user_role() = 'employee'
  and company_id = public.current_user_company_id()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_comments.job_id
      and (
        j.assigned_to = auth.uid()
        or public.is_assigned_to_job(j.id)
      )
  )
);

-- HINWEIS: "employee insert comments on own jobs" bleibt UNVERAENDERT
-- und weiterhin an j.assigned_to = auth.uid() gebunden. Schreibrechte
-- sind nicht Teil dieser Migration (Phase 6/7).


-- ---------------------------------------------------------
-- 3. public.job_photos — Employee-Lesepolicy
-- ---------------------------------------------------------
drop policy if exists "employee read photos on own jobs" on public.job_photos;
create policy "employee read photos on own jobs"
on public.job_photos
for select
to authenticated
using (
  public.current_user_role() = 'employee'
  and company_id = public.current_user_company_id()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_photos.job_id
      and (
        j.assigned_to = auth.uid()
        or public.is_assigned_to_job(j.id)
      )
  )
);

-- HINWEIS: "employee insert photos on own jobs" bleibt UNVERAENDERT.


-- ---------------------------------------------------------
-- 4. storage.objects — Lesepolicy des Buckets job-photos
-- ---------------------------------------------------------
-- Ohne diese Anpassung sieht ein sekundaerer Zugewiesener zwar die
-- job_photos-Zeile (Punkt 3), bekommt aber beim Laden der Datei einen
-- Zugriffsfehler — die Galerie zeigte dann leere Kacheln.
--
-- ZWEI AUSGANGSLAGEN — die Anweisung unten ist fuer beide korrekt, das
-- ERGEBNIS ist es ebenfalls, aber der Weg dorthin unterscheidet sich:
--
--   a) PRODUKTION: die Policy existiert bereits (dort manuell angewandt,
--      siehe lib/schema.sql — Storage-Policies sind in KEINER Migration
--      gefuehrt). DROP + CREATE ERSETZT sie; Pfadaufbau und Firmenpruefung
--      bleiben identisch, erweitert wird nur der Employee-Zweig.
--
--   b) AUS MIGRATIONEN GEBAUTE UMGEBUNG (lokaler Reset, frisches Staging):
--      die Policy existiert NICHT — das DROP laeuft ins Leere ("does not
--      exist, skipping") und das CREATE legt sie ERSTMALS an. Dort ist das
--      also keine Erweiterung, sondern die Erstvergabe eines Leserechts.
--      Vorher konnte in so einer Umgebung NIEMAND Dateien des Buckets
--      lesen, weil ueberhaupt keine SELECT-Policy existierte.
--
-- Diese Divergenz ist ein Symptom der Storage-Drift (die INSERT-/DELETE-
-- Policies fehlen in Migrationen ebenfalls, und in Produktion existieren
-- zusaetzliche, weiter gefasste Storage-Policies). Sie wird hier NICHT
-- behoben — dafuer ist der eigene Storage-PR zustaendig. Konsequenz fuer
-- Reviews: ein gruener Lauf gegen eine aus Migrationen gebaute Datenbank
-- sagt NICHTS ueber das Storage-Verhalten in Produktion aus.
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
    where j.id = ((storage.foldername(name))[2])::uuid
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

-- HINWEIS: "job-photos insert allowed" und "job-photos delete own upload"
-- bleiben UNVERAENDERT an j.assigned_to = auth.uid() gebunden.


-- ---------------------------------------------------------
-- 5. BEWUSST NICHT GEAENDERT: get_unread_comment_job_ids()
-- ---------------------------------------------------------
-- Ein frueherer Entwurf dieser Migration hat die RPC ebenfalls um den
-- Zuweisungs-Zweig erweitert, damit die Ungelesen-Kennzeichnung zur neuen
-- Kommentar-Sichtbarkeit passt. Das war FALSCH und wird hier bewusst
-- unterlassen:
--
--   Das Markieren als gelesen ist ein SCHREIBVORGANG auf
--   public.job_comment_reads. Dessen INSERT- und UPDATE-Policies
--   ("insert own comment-read state" / "update own comment-read state")
--   verlangen weiterhin
--       EXISTS (select 1 from jobs j
--               where j.id = job_comment_reads.job_id
--                 and (admin or (employee and j.assigned_to = auth.uid())))
--   also den LEGACY-PRIMAER. Sie gehoeren zum Schreibpfad und duerfen in
--   dieser rein lesenden Phase nicht angefasst werden.
--
--   Haette man nur die RPC erweitert, waere fuer einen sekundaer
--   Zugewiesenen ein DAUERHAFT HAENGENDER Zustand entstanden: die RPC
--   meldet den Auftrag als ungelesen, das Markieren scheitert mit 42501,
--   der Fehler wird im JobContext geschluckt — der rote Punkt kaeme nach
--   jedem Refresh zurueck und liesse sich nie entfernen. Lokal
--   reproduziert (SEC-READ sichtbar=1 / SEC-UNREAD ungelesen=1 /
--   SEC-MARKREAD ABGELEHNT 42501).
--
-- GEWAEHLTE LOESUNG (die kleinere und sichere): die RPC bleibt
-- unveraendert. Ein sekundaer Zugewiesener sieht die Kommentare eines
-- Auftrags, bekommt dafuer aber (noch) keine Ungelesen-Kennzeichnung.
-- Das ist ein fehlender Hinweis, KEIN kaputter Zustand — und exakt das
-- heutige Verhalten. Die Kennzeichnung folgt in Phase 6/7 gemeinsam mit
-- den Schreibpfaden, dann konsistent mit job_comment_reads.
--
-- Der Client stellt zusaetzlich sicher, dass fuer einen sekundaer
-- Zugewiesenen gar kein Markier-Versuch mehr abgesetzt wird
-- (JobDetailScreen), damit kein stiller 42501 im Log landet.
-- ---------------------------------------------------------
-- 6. Zwei veraltete, ZU WEITE job_photos-Policies entfernen
-- ---------------------------------------------------------
-- WARUM DAS HIER STEHT — sonst waere diese Migration NICHT read-only:
--
-- In der Produktionsdatenbank existieren zwei Policies aus der Zeit vor
-- der heutigen Rechtestruktur (uebernommen in
-- 20260713000000_remote_baseline.sql, Zeilen 965 und 971):
--
--   "job_photos: Firma darf Fotos lesen"      (SELECT)
--   "job_photos: Firma darf Fotos hochladen"  (INSERT)
--
-- Beide pruefen NICHT die Zuweisung, sondern nur:
--   company_id = current_user_company_id()
--   AND EXISTS (select 1 from public.jobs j
--               where j.id = job_photos.job_id
--                 and j.company_id = current_user_company_id())
--
-- Entscheidend ist, dass diese Unterabfrage auf public.jobs der
-- JOBS-RLS DES AUFRUFERS unterliegt (sie steht in einer Policy, nicht in
-- einer SECURITY-DEFINER-Funktion). Ihre gesamte Schutzwirkung stammt
-- also nicht aus der Policy selbst, sondern daraus, WELCHE jobs-Zeilen
-- der Aufrufer sehen darf. Bis heute war das genau die Menge
-- "assigned_to = auth.uid()", weshalb die beiden weiten Policies faktisch
-- dasselbe erlaubten wie die strengen aus lib/schema.sql und nie
-- auffielen.
--
-- Abschnitt 1 dieser Migration erweitert exakt jene jobs-Sichtbarkeit.
-- Damit wuerde die weite INSERT-Policy ab sofort auch einem SEKUNDAEREN
-- Zugewiesenen das Anlegen von job_photos-Zeilen erlauben — eine
-- SCHREIBRECHTS-Erweiterung als Nebenwirkung einer Lese-Aenderung. Genau
-- das ist ausgeschlossen. (Im lokalen Testlauf ist das reproduziert
-- worden, bevor dieser Abschnitt existierte: Fall 16 schlug fehl,
-- der Upload wurde AKZEPTIERT.)
--
-- Die weite SELECT-Policy traegt dasselbe Problem in harmloserer Form:
-- sie waere ab sofort die eigentlich wirksame Lese-Regel, waehrend die
-- dokumentierte, strenge Policy nur noch danebensteht.
--
-- BEIDE SIND VOLLSTAENDIG REDUNDANT und werden deshalb entfernt:
--   * Lesen:  "admin read photos in own company" deckt Admins ab,
--             "employee read photos on own jobs" (Abschnitt 3) deckt
--             Zugewiesene ab — inklusive der neuen Zuweisungsmenge.
--   * Anlegen:"admin insert photos in own company" deckt Admins ab,
--             "employee insert photos on own jobs" deckt Zugewiesene ab
--             (unveraendert an assigned_to gebunden).
--
-- NETTOWIRKUNG AUF SCHREIBRECHTE = NULL. Verglichen mit dem Zustand VOR
-- dieser Migration kann nach ihr exakt derselbe Personenkreis Fotos
-- anlegen wie vorher. Das Entfernen nimmt niemandem ein heute
-- tatsaechlich nutzbares Recht — es verhindert nur, dass Abschnitt 1
-- eines dazugibt.
--
-- KORREKTUR EINER FRUEHEREN BEGRUENDUNG: hier stand zunaechst, ein
-- sekundaer Zugewiesener haette ueber die weite Policy zwar eine
-- Foto-ZEILE anlegen koennen, aber nicht die Datei hochladen duerfen.
-- Das ist fuer die PRODUKTIONSDATENBANK nachweislich falsch: dort
-- existiert zusaetzlich die Policy
--     "job-photos storage: Hochladen in eigenen Firma-Ordner"
-- die ausschliesslich Bucket und Firmen-Ordner prueft und damit jedem
-- Mitarbeiter der Firma den Upload in JEDEN Auftragsordner erlaubt
-- (lokal mit dem Produktions-Policy-Stand reproduziert). Das Entfernen
-- der beiden weiten job_photos-Policies bleibt trotzdem richtig und
-- notwendig — die Begruendung ist schlicht die oben genannte
-- Transitivitaet, nicht ein angeblicher Zwischenzustand. Die weiten
-- STORAGE-Policies sind Teil der Produktions-Drift und werden in einem
-- eigenen PR behandelt, nicht hier.
drop policy if exists "job_photos: Firma darf Fotos lesen"     on public.job_photos;
drop policy if exists "job_photos: Firma darf Fotos hochladen" on public.job_photos;


-- =========================================================
-- ROLLBACK
-- =========================================================
-- Rein lesende Aenderung ohne Datenmigration — der Rueckweg besteht
-- darin, die vier Policies in ihrer Fassung aus lib/schema.sql (Stand vor
-- dieser Migration) neu anzulegen, also jeweils den ODER-Zweig
-- "or public.is_assigned_to_job(...)" zu entfernen.
-- Danach sehen Mitarbeiter wieder ausschliesslich die Auftraege, bei
-- denen sie der Legacy-Primaer sind. Es gehen dabei keine Daten
-- verloren; job_assignments bleibt unberuehrt.
--
-- Die beiden in Abschnitt 6 entfernten job_photos-Policies muessen fuer
-- einen Rollback NICHT wiederhergestellt werden: sie sind durch die
-- strengen Policies vollstaendig abgedeckt (Begruendung dort). Wer sie
-- dennoch exakt zurueckholen will, findet ihren Wortlaut in
-- supabase/migrations/20260713000000_remote_baseline.sql, Zeilen 965/971.
