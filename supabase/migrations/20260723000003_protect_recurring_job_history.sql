-- =========================================================
-- MIGRATION: Schutz der Job-Historie beim Löschen von Daueraufträgen
-- Datum: 2026-07-23
-- Zweck: Verhindert, dass das Löschen einer wiederkehrenden Parent-Regel
--        über den ON-DELETE-CASCADE-Pfad bereits gestartete oder
--        abgeschlossene Occurrences (und damit Timesheet-Zeitstempel,
--        Kommentare und Fotos) unwiederbringlich mitlöscht.
-- =========================================================
-- HINTERGRUND (verifiziert am deployten Stand, nicht aus alten Migrationen):
--   - public.jobs.parent_job_id  →  FOREIGN KEY … ON DELETE CASCADE
--   - job_comments.job_id / job_photos.job_id / job_comment_reads.job_id
--     hängen ihrerseits mit ON DELETE CASCADE an jobs(id)
--   - services/jobs/jobs.service.ts deleteJob() setzt ein einfaches
--     DELETE ohne jede Prüfung ab (nur Rollen-Check auf 'admin')
--   → Ein einziger Löschvorgang auf einer Parent-Regel entfernt damit
--     sämtliche Occurrences inklusive der abgeschlossenen. Genau diese
--     Zeilen sind die Datenquelle des Stundenzettels
--     (services/timesheets/timesheet.service.ts: status='completed',
--     job_type='single', started_at/completed_at NOT NULL).
--
-- SCHUTZLOGIK (bewusst minimal gehalten):
--   Ein BEFORE-DELETE-Trigger auf public.jobs bricht den Löschvorgang ab,
--   wenn die zu löschende Zeile eine Parent-Regel ist
--   (job_type = 'recurring' UND parent_job_id IS NULL) und mindestens ein
--   Child mit Status 'in_progress' oder 'completed' existiert.
--
--   Warum BEFORE DELETE ausreicht: PostgreSQL führt die referenzielle
--   Aktion ON DELETE CASCADE als internen AFTER-Trigger auf der
--   referenzierenden Tabelle aus. Ein BEFORE-DELETE-Trigger auf der
--   Parent-Zeile läuft davor — die Exception bricht die Transaktion ab,
--   BEVOR ein einziges Child angefasst wird. Der Test
--   supabase/tests/protect_recurring_job_history.test.sql weist das
--   ausdrücklich nach (Fall 6), statt es nur anzunehmen.
--
-- BEWUSST NICHT TEIL DIESER MIGRATION:
--   - Occurrences werden weder gelöscht, geändert noch neu erzeugt.
--   - Bestehende Foreign Keys bleiben unverändert (kein CASCADE→RESTRICT).
--   - Das Löschen einer Parent-Regel mit ausschließlich offenen
--     Occurrences bleibt vorerst erlaubt (bestehendes Verhalten).
--   - Das Löschen einzelner Occurrences bleibt unverändert erlaubt.
--   - Keine Änderung an Produktionsdaten.
--
-- BEKANNTE NEBENWIRKUNG (beabsichtigt):
--   companies.id → jobs.company_id ist ebenfalls ON DELETE CASCADE. Ein
--   Löschen einer Firma mit geschützter Job-Historie wird daher künftig
--   ebenfalls abgelehnt. Es existiert aktuell kein Anwendungs-Pfad, der
--   Firmen löscht (die Konto-Löschung entfernt nur auth.users; jobs
--   werden dort über ON DELETE SET NULL anonymisiert, nicht gelöscht).
--   Das Verhalten ist gewollt: Historie soll nicht beiläufig verschwinden.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Trigger-Funktion
-- ---------------------------------------------------------
-- SECURITY DEFINER — ausdrücklich begründet:
--   Die Prüfung muss FAIL-CLOSED sein. Als SECURITY INVOKER liefe das
--   EXISTS unter der RLS des löschenden Admins. Sähe dieser (heute oder
--   nach einer künftigen Policy-Änderung) ein geschütztes Child nicht,
--   fände die Prüfung nichts und der Schutz liefe still ins Leere — die
--   Historie wäre wieder ungeschützt. Ein Datenschutz-Guard, der bei
--   eingeschränkter Sichtbarkeit "erlaubt" antwortet, ist wertlos.
--   Als DEFINER ist die Prüfung unabhängig von der Zeilensichtbarkeit
--   des Aufrufers autoritativ.
--
--   Risikoabwägung: Die Funktion nimmt keinerlei Nutzereingabe entgegen
--   (nur OLD.id aus dem Trigger-Kontext), schreibt nichts, gibt nichts
--   zurück außer NULL bzw. wirft, und ist als Trigger-Funktion nicht
--   über PostgREST aufrufbar. search_path ist fest gesetzt, EXECUTE wird
--   unten von anon/authenticated entzogen. Damit entspricht sie exakt
--   dem Muster der bestehenden Trigger-Funktion enforce_active_assignee().
create or replace function public.protect_recurring_job_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  protected_count int;
begin
  -- Nur Parent-Regeln wiederkehrender Aufträge sind hier relevant.
  -- Konkrete Occurrences (parent_job_id IS NOT NULL) und normale
  -- Einzel-Jobs laufen unverändert durch — auch dann, wenn sie selbst
  -- über den CASCADE-Pfad dieser Tabelle gelöscht werden.
  if old.job_type is distinct from 'recurring' or old.parent_job_id is not null then
    return old;
  end if;

  select count(*)
    into protected_count
  from public.jobs c
  where c.parent_job_id = old.id
    and c.status in ('in_progress', 'completed');

  if protected_count > 0 then
    raise exception
      'Dauerauftrag kann nicht gelöscht werden: % bereits gestartete oder abgeschlossene Termine hängen daran.',
      protected_count
      using
        detail =
          'Das Löschen würde diese Termine samt Arbeitszeiten (Stundenzettel), '
          || 'Kommentaren und Fotos unwiederbringlich entfernen.',
        hint =
          'Setze den Dauerauftrag stattdessen auf inaktiv (is_active = false). '
          || 'Zukünftige Termine entfallen damit, die Historie bleibt erhalten.';
  end if;

  return old;
end;
$$;

comment on function public.protect_recurring_job_history() is
'BEFORE-DELETE-Guard auf public.jobs: verhindert das Löschen einer wiederkehrenden '
'Parent-Regel, solange Occurrences mit Status in_progress/completed existieren. '
'Schützt Stundenzettel-Zeitstempel, Kommentare und Fotos vor dem ON-DELETE-CASCADE.';

-- Die Funktion ist ausschließlich als Trigger sinnvoll und soll nicht
-- direkt aufrufbar sein (Defense-in-Depth, analog 20260723000002).
revoke all on function public.protect_recurring_job_history() from public;
revoke all on function public.protect_recurring_job_history() from anon, authenticated;


-- ---------------------------------------------------------
-- 2. Trigger
-- ---------------------------------------------------------
-- Wiederholbar: erst droppen, dann neu anlegen. Damit ist die Migration
-- idempotent und kann gefahrlos erneut ausgeführt werden.
drop trigger if exists trg_jobs_protect_recurring_history on public.jobs;

create trigger trg_jobs_protect_recurring_history
  before delete on public.jobs
  for each row
  execute function public.protect_recurring_job_history();

comment on trigger trg_jobs_protect_recurring_history on public.jobs is
'Blockiert das Löschen wiederkehrender Parent-Regeln mit bereits gestarteten '
'oder abgeschlossenen Occurrences (Historie-/Stundenzettel-Schutz).';
