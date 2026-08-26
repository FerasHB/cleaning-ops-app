-- =========================================================
-- MIGRATION: Schreibzugriff für sekundär Zugewiesene (Kommentare, Fotos)
-- Datum: 2026-08-26   (eigener PR, angekündigt in 20260730000000 und
--                      20260805000000)
-- =========================================================
-- ZWECK
--   Schließt die in CLAUDE.md dokumentierte, bewusste Asymmetrie: seit
--   Phase 5 (20260730000000) darf ein sekundär Zugewiesener (Mitglied der
--   job_assignments-Menge, aber nicht der Legacy-Primär jobs.assigned_to)
--   einen Auftrag, dessen Kommentare und Fotos LESEN — aber nicht
--   kommentieren, kein Foto hochladen und den Ungelesen-Status nicht
--   schreiben (leerer, aber dauerhaft hängender roter Punkt, siehe
--   20260730000000 Abschnitt 5 / Testfall 12b). Diese Migration hebt genau
--   diese fünf Schreibpfade auf die volle Zuweisungsmenge:
--
--     1. public.job_comments        INSERT  ("employee insert comments on own jobs")
--     2. public.job_photos          INSERT  ("employee insert photos on own jobs")
--     3. public.job_comment_reads   INSERT  ("insert own comment-read state")
--     4. public.job_comment_reads   UPDATE  ("update own comment-read state")
--     5. storage.objects            INSERT  ("job-photos insert allowed", Bucket job-photos)
--
--   Alle fünf nutzen ab jetzt exakt dasselbe Muster wie die vier
--   Lese-Policies aus Phase 5 und die Storage-Neufassung aus 20260805000000:
--
--       assigned_to = auth.uid()  OR  public.is_assigned_to_job(<job>)
--
--   also eine echte OBERMENGE des heutigen Verhaltens (kein Mitarbeiter
--   verliert Zugriff). is_assigned_to_job() prüft company_id bereits intern
--   (SECURITY DEFINER, Migration 20260727000000) — keine der fünf Policies
--   verliert dadurch ihre Firmenprüfung.
--
-- =========================================================
-- WAS SICH NICHT ÄNDERT
-- =========================================================
--   * Start/Abschluss (start_own_job/complete_own_job) — bereits seit
--     Phase 7 (20260731000000) auf der vollen Zuweisungsmenge.
--   * Alle Admin-Policies — company-scope unverändert.
--   * Recurring-Parent-Regeln — keine der fünf Policies hängt an
--     jobs.job_type; Kommentare/Fotos/Ungelesen-Status existieren fachlich
--     ohnehin nur an konkreten Terminen (job_type='single'), genau wie vor
--     dieser Migration.
--   * job_comments/job_photos bleiben append-only (weiterhin keine
--     UPDATE/DELETE-Policy).
--   * get_unread_comment_job_ids() — unverändert. Sie fragt bereits nur ab,
--     was ein Nutzer sehen soll (volle Zuweisungsmenge, siehe Phase 5);
--     mit dem jetzt erweiterten Schreibpfad auf job_comment_reads
--     verschwindet die Lücke aus Testfall 12b von selbst, ohne dass die RPC
--     angefasst werden muss.
--
-- =========================================================
-- KLARSTELLUNG ZUR STORAGE-POLICY (Abschnitt 5)
-- =========================================================
--   "job-photos insert allowed" wurde zuletzt in 20260805000000 im
--   Text-Vergleich-Stil (`j.id::text = (storage.foldername(name))[2]`)
--   neu gefasst, um einen 22P02-Absturz bei fremdbenannten Bucket-Objekten
--   zu vermeiden (siehe dortige Begründung). Diese Migration übernimmt
--   exakt diesen Stil und ergänzt NUR den ODER-Zweig — der Textvergleich
--   selbst bleibt unverändert. lib/schema.sql weicht an dieser Stelle
--   weiterhin auf den älteren Cast-Stil ab (vorbestehende, in 20260730000000
--   dokumentierte Storage-Drift) — nicht Gegenstand dieser Migration.
--
-- IDEMPOTENZ
--   Vollständig wiederholbar: alle Policies via DROP IF EXISTS + CREATE.
--
-- ANWENDUNG
--   Wie alle Schemaänderungen hier MANUELL im Supabase SQL Editor
--   ausführen (siehe CLAUDE.md).
-- =========================================================


-- ---------------------------------------------------------
-- 1. public.job_comments — Employee-Insert-Policy
-- ---------------------------------------------------------
drop policy if exists "employee insert comments on own jobs" on public.job_comments;
create policy "employee insert comments on own jobs"
on public.job_comments
for insert
to authenticated
with check (
  public.current_user_role() = 'employee'
  and author_id = auth.uid()
  and company_id = public.current_user_company_id()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_comments.job_id
      and j.company_id = public.current_user_company_id()
      and (
        j.assigned_to = auth.uid()
        or public.is_assigned_to_job(j.id)
      )
  )
);


-- ---------------------------------------------------------
-- 2. public.job_photos — Employee-Insert-Policy
-- ---------------------------------------------------------
drop policy if exists "employee insert photos on own jobs" on public.job_photos;
create policy "employee insert photos on own jobs"
on public.job_photos
for insert
to authenticated
with check (
  public.current_user_role() = 'employee'
  and uploaded_by = auth.uid()
  and company_id = public.current_user_company_id()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_photos.job_id
      and j.company_id = public.current_user_company_id()
      and (
        j.assigned_to = auth.uid()
        or public.is_assigned_to_job(j.id)
      )
  )
);


-- ---------------------------------------------------------
-- 3./4. public.job_comment_reads — Insert/Update
-- ---------------------------------------------------------
drop policy if exists "insert own comment-read state" on public.job_comment_reads;
create policy "insert own comment-read state"
on public.job_comment_reads
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_comment_reads.job_id
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

drop policy if exists "update own comment-read state" on public.job_comment_reads;
create policy "update own comment-read state"
on public.job_comment_reads
for update
to authenticated
using (
  user_id = auth.uid()
)
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.jobs j
    where j.id = job_comment_reads.job_id
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


-- ---------------------------------------------------------
-- 5. storage.objects — Insert-Policy des Buckets job-photos
-- ---------------------------------------------------------
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
          and (
            j.assigned_to = auth.uid()
            or public.is_assigned_to_job(j.id)
          )
        )
      )
  )
);


-- =========================================================
-- ROLLBACK
-- =========================================================
-- Alle fünf Policies in der Fassung von VOR dieser Migration neu anlegen,
-- also jeweils "or public.is_assigned_to_job(...)" wieder entfernen:
--   * job_comments / job_photos / job_comment_reads: Wortlaut siehe
--     lib/schema.sql (Stand vor dieser Migration).
--   * storage.objects "job-photos insert allowed": Wortlaut siehe
--     20260805000000_lock_down_job_photo_storage_and_job_updates.sql,
--     Abschnitt 2 ("HOCHLADEN").
-- Es gehen dabei keine Daten verloren; job_assignments bleibt unberührt.
