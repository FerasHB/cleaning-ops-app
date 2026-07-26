-- =========================================================
-- MIGRATION: Legacy-Schreibvorgang ersetzt die ZUWEISUNGSMENGE
-- Datum: 2026-07-29   (Nachtrag zur Kompatibilitaetsschicht, Phase 2)
-- =========================================================
-- ZWECK
--   Behebt den im Review zu PR #52 und PR #53 festgehaltenen
--   "Mischmengen"-Befund: schreibt ein ALTER Client jobs.assigned_to auf
--   einem mehrfach zugewiesenen Auftrag, entsteht eine Mischmenge statt
--   der beabsichtigten Einzelzuweisung.
--
-- =========================================================
-- BEFUND: EXAKTE URSACHE (reproduziert, nicht vermutet)
-- =========================================================
-- Ausgangslage: neuer Client setzt per set_job_assignments die Menge
-- {A, B}. Phase 2 Richtung B bestimmt daraus den Legacy-Primaer; welcher
-- der beiden das wird, entscheidet bei gleichem assigned_at der
-- zufaellige id-Tiebreaker. Danach setzt ein ALTER Client (updateJob)
-- jobs.assigned_to = C, meint damit "der Auftrag gehoert jetzt C".
--
-- Beobachtetes Ergebnis ueber 5 Laeufe:
--   {A,C} / {A,C} / {A,C} / {B,C} / {A,C}
--
-- Ursache: das DELETE in compat_sync_assignments_from_legacy (Richtung A)
-- ist auf GENAU EINEN Mitarbeiter eingeschraenkt:
--
--     and ja.employee_id = old.assigned_to
--
-- Ein Legacy-Schreibvorgang wird damit als "tausche den einen primaeren
-- Mitarbeiter aus" interpretiert. Das war exakt richtig, solange die
-- Legacy-Spalte die EINZIGE Darstellung der Zuweisung war — dort ist ein
-- Mitarbeiter gleichbedeutend mit der ganzen Menge. Sobald Mehrfach-
-- zuweisungen existieren, ist es falsch: entfernt wird nur der zufaellig
-- zum Primaer bestimmte Mitarbeiter, alle uebrigen bleiben unbemerkt am
-- Auftrag und behalten Zugriff.
--
-- Der alte Client hat keine Moeglichkeit, eine Menge auszudruecken. Sein
-- Schreibvorgang kann nur EINE Bedeutung haben: "ab jetzt ist genau
-- dieser eine Mitarbeiter zustaendig". Genau das setzt diese Migration um.
--
-- =========================================================
-- DIE AENDERUNG
-- =========================================================
-- Das DELETE verliert die Einschraenkung auf old.assigned_to und entfernt
-- stattdessen ALLE spurenfreien Zuweisungen, die nicht dem neuen Wert
-- entsprechen. Ein Legacy-Schreibvorgang bedeutet damit "Menge ersetzen"
-- statt "einen Mitarbeiter tauschen".
--
-- UNVERAENDERT und weiterhin tragend:
--   * Die WHEN-Klausel der Trigger bleibt wie sie ist. Der Trigger feuert
--     ausschliesslich, wenn sich assigned_to TATSAECHLICH aendert
--     (IS DISTINCT FROM). Ein alter Client, der bei jedem updateJob den
--     UNVERAENDERTEN Wert mitsendet — der Regelfall — loest weiterhin
--     ueberhaupt nichts aus. Ohne diese Eigenschaft wuerde die Aenderung
--     hier zur Katastrophe: jede beliebige Feldaenderung eines alten
--     Clients wuerde die Mehrfachzuweisung platt machen. Der bestehende
--     Test "Old-client no-op" sichert das ab.
--   * Der Spurenfrei-Guard bleibt vollstaendig erhalten: Anwesenheit,
--     Review und Zeitstempel schuetzen eine Zeile weiterhin vor dem
--     Loeschen. Ein alter Client kann keinen Nachweis vernichten.
--   * Anonymisierte Zeilen (employee_id IS NULL, Konto geloescht) werden
--     durch die zusaetzliche Bedingung employee_id IS NOT NULL explizit
--     geschuetzt.
--   * Der neue Mitarbeiter selbst wird nie geloescht-und-neu-angelegt
--     (employee_id IS DISTINCT FROM new.assigned_to) — das bewahrt sein
--     assigned_at/assigned_by und vermeidet unnoetigen Row-Churn.
--
-- =========================================================
-- BEWUSST NICHT TEIL DIESER MIGRATION
-- =========================================================
--   * KEINE Aenderung an Phase 4: ein Legacy-Schreibvorgang markiert
--     einen Termin weiterhin NICHT als individuell angepasst. Die
--     Anpassung eines Termins durch einen ALTEN Client bleibt damit — wie
--     bisher — nicht dauerhaft und wird von der naechsten
--     Regel-Synchronisierung wieder eingeebnet. Das ist exakt das heutige
--     Verhalten; alten Clients hier neue Faehigkeiten zu geben waere eine
--     Funktionserweiterung, keine Fehlerbehebung.
--   * KEINE Aenderung an Richtung B, an der Primaer-Regel, an RLS, an
--     Grants, an den Recurring-RPCs oder an public.jobs.
--   * Keine Datenaenderung, kein Backfill.
--
-- ANWENDUNG: manuell im Supabase SQL Editor (siehe CLAUDE.md).
-- Diese Migration wurde NICHT auf Produktion angewandt.
-- =========================================================

create or replace function public.compat_sync_assignments_from_legacy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor           uuid;
  v_anonymisierung  boolean;
begin
  -- Wir stecken bereits in der Gegenrichtung -> nichts tun.
  if public.compat_assignment_sync_active() then
    return null;
  end if;

  perform set_config('app.jobs_assignment_sync', '1', true);

  begin
    -- ── Menge auf den neuen Legacy-Wert reduzieren ─────────────────
    -- Ein alter Client kann keine Menge ausdruecken; sein Schreibvorgang
    -- bedeutet "ab jetzt genau dieser eine Mitarbeiter". Deshalb werden
    -- ALLE spurenfreien Zuweisungen entfernt, die nicht dem neuen Wert
    -- entsprechen — nicht mehr nur die des bisherigen Primaers.
    --
    -- Geschuetzt bleiben: Anwesenheit, Review, Zeitstempel (Nachweise)
    -- sowie anonymisierte Zeilen aus Konto-Loeschungen.
    --
    -- Ausgeloest wird das nur bei einer ECHTEN Aenderung von assigned_to
    -- (WHEN-Klausel der Trigger) — ein unveraendert mitgesendeter Wert
    -- laesst die Mehrfachzuweisung unangetastet.
    -- AUSNAHME: der Anonymisierungspfad einer Konto-Loeschung.
    -- Wird ein Profil geloescht, setzt der Fremdschluessel
    -- jobs_assigned_to_fkey (ON DELETE SET NULL) assigned_to auf NULL.
    -- Auf Trigger-Ebene sieht das exakt aus wie ein alter Client, der den
    -- Auftrag bewusst niemandem mehr zuweist — ist es aber nicht. Ohne
    -- diese Unterscheidung wuerde eine Konto-Loeschung die Zuweisungen
    -- ALLER UEBRIGEN, voellig unbeteiligten Mitarbeiter dieses Auftrags
    -- mit entfernen (im Bestandstest "Konto-Loeschung: Snapshot bleibt,
    -- anderer Primaer wird gewaehlt" nachgewiesen).
    --
    -- Erkennbar ist der Pfad daran, dass das bisherige Ziel gar nicht mehr
    -- existiert: nur der Fremdschluessel kann assigned_to auf NULL setzen,
    -- waehrend das zugehoerige Profil bereits verschwunden ist. In diesem
    -- Fall bleibt job_assignments unangetastet — die Zeile des geloeschten
    -- Kontos anonymisiert der zweite Fremdschluessel, und Richtung B
    -- bestimmt daraufhin den naechsten gueltigen Primaer.
    v_anonymisierung :=
      tg_op = 'UPDATE'
      and new.assigned_to is null
      and old.assigned_to is not null
      and not exists (select 1 from public.profiles p where p.id = old.assigned_to);

    if tg_op = 'UPDATE' and not v_anonymisierung then
      delete from public.job_assignments ja
      where ja.job_id                 = new.id
        and ja.employee_id           is not null
        and ja.employee_id           is distinct from new.assigned_to
        and ja.attendance             = 'assigned'
        and ja.review                is null
        and ja.employee_started_at   is null
        and ja.employee_completed_at is null;
    end if;

    -- ── Neuen Zeiger spiegeln ──────────────────────────────────────
    if new.assigned_to is not null then

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
        coalesce(nullif(btrim(p.full_name), ''), 'Unbekannt'),
        now(),
        v_actor,
        case new.status
          when 'completed'   then 'completed'
          when 'in_progress' then 'started'
          else                    'assigned'
        end::public.attendance_state,
        case when new.status in ('in_progress', 'completed')
             then new.started_at end,
        case when new.status = 'completed'
             then new.completed_at end
      from public.profiles p
      where p.id = new.assigned_to
      on conflict (job_id, employee_id) do nothing;
    end if;

    perform set_config('app.jobs_assignment_sync', '', true);

  exception when others then
    perform set_config('app.jobs_assignment_sync', '', true);
    raise;
  end;

  return null;
end;
$$;

comment on function public.compat_sync_assignments_from_legacy() is
'TEMPORAER (Phase 2-11). Spiegelt Schreibvorgaenge alter Clients auf '
'jobs.assigned_to in public.job_assignments. Ein Legacy-Schreibvorgang '
'bedeutet MENGE ERSETZEN: alle spurenfreien Zuweisungen ausser dem neuen '
'Wert werden entfernt, weil ein alter Client keine Menge ausdruecken kann. '
'Nachweise (Anwesenheit, Review, Zeitstempel) und anonymisierte Zeilen '
'bleiben unangetastet. Feuert nur bei echter Aenderung von assigned_to.';

revoke all on function public.compat_sync_assignments_from_legacy() from public;
revoke all on function public.compat_sync_assignments_from_legacy() from anon, authenticated;


-- =========================================================
-- ROLLBACK
-- =========================================================
-- compat_sync_assignments_from_legacy() auf den Stand der Migration
-- 20260726000000 zuruecksetzen — identischer Rumpf, im DELETE jedoch
-- wieder auf den bisherigen Primaer eingeschraenkt:
--
--     and ja.employee_id = old.assigned_to
--
-- statt der drei Bedingungen (IS NOT NULL / IS DISTINCT FROM
-- new.assigned_to / kein alter tg_op-Guard). Die Trigger selbst bleiben
-- unveraendert und muessen NICHT neu angelegt werden.
--
-- Es gehen dabei keine Daten verloren; nach dem Rueckbau entstehen bei
-- Legacy-Schreibvorgaengen auf mehrfach zugewiesenen Auftraegen wieder
-- die oben beschriebenen Mischmengen.
-- =========================================================
