-- =========================================================
-- TEST: Serverseitiger Admin-Push bei Job-Statuswechsel
-- (Migration 20260717000000 — Zustandsmaschine + Dispatcher-RPCs)
-- =========================================================
-- Prüft die vollständige serverseitige Dispatch-Kette OHNE Client:
--   start_own_job/complete_own_job -> notification_outbox (Event)
--   fanout_notification_events()   -> notification_deliveries (pro Empfänger)
--   claim_notification_deliveries()-> atomarer Claim (processing)
--   complete_notification_delivery -> sent | pending(Backoff) | failed
--
-- AUSFÜHREN: im Supabase SQL Editor (postgres) komplett einfügen. Legt Testdaten
-- an, simuliert Mitarbeiter über SET ROLE + request.jwt.claims, ruft die
-- Dispatcher-RPCs als postgres (= Server/Sweeper-Sicht, KEIN Client-Kick) auf und
-- macht am Ende ROLLBACK. Lokal gegen die Migrations-DB via:
--   docker exec -i <supabase_db_container> psql -U postgres -d postgres
--     -v ON_ERROR_STOP=1 < supabase/tests/admin_status_notifications.test.sql
--
-- Hinweis handle_new_user: Der auth.users-Trigger ist im lokalen public-Baseline
-- NICHT enthalten -> Profile werden hier explizit via on conflict do update
-- angelegt (läuft im SQL Editor UND lokal).
-- =========================================================

begin;

-- Jede Firma isoliert ein Szenario, damit company-gescopte Claims sich nicht
-- gegenseitig beeinflussen. Ausnahme: Firma S nutzt bewusst den GLOBALEN Claim
-- (Sweeper-Sicht), solange nur S-Events existieren.
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','a5100000-0000-0000-0000-000000000001','authenticated','authenticated','n-s-a1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','a5100000-0000-0000-0000-000000000002','authenticated','authenticated','n-s-a2@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','a5100000-0000-0000-0000-000000000003','authenticated','authenticated','n-s-ad@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','e5100000-0000-0000-0000-000000000001','authenticated','authenticated','n-s-e1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','e5100000-0000-0000-0000-000000000002','authenticated','authenticated','n-s-e2@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','a5200000-0000-0000-0000-000000000001','authenticated','authenticated','n-p-a1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','a5200000-0000-0000-0000-000000000002','authenticated','authenticated','n-p-a2@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','e5200000-0000-0000-0000-000000000001','authenticated','authenticated','n-p-e1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','a5300000-0000-0000-0000-000000000001','authenticated','authenticated','n-k-a1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','e5300000-0000-0000-0000-000000000001','authenticated','authenticated','n-k-e1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','a5400000-0000-0000-0000-000000000001','authenticated','authenticated','n-m-a1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','e5400000-0000-0000-0000-000000000001','authenticated','authenticated','n-m-e1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','a5500000-0000-0000-0000-000000000001','authenticated','authenticated','n-d-a1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','e5500000-0000-0000-0000-000000000001','authenticated','authenticated','n-d-e1@x.test','{}'),
 -- Firma T (Token-Resilienz): Admin T1 mit Token, Admin T2 OHNE Token
 ('00000000-0000-0000-0000-000000000000','a5600000-0000-0000-0000-000000000001','authenticated','authenticated','n-t-a1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','a5600000-0000-0000-0000-000000000002','authenticated','authenticated','n-t-a2@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','e5600000-0000-0000-0000-000000000001','authenticated','authenticated','n-t-e1@x.test','{}'),
 -- Firma X (Backfill): X1/X2 aktiv, X3 inaktiv
 ('00000000-0000-0000-0000-000000000000','a5700000-0000-0000-0000-000000000001','authenticated','authenticated','n-x-a1@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','a5700000-0000-0000-0000-000000000002','authenticated','authenticated','n-x-a2@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','a5700000-0000-0000-0000-000000000003','authenticated','authenticated','n-x-a3@x.test','{}'),
 ('00000000-0000-0000-0000-000000000000','e5700000-0000-0000-0000-000000000001','authenticated','authenticated','n-x-e1@x.test','{}');

insert into public.companies (id,name,slug) values
 ('51111111-1111-1111-1111-111111111111','Firma S','n-firma-s'),
 ('52222222-2222-2222-2222-222222222222','Firma P','n-firma-p'),
 ('53333333-3333-3333-3333-333333333333','Firma K','n-firma-k'),
 ('54444444-4444-4444-4444-444444444444','Firma M','n-firma-m'),
 ('55555555-5555-5555-5555-555555555555','Firma D','n-firma-d'),
 ('56666666-6666-6666-6666-666666666666','Firma T','n-firma-t'),
 ('57777777-7777-7777-7777-777777777777','Firma X','n-firma-x');

-- adminSde ist bewusst inaktiv MIT Token -> muss trotzdem ausgeschlossen werden.
insert into public.profiles (id,role,company_id,is_active,expo_push_token,full_name) values
 ('a5100000-0000-0000-0000-000000000001','admin',   '51111111-1111-1111-1111-111111111111',true, 'Tok-S1','Admin S1'),
 ('a5100000-0000-0000-0000-000000000002','admin',   '51111111-1111-1111-1111-111111111111',true, 'Tok-S2','Admin S2'),
 ('a5100000-0000-0000-0000-000000000003','admin',   '51111111-1111-1111-1111-111111111111',false,'Tok-Sd','Admin S deaktiviert'),
 ('e5100000-0000-0000-0000-000000000001','employee','51111111-1111-1111-1111-111111111111',true, null,   'Mitarbeiter S1'),
 ('e5100000-0000-0000-0000-000000000002','employee','51111111-1111-1111-1111-111111111111',true, null,   'Mitarbeiter S2'),
 ('a5200000-0000-0000-0000-000000000001','admin',   '52222222-2222-2222-2222-222222222222',true, 'Tok-P1','Admin P1'),
 ('a5200000-0000-0000-0000-000000000002','admin',   '52222222-2222-2222-2222-222222222222',true, 'Tok-P2','Admin P2'),
 ('e5200000-0000-0000-0000-000000000001','employee','52222222-2222-2222-2222-222222222222',true, null,   'Mitarbeiter P1'),
 ('a5300000-0000-0000-0000-000000000001','admin',   '53333333-3333-3333-3333-333333333333',true, 'Tok-K1','Admin K1'),
 ('e5300000-0000-0000-0000-000000000001','employee','53333333-3333-3333-3333-333333333333',true, null,   'Mitarbeiter K1'),
 ('a5400000-0000-0000-0000-000000000001','admin',   '54444444-4444-4444-4444-444444444444',true, 'Tok-M1','Admin M1'),
 ('e5400000-0000-0000-0000-000000000001','employee','54444444-4444-4444-4444-444444444444',true, null,   'Mitarbeiter M1'),
 ('a5500000-0000-0000-0000-000000000001','admin',   '55555555-5555-5555-5555-555555555555',true, 'Tok-D1','Admin D1'),
 ('e5500000-0000-0000-0000-000000000001','employee','55555555-5555-5555-5555-555555555555',true, null,   'Mitarbeiter D1'),
 -- Firma T: T1 hat Token, T2 hat (noch) KEINEN Token -> muss trotzdem Delivery bekommen.
 ('a5600000-0000-0000-0000-000000000001','admin',   '56666666-6666-6666-6666-666666666666',true, 'Tok-T1','Admin T1'),
 ('a5600000-0000-0000-0000-000000000002','admin',   '56666666-6666-6666-6666-666666666666',true, null,    'Admin T2'),
 ('e5600000-0000-0000-0000-000000000001','employee','56666666-6666-6666-6666-666666666666',true, null,    'Mitarbeiter T1'),
 -- Firma X: X1/X2 aktiv, X3 inaktiv (Backfill darf X3 nicht bedienen).
 ('a5700000-0000-0000-0000-000000000001','admin',   '57777777-7777-7777-7777-777777777777',true, 'Tok-X1','Admin X1'),
 ('a5700000-0000-0000-0000-000000000002','admin',   '57777777-7777-7777-7777-777777777777',true, 'Tok-X2','Admin X2'),
 ('a5700000-0000-0000-0000-000000000003','admin',   '57777777-7777-7777-7777-777777777777',false,'Tok-X3','Admin X3 inaktiv'),
 ('e5700000-0000-0000-0000-000000000001','employee','57777777-7777-7777-7777-777777777777',true, null,   'Mitarbeiter X1')
on conflict (id) do update set
  role=excluded.role, company_id=excluded.company_id, is_active=excluded.is_active,
  expo_push_token=excluded.expo_push_token, full_name=excluded.full_name;

insert into public.jobs (id,company_id,customer_name,service_name,location_address,status,assigned_to,job_type,is_active) values
 ('15000000-0000-0000-0000-0000000000a1','51111111-1111-1111-1111-111111111111','Kunde S','Fensterreinigung','Weg 1','open','e5100000-0000-0000-0000-000000000001','single',true),
 ('15000000-0000-0000-0000-0000000000a2','51111111-1111-1111-1111-111111111111','Kunde S2','Bodenreinigung','Weg 2','open','e5100000-0000-0000-0000-000000000001','single',true),
 ('15000000-0000-0000-0000-0000000000a3','51111111-1111-1111-1111-111111111111','Kunde Sf','Grundreinigung','Weg 3','open','e5100000-0000-0000-0000-000000000002','single',true),
 ('15000000-0000-0000-0000-0000000000b1','52222222-2222-2222-2222-222222222222','Kunde P','Reinigung P','Weg 4','open','e5200000-0000-0000-0000-000000000001','single',true),
 ('15000000-0000-0000-0000-0000000000c1','53333333-3333-3333-3333-333333333333','Kunde K','Reinigung K','Weg 5','open','e5300000-0000-0000-0000-000000000001','single',true),
 ('15000000-0000-0000-0000-0000000000d1','54444444-4444-4444-4444-444444444444','Kunde M','Reinigung M','Weg 6','open','e5400000-0000-0000-0000-000000000001','single',true),
 ('15000000-0000-0000-0000-0000000000e1','55555555-5555-5555-5555-555555555555','Kunde D','Reinigung D','Weg 7','open','e5500000-0000-0000-0000-000000000001','single',true),
 ('15000000-0000-0000-0000-0000000000f1','56666666-6666-6666-6666-666666666666','Kunde T','Reinigung T','Weg 8','open','e5600000-0000-0000-0000-000000000001','single',true),
 ('15000000-0000-0000-0000-0000000000f2','57777777-7777-7777-7777-777777777777','Kunde X','Reinigung X','Weg 9','open','e5700000-0000-0000-0000-000000000001','single',true);

create temp table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

-- =========================================================
-- SECTION S — Server-Dispatch ohne Client, Fan-out, Claim, sent_at, Concurrency
-- =========================================================

-- CASE 1: Mitarbeiter startet Job -> 1 Event; Fan-out ergibt GENAU die 2 aktiven
-- Admins der Firma (ohne Auslöser, ohne deaktivierten Admin, ohne Fremdfirma).
do $$
declare ev_cnt int; fo int; good int; total int;
begin
  perform set_config('request.jwt.claims','{"sub":"e5100000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  execute 'set local role authenticated';
  perform public.start_own_job('15000000-0000-0000-0000-0000000000a1');
  execute 'reset role';

  select count(*) into ev_cnt from public.notification_outbox where job_id='15000000-0000-0000-0000-0000000000a1' and event_type='job_started';
  select public.fanout_notification_events() into fo;
  select
    count(*) filter (where recipient_id in ('a5100000-0000-0000-0000-000000000001','a5100000-0000-0000-0000-000000000002')),
    count(*)
  into good, total
  from public.notification_deliveries d
  join public.notification_outbox o on o.id=d.outbox_id
  where o.job_id='15000000-0000-0000-0000-0000000000a1';
  insert into _r values (1,'Start -> 1 Event; Fan-out = genau die 2 gültigen Admins','1|2|2', ev_cnt||'|'||good||'|'||total);
  raise notice 'CASE 1 -> ev=% good=% total=%', ev_cnt, good, total;
end $$;

-- CASE 2: Serverseitiger Dispatch OHNE Client-Kick. Globaler Claim (Sweeper-Sicht,
-- nur S-Events existieren) -> processing, sent_at NULL. Zweiter Claim sofort -> 0
-- (in-flight wird übersprungen -> keine doppelte parallele Verarbeitung).
do $$
declare claimed1 int; sent_null_after_claim boolean; claimed2 int;
begin
  select count(*), bool_and(sent_at is null)
    into claimed1, sent_null_after_claim
  from (select delivery_id from public.claim_notification_deliveries(null,50,120)) c
  join public.notification_deliveries nd on nd.id=c.delivery_id;

  select count(*) into claimed2 from public.claim_notification_deliveries(null,50,120);

  insert into _r values (2,'Server-Claim: 2 processing, sent_at noch NULL; 2. Claim 0 (in-flight)','2|true|0', claimed1||'|'||sent_null_after_claim||'|'||claimed2);
  raise notice 'CASE 2 -> claimed1=% sentNull=% claimed2=%', claimed1, sent_null_after_claim, claimed2;
end $$;

-- CASE 3: Erfolgreicher Versand -> beide Deliveries sent, sent_at ERST JETZT gesetzt.
do $$
declare ev uuid; sent_cnt int; sentat_cnt int;
begin
  select o.id into ev from public.notification_outbox o where o.job_id='15000000-0000-0000-0000-0000000000a1' and o.event_type='job_started';
  perform public.complete_notification_delivery(d.id,'sent')
    from public.notification_deliveries d where d.outbox_id=ev;
  select count(*) filter (where status='sent'), count(*) filter (where sent_at is not null)
    into sent_cnt, sentat_cnt
  from public.notification_deliveries where outbox_id=ev;
  insert into _r values (3,'Nach Erfolg: beide sent + sent_at gesetzt','2|2', sent_cnt||'|'||sentat_cnt);
  raise notice 'CASE 3 -> sent=% sentat=%', sent_cnt, sentat_cnt;
end $$;

-- CASE 4: Doppelter Start (App-Neustart / Retry) -> KEIN zweites Event.
do $$
declare ev_cnt int; err text := 'OK';
begin
  perform set_config('request.jwt.claims','{"sub":"e5100000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  execute 'set local role authenticated';
  begin perform public.start_own_job('15000000-0000-0000-0000-0000000000a1'); exception when others then err:='ERR:'||sqlstate; end;
  execute 'reset role';
  select count(*) into ev_cnt from public.notification_outbox where job_id='15000000-0000-0000-0000-0000000000a1' and event_type='job_started';
  insert into _r values (4,'Doppelter Start: kein zweites Event, kein Fehler','1|OK', ev_cnt||'|'||err);
  raise notice 'CASE 4 -> ev=% err=%', ev_cnt, err;
end $$;

-- CASE 5: complete_own_job auf NICHT gestarteten (open) Job -> wirft (kein
-- vorgetäuschter Erfolg), kein Event.
do $$
declare v text; ev_cnt int;
begin
  perform set_config('request.jwt.claims','{"sub":"e5100000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  execute 'set local role authenticated';
  begin perform public.complete_own_job('15000000-0000-0000-0000-0000000000a2'); v:='ALLOWED'; exception when others then v:='BLOCKED'; end;
  execute 'reset role';
  select count(*) into ev_cnt from public.notification_outbox where job_id='15000000-0000-0000-0000-0000000000a2';
  insert into _r values (5,'Complete auf open-Job: wirft, kein Event','BLOCKED|0', v||'|'||ev_cnt);
  raise notice 'CASE 5 -> % ev=%', v, ev_cnt;
end $$;

-- CASE 6: Fremder Job (empS2 zugewiesen) durch empS -> nicht erlaubt, kein Event.
do $$
declare v text; ev_cnt int;
begin
  perform set_config('request.jwt.claims','{"sub":"e5100000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  execute 'set local role authenticated';
  begin perform public.start_own_job('15000000-0000-0000-0000-0000000000a3'); v:='ALLOWED'; exception when others then v:='BLOCKED'; end;
  execute 'reset role';
  select count(*) into ev_cnt from public.notification_outbox where job_id='15000000-0000-0000-0000-0000000000a3';
  insert into _r values (6,'Fremder Job: nicht erlaubt, kein Event','BLOCKED|0', v||'|'||ev_cnt);
  raise notice 'CASE 6 -> % ev=%', v, ev_cnt;
end $$;

-- =========================================================
-- SECTION P — Teilerfolg: nur der fehlgeschlagene Empfänger wird erneut versucht
-- =========================================================
do $$
declare ev uuid; d_p1 uuid; d_p2 uuid; p1_status text; p2_status text; p2_attempts int;
        p2_future boolean; reclaim_cnt int; reclaim_is_p2 boolean;
begin
  perform set_config('request.jwt.claims','{"sub":"e5200000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  execute 'set local role authenticated';
  perform public.start_own_job('15000000-0000-0000-0000-0000000000b1');
  execute 'reset role';
  perform public.fanout_notification_events('52222222-2222-2222-2222-222222222222');

  select o.id into ev from public.notification_outbox o where o.job_id='15000000-0000-0000-0000-0000000000b1';
  -- claim (scoped auf Firma P)
  perform public.claim_notification_deliveries('52222222-2222-2222-2222-222222222222',50,120);
  select id into d_p1 from public.notification_deliveries where outbox_id=ev and recipient_id='a5200000-0000-0000-0000-000000000001';
  select id into d_p2 from public.notification_deliveries where outbox_id=ev and recipient_id='a5200000-0000-0000-0000-000000000002';

  perform public.complete_notification_delivery(d_p1,'sent');
  perform public.complete_notification_delivery(d_p2,'retry','expo temporär nicht erreichbar');

  select status into p1_status from public.notification_deliveries where id=d_p1;
  select status, attempts, next_attempt_at > now() into p2_status, p2_attempts, p2_future from public.notification_deliveries where id=d_p2;

  -- sofortiger Claim: P2 ist noch nicht fällig (Backoff), P1 ist sent -> 0
  select count(*) into reclaim_cnt from public.claim_notification_deliveries('52222222-2222-2222-2222-222222222222',50,120);

  -- Backoff simulieren: P2 fällig machen; erneuter Claim -> NUR P2
  update public.notification_deliveries set next_attempt_at=now() where id=d_p2 and status='pending';
  select count(*)=1 and bool_and(delivery_id=d_p2) into reclaim_is_p2 from public.claim_notification_deliveries('52222222-2222-2222-2222-222222222222',50,120);

  insert into _r values (7,'Teilerfolg P1=sent, P2=retry(pending,Backoff)','sent|pending|1|true', p1_status||'|'||p2_status||'|'||p2_attempts||'|'||p2_future);
  insert into _r values (8,'Vor Backoff kein Reclaim (0); danach NUR P2','0|true', reclaim_cnt||'|'||reclaim_is_p2);
  raise notice 'SECTION P -> p1=% p2=% att=% future=% reclaim0=% onlyP2=%', p1_status,p2_status,p2_attempts,p2_future,reclaim_cnt,reclaim_is_p2;
end $$;

-- =========================================================
-- SECTION K — Crash nach Claim, vor Versand -> Reclaim nach Timeout
-- =========================================================
do $$
declare ev uuid; dlv uuid; a1 int; a2 int; st text;
begin
  perform set_config('request.jwt.claims','{"sub":"e5300000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  execute 'set local role authenticated';
  perform public.start_own_job('15000000-0000-0000-0000-0000000000c1');
  execute 'reset role';
  perform public.fanout_notification_events('53333333-3333-3333-3333-333333333333');
  select o.id into ev from public.notification_outbox o where o.job_id='15000000-0000-0000-0000-0000000000c1';
  select id into dlv from public.notification_deliveries where outbox_id=ev;

  perform public.claim_notification_deliveries('53333333-3333-3333-3333-333333333333',50,120);
  select attempts into a1 from public.notification_deliveries where id=dlv;   -- 1, processing

  -- Simuliere Absturz: kein complete; claimed_at künstlich altern lassen.
  update public.notification_deliveries set claimed_at = now() - interval '10 minutes' where id=dlv;

  -- Reclaim mit Timeout 120s -> hängende processing-Zeile wird erneut übernommen.
  perform public.claim_notification_deliveries('53333333-3333-3333-3333-333333333333',50,120);
  select attempts, status into a2, st from public.notification_deliveries where id=dlv;

  insert into _r values (9,'Hängende processing-Zeile nach Timeout erneut geclaimt (attempts 1->2)','1|2|processing', a1||'|'||a2||'|'||st);
  raise notice 'SECTION K -> a1=% a2=% st=%', a1, a2, st;
end $$;

-- =========================================================
-- SECTION M — Maximalversuche erreicht -> failed
-- =========================================================
do $$
declare ev uuid; dlv uuid; final_status text; final_attempts int; i int;
begin
  perform set_config('request.jwt.claims','{"sub":"e5400000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  execute 'set local role authenticated';
  perform public.start_own_job('15000000-0000-0000-0000-0000000000d1');
  execute 'reset role';
  perform public.fanout_notification_events('54444444-4444-4444-4444-444444444444');
  select o.id into ev from public.notification_outbox o where o.job_id='15000000-0000-0000-0000-0000000000d1';
  select id into dlv from public.notification_deliveries where outbox_id=ev;

  for i in 1..5 loop
    update public.notification_deliveries set next_attempt_at=now() where id=dlv and status='pending';
    perform public.claim_notification_deliveries('54444444-4444-4444-4444-444444444444',50,120);
    perform public.complete_notification_delivery(dlv,'retry','temporärer Fehler', 5);
  end loop;

  select status, attempts into final_status, final_attempts from public.notification_deliveries where id=dlv;
  insert into _r values (10,'Nach 5 Versuchen -> failed','failed|5', final_status||'|'||final_attempts);
  raise notice 'SECTION M -> status=% attempts=%', final_status, final_attempts;
end $$;

-- =========================================================
-- SECTION D — DeviceNotRegistered -> Token gelöscht, permanent failed, kein Retry
-- =========================================================
do $$
declare ev uuid; dlv uuid; st text; tok text; reclaim_cnt int;
begin
  perform set_config('request.jwt.claims','{"sub":"e5500000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  execute 'set local role authenticated';
  perform public.start_own_job('15000000-0000-0000-0000-0000000000e1');
  execute 'reset role';
  perform public.fanout_notification_events('55555555-5555-5555-5555-555555555555');
  select o.id into ev from public.notification_outbox o where o.job_id='15000000-0000-0000-0000-0000000000e1';
  select id into dlv from public.notification_deliveries where outbox_id=ev;

  perform public.claim_notification_deliveries('55555555-5555-5555-5555-555555555555',50,120);
  -- Edge Function bei DeviceNotRegistered: Token säubern + permanent_fail.
  update public.profiles set expo_push_token=null where id='a5500000-0000-0000-0000-000000000001';
  perform public.complete_notification_delivery(dlv,'permanent_fail','DeviceNotRegistered');

  select status into st from public.notification_deliveries where id=dlv;
  select expo_push_token into tok from public.profiles where id='a5500000-0000-0000-0000-000000000001';
  -- Kein endloser Retry: erneuter Claim liefert nichts (failed ist terminal).
  update public.notification_deliveries set next_attempt_at=now() where id=dlv;
  select count(*) into reclaim_cnt from public.claim_notification_deliveries('55555555-5555-5555-5555-555555555555',50,120);

  insert into _r values (11,'DeviceNotRegistered: failed, Token=null, kein Reclaim','failed|NULL|0', st||'|'||coalesce(tok,'NULL')||'|'||reclaim_cnt);
  raise notice 'SECTION D -> st=% tok=% reclaim=%', st, coalesce(tok,'NULL'), reclaim_cnt;
end $$;

-- =========================================================
-- SECTION T — Token-Resilienz: Admin ohne Token beim Event bekommt trotzdem
-- eine Delivery; nach Token-Registrierung wird sie zustellbar. Kein Duplikat bei
-- wiederholtem Fan-out.
-- =========================================================
do $$
declare
  ev uuid;
  fanned int; fo2 int;
  del_total int; del_t2 int;
  d_t2 uuid; claim_token text; t2_status text; t2_err text; t2_att int; t2_future boolean;
  reclaim_after_token boolean; final_status text;
begin
  perform set_config('request.jwt.claims','{"sub":"e5600000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  execute 'set local role authenticated';
  perform public.start_own_job('15000000-0000-0000-0000-0000000000f1');
  execute 'reset role';

  -- Fan-out OHNE Token-Filter -> beide Admins (auch der tokenlose T2) bekommen Delivery.
  select public.fanout_notification_events('56666666-6666-6666-6666-666666666666') into fanned;
  select o.id into ev from public.notification_outbox o where o.job_id='15000000-0000-0000-0000-0000000000f1';
  select count(*),
         count(*) filter (where recipient_id='a5600000-0000-0000-0000-000000000002')
    into del_total, del_t2
  from public.notification_deliveries where outbox_id=ev;

  -- Wiederholter Fan-out erzeugt KEINE Duplikate.
  select public.fanout_notification_events('56666666-6666-6666-6666-666666666666') into fo2;
  select count(*) into del_total from public.notification_deliveries where outbox_id=ev;

  insert into _r values (12,'Tokenloser Admin bekommt Delivery; Fan-out idempotent','2|1|2', del_total||'|'||del_t2||'|'||del_total);
  raise notice 'SECTION T fanout -> total=% t2=% (nach 2. fanout total=%)', del_total, del_t2, del_total;

  -- Claim: T2 kommt mit expo_push_token = NULL zurück. Dispatcher -> 'missing_token'.
  select id into d_t2 from public.notification_deliveries where outbox_id=ev and recipient_id='a5600000-0000-0000-0000-000000000002';
  select expo_push_token into claim_token
  from public.claim_notification_deliveries('56666666-6666-6666-6666-666666666666',50,120)
  where recipient_id='a5600000-0000-0000-0000-000000000002';

  perform public.complete_notification_delivery(d_t2,'missing_token');
  select status, last_error, attempts, next_attempt_at > now()
    into t2_status, t2_err, t2_att, t2_future
  from public.notification_deliveries where id=d_t2;

  insert into _r values (13,'missing_token: pending, last_error, attempts zurueckgesetzt, Backoff',
    'pending|missing_push_token|0|true', t2_status||'|'||t2_err||'|'||t2_att||'|'||t2_future);
  raise notice 'SECTION T defer -> claimTok=% status=% err=% att=% future=%', coalesce(claim_token,'NULL'), t2_status, t2_err, t2_att, t2_future;

  -- Token wird registriert + Backoff abgelaufen -> Delivery wird beim naechsten
  -- faelligen Claim geliefert und kann gesendet werden.
  update public.profiles set expo_push_token='Tok-T2-neu' where id='a5600000-0000-0000-0000-000000000002';
  update public.notification_deliveries set next_attempt_at=now() where id=d_t2;
  select bool_and(expo_push_token='Tok-T2-neu') into reclaim_after_token
  from public.claim_notification_deliveries('56666666-6666-6666-6666-666666666666',50,120)
  where recipient_id='a5600000-0000-0000-0000-000000000002';
  perform public.complete_notification_delivery(d_t2,'sent');
  select status into final_status from public.notification_deliveries where id=d_t2;

  insert into _r values (14,'Nach Token-Registrierung: Claim liefert Token, Versand -> sent','true|sent', reclaim_after_token||'|'||final_status);
  raise notice 'SECTION T retry -> reclaimWithToken=% final=%', reclaim_after_token, final_status;
end $$;

-- =========================================================
-- SECTION X — Backfill: verlorenes Event (fanned_out gesetzt, KEINE Deliveries)
-- bekommt Deliveries fuer aktive Admins nacherzeugt; idempotent (genau einmal);
-- inaktiver Admin ausgeschlossen.
-- =========================================================
do $$
declare
  ev uuid;
  created_x1 int; created_x2 int; created_x3 int; created_total int;
  total_after_2nd int;
begin
  -- Verlorenes Event simulieren: Outbox-Zeile MIT fanned_out_at, aber OHNE Delivery.
  insert into public.notification_outbox (
    company_id, job_id, event_type, job_status, employee_id, employee_name,
    customer_name, service_name, fanned_out_at
  )
  values (
    '57777777-7777-7777-7777-777777777777', '15000000-0000-0000-0000-0000000000f2',
    'job_started', 'in_progress', 'e5700000-0000-0000-0000-000000000001', 'Mitarbeiter X1',
    'Kunde X', 'Reinigung X', now()
  )
  returning id into ev;

  -- Exakt die Backfill-Anweisung aus Migration 20260717000002 (global, idempotent).
  insert into public.notification_deliveries (outbox_id, company_id, recipient_id, next_attempt_at)
  select o.id, o.company_id, p.id, now()
  from public.notification_outbox o
  join public.profiles p
    on p.company_id = o.company_id
   and p.role = 'admin'
   and p.is_active = true
   and (o.employee_id is null or p.id <> o.employee_id)
  where o.fanned_out_at is not null
    and not exists (select 1 from public.notification_deliveries d where d.outbox_id = o.id)
  on conflict (outbox_id, recipient_id) do nothing;

  select
    count(*) filter (where recipient_id='a5700000-0000-0000-0000-000000000001'),
    count(*) filter (where recipient_id='a5700000-0000-0000-0000-000000000002'),
    count(*) filter (where recipient_id='a5700000-0000-0000-0000-000000000003'),
    count(*)
  into created_x1, created_x2, created_x3, created_total
  from public.notification_deliveries where outbox_id=ev;

  insert into _r values (15,'Backfill: X1+X2 je 1 Delivery, X3 inaktiv=0, gesamt 2','1|1|0|2',
    created_x1||'|'||created_x2||'|'||created_x3||'|'||created_total);
  raise notice 'SECTION X backfill -> x1=% x2=% x3=% total=%', created_x1, created_x2, created_x3, created_total;

  -- Zweiter Lauf -> keine Duplikate (Idempotenz ueber UNIQUE(outbox_id,recipient_id)).
  insert into public.notification_deliveries (outbox_id, company_id, recipient_id, next_attempt_at)
  select o.id, o.company_id, p.id, now()
  from public.notification_outbox o
  join public.profiles p
    on p.company_id = o.company_id
   and p.role = 'admin'
   and p.is_active = true
   and (o.employee_id is null or p.id <> o.employee_id)
  where o.fanned_out_at is not null
    and not exists (select 1 from public.notification_deliveries d where d.outbox_id = o.id)
  on conflict (outbox_id, recipient_id) do nothing;

  select count(*) into total_after_2nd from public.notification_deliveries where outbox_id=ev;
  insert into _r values (16,'Backfill idempotent: 2. Lauf erzeugt keine Duplikate','2', total_after_2nd::text);
  raise notice 'SECTION X idempotent -> total_after_2nd=%', total_after_2nd;
end $$;

-- =========================================================
-- Ergebnisübersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
  case when erwartet = ergebnis then 'PASS' else 'FAIL' end as verdikt
from _r order by case_no;

rollback;
