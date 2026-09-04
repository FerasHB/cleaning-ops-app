-- =========================================================
-- TEST: Ungelesen-Kennzeichnung für sekundär Zugewiesene
-- (RPC public.get_unread_comment_job_ids)
-- =========================================================
-- HINTERGRUND
--   Seit 20260730000000 (Phase 5) darf ein sekundär Zugewiesener — Mitglied
--   der job_assignments-Menge, aber NICHT der Legacy-Zeiger jobs.assigned_to —
--   Auftrag und Kommentare LESEN. Seit 20260826000001 darf er zusätzlich
--   kommentieren, Fotos hochladen und seinen eigenen Ungelesen-Status auf
--   public.job_comment_reads SCHREIBEN.
--
--   Die RPC get_unread_comment_job_ids() blieb in beiden Migrationen
--   unverändert am Legacy-Zeiger hängen. In 20260730000000 war das die
--   bewusst gewählte kleinere Lösung (der Schreibpfad auf job_comment_reads
--   verlangte damals noch den Primär — hätte man nur die RPC erweitert, wäre
--   ein dauerhaft hängender roter Punkt entstanden, 42501 beim Markieren).
--   Der Kopfkommentar von 20260826000001 begründet das Nicht-Anfassen dann
--   allerdings mit "sie fragt bereits die volle Zuweisungsmenge ab (siehe
--   Phase 5)" — das trifft nachweislich nicht zu, Phase 5 hat sie explizit
--   ausgenommen. Damit blieb der letzte Baustein liegen, obwohl seine
--   Vorbedingung (Schreibrecht auf job_comment_reads) erfüllt ist.
--
-- WAS DIESER TEST FESTSCHREIBT
--   Die RPC folgt derselben Zuweisungsmenge wie die vier Lese- und die fünf
--   Schreib-Policies: assigned_to = auth.uid() ODER is_assigned_to_job(job).
--   Firmen-Scope, Rollen-Scope, Autor-Ausschluss, Inaktiv-Schutz und die
--   PRO-BENUTZER-Unabhängigkeit des Read-States bleiben unverändert.
--
-- Matrix je Fall:
--   A. PRIMÄR zugewiesen (Legacy-Zeiger)      -> Ungelesen-Meldung
--   B. SEKUNDÄR zugewiesen (job_assignments)  -> Ungelesen-Meldung (DIE LÜCKE)
--   C. gleiche Firma, NICHT zugewiesen        -> keine Meldung
--   D. andere Firma                           -> keine Meldung
--   E. Admin, gleiche Firma                   -> Meldung
--   F. Admin, andere Firma                    -> keine Meldung
--   G. LEGACY (nur assigned_to, keine job_assignments-Zeile) -> Meldung
--
-- DETERMINISMUS: alle Zeitpunkte sind FESTE Literale. `now()` steht innerhalb
--   einer Transaktion still — "markiert gelesen, danach neuer Kommentar" wäre
--   damit nicht darstellbar. Zeitachse:
--     T1 = 2026-01-01 10:00Z  erster Kommentar
--     T2 = 2026-01-01 11:00Z  gelesen-markiert
--     T3 = 2026-01-01 12:00Z  zweiter Kommentar
--
-- Alle Zugriffe laufen als echte Rollen (SET ROLE + request.jwt.claims), also
-- über denselben Pfad wie die App über PostgREST.
--
-- Läuft transaktional (BEGIN … ROLLBACK): keine Rückstände, keine
-- Produktionsdaten. Ausführen lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/secondary_assignee_unread_comments.test.sql
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = 95…1 | Firma B = 95…2
-- Admin A   = 96…1
-- PRIMÄR    = 96…2  (jobs.assigned_to von J1 + job_assignments-Zeile)
-- SEKUNDÄR  = 96…3  (NUR job_assignments-Zeile auf J1)
-- FREMD A   = 96…4  (Firma A, J1 nicht zugewiesen)
-- Admin B   = 96…5 | Employee B = 96…6 (andere Firma)
-- LEGACY    = 96…7  (nur jobs.assigned_to auf J2, KEINE job_assignments-Zeile)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','96000000-0000-0000-0000-000000000001','authenticated','authenticated','u-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','96000000-0000-0000-0000-000000000002','authenticated','authenticated','u-primaer@example.test','{"full_name":"Paula Primaer"}'),
    ('00000000-0000-0000-0000-000000000000','96000000-0000-0000-0000-000000000003','authenticated','authenticated','u-sekundaer@example.test','{"full_name":"Simon Sekundaer"}'),
    ('00000000-0000-0000-0000-000000000000','96000000-0000-0000-0000-000000000004','authenticated','authenticated','u-fremd@example.test','{"full_name":"Frida Fremd"}'),
    ('00000000-0000-0000-0000-000000000000','96000000-0000-0000-0000-000000000005','authenticated','authenticated','u-adminB@example.test','{"full_name":"Admin B"}'),
    ('00000000-0000-0000-0000-000000000000','96000000-0000-0000-0000-000000000006','authenticated','authenticated','u-b1@example.test','{"full_name":"Bea Fremdfirma"}'),
    ('00000000-0000-0000-0000-000000000000','96000000-0000-0000-0000-000000000007','authenticated','authenticated','u-legacy@example.test','{"full_name":"Lena Legacy"}');
end $$;

-- Der auth-Trigger handle_new_user ist in der lokalen Baseline nicht
-- enthalten — Profile werden deshalb explizit angelegt.
insert into public.profiles (id, full_name) values
  ('96000000-0000-0000-0000-000000000001','Admin A'),
  ('96000000-0000-0000-0000-000000000002','Paula Primaer'),
  ('96000000-0000-0000-0000-000000000003','Simon Sekundaer'),
  ('96000000-0000-0000-0000-000000000004','Frida Fremd'),
  ('96000000-0000-0000-0000-000000000005','Admin B'),
  ('96000000-0000-0000-0000-000000000006','Bea Fremdfirma'),
  ('96000000-0000-0000-0000-000000000007','Lena Legacy')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('95000000-0000-0000-0000-000000000001','Ungelesen Firma A','ungelesen-firma-a-test'),
  ('95000000-0000-0000-0000-000000000002','Ungelesen Firma B','ungelesen-firma-b-test');

update public.profiles set company_id='95000000-0000-0000-0000-000000000001', role='admin',    is_active=true where id='96000000-0000-0000-0000-000000000001';
update public.profiles set company_id='95000000-0000-0000-0000-000000000001', role='employee', is_active=true where id in
  ('96000000-0000-0000-0000-000000000002','96000000-0000-0000-0000-000000000003','96000000-0000-0000-0000-000000000004','96000000-0000-0000-0000-000000000007');
update public.profiles set company_id='95000000-0000-0000-0000-000000000002', role='admin',    is_active=true where id='96000000-0000-0000-0000-000000000005';
update public.profiles set company_id='95000000-0000-0000-0000-000000000002', role='employee', is_active=true where id='96000000-0000-0000-0000-000000000006';

-- Aufträge:
--   J1 = Firma A, single, {PRIMÄR, SEKUNDÄR} über job_assignments
--   J2 = Firma A, single, NUR jobs.assigned_to = LEGACY (keine job_assignments-Zeile)
--   J3 = Firma A, single, {PRIMÄR, SEKUNDÄR} — für den Autor-Ausschluss
insert into public.jobs (id, company_id, assigned_to, created_by, customer_name, service_name,
                         location_address, status, job_type, date, start_time, recurring_days,
                         is_active, created_at, updated_at) values
  ('97000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000001',null,'96000000-0000-0000-0000-000000000001','K1','S1','O1','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00'),
  ('97000000-0000-0000-0000-000000000002','95000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000007','96000000-0000-0000-0000-000000000001','K2','S2','O2','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00'),
  ('97000000-0000-0000-0000-000000000003','95000000-0000-0000-0000-000000000001',null,'96000000-0000-0000-0000-000000000001','K3','S3','O3','open','single',current_date,'08:00',null,true,timestamptz '2020-01-01 10:00+00',timestamptz '2020-01-01 10:00+00');

-- J2 zu einer ECHTEN Bestandszeile machen: der Dual-Write-Trigger
-- compat_sync_assignments_from_legacy_ins (20260726000000) legt beim INSERT
-- automatisch eine job_assignments-Zeile an. Genau die muss hier wieder weg,
-- sonst prüft CASE 7 den Legacy-Zweig gar nicht, sondern erneut den
-- Zuweisungs-Zweig. (Der Phase-1-Backfill hat solche Zeilen bewusst erhalten;
-- sie sind der Grund, warum der Legacy-Zweig überhaupt noch existiert.)
--
-- Das Löschen allein genügt NICHT: compat_sync_legacy_from_assignments_trg
-- schreibt die Rückrichtung und würde jobs.assigned_to dabei auf NULL setzen —
-- übrig bliebe ein komplett unzugewiesener Auftrag statt einer Legacy-Zeile.
-- session_replication_role='replica' legt die Kompatibilitäts-Trigger für
-- genau diesen Fixture-Schritt still (transaktional, per SET LOCAL).
set local session_replication_role = replica;
delete from public.job_assignments where job_id='97000000-0000-0000-0000-000000000002';
update public.jobs set assigned_to='96000000-0000-0000-0000-000000000007'
  where id='97000000-0000-0000-0000-000000000002';
set local session_replication_role = origin;

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;

-- Ruft die RPC als <uid> auf und zählt, WIE OFT <job> zurückkommt.
-- Die Trefferzahl (statt eines booleschen Werts) deckt gleichzeitig den
-- Duplikat-Fall ab: ein Nutzer, der über BEIDE Zweige der Oder-Verknüpfung
-- passt (Legacy-Zeiger UND job_assignments), darf die Job-ID trotzdem nur
-- einmal erhalten.
create or replace function pg_temp.unread(uid uuid, job uuid) returns text language plpgsql as $f$
declare n int;
begin
  perform pg_temp.act_as(uid);
  execute 'set local role authenticated';
  select count(*) into n from public.get_unread_comment_job_ids() g where g = job;
  execute 'reset role';
  return 'treffer='||n::text;
end $f$;

-- Markiert als gelesen — als ECHTER Nutzer über die RLS-geschützte Tabelle,
-- nicht als postgres. Ein RLS-Verstoß wird als ABGELEHNT(<sqlstate>)
-- zurückgegeben statt den Test abzubrechen.
create or replace function pg_temp.mark_read(uid uuid, job uuid, gesehen timestamptz)
returns text language plpgsql as $f$
begin
  perform pg_temp.act_as(uid);
  execute 'set local role authenticated';
  begin
    insert into public.job_comment_reads (job_id, user_id, last_seen_at)
    values (job, uid, gesehen)
    on conflict (job_id, user_id) do update set last_seen_at = excluded.last_seen_at;
    execute 'reset role';
    return 'ERLAUBT';
  exception when others then
    execute 'reset role';
    return 'ABGELEHNT('||sqlstate||')';
  end;
end $f$;

-- ── Zuweisungen herstellen ──
-- PRIMÄR zuerst allein (setzt den Legacy-Zeiger), dann SEKUNDÄR ergänzen
-- (der Zeiger bleibt auf PRIMÄR stehen, siehe compat_primary_assignee).
do $$
begin
  perform pg_temp.act_as('96000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  perform public.set_job_assignments('97000000-0000-0000-0000-000000000001',
    array['96000000-0000-0000-0000-000000000002']::uuid[]);
  perform public.set_job_assignments('97000000-0000-0000-0000-000000000001',
    array['96000000-0000-0000-0000-000000000002','96000000-0000-0000-0000-000000000003']::uuid[]);
  perform public.set_job_assignments('97000000-0000-0000-0000-000000000003',
    array['96000000-0000-0000-0000-000000000002']::uuid[]);
  perform public.set_job_assignments('97000000-0000-0000-0000-000000000003',
    array['96000000-0000-0000-0000-000000000002','96000000-0000-0000-0000-000000000003']::uuid[]);
  execute 'reset role';
end $$;

-- Sanity: Ausgangslage wie angenommen.
do $$
declare v text;
begin
  select assigned_to::text into v from public.jobs where id='97000000-0000-0000-0000-000000000001';
  if v <> '96000000-0000-0000-0000-000000000002' then
    raise exception 'FIXTURE KAPUTT: Legacy-Primaer von J1 ist % statt PRIMAER', v;
  end if;
  if (select count(*) from public.job_assignments where job_id='97000000-0000-0000-0000-000000000001') <> 2 then
    raise exception 'FIXTURE KAPUTT: J1 hat nicht genau 2 Zuweisungen';
  end if;
  if exists (select 1 from public.job_assignments where job_id='97000000-0000-0000-0000-000000000002') then
    raise exception 'FIXTURE KAPUTT: J2 darf KEINE job_assignments-Zeile haben';
  end if;
  -- Bewusst auf die Fixture-Aufträge eingegrenzt: der Test läuft auch gegen
  -- befüllte Umgebungen (Staging), in denen fremde Read-States existieren.
  if (select count(*) from public.job_comment_reads
      where job_id in ('97000000-0000-0000-0000-000000000001',
                       '97000000-0000-0000-0000-000000000002',
                       '97000000-0000-0000-0000-000000000003')) <> 0 then
    raise exception 'FIXTURE KAPUTT: es darf noch kein Read-State existieren';
  end if;
  if (select assigned_to::text from public.jobs where id='97000000-0000-0000-0000-000000000002')
     <> '96000000-0000-0000-0000-000000000007' then
    raise exception 'FIXTURE KAPUTT: J2 hat keinen Legacy-Zeiger mehr';
  end if;
end $$;

-- ── Kommentare vor dem ersten Lesen (Zeitachse T1) ──
-- Auf J1 drei Stück, bewusst gemischt verfasst, damit JEDE der drei Rollen
-- mindestens einen FREMDEN Kommentar hat (eigene zählen nie als ungelesen):
--   09:00 Admin   -> ungelesen für PRIMÄR und SEKUNDÄR
--   09:30 PRIMÄR  -> ungelesen für ADMIN und SEKUNDÄR
--   10:00 Admin   -> jüngster Kommentar insgesamt
-- Mehrere Kommentare am selben Auftrag sind zugleich die Vorlage für die
-- Duplikat-Prüfung (CASE 21).
insert into public.job_comments (company_id, job_id, author_id, message, created_at) values
  ('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000001','Admin-Kommentar 1 auf J1',  timestamptz '2026-01-01 09:00+00'),
  ('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000002','Primaer-Kommentar auf J1', timestamptz '2026-01-01 09:30+00'),
  ('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000001','Admin-Kommentar 2 auf J1',  timestamptz '2026-01-01 10:00+00'),
  ('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000002','96000000-0000-0000-0000-000000000001','Admin-Kommentar auf J2',    timestamptz '2026-01-01 10:00+00');


-- =========================================================
-- TEIL A — Sichtbarkeit der Ungelesen-Meldung (noch nichts gelesen)
-- =========================================================

-- CASE 1 (Matrix A): PRIMÄR bekommt J1 gemeldet.
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000001');
  insert into _r values (1,'Matrix A: PRIMAER bekommt J1 als ungelesen','treffer=1',v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2 (Matrix B): SEKUNDÄR bekommt J1 gemeldet — DIE GESCHLOSSENE LÜCKE.
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000003','97000000-0000-0000-0000-000000000001');
  insert into _r values (2,'Matrix B: SEKUNDAER bekommt J1 als ungelesen','treffer=1',v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3 (Matrix C): nicht zugewiesener Mitarbeiter derselben Firma -> nichts.
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000004','97000000-0000-0000-0000-000000000001');
  insert into _r values (3,'Matrix C: nicht zugewiesener Mitarbeiter (gleiche Firma) bekommt J1 NICHT','treffer=0',v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4 (Matrix D): Mitarbeiter ANDERER Firma -> nichts.
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000006','97000000-0000-0000-0000-000000000001');
  insert into _r values (4,'Matrix D: Mitarbeiter anderer Firma bekommt J1 NICHT','treffer=0',v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- CASE 5 (Matrix E): Admin der eigenen Firma -> Meldung (unverändert).
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001');
  insert into _r values (5,'Matrix E: Admin der eigenen Firma bekommt J1','treffer=1',v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6 (Matrix F): Admin ANDERER Firma -> nichts.
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000005','97000000-0000-0000-0000-000000000001');
  insert into _r values (6,'Matrix F: Admin anderer Firma bekommt J1 NICHT','treffer=0',v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7 (Matrix G): LEGACY-Bestandszeile (nur jobs.assigned_to, keine
-- job_assignments-Zeile) meldet weiterhin — Rückwärtskompatibilität.
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000007','97000000-0000-0000-0000-000000000002');
  insert into _r values (7,'Matrix G: LEGACY-Zugewiesener bekommt J2 (nur assigned_to)','treffer=1',v);
  raise notice 'CASE 7 -> %', v;
end $$;

-- CASE 8: SEKUNDÄR bekommt J2 NICHT (kein Querschlagen zwischen Auftraegen).
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000003','97000000-0000-0000-0000-000000000002');
  insert into _r values (8,'SEKUNDAER von J1 bekommt den fremden J2 NICHT','treffer=0',v);
  raise notice 'CASE 8 -> %', v;
end $$;


-- =========================================================
-- TEIL B — Autor-Ausschluss (eigene Kommentare sind nie ungelesen)
-- =========================================================

-- J3 bekommt genau EINEN Kommentar, verfasst vom SEKUNDÄREN selbst.
do $$
declare v text;
begin
  perform pg_temp.act_as('96000000-0000-0000-0000-000000000003');
  execute 'set local role authenticated';
  insert into public.job_comments (company_id, job_id, author_id, message, created_at)
  values ('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000003',
          '96000000-0000-0000-0000-000000000003','Von Sekundaer selbst', timestamptz '2026-01-01 10:00+00');
  execute 'reset role';
end $$;

-- CASE 9: der Autor (SEKUNDÄR) bekommt seinen eigenen Kommentar NICHT gemeldet.
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000003','97000000-0000-0000-0000-000000000003');
  insert into _r values (9,'Autor-Ausschluss: SEKUNDAER bekommt den EIGENEN Kommentar auf J3 nicht','treffer=0',v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: derselbe Kommentar ist für den PRIMÄREN sehr wohl ungelesen.
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000003');
  insert into _r values (10,'PRIMAER bekommt den Kommentar des SEKUNDAEREN auf J3 als ungelesen','treffer=1',v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- CASE 11: und auch für den Admin (Mitarbeiter-Kommentar an den Admin).
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000003');
  insert into _r values (11,'Admin bekommt den Kommentar des SEKUNDAEREN auf J3 als ungelesen','treffer=1',v);
  raise notice 'CASE 11 -> %', v;
end $$;


-- =========================================================
-- TEIL C — Read-State ist PRO BENUTZER unabhängig
-- =========================================================

-- CASE 12: SEKUNDÄR markiert J1 als gelesen (T2) — der Schreibvorgang selbst
-- muss durch die RLS gehen (seit 20260826000001).
do $$
declare v text;
begin
  v := pg_temp.mark_read('96000000-0000-0000-0000-000000000003','97000000-0000-0000-0000-000000000001', timestamptz '2026-01-01 11:00+00');
  insert into _r values (12,'SEKUNDAER darf seinen eigenen Read-State auf J1 schreiben','ERLAUBT',v);
  raise notice 'CASE 12 -> %', v;
end $$;

-- CASE 13: danach meldet die RPC J1 für den SEKUNDÄREN nicht mehr.
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000003','97000000-0000-0000-0000-000000000001');
  insert into _r values (13,'Nach dem Markieren bekommt SEKUNDAER J1 nicht mehr','treffer=0',v);
  raise notice 'CASE 13 -> %', v;
end $$;

-- CASE 14: der PRIMÄRE ist davon UNBERÜHRT (B6 der Regressionsmatrix).
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000001');
  insert into _r values (14,'Markieren durch SEKUNDAER laesst PRIMAERs Ungelesen-Status unberuehrt','treffer=1',v);
  raise notice 'CASE 14 -> %', v;
end $$;

-- CASE 15: auch der ADMIN ist unberührt.
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001');
  insert into _r values (15,'Markieren durch SEKUNDAER laesst den Admin unberuehrt','treffer=1',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16: jetzt markiert der PRIMÄRE (T2). Er passt auf BEIDE Zweige der
-- Oder-Verknüpfung (Legacy-Zeiger UND job_assignments) — die Job-ID darf
-- trotzdem nur EINMAL zurückkommen. Erst prüfen (Duplikat), dann markieren.
do $$
declare v text;
begin
  v := pg_temp.mark_read('96000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000001', timestamptz '2026-01-01 11:00+00');
  insert into _r values (16,'PRIMAER darf seinen eigenen Read-State auf J1 schreiben','ERLAUBT',v);
  raise notice 'CASE 16 -> %', v;
end $$;

-- CASE 17: PRIMÄR bekommt J1 nicht mehr …
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000001');
  insert into _r values (17,'Nach dem Markieren bekommt PRIMAER J1 nicht mehr','treffer=0',v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- CASE 18: … und der SEKUNDÄRE bleibt ebenfalls auf "gelesen" (B7: kein
-- Zurückschlagen des fremden Markierens).
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000003','97000000-0000-0000-0000-000000000001');
  insert into _r values (18,'Markieren durch PRIMAER setzt SEKUNDAER nicht zurueck','treffer=0',v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- CASE 19: genau zwei Read-State-Zeilen, je eine pro Nutzer.
do $$
declare v text;
begin
  select 'zeilen='||count(*)::text into v
  from public.job_comment_reads
  where job_id='97000000-0000-0000-0000-000000000001';
  insert into _r values (19,'Read-State auf J1 ist pro Benutzer getrennt gespeichert','zeilen=2',v);
  raise notice 'CASE 19 -> %', v;
end $$;

-- ── Neuer Admin-Kommentar zum Zeitpunkt T3 (nach beiden Markierungen) ──
insert into public.job_comments (company_id, job_id, author_id, message, created_at) values
  ('95000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','96000000-0000-0000-0000-000000000001','Admin-Kommentar 3 auf J1', timestamptz '2026-01-01 12:00+00');

-- CASE 20: der neue Kommentar macht J1 für BEIDE wieder ungelesen …
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000003','97000000-0000-0000-0000-000000000001');
  insert into _r values (20,'Neuer Kommentar nach dem Lesen macht J1 fuer SEKUNDAER wieder ungelesen','treffer=1',v);
  raise notice 'CASE 20 -> %', v;
end $$;

-- CASE 21: … genau einmal, obwohl PRIMÄR über beide Oder-Zweige passt und J1
-- inzwischen drei Kommentare traegt (Duplikat-Schutz der Aggregation).
do $$
declare v text;
begin
  v := pg_temp.unread('96000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000001');
  insert into _r values (21,'PRIMAER (passt auf beide Oder-Zweige) bekommt J1 genau EINMAL','treffer=1',v);
  raise notice 'CASE 21 -> %', v;
end $$;


-- =========================================================
-- TEIL D — Schutzmechanismen bleiben bestehen
-- =========================================================

-- CASE 22: DEAKTIVIERTER sekundär Zugewiesener bekommt nichts mehr
-- (current_user_company_id()/current_user_role() liefern für is_active=false
-- NULL — der Firmen- und Rollenfilter der RPC greift dadurch weiterhin).
do $$
declare v text;
begin
  update public.profiles set is_active=false where id='96000000-0000-0000-0000-000000000003';
  v := pg_temp.unread('96000000-0000-0000-0000-000000000003','97000000-0000-0000-0000-000000000001');
  insert into _r values (22,'Deaktivierter SEKUNDAERer bekommt keine Ungelesen-Meldung','treffer=0',v);
  raise notice 'CASE 22 -> %', v;
  update public.profiles set is_active=true where id='96000000-0000-0000-0000-000000000003';
end $$;

-- CASE 23: die RPC bleibt SECURITY DEFINER + STABLE (Aufrufbarkeit trotz RLS
-- auf jobs/job_comments; kein Wechsel des Ausführungsmodells).
do $$
declare v text;
begin
  select 'definer='||p.prosecdef::text||',volatilitaet='||p.provolatile::text into v
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='get_unread_comment_job_ids';
  insert into _r values (23,'RPC bleibt SECURITY DEFINER und STABLE','definer=true,volatilitaet=s',v);
  raise notice 'CASE 23 -> %', v;
end $$;

-- CASE 24: die EXECUTE-Grants aus 20260723000002 bleiben unverändert
-- (nur authenticated + service_role, nicht public/anon).
do $$
declare v text;
begin
  select 'anon='||has_function_privilege('anon','public.get_unread_comment_job_ids()','execute')::text
      ||',auth='||has_function_privilege('authenticated','public.get_unread_comment_job_ids()','execute')::text
    into v;
  insert into _r values (24,'EXECUTE-Grants der RPC unveraendert','anon=false,auth=true',v);
  raise notice 'CASE 24 -> %', v;
end $$;

-- CASE 25: die RPC wertet die kanonische Zuweisungsmenge aus (Strukturprobe —
-- Gegenprobe zu employee_read_via_assignments CASE 23 und
-- secondary_assignee_write_access CASE 29, die beide den alten Zustand
-- festgeschrieben hatten).
do $$
declare v text;
begin
  select 'nutzt_helfer='||(pg_get_functiondef(p.oid) like '%is_assigned_to_job%')::text into v
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='get_unread_comment_job_ids';
  insert into _r values (25,'RPC autorisiert ueber job_assignments (is_assigned_to_job)','nutzt_helfer=true',v);
  raise notice 'CASE 25 -> %', v;
end $$;


-- =========================================================
-- Ergebnisübersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _r order by case_no;

do $$
declare fails int; gesamt int;
begin
  select count(*), count(*) filter (where ergebnis is distinct from erwartet)
    into gesamt, fails from _r;
  if fails > 0 then
    raise exception 'SECONDARY ASSIGNEE UNREAD COMMENTS TEST: % von % Faellen FEHLGESCHLAGEN', fails, gesamt;
  end if;
  raise notice 'ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
