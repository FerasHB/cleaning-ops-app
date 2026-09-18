-- =========================================================
-- TEST: Notification-Dispatch-Integrität + -Latenz
-- (Migrationen 20260916130000 + 20260916140000)
-- =========================================================
-- Deckt die Regression ab, die dieser Fix behebt:
--   claim_notification_deliveries() muss GLEICHZEITIG recipient_locale
--   (Phase E, 20260915000000) UND entity_type/entity_id/absence_start_date/
--   absence_end_date (20260821000000) liefern — 20260915000000 hatte die
--   zweite Gruppe versehentlich entfernt.
-- Sowie den neuen Sofort-Trigger (20260916140000): authentifizierter
-- pg_net-Aufruf über denselben Vault-Mechanismus wie der Minuten-Sweeper,
-- OHNE das Secret jemals im Klartext preiszugeben, und ohne den Sweeper
-- (Fallback) zu verändern.
--
-- Alle Zugriffe als ECHTE Rollen (SET ROLE + request.jwt.claims) über die
-- echten RPCs (start_own_job/complete_own_job/request_own_vacation/
-- report_own_sickness/update_own_sickness_end/admin_review_vacation/
-- Kommentar-INSERT) — KEIN direktes Schreiben in notification_outbox/
-- notification_deliveries, damit exakt der Produktionspfad geprüft wird.
-- Transaktional (BEGIN … ROLLBACK), keine Rückstände.
--
-- Lokal:
--   docker exec -i supabase_db_cleaning-employee-app-2 psql -U postgres \
--     -d postgres -v ON_ERROR_STOP=1 < supabase/tests/notification_dispatch_integrity.test.sql
-- =========================================================

begin;

-- ── Fixdaten (eigener ID-Raum 99xxxxxx…) ──
-- Firma NDI = 99000000…0001
-- Admin A (locale=en)     = 99100000…0001, Token 'Tok-NDI-A'
-- Employee E1 (locale=ar) = 99100000…0002, Token 'Tok-NDI-E1'  (primärer Zugewiesener)
-- Employee E2 (locale=tr) = 99100000…0003, Token 'Tok-NDI-E2'  (sekundärer Zugewiesener)
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','99100000-0000-0000-0000-000000000001','authenticated','authenticated','ndi-a1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','99100000-0000-0000-0000-000000000002','authenticated','authenticated','ndi-e1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','99100000-0000-0000-0000-000000000003','authenticated','authenticated','ndi-e2@x.test','{}');

insert into public.companies (id, name, slug) values
 ('99000000-0000-0000-0000-000000000001','NDI Firma','ndi-firma-test');

insert into public.profiles (id, role, company_id, is_active, expo_push_token, full_name, locale) values
 ('99100000-0000-0000-0000-000000000001','admin',   '99000000-0000-0000-0000-000000000001',true,'Tok-NDI-A', 'Admin NDI','en'),
 ('99100000-0000-0000-0000-000000000002','employee','99000000-0000-0000-0000-000000000001',true,'Tok-NDI-E1','Erste Mitarbeiterin','ar'),
 ('99100000-0000-0000-0000-000000000003','employee','99000000-0000-0000-0000-000000000001',true,'Tok-NDI-E2','Zweiter Mitarbeiter','tr')
on conflict (id) do update set
  role=excluded.role, company_id=excluded.company_id, is_active=excluded.is_active,
  expo_push_token=excluded.expo_push_token, full_name=excluded.full_name, locale=excluded.locale;

insert into public.jobs (id, company_id, customer_name, service_name, location_address, status, assigned_to, job_type, is_active) values
 ('99200000-0000-0000-0000-000000000001','99000000-0000-0000-0000-000000000001','Kunde NDI','Büroreinigung','Weg 1','open','99100000-0000-0000-0000-000000000002','single',true);

-- E1 (primärer Zeiger assigned_to) wird bereits per compat_sync_assignments_
-- from_legacy_ins-Trigger (20260726000000) aus dem INSERT oben angelegt —
-- hier nur E2 (sekundär) zusätzlich, mit ON CONFLICT als Sicherheitsnetz.
insert into public.job_assignments (job_id, employee_id, employee_name_snapshot) values
 ('99200000-0000-0000-0000-000000000001','99100000-0000-0000-0000-000000000002','Erste Mitarbeiterin'),
 ('99200000-0000-0000-0000-000000000001','99100000-0000-0000-0000-000000000003','Zweiter Mitarbeiter')
on conflict (job_id, employee_id) do nothing;

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

-- =========================================================
-- A — Claim-Vertrag: job_started liefert entity_type/entity_id UND locale
-- =========================================================
do $$
declare
  v_event_type text; v_entity_type text; v_entity_id uuid; v_job_id uuid;
  v_absence_start date; v_absence_end date; v_locale text;
begin
  perform set_config('request.jwt.claims','{"sub":"99100000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  perform public.start_own_job('99200000-0000-0000-0000-000000000001');
  execute 'reset role';

  perform public.fanout_notification_events();

  select event_type, entity_type, entity_id, job_id, absence_start_date, absence_end_date, recipient_locale
    into v_event_type, v_entity_type, v_entity_id, v_job_id, v_absence_start, v_absence_end, v_locale
  from public.claim_notification_deliveries()
  where event_type = 'job_started' and recipient_id = '99100000-0000-0000-0000-000000000001';

  insert into _r values (1,
    'job_started: event_type|entity_type|entity_id=job_id|absence_start|absence_end|locale',
    'job_started|job|true|NULL|NULL|en',
    coalesce(v_event_type,'NULL')||'|'||coalesce(v_entity_type,'NULL')||'|'||(v_entity_id = v_job_id)::text||'|'||coalesce(v_absence_start::text,'NULL')||'|'||coalesce(v_absence_end::text,'NULL')||'|'||coalesce(v_locale,'NULL'));
end $$;

-- =========================================================
-- F — job_completed bleibt korrekt (entity_type weiterhin 'job')
-- =========================================================
do $$
declare v_event_type text; v_entity_type text;
begin
  perform set_config('request.jwt.claims','{"sub":"99100000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  perform public.complete_own_job('99200000-0000-0000-0000-000000000001');
  execute 'reset role';

  perform public.fanout_notification_events();

  select event_type, entity_type into v_event_type, v_entity_type
  from public.claim_notification_deliveries()
  where event_type = 'job_completed' and recipient_id = '99100000-0000-0000-0000-000000000001';

  insert into _r values (2, 'job_completed: event_type|entity_type', 'job_completed|job',
    coalesce(v_event_type,'NULL')||'|'||coalesce(v_entity_type,'NULL'));
end $$;

-- =========================================================
-- D — Kommentar: entity_type='comment', entity_id=Kommentar-ID, job_id
-- gesetzt, UND recipient_locale ist PRO EMPFÄNGER unterschiedlich (E2=tr,
-- Admin=en) — beweist den JOIN gegen profiles pro Zeile, nicht pro Event.
-- =========================================================
-- WICHTIG: claim_notification_deliveries() claimt (status -> processing)
-- ALLE faelligen Zeilen IN EINEM AUFRUF. Ein zweiter Aufruf sieht die vom
-- ersten bereits geclaimten Zeilen NICHT mehr (genau das ist die geprüfte
-- FOR-UPDATE-SKIP-LOCKED-Semantik, siehe Fall 8 unten) — deshalb hier GENAU
-- EIN Aufruf, dessen komplettes Ergebnis in einer Temp-Tabelle landet, und
-- beide Empfaenger-Zeilen werden AUS DIESER EINEN Materialisierung gelesen.
do $$
declare
  v_comment_id uuid;
  v_e2_entity_type text; v_e2_entity_id uuid; v_e2_job_id uuid; v_e2_locale text;
  v_admin_entity_type text; v_admin_locale text;
begin
  perform set_config('request.jwt.claims','{"sub":"99100000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  insert into public.job_comments (job_id, company_id, author_id, message)
  values ('99200000-0000-0000-0000-000000000001','99000000-0000-0000-0000-000000000001','99100000-0000-0000-0000-000000000002','Testkommentar')
  returning id into v_comment_id;
  execute 'reset role';

  -- Kommentar-Deliveries werden vom Trigger DIREKT geschrieben (fanned_out_at
  -- sofort gesetzt) -> kein fanout_notification_events() nötig.
  create temporary table _claim3 on commit drop as
  select * from public.claim_notification_deliveries();

  select entity_type, entity_id, job_id, recipient_locale
    into v_e2_entity_type, v_e2_entity_id, v_e2_job_id, v_e2_locale
  from _claim3
  where event_type = 'comment_added' and recipient_id = '99100000-0000-0000-0000-000000000003';

  select entity_type, recipient_locale into v_admin_entity_type, v_admin_locale
  from _claim3
  where event_type = 'comment_added' and recipient_id = '99100000-0000-0000-0000-000000000001';

  insert into _r values (3,
    'comment_added an E2: entity_type|entity_id=comment_id|job_id gesetzt|locale=tr',
    'comment|true|true|tr',
    coalesce(v_e2_entity_type,'NULL')||'|'||(v_e2_entity_id = v_comment_id)::text||'|'||(v_e2_job_id is not null)::text||'|'||coalesce(v_e2_locale,'NULL'));

  insert into _r values (4,
    'comment_added an Admin (Mitarbeiter-Autor -> zusätzlich Admin-Fanout): entity_type|locale=en',
    'comment|en',
    coalesce(v_admin_entity_type,'NULL')||'|'||coalesce(v_admin_locale,'NULL'));
end $$;

-- =========================================================
-- E — Abwesenheit: vacation_requested (Admin-Fanout) + vacation_approved
-- (Direktzustellung an Antragsteller). entity_type='absence',
-- entity_id=absence_id, absence_start/end gesetzt, Empfänger-Locale korrekt.
-- =========================================================
do $$
declare
  v_absence_id uuid;
  v_entity_type text; v_entity_id uuid; v_start date; v_end date; v_locale text;
  v_approved_event text; v_approved_locale text; v_approved_start date;
begin
  perform set_config('request.jwt.claims','{"sub":"99100000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  select id into v_absence_id
  from public.request_own_vacation('2026-10-05','2026-10-09', null);
  execute 'reset role';

  perform public.fanout_notification_events();

  select entity_type, entity_id, absence_start_date, absence_end_date, recipient_locale
    into v_entity_type, v_entity_id, v_start, v_end, v_locale
  from public.claim_notification_deliveries()
  where event_type = 'vacation_requested' and recipient_id = '99100000-0000-0000-0000-000000000001';

  insert into _r values (5,
    'vacation_requested: entity_type|entity_id=absence_id|start|end|locale(Admin=en)',
    'absence|true|2026-10-05|2026-10-09|en',
    coalesce(v_entity_type,'NULL')||'|'||(v_entity_id = v_absence_id)::text||'|'||coalesce(v_start::text,'NULL')||'|'||coalesce(v_end::text,'NULL')||'|'||coalesce(v_locale,'NULL'));

  -- Admin genehmigt -> Direktzustellung an den Antragsteller (E1, locale=ar).
  perform set_config('request.jwt.claims','{"sub":"99100000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  perform public.admin_review_vacation(v_absence_id, 'approved', null);
  execute 'reset role';

  select event_type, recipient_locale, absence_start_date into v_approved_event, v_approved_locale, v_approved_start
  from public.claim_notification_deliveries()
  where event_type = 'vacation_approved' and recipient_id = '99100000-0000-0000-0000-000000000002';

  insert into _r values (6, 'vacation_approved an E1 (Direktzustellung): event_type|locale=ar|start erhalten',
    'vacation_approved|ar|2026-10-05',
    coalesce(v_approved_event,'NULL')||'|'||coalesce(v_approved_locale,'NULL')||'|'||coalesce(v_approved_start::text,'NULL'));
end $$;

-- =========================================================
-- Grants unveraendert: nur service_role, NICHT public/anon/authenticated
-- =========================================================
do $$
declare v_service boolean; v_anon boolean; v_auth boolean;
begin
  select has_function_privilege('service_role','public.claim_notification_deliveries(uuid,int,int)','EXECUTE') into v_service;
  select has_function_privilege('anon','public.claim_notification_deliveries(uuid,int,int)','EXECUTE') into v_anon;
  select has_function_privilege('authenticated','public.claim_notification_deliveries(uuid,int,int)','EXECUTE') into v_auth;
  insert into _r values (7, 'Grants: service_role=true, anon=false, authenticated=false',
    'true|false|false', v_service||'|'||v_anon||'|'||v_auth);
end $$;

-- =========================================================
-- Locking/Retry unveraendert: FOR UPDATE SKIP LOCKED + Stale-Reclaim
-- =========================================================
-- Eigener, bis hierher unberuehrter Job/Event (99…0004), damit dieser Fall
-- garantiert eine NOCH NICHT geclaimte Zeile testet — nicht eine, die ein
-- frueherer Testfall in diesem Skript bereits auf 'processing' gesetzt hat.
do $$
declare
  v_delivery_id uuid;
  v_status_after_claim text;
  v_reclaimed_attempts int;
  v_immediate_reclaim_count int;
begin
  insert into public.jobs (id, company_id, customer_name, service_name, location_address, status, assigned_to, job_type, is_active)
  values ('99200000-0000-0000-0000-000000000004','99000000-0000-0000-0000-000000000001','Kunde NDI Lock','Teppichreinigung','Weg 4','open','99100000-0000-0000-0000-000000000002','single',true);

  perform set_config('request.jwt.claims','{"sub":"99100000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  perform public.start_own_job('99200000-0000-0000-0000-000000000004');
  execute 'reset role';

  perform public.fanout_notification_events();

  select delivery_id into v_delivery_id
  from public.claim_notification_deliveries()
  where event_type = 'job_started'
    and recipient_id = '99100000-0000-0000-0000-000000000001'
    and job_id = '99200000-0000-0000-0000-000000000004';

  select status into v_status_after_claim from public.notification_deliveries where id = v_delivery_id;

  -- Zweiter Claim SOFORT danach (Timeout 120s, Standard) darf die gerade
  -- geclaimte Zeile NICHT zurueckgeben (FOR UPDATE SKIP LOCKED / processing).
  select count(*) into v_immediate_reclaim_count
  from public.claim_notification_deliveries(null, 50, 120)
  where delivery_id = v_delivery_id;

  -- Zeile kuenstlich als "seit 200s haengend" markieren -> mit
  -- processing_timeout_seconds=60 muss sie reklamiert werden (attempts++).
  update public.notification_deliveries
    set claimed_at = now() - interval '200 seconds'
    where id = v_delivery_id;

  select attempts into v_reclaimed_attempts
  from public.claim_notification_deliveries(null, 50, 60)
  where delivery_id = v_delivery_id;

  insert into _r values (8,
    'Claim-Semantik: Status nach 1. Claim=processing|kein Sofort-Reclaim|Stale-Reclaim erhoeht attempts auf 2',
    'processing|0|2',
    coalesce(v_status_after_claim,'NULL')||'|'||v_immediate_reclaim_count||'|'||coalesce(v_reclaimed_attempts::text,'NULL'));
end $$;

-- =========================================================
-- H — Sofort-Dispatch-Trigger: authentifizierte Anfrage OHNE Secret im Klartext
-- =========================================================
-- Test-lokale Vault-Werte (NICHT produktiv, nur fuer diese Transaktion).
-- KEIN echter Netzwerkaufruf verlaesst diese Maschine: pg_net queued die
-- Anfrage nur; ein Empfaenger auf 127.0.0.1:6 (verworfener Port) existiert
-- nicht, das wird hier nicht abgewartet.
do $$
declare
  v_secret_exists_before boolean;
  v_req_url text; v_req_headers jsonb; v_req_method text;
  v_job_id uuid;
begin
  select exists(select 1 from vault.secrets where name = 'project_url') into v_secret_exists_before;
  if not v_secret_exists_before then
    perform vault.create_secret('http://127.0.0.1:6', 'project_url', 'TEST-ONLY, rollt mit dieser Transaktion zurueck');
  end if;
  if not exists(select 1 from vault.secrets where name = 'dispatch_sweeper_secret') then
    perform vault.create_secret('test-only-fake-sweeper-secret', 'dispatch_sweeper_secret', 'TEST-ONLY, rollt mit dieser Transaktion zurueck');
  end if;

  insert into public.jobs (id, company_id, customer_name, service_name, location_address, status, assigned_to, job_type, is_active)
  values ('99200000-0000-0000-0000-000000000002','99000000-0000-0000-0000-000000000001','Kunde NDI 2','Fensterreinigung','Weg 2','open','99100000-0000-0000-0000-000000000002','single',true)
  returning id into v_job_id;

  perform set_config('request.jwt.claims','{"sub":"99100000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  execute 'set local role authenticated';
  perform public.start_own_job(v_job_id);
  execute 'reset role';

  select url, headers, method into v_req_url, v_req_headers, v_req_method
  from net.http_request_queue
  where url = 'http://127.0.0.1:6/functions/v1/dispatch-notifications'
  order by id desc limit 1;

  insert into _r values (9,
    'Sofort-Trigger: url korrekt|Methode=POST|x-sweeper-secret gesetzt|KEIN Authorization-Header',
    'true|POST|test-only-fake-sweeper-secret|false',
    (v_req_url = 'http://127.0.0.1:6/functions/v1/dispatch-notifications')::text||'|'||coalesce(v_req_method,'NULL')||'|'||coalesce(v_req_headers->>'x-sweeper-secret','NULL')||'|'||(v_req_headers ? 'Authorization')::text);
end $$;

-- =========================================================
-- I — Fallback: Minuten-Sweeper bleibt unveraendert bestehen
-- =========================================================
do $$
declare v_cnt int; v_schedule text;
begin
  select count(*), max(schedule) into v_cnt, v_schedule
  from cron.job where jobname = 'notification-dispatch-sweeper';
  insert into _r values (10, 'Sweeper-Cron weiterhin vorhanden: count|schedule', '1|* * * * *',
    v_cnt||'|'||coalesce(v_schedule,'NULL'));
end $$;

-- =========================================================
-- Ergebnisübersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
  case when erwartet = ergebnis then 'PASS' else 'FAIL' end as verdikt
from _r order by case_no;

rollback;
