-- =========================================================
-- TEST: admin_create_absence respektiert das Urlaubskonto
-- (Migration 20260826000002_admin_create_absence_respects_vacation_ledger)
-- =========================================================
-- Deckt den auf Staging nachgewiesenen Pre-Beta-Blocker ab: admin_create_
-- absence(type='vacation') landete bisher IMMER direkt bei status='approved'
-- — auch fuer Mitarbeiter mit gefuehrtem Urlaubskonto (profiles.
-- vacation_management_enabled=true) — ohne jede vacation_ledger-Zeile und
-- ohne vacation_deducted_days_snapshot, obwohl die Zeile ab sofort ueberall
-- als wirksamer Urlaub zaehlt (isOperationallyActiveAbsence prueft nur
-- status='approved').
--
-- Alle Zugriffe laufen als echte Rollen (SET ROLE + request.jwt.claims),
-- also ueber denselben Pfad wie die App ueber PostgREST.
--
-- HINWEIS ZU „VERWEIGERT"-PFADEN: der lokale Supabase-Container stuerzt bei
-- FEHLENDEM PRIVILEG ab (siehe job_assignments_rls.test.sql). Alle
-- Ablehnungen hier laufen ueber die RPC-eigene Rollen-/Firmenpruefung
-- (raise exception, sauber abgefangen per BEGIN/EXCEPTION), nicht ueber ein
-- fehlendes GRANT.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende, keine
-- Produktionsdaten. Ausfuehren lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/admin_create_absence_vacation_ledger.test.sql
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma A = 51…1 | Firma B = 51…2
-- Admin A  = 52…1
-- X = 52…2  (Firma A, vacation_management_enabled=true, Konto 2026 mit 24 Tagen)
-- Y = 52…3  (Firma A, vacation_management_enabled=false — Standardfall)
-- Admin B  = 52…4 (Firma B, fuer Cross-Company-Faelle)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','52000000-0000-0000-0000-000000000001','authenticated','authenticated','z-adminA@example.test','{"full_name":"Admin A"}'),
    ('00000000-0000-0000-0000-000000000000','52000000-0000-0000-0000-000000000002','authenticated','authenticated','z-x@example.test','{"full_name":"Xenia Konto"}'),
    ('00000000-0000-0000-0000-000000000000','52000000-0000-0000-0000-000000000003','authenticated','authenticated','z-y@example.test','{"full_name":"Yannick Ohne Konto"}'),
    ('00000000-0000-0000-0000-000000000000','52000000-0000-0000-0000-000000000004','authenticated','authenticated','z-adminB@example.test','{"full_name":"Admin B"}');
end $$;

-- Der auth-Trigger handle_new_user ist in der lokalen Baseline nicht
-- enthalten — Profile werden deshalb explizit angelegt.
insert into public.profiles (id, full_name) values
  ('52000000-0000-0000-0000-000000000001','Admin A'),
  ('52000000-0000-0000-0000-000000000002','Xenia Konto'),
  ('52000000-0000-0000-0000-000000000003','Yannick Ohne Konto'),
  ('52000000-0000-0000-0000-000000000004','Admin B')
on conflict (id) do nothing;

insert into public.companies (id,name,slug) values
  ('51000000-0000-0000-0000-000000000001','Ledger Firma A','ledger-firma-a-test'),
  ('51000000-0000-0000-0000-000000000002','Ledger Firma B','ledger-firma-b-test');

update public.profiles set company_id='51000000-0000-0000-0000-000000000001', role='admin',    is_active=true
  where id='52000000-0000-0000-0000-000000000001';
update public.profiles set company_id='51000000-0000-0000-0000-000000000001', role='employee', is_active=true,
  vacation_management_enabled=true, vacation_annual_entitlement_days=24
  where id='52000000-0000-0000-0000-000000000002';
update public.profiles set company_id='51000000-0000-0000-0000-000000000001', role='employee', is_active=true,
  vacation_management_enabled=false
  where id='52000000-0000-0000-0000-000000000003';
update public.profiles set company_id='51000000-0000-0000-0000-000000000002', role='admin',    is_active=true
  where id='52000000-0000-0000-0000-000000000004';

create temporary table _r (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid::text,'role','authenticated')::text, true);
end $f$;

-- ── Urlaubskonto fuer X initialisieren (Jahr 2026, 24 Tage Anspruch) ──
do $$
declare v_year_id uuid;
begin
  perform pg_temp.act_as('52000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  v_year_id := public.admin_initialize_vacation_year('52000000-0000-0000-0000-000000000002', 2026);
  execute 'reset role';
  insert into _r values (0,'Setup: Urlaubskonto X/2026 initialisiert (24 Tage)','not null',
    case when v_year_id is not null then 'not null' else 'null' end);
end $$;


-- =========================================================
-- CASE A — Admin legt Urlaub fuer Y (KEIN Konto) an
-- =========================================================
-- Erwartet: unveraendertes Alt-Verhalten — sofort approved,
-- reviewed_by/at gesetzt, kein Ledger-Zwang.
do $$
declare v_status text; v_reviewed_by text; v_snapshot text;
begin
  perform pg_temp.act_as('52000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select status::text, reviewed_by::text, coalesce(vacation_deducted_days_snapshot::text,'NULL')
    into v_status, v_reviewed_by, v_snapshot
  from public.admin_create_absence(
    '52000000-0000-0000-0000-000000000003', 'vacation', '2026-09-01', '2026-09-03', 'QA CASE A'
  );
  execute 'reset role';
  insert into _r values (1,'CASE A: Urlaub fuer Y (kein Konto) -> sofort approved',
    'status=approved/reviewed_by=set/snapshot=NULL',
    'status='||v_status||'/reviewed_by='||(case when v_reviewed_by is not null then 'set' else 'NULL' end)||'/snapshot='||v_snapshot);
  raise notice 'CASE A -> %', v_status;
end $$;


-- =========================================================
-- CASE B — Admin legt Urlaub fuer X (Konto aktiv) an
-- =========================================================
-- Erwartet: status=requested, reviewed_by/at NULL, snapshot NULL,
-- KEINE Ledger-Zeile.
do $$
declare
  v_id uuid; v_status text; v_reviewed_by text; v_reviewed_at text; v_snapshot text;
  v_ledger_rows int;
begin
  perform pg_temp.act_as('52000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select id, status::text, reviewed_by::text, reviewed_at::text,
         coalesce(vacation_deducted_days_snapshot::text,'NULL')
    into v_id, v_status, v_reviewed_by, v_reviewed_at, v_snapshot
  from public.admin_create_absence(
    '52000000-0000-0000-0000-000000000002', 'vacation', '2026-09-07', '2026-09-11', 'QA CASE B'
  );
  execute 'reset role';

  select count(*) into v_ledger_rows from public.vacation_ledger where absence_id = v_id;

  insert into _r values (2,'CASE B: Urlaub fuer X (Konto aktiv) -> requested, kein Ledger',
    'status=requested/reviewed_by=NULL/reviewed_at=NULL/snapshot=NULL/ledger=0',
    'status='||v_status||'/reviewed_by='||coalesce(v_reviewed_by,'NULL')||'/reviewed_at='
      ||(case when v_reviewed_at is null then 'NULL' else 'set' end)
      ||'/snapshot='||v_snapshot||'/ledger='||v_ledger_rows::text);
  raise notice 'CASE B -> %', v_status;

  -- Fuer CASE C/D weiterreichen.
  create temporary table _case_b (id uuid) on commit drop;
  insert into _case_b values (v_id);
end $$;


-- =========================================================
-- CASE C — Admin genehmigt den CASE-B-Antrag ueber admin_review_vacation
-- =========================================================
-- Erwartet: status=approved, snapshot korrekt, approved_vacation-Zeile,
-- Saldo korrekt reduziert (24 -> 24-5=19, 5 Kalendertage Mo-Fr).
do $$
declare
  v_case_b_id uuid;
  v_status text; v_snapshot numeric; v_ledger_amount numeric;
  v_balance numeric;
begin
  select id into v_case_b_id from _case_b;

  perform pg_temp.act_as('52000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select status::text, vacation_deducted_days_snapshot
    into v_status, v_snapshot
  from public.admin_review_vacation(v_case_b_id, 'approved', 'QA CASE C', jsonb_build_object('2026', 5));
  execute 'reset role';

  select amount_days into v_ledger_amount
  from public.vacation_ledger
  where absence_id = v_case_b_id and entry_type = 'approved_vacation';

  select sum(vl.amount_days) into v_balance
  from public.vacation_ledger vl
  join public.vacation_years vy on vy.id = vl.vacation_year_id
  where vy.employee_id = '52000000-0000-0000-0000-000000000002' and vy.year = 2026;

  insert into _r values (3,'CASE C: Genehmigung des admin-erfassten Antrags via admin_review_vacation',
    'status=approved/snapshot=5.00/ledger=-5.00/balance=19.00',
    'status='||v_status||'/snapshot='||coalesce(v_snapshot::text,'NULL')||'/ledger='||coalesce(v_ledger_amount::text,'NULL')||'/balance='||coalesce(v_balance::text,'NULL'));
  raise notice 'CASE C -> status=% snapshot=% ledger=% balance=%', v_status, v_snapshot, v_ledger_amount, v_balance;
end $$;


-- =========================================================
-- CASE D — Admin lehnt einen admin-erfassten, noch offenen Antrag ab
-- =========================================================
-- Neuer, separater admin-erfasster Urlaub fuer X (Konto aktiv), diesmal
-- abgelehnt statt genehmigt. Erwartet: status=rejected, KEINE Ledger-Zeile,
-- Saldo bleibt bei 19.00 (aus CASE C).
do $$
declare
  v_id uuid; v_status text;
  v_ledger_rows int; v_balance numeric;
begin
  perform pg_temp.act_as('52000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select id into v_id
  from public.admin_create_absence(
    '52000000-0000-0000-0000-000000000002', 'vacation', '2026-10-05', '2026-10-06', 'QA CASE D - wird abgelehnt'
  );
  select status::text into v_status
  from public.admin_review_vacation(v_id, 'rejected', 'QA CASE D reject', null);
  execute 'reset role';

  select count(*) into v_ledger_rows from public.vacation_ledger where absence_id = v_id;
  select sum(vl.amount_days) into v_balance
  from public.vacation_ledger vl
  join public.vacation_years vy on vy.id = vl.vacation_year_id
  where vy.employee_id = '52000000-0000-0000-0000-000000000002' and vy.year = 2026;

  insert into _r values (4,'CASE D: admin-erfasster Antrag wird abgelehnt -> kein Ledger-Effekt',
    'status=rejected/ledger=0/balance=19.00',
    'status='||v_status||'/ledger='||v_ledger_rows::text||'/balance='||coalesce(v_balance::text,'NULL'));
  raise notice 'CASE D -> %', v_status;
end $$;


-- =========================================================
-- CASE E — Krankheit ueber admin_create_absence bleibt unveraendert
-- =========================================================
-- Regressionsschutz: Krankheit landet unabhaengig vom Urlaubskonto-Status
-- des Mitarbeiters weiterhin bei status=reported, reviewed_by/at NULL.
do $$
declare v_status text; v_reviewed_by text; v_reviewed_at text;
begin
  perform pg_temp.act_as('52000000-0000-0000-0000-000000000001');
  execute 'set local role authenticated';
  select status::text, reviewed_by::text, reviewed_at::text
    into v_status, v_reviewed_by, v_reviewed_at
  from public.admin_create_absence(
    '52000000-0000-0000-0000-000000000002', 'sickness', '2026-09-20', null, 'QA CASE E'
  );
  execute 'reset role';
  insert into _r values (5,'CASE E: Krankheit via admin_create_absence unveraendert',
    'status=reported/reviewed_by=NULL/reviewed_at=NULL',
    'status='||v_status||'/reviewed_by='||coalesce(v_reviewed_by,'NULL')||'/reviewed_at='||coalesce(v_reviewed_at,'NULL'));
  raise notice 'CASE E -> %', v_status;
end $$;


-- =========================================================
-- CASE F — Autorisierung bleibt unveraendert
-- =========================================================

-- CASE F1: Mitarbeiterrolle darf admin_create_absence nicht aufrufen.
do $$
declare v_result text;
begin
  perform pg_temp.act_as('52000000-0000-0000-0000-000000000002');
  execute 'set local role authenticated';
  begin
    perform public.admin_create_absence(
      '52000000-0000-0000-0000-000000000003', 'vacation', '2026-11-02', '2026-11-03', 'QA CASE F1'
    );
    v_result := 'AKZEPTIERT';
  exception when others then v_result := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (6,'CASE F1: Mitarbeiterrolle darf admin_create_absence nicht aufrufen','ABGELEHNT',v_result);
  raise notice 'CASE F1 -> %', v_result;
end $$;

-- CASE F2: Admin einer ANDEREN Firma kann fuer X keine Abwesenheit anlegen.
do $$
declare v_result text;
begin
  perform pg_temp.act_as('52000000-0000-0000-0000-000000000004');
  execute 'set local role authenticated';
  begin
    perform public.admin_create_absence(
      '52000000-0000-0000-0000-000000000002', 'vacation', '2026-11-09', '2026-11-10', 'QA CASE F2'
    );
    v_result := 'AKZEPTIERT';
  exception when others then v_result := 'ABGELEHNT';
  end;
  execute 'reset role';
  insert into _r values (7,'CASE F2: Admin ANDERER Firma kann fuer X keine Abwesenheit anlegen','ABGELEHNT',v_result);
  raise notice 'CASE F2 -> %', v_result;
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
    raise exception 'ADMIN CREATE ABSENCE VACATION LEDGER TEST: % von % Faellen FEHLGESCHLAGEN', fails, gesamt;
  end if;
  raise notice 'ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
