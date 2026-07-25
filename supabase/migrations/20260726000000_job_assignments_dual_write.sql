-- =========================================================
-- MIGRATION: Kompatibilitäts-Dual-Write jobs.assigned_to <-> job_assignments
-- Datum: 2026-07-26   (Phase 2 von 11 — reine Datenschicht)
-- =========================================================
-- ZWECK
--   Hält die alte Einzel-Spalte public.jobs.assigned_to und die neue
--   Tabelle public.job_assignments automatisch synchron, damit
--     * ALTE App-Versionen im Feld (die nur assigned_to kennen) weiter
--       korrekt lesen und schreiben können, und
--     * ab Phase 5/6 neuer Code ausschließlich mit job_assignments
--       arbeiten kann — beide gleichzeitig, ohne Datenverlust.
--
--   Diese Migration ist ein TEMPORÄRES Kompatibilitätsgerüst. Sie wird in
--   Phase 11 (Sunset) vollständig entfernt, sobald alte Clients
--   ausgelaufen sind und assigned_to fällt.
--
-- REIN ADDITIV / KEINE DATENÄNDERUNG
--   Die Migration legt NUR Funktionen und Trigger an und ersetzt EINE
--   bestehende Funktion (touch_job_on_assignment_change, Begründung
--   unten). Sie enthält KEINE einzige DML-Anweisung:
--     * kein Backfill (Phase 1 hat bereits 870 Zeilen erzeugt)
--     * keine Zeile wird umgeschrieben
--     * die 6 historischen Guard-Ausnahmen werden NICHT angefasst,
--       NICHT revalidiert und NICHT gelöscht
--     * beim Deploy entsteht KEIN Realtime-Sturm, weil nichts geschrieben
--       wird
--   Sie ist damit gefahrlos VOR jeder App-Änderung anwendbar.
--
-- BEWUSST NICHT TEIL DIESER MIGRATION
--   Keine Änderung an RLS-Policies, an start_own_job/complete_own_job, an
--   generate_job_occurrences/update_job_occurrences, an Benachrichtigungen
--   oder am App-Code. Zuweisungs-MENGEN werden weiterhin NICHT auf
--   Occurrences propagiert (das ist Phase 4) — gespiegelt wird nur der
--   einzelne Legacy-Wert, exakt wie heute.
--
-- =========================================================
-- ARCHITEKTUR-BEFUND (am deployten Stand erhoben, nicht aus Annahmen)
-- =========================================================
-- Schreibende Zugriffe auf jobs.assigned_to — vollständige Liste:
--   1. services/jobs/jobs.service.ts createJob()  -> INSERT jobs
--   2. services/jobs/jobs.service.ts updateJob()  -> UPDATE jobs
--   3. public.generate_job_occurrences()          -> INSERT jobs (Occurrences)
--   4. public.update_job_occurrences()            -> UPDATE jobs (SYNC-Block,
--      MENGENBASIERT über alle zukünftigen offenen Occurrences einer Regel)
--   5. direkte Admin-SQL / Supabase Studio
--   start_own_job/complete_own_job LESEN assigned_to nur in der
--   WHERE-Klausel und schreiben es nie.
--
-- Bestehende Trigger:
--   jobs             BEFORE INS/UPD  enforce_active_assignee_on_jobs
--   jobs             BEFORE UPD      trg_jobs_updated_at (setzt updated_at=now())
--   jobs             BEFORE DEL      trg_jobs_protect_recurring_history
--   job_assignments  BEFORE INS/UPD  enforce_active_assignment_on_job_assignments
--   job_assignments  AFTER INS/UPD/DEL touch_job_on_assignment_change_trg
--
-- Realtime-Publication: nur public.jobs und public.profiles.
--   job_assignments ist NICHT enthalten — deshalb existiert der
--   Touch-Trigger aus Phase 1 überhaupt.
--
-- KRITISCHER BEFUND (Grund für die Flag-Architektur unten):
--   update_job_occurrences() aktualisiert assigned_to MENGENBASIERT über
--   alle zukünftigen offenen Occurrences einer Regel — laut Messung in
--   20260723000004 bis zu 624 Zeilen pro Regel-Edit. Ohne Gegenmaßnahme
--   würde jede dieser Zeilen
--     (a) den Legacy->Assignments-Trigger auslösen,
--     (b) dieser den Touch-Trigger,
--     (c) dieser ein ZWEITES UPDATE auf derselben jobs-Zeile,
--   also die doppelte Schreiblast UND die doppelte Zahl an
--   Realtime-Events. Genau das verhindert das Sync-Flag: während einer
--   Legacy->Assignments-Synchronisierung wird der Touch unterdrückt, weil
--   die jobs-Zeile in diesem Moment ohnehin gerade geschrieben wird und
--   trg_jobs_updated_at updated_at bereits anhebt. Ergebnis: exakt EINE
--   Zeilenversion pro Occurrence — identisch zum heutigen Verhalten.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Schleifenschutz: transaktionslokales Sync-Flag
-- ---------------------------------------------------------
-- Beide Richtungen schreiben in die jeweils andere Tabelle. Ohne Guard
-- ergäbe das eine Endlosschleife.
--
-- Gewählt: ein transaktionslokales GUC (set_config(..., is_local => true)).
--   * Es ist EXPLIZIT und selbstdokumentierend — man sieht im Code, welche
--     Richtung gerade aktiv ist.
--   * Es wird beim COMMIT/ROLLBACK automatisch verworfen; es kann nicht in
--     eine andere Transaktion oder Session auslaufen.
--   * Es wirkt gezielt auf genau die drei Trigger, die es abfragen — im
--     Gegensatz zu ALTER TABLE ... DISABLE TRIGGER, das global wirkt, eine
--     ACCESS EXCLUSIVE Sperre auf der Produktionstabelle nimmt und den
--     Schutz auch für Fremdsessions aushebelt. DISABLE TRIGGER ist hier
--     ausdrücklich NICHT zulässig.
--
-- Verworfene Alternative pg_trigger_depth(): funktioniert zwar (Tiefe > 1
-- bedeutet "verschachtelt"), unterscheidet aber nicht, WELCHE Richtung
-- verschachtelt ist, und würde still kaputtgehen, sobald irgendwann ein
-- weiterer, unbeteiligter Trigger auf jobs oder job_assignments dazukommt.
-- Zusätzlich greift überall IS DISTINCT FROM als zweite, unabhängige
-- Abbruchbedingung — selbst bei einem Flag-Fehler kann keine Endlosschleife
-- entstehen, weil ein Sync, der nichts ändert, keinen weiteren Trigger
-- auslöst.

create or replace function public.compat_assignment_sync_active()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(current_setting('app.jobs_assignment_sync', true), '') = '1';
$$;

comment on function public.compat_assignment_sync_active() is
'TEMPORÄR (Phase 2–11). Liest das transaktionslokale Sync-Flag. true = wir '
'befinden uns bereits innerhalb einer Kompatibilitäts-Synchronisierung; '
'weitere Sync-Trigger müssen dann aussetzen (Schleifen- und Sturmschutz).';

revoke all on function public.compat_assignment_sync_active() from public;
revoke all on function public.compat_assignment_sync_active() from anon, authenticated;


-- ---------------------------------------------------------
-- 2. Primär-Zuweisungs-Regel (Assignments -> Legacy)
-- ---------------------------------------------------------
-- jobs.assigned_to kann nur EINEN Mitarbeiter abbilden. Solange alte
-- Clients existieren, muss dort ein sinnvoller "primärer" Mitarbeiter
-- stehen. Diese Funktion ist die EINZIGE Stelle, die das entscheidet.
--
-- DEFINITIONEN
--   LEBEND ist eine Zuweisung, wenn ALLE gelten:
--     * employee_id IS NOT NULL          (nicht durch Konto-Löschung anonymisiert)
--     * das Profil existiert, is_active = true, role = 'employee'
--     * das Profil gehört zur company_id des Auftrags
--   SAUBER ist eine Zuweisung, wenn sie LEBEND ist UND keinerlei Spuren
--   trägt:
--     * attendance = 'assigned'
--     * review IS NULL
--     * employee_started_at IS NULL
--     * employee_completed_at IS NULL
--   Eine Zuweisung MIT Spuren (gestartet/abgeschlossen/geprüft) ist ein
--   Nachweis — nie "sauber".
--
-- REGEL (in dieser Reihenfolge, erste Übereinstimmung gewinnt)
--   1. Zeigt jobs.assigned_to auf einen Mitarbeiter, für den an diesem
--      Auftrag ÜBERHAUPT eine Zuweisungszeile existiert, bleibt der Zeiger
--      unverändert.
--   2. Sonst: die ÄLTESTE SAUBERE LEBENDE Zuweisung, sortiert nach
--      (assigned_at, id).
--   3. Sonst: NULL.
--
-- ZUM TIEBREAKER (im Test nachgewiesen, nicht angenommen)
--   now() ist transaktionsfix: mehrere in DERSELBEN Transaktion erzeugte
--   Zuweisungen tragen exakt denselben assigned_at. Die Reihenfolge
--   entscheidet dann allein die id — eine zufällige UUID. Die Auswahl ist
--   damit ARBITRÄR, aber DETERMINISTISCH: für einen gegebenen Datenbestand
--   liefert die Funktion immer denselben Mitarbeiter, und die Reihenfolge
--   ändert sich nachträglich nie. Ein besserer Tiebreaker existiert im
--   aktuellen Schema nicht (eine Sequenz-Spalte wäre eine Schemaänderung
--   und würde die Forderung verletzen, dass diese Phase allein durch
--   Löschen von Triggern/Funktionen rückgängig zu machen ist). Fachlich
--   ist die Wahl unter gleichzeitig angelegten, gleichrangigen
--   Zuweisungen ohnehin beliebig.
--
-- WARUM SCHRITT 1 BEWUSST "IRGENDEINE" STATT "LEBENDE" ZUWEISUNG PRÜFT
--   Die ursprüngliche Vorgabe lautete "solange assigned_to auf eine
--   LEBENDE Zuweisung zeigt". Das wurde bewusst zu "irgendeine Zuweisung"
--   erweitert, weil sonst genau die 6 historischen Guard-Ausnahmen in
--   Produktion beschädigt würden: dort zeigt assigned_to auf einen
--   inzwischen DEAKTIVIERTEN Mitarbeiter — nach der engeren Regel wäre
--   dieser Zeiger "nicht lebend" und würde bei der nächsten beliebigen
--   Zuweisungsänderung still auf einen anderen Mitarbeiter oder auf NULL
--   umgebogen. Das wäre exakt die "Reparatur", die ausdrücklich untersagt
--   ist. Die weitere Fassung lässt bestehende Zeiger unangetastet und
--   wählt nur dann neu, wenn gar keine Deckung mehr existiert.
--
-- WARUM SCHRITT 2 NUR SAUBERE ZUWEISUNGEN WÄHLT
--   Nachweis-Zeilen (bewahrte Historie) dürfen NICHT automatisch zum
--   primären Mitarbeiter werden. Ein Mitarbeiter, der gerade arbeitet
--   (attendance='started'), verliert dadurch nichts: für ihn greift
--   bereits Schritt 1, weil assigned_to zu diesem Zeitpunkt noch auf ihn
--   zeigt. Schritt 2 wird ausschließlich für die Wahl eines NEUEN Primärs
--   herangezogen.
--
-- Anonymisierte Zeilen (employee_id IS NULL) werden durch die
-- LEBEND-Bedingung strukturell nie ausgewählt.
--
-- WARUM STABLE UND NICHT VOLATILE (im Review geprüft, nicht angenommen)
--   Die Funktion wird ausschließlich aus
--   compat_sync_legacy_from_assignments() aufgerufen, und zwar NACH dem
--   dortigen "SELECT … FOR UPDATE". Der Aufruf ist eine eigene
--   PL/pgSQL-Anweisung innerhalb einer VOLATILE-Triggerfunktion und
--   erhält damit in READ COMMITTED einen frischen Snapshot — also den
--   Stand NACH dem Commit der blockierenden Transaktion. Als STABLE
--   übernimmt diese Funktion exakt diesen frischen Snapshot ihres
--   Aufrufers. VOLATILE ist deshalb nicht nötig; die Zwei-Sitzungs-
--   Reproduktion aus dem Review ist mit STABLE + FOR UPDATE nachweislich
--   nicht mehr auslösbar (auch in der Variante, in der der korrekte
--   Primär ein anderer Mitarbeiter statt NULL ist).
create or replace function public.compat_primary_assignee(p_job_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_current uuid;
  v_next    uuid;
begin
  select j.assigned_to into v_current
  from public.jobs j
  where j.id = p_job_id;

  -- 1) Bestehenden Zeiger behalten, solange er gedeckt ist.
  if v_current is not null and exists (
    select 1
    from public.job_assignments ja
    where ja.job_id = p_job_id
      and ja.employee_id = v_current
  ) then
    return v_current;
  end if;

  -- 2) Älteste saubere, lebende Zuweisung.
  select ja.employee_id into v_next
  from public.job_assignments ja
  join public.jobs     j on j.id = ja.job_id
  join public.profiles p on p.id = ja.employee_id
  where ja.job_id                = p_job_id
    and ja.employee_id          is not null
    and ja.attendance            = 'assigned'
    and ja.review               is null
    and ja.employee_started_at  is null
    and ja.employee_completed_at is null
    and p.is_active              = true
    and p.role                   = 'employee'
    and p.company_id             = j.company_id
  order by ja.assigned_at, ja.id
  limit 1;

  -- 3) NULL, wenn nichts Geeignetes existiert.
  return v_next;
end;
$$;

comment on function public.compat_primary_assignee(uuid) is
'TEMPORÄR (Phase 2–11). Bestimmt den primären Mitarbeiter für die '
'Legacy-Spalte jobs.assigned_to. 1) bestehenden Zeiger behalten, solange '
'eine Zuweisungszeile ihn deckt (schützt u. a. historische Ausnahmen), '
'2) sonst älteste SAUBERE LEBENDE Zuweisung nach (assigned_at, id), '
'3) sonst NULL. Nachweis-Zeilen werden nie automatisch primär.';

revoke all on function public.compat_primary_assignee(uuid) from public;
revoke all on function public.compat_primary_assignee(uuid) from anon, authenticated;


-- ---------------------------------------------------------
-- 3. Richtung A: jobs.assigned_to  ->  job_assignments
-- ---------------------------------------------------------
-- SECURITY DEFINER — begründet: die Funktion schreibt in
-- public.job_assignments, auf die normale Clients per RLS/Grants
-- KEINEN Zugriff haben (Phase 1: fail-closed, Policies erst in Phase 3).
-- Ein alter Client, der legitim jobs.assigned_to setzt, muss die
-- Spiegelzeile trotzdem erzeugen können. Die Funktion nimmt keine
-- Nutzereingabe außer NEW entgegen, ist als Trigger nicht über PostgREST
-- aufrufbar, hat festen search_path und entzogene EXECUTE-Rechte.
--
-- ZUSAMMENSPIEL MIT enforce_active_assignment():
--   Der Guard auf job_assignments bleibt WIRKSAM — er wird hier bewusst
--   NICHT umgangen. Das ist unkritisch, weil jobs seinen eigenen,
--   inhaltsgleichen Guard hat (enforce_active_assignee: aktiv,
--   role='employee', gleiche Firma) und dieser BEFORE läuft. Jeder Wert,
--   der diesen AFTER-Trigger erreicht, hat die identische Prüfung also
--   bereits bestanden. Ein INSERT in job_assignments kann hier folglich
--   nicht am Guard scheitern.
create or replace function public.compat_sync_assignments_from_legacy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
begin
  -- Wir stecken bereits in der Gegenrichtung -> nichts tun.
  if public.compat_assignment_sync_active() then
    return null;
  end if;

  perform set_config('app.jobs_assignment_sync', '1', true);

  begin
    -- ── Alten Zeiger abräumen — NUR wenn spurenfrei ────────────────
    -- Trägt die Zuweisung irgendeinen Nachweis (gestartet, abgeschlossen,
    -- Zeitstempel oder Manager-Review), bleibt sie als Historie stehen.
    -- Sie ist danach eine "abgekoppelte" Nachweiszeile und wird von
    -- compat_primary_assignee nie automatisch wieder primär.
    if tg_op = 'UPDATE'
       and old.assigned_to is not null
       and old.assigned_to is distinct from new.assigned_to then

      delete from public.job_assignments ja
      where ja.job_id                 = new.id
        and ja.employee_id            = old.assigned_to
        and ja.attendance             = 'assigned'
        and ja.review                is null
        and ja.employee_started_at   is null
        and ja.employee_completed_at is null;
    end if;

    -- ── Neuen Zeiger spiegeln ──────────────────────────────────────
    if new.assigned_to is not null then

      -- Handelnde Person, sofern verlässlich bestimmbar: der
      -- authentifizierte Aufrufer, sonst der Ersteller des Auftrags.
      -- Der Unterabfrage-Join stellt sicher, dass nur eine real
      -- existierende Profil-ID gesetzt wird (assigned_by hat eine FK).
      select p.id into v_actor
      from public.profiles p
      where p.id = coalesce(auth.uid(), new.created_by);

      insert into public.job_assignments (
        job_id, employee_id, employee_name_snapshot,
        assigned_at, assigned_by,
        attendance, employee_started_at, employee_completed_at
      )
      select
        new.id,
        new.assigned_to,
        -- Schnappschuss immer aus dem LEBENDEN Profilnamen, nie leer.
        coalesce(nullif(btrim(p.full_name), ''), 'Unbekannt'),
        now(),
        v_actor,
        -- Anwesenheit aus dem aktuellen Job-Status ableiten, damit ein
        -- laufender oder bereits abgeschlossener Auftrag nicht
        -- fälschlich als "nur zugewiesen" erscheint.
        case new.status
          when 'completed'   then 'completed'
          when 'in_progress' then 'started'
          else                    'assigned'
        end::public.attendance_state,
        -- Audit-Zeitstempel nur übernehmen, wenn sie fachlich passen.
        case when new.status in ('in_progress', 'completed')
             then new.started_at end,
        case when new.status = 'completed'
             then new.completed_at end
      from public.profiles p
      where p.id = new.assigned_to
      -- Idempotenz: existiert die Zuweisung bereits (z. B. weil derselbe
      -- Mitarbeiter erneut geschrieben wurde), bleibt sie unverändert.
      -- Insbesondere werden vorhandene Anwesenheits- und Review-Daten
      -- NICHT überschrieben.
      on conflict (job_id, employee_id) do nothing;
    end if;

    perform set_config('app.jobs_assignment_sync', '', true);

  exception when others then
    -- Flag auch im Fehlerfall zurücksetzen, damit ein von außen
    -- abgefangener Fehler den Rest der Transaktion nicht stumm schaltet.
    perform set_config('app.jobs_assignment_sync', '', true);
    raise;
  end;

  return null;
end;
$$;

comment on function public.compat_sync_assignments_from_legacy() is
'TEMPORÄR (Phase 2–11). Spiegelt Schreibvorgänge alter Clients auf '
'jobs.assigned_to in public.job_assignments. Legt fehlende Zuweisungen an '
'(Anwesenheit aus dem Job-Status abgeleitet) und entfernt den vorherigen '
'Zeiger NUR, wenn dessen Zuweisung spurenfrei ist. Nachweise (Anwesenheit, '
'Zeitstempel, Review) werden nie gelöscht oder überschrieben.';

revoke all on function public.compat_sync_assignments_from_legacy() from public;
revoke all on function public.compat_sync_assignments_from_legacy() from anon, authenticated;

-- Zwei getrennte Trigger statt einem: nur so lässt sich je Ereignis eine
-- passende WHEN-Bedingung setzen (OLD existiert bei INSERT nicht). Die
-- WHEN-Klausel ist der erste und billigste Filter — bei Schreibvorgängen,
-- die assigned_to nicht verändern, läuft die Funktion gar nicht erst an.
drop trigger if exists compat_sync_assignments_from_legacy_ins on public.jobs;
create trigger compat_sync_assignments_from_legacy_ins
  after insert on public.jobs
  for each row
  when (new.assigned_to is not null)
  execute function public.compat_sync_assignments_from_legacy();

drop trigger if exists compat_sync_assignments_from_legacy_upd on public.jobs;
create trigger compat_sync_assignments_from_legacy_upd
  after update of assigned_to on public.jobs
  for each row
  when (new.assigned_to is distinct from old.assigned_to)
  execute function public.compat_sync_assignments_from_legacy();


-- ---------------------------------------------------------
-- 4. Richtung B: job_assignments  ->  jobs.assigned_to
-- ---------------------------------------------------------
-- SECURITY DEFINER — begründet: schreibt public.jobs. Ein Mitarbeiter, der
-- ab Phase 7 nur seine eigene Anwesenheit ändert, hat kein UPDATE-Recht auf
-- der jobs-Zeile; die Legacy-Spalte muss trotzdem konsistent bleiben.
-- Angefasst wird ausschließlich assigned_to des zugehörigen Auftrags.
create or replace function public.compat_sync_legacy_from_assignments()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id  uuid;
  v_primary uuid;
begin
  -- Wir stecken bereits in der Gegenrichtung -> jobs.assigned_to ist dort
  -- die Quelle und darf nicht zurückgeschrieben werden.
  if public.compat_assignment_sync_active() then
    return null;
  end if;

  v_job_id := case when tg_op = 'DELETE' then old.job_id else new.job_id end;

  -- UPDATE ohne Wechsel der Mitarbeiter-Identität kann den Primär nicht
  -- verändern (Regel 1 behält den bestehenden Zeiger). Reine Anwesenheits-
  -- oder Review-Änderungen laufen damit ohne jeden Schreibvorgang durch.
  if tg_op = 'UPDATE' and new.employee_id is not distinct from old.employee_id then
    return null;
  end if;

  -- Wird der Auftrag selbst gerade gelöscht (ON DELETE CASCADE), gibt es
  -- nichts mehr zu aktualisieren. Ohne diese Prüfung liefe pro
  -- kaskadierter Zuweisung ein UPDATE über 0 Zeilen.
  if not exists (select 1 from public.jobs j where j.id = v_job_id) then
    return null;
  end if;

  -- Auftragszeile SPERREN, bevor der Primär bestimmt wird.
  --
  -- Ohne diese Sperre ist die Berechnung ein Read-then-Write ohne
  -- Serialisierung: Löschen zwei Transaktionen gleichzeitig VERSCHIEDENE
  -- Zuweisungen desselben Auftrags, liest die zweite den noch alten
  -- assigned_to-Wert, hält ihn nach Regel 1 für gedeckt und schreibt
  -- nichts — obwohl die erste Transaktion den Zeiger inzwischen auf einen
  -- Mitarbeiter gesetzt hat, dessen Zuweisung die zweite gerade entfernt.
  -- Ergebnis: jobs.assigned_to zeigt auf eine nicht mehr existierende
  -- Zuweisung. Das ist nicht nur kosmetisch — start_own_job/
  -- complete_own_job prüfen ausschließlich assigned_to = auth.uid().
  -- Der Fall wurde im Review mit zwei echten Sitzungen reproduziert.
  --
  -- Das UPDATE weiter unten serialisiert NICHT von allein: greift Regel 1,
  -- ist die WHERE-Bedingung "IS DISTINCT FROM" leer, das UPDATE trifft
  -- null Zeilen und fordert nie eine Sperre an.
  --
  -- Gleiche Sperrdisziplin wie in update_job_occurrences (20260723000004).
  -- In READ COMMITTED wartet die zweite Transaktion hier, liest die
  -- Auftragszeile nach dem Commit der ersten neu (EvalPlanQual) und
  -- berechnet den Primär auf dem dann gültigen Stand.
  perform 1 from public.jobs where id = v_job_id for update;

  v_primary := public.compat_primary_assignee(v_job_id);

  perform set_config('app.jobs_assignment_sync', '1', true);

  begin
    -- IS DISTINCT FROM ist hier die zweite, vom Flag unabhängige
    -- Abbruchbedingung: ändert sich nichts, wird auch nicht geschrieben —
    -- kein Row-Churn, kein zusätzliches Realtime-Event, kein
    -- angehobenes updated_at.
    update public.jobs j
       set assigned_to = v_primary
     where j.id = v_job_id
       and j.assigned_to is distinct from v_primary;

    perform set_config('app.jobs_assignment_sync', '', true);

  exception when others then
    perform set_config('app.jobs_assignment_sync', '', true);
    raise;
  end;

  return null;
end;
$$;

comment on function public.compat_sync_legacy_from_assignments() is
'TEMPORÄR (Phase 2–11). Hält jobs.assigned_to auf dem primären Mitarbeiter '
'gemäß compat_primary_assignee(). Schreibt nur bei echter Änderung '
'(IS DISTINCT FROM) und setzt bei reinen Anwesenheits-/Review-Änderungen '
'gar nicht erst an.';

revoke all on function public.compat_sync_legacy_from_assignments() from public;
revoke all on function public.compat_sync_legacy_from_assignments() from anon, authenticated;

-- UPDATE OF employee_id grenzt bereits auf Katalogebene ein: Änderungen an
-- attendance/review/Zeitstempeln — der Regelfall ab Phase 7/10 — lösen den
-- Trigger überhaupt nicht aus.
drop trigger if exists compat_sync_legacy_from_assignments_trg on public.job_assignments;
create trigger compat_sync_legacy_from_assignments_trg
  after insert or delete or update of employee_id on public.job_assignments
  for each row
  execute function public.compat_sync_legacy_from_assignments();


-- ---------------------------------------------------------
-- 5. Touch-Trigger aus Phase 1 an den Dual-Write anpassen
-- ---------------------------------------------------------
-- ERSETZT public.touch_job_on_assignment_change() aus Migration
-- 20260725000000. Einzige Änderung: ein vorangestellter Flag-Check.
--
-- Warum das nötig ist: läuft die Synchronisierung von jobs nach
-- job_assignments, wird die jobs-Zeile in genau diesem Moment ohnehin
-- geschrieben; trg_jobs_updated_at hebt updated_at bereits an und das
-- Realtime-Event ist damit schon unterwegs. Ein zusätzliches UPDATE aus
-- dem Touch-Trigger wäre reine Verdopplung — bei einem Regel-Edit über
-- update_job_occurrences mit bis zu 624 betroffenen Occurrences also 624
-- überflüssige Zeilenversionen und 624 überflüssige Realtime-Events.
--
-- In der Gegenrichtung (direkter Schreibzugriff auf job_assignments, ab
-- Phase 6) bleibt der Touch unverändert aktiv und notwendig, weil
-- job_assignments nicht Teil der supabase_realtime-Publication ist.
--
-- BEKANNTE, BEWUSST AKZEPTIERTE RESTKOSTEN: Ändert ein direkter
-- Zuweisungs-Schreibvorgang zugleich den primären Mitarbeiter, schreiben
-- Richtung B (assigned_to) und der Touch (updated_at) nacheinander je
-- einmal auf dieselbe jobs-Zeile — zwei Zeilenversionen statt einer. Das
-- betrifft nur einzelne, nutzerausgelöste Aktionen (nie Mengenoperationen)
-- und wird in Phase 6 zusammengeführt, wenn der Schreibpfad ohnehin neu
-- gebaut wird.
create or replace function public.touch_job_on_assignment_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Phase 2: während einer Legacy->Assignments-Synchronisierung wird die
  -- jobs-Zeile bereits geschrieben -> kein zweites UPDATE.
  if public.compat_assignment_sync_active() then
    return null;
  end if;

  if tg_op = 'DELETE' then
    update public.jobs set updated_at = now() where id = old.job_id;
    return null;
  end if;

  update public.jobs set updated_at = now() where id = new.job_id;

  -- Wechselt eine Zuweisung den Auftrag, müssen BEIDE Seiten neu laden.
  if tg_op = 'UPDATE' and new.job_id is distinct from old.job_id then
    update public.jobs set updated_at = now() where id = old.job_id;
  end if;

  return null;
end;
$$;

comment on function public.touch_job_on_assignment_change() is
'AFTER INSERT/UPDATE/DELETE auf job_assignments: hebt jobs.updated_at des '
'betroffenen Auftrags an. Notwendig, weil nur public.jobs Teil der '
'supabase_realtime-Publication ist. Setzt während einer '
'Kompatibilitäts-Synchronisierung (Phase 2) aus, weil die jobs-Zeile dann '
'ohnehin geschrieben wird.';

revoke all on function public.touch_job_on_assignment_change() from public;
revoke all on function public.touch_job_on_assignment_change() from anon, authenticated;


-- =========================================================
-- WIEDERKEHRENDE AUFTRÄGE — erwartetes Verhalten und Risiken
-- =========================================================
-- Die Kompatibilitäts-Trigger unterscheiden NICHT zwischen den drei
-- Zeilenarten in public.jobs. Sie feuern damit auf:
--
--   1. PARENT-REGELN (job_type='recurring', parent_job_id IS NULL)
--      Setzt ein Admin assigned_to auf einer Regel, entsteht eine
--      Zuweisungszeile AN DER REGEL. Das ist beabsichtigt und entspricht
--      dem Zielmodell: die Regel trägt die VORLAGE der Zuweisung, die
--      Occurrence die tatsächliche. Regeln werden nie ausgeführt, ihre
--      Anwesenheit bleibt daher dauerhaft 'assigned'. Da eine Regel-Zeile
--      nie status='in_progress'/'completed' annimmt, kann die
--      Statusableitung hier nichts Falsches erzeugen.
--
--   2. OCCURRENCES (job_type='single', parent_job_id IS NOT NULL)
--      generate_job_occurrences() fügt Occurrences MIT assigned_to ein ->
--      Richtung A legt je Occurrence eine Zuweisung an. Das spiegelt
--      exakt den Legacy-Wert, den die Funktion ohnehin schon setzt.
--      Es wird KEINE Zuweisungs-MENGE propagiert — Mehrfachzuweisung auf
--      Occurrences ist Phase 4.
--
--   3. SYNC-BLOCK von update_job_occurrences()
--      Mengenbasiertes UPDATE von assigned_to über alle zukünftigen
--      offenen Occurrences. Richtung A feuert je betroffener Zeile:
--        * wechselt der Mitarbeiter, wird die alte Zuweisung entfernt,
--          sofern spurenfrei — was auf zukünftigen, offenen, noch nicht
--          gestarteten Occurrences per Definition zutrifft;
--        * wird effective_assigned_to zu NULL (Mitarbeiter inzwischen
--          deaktiviert), wird die saubere Zuweisung entfernt, die Regel-
--          Vorlage bleibt davon unberührt.
--      Occurrences mit Historie fasst der SYNC-Block ohnehin nicht an
--      (status='open' AND started_at IS NULL AND completed_at IS NULL),
--      es kann dort also gar kein Nachweis verloren gehen.
--
--   4. PRUNE-BLOCK von update_job_occurrences() und Regel-Löschung
--      Gelöschte Occurrence-Zeilen nehmen ihre Zuweisungen per
--      ON DELETE CASCADE mit. Richtung B erkennt über die
--      Existenzprüfung, dass der Auftrag verschwunden ist, und schreibt
--      nichts.
--
-- RISIKEN (bewusst offen, gehören zu Phase 4)
--   * Zuweisungs-MENGEN werden noch nicht auf Occurrences propagiert.
--     Weist ab Phase 6 jemand einer Regel drei Mitarbeiter zu, erhalten
--     neue Occurrences weiterhin nur den primären Mitarbeiter aus
--     assigned_to. Das ist erwartet und nicht schädlich — es ist exakt
--     das heutige Verhalten.
--   * Ein Regel-Edit erzeugt weiterhin bis zu 624 Zeilen-Updates; durch
--     die Touch-Unterdrückung entsteht daraus KEINE zusätzliche Last
--     gegenüber heute.
-- =========================================================


-- =========================================================
-- ROLLBACK (vollständig, nicht destruktiv)
-- =========================================================
-- REIHENFOLGE IST ZWINGEND: touch_job_on_assignment_change() ruft
-- compat_assignment_sync_active() auf. Wird die Hilfsfunktion zuerst
-- entfernt, scheitert JEDER Schreibvorgang auf job_assignments mit
-- SQLSTATE 42883, bis der Phase-1-Rumpf wiederhergestellt ist. In diesem
-- Repository werden Schemaänderungen manuell und Anweisung für Anweisung
-- im Supabase SQL Editor ausgeführt (siehe CLAUDE.md) — dieses Fenster
-- wäre also real und für laufenden Traffic sichtbar. Deshalb ZUERST den
-- Trigger-Rumpf zurücksetzen, DANN die Kompatibilitätsobjekte abbauen.
--
--   -- 1) touch_job_on_assignment_change() auf den Phase-1-Stand
--   --    zurücksetzen (Migration 20260725000000, Abschnitt 7):
--   --    identischer Rumpf OHNE den vorangestellten Flag-Check.
--   create or replace function public.touch_job_on_assignment_change()
--   returns trigger language plpgsql security definer
--   set search_path = public, pg_temp
--   as $body$
--   begin
--     if tg_op = 'DELETE' then
--       update public.jobs set updated_at = now() where id = old.job_id;
--       return null;
--     end if;
--     update public.jobs set updated_at = now() where id = new.job_id;
--     if tg_op = 'UPDATE' and new.job_id is distinct from old.job_id then
--       update public.jobs set updated_at = now() where id = old.job_id;
--     end if;
--     return null;
--   end;
--   $body$;
--
--   -- 2) erst danach die Kompatibilitätsschicht abbauen:
--   drop trigger if exists compat_sync_assignments_from_legacy_ins on public.jobs;
--   drop trigger if exists compat_sync_assignments_from_legacy_upd on public.jobs;
--   drop trigger if exists compat_sync_legacy_from_assignments_trg on public.job_assignments;
--   drop function if exists public.compat_sync_assignments_from_legacy();
--   drop function if exists public.compat_sync_legacy_from_assignments();
--   drop function if exists public.compat_primary_assignee(uuid);
--   drop function if exists public.compat_assignment_sync_active();
--
-- Es gehen dabei KEINE Daten verloren: die Kompatibilitätsschicht besitzt
-- keine eigenen Daten. jobs.assigned_to und job_assignments behalten
-- exakt den zuletzt synchronisierten Stand, und jobs.assigned_to bleibt
-- für alte Clients weiterhin die maßgebliche Quelle.
-- =========================================================
