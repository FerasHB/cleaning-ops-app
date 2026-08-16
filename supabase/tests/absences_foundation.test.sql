-- =========================================================
-- TEST: Abwesenheiten — Grundlage (Phase A)
-- (Migration 20260816000000_absences_foundation)
-- =========================================================
-- Prueft Schema-Constraints, RLS (Lese-Policies + fehlende Schreibrechte)
-- und alle sieben SECURITY-DEFINER-RPCs (Mitarbeiter-Selbstbedienung +
-- Admin-Review/manuelle Erfassung), inklusive Ueberlappungsregeln und
-- Bewahrung der Historie nach Kontoloeschung.
--
-- Alle RPC-Aufrufe laufen als echte Rolle (SET LOCAL ROLE + request.jwt.
-- claims), also ueber denselben Pfad wie die App ueber PostgREST.
--
-- HINWEIS ZU „VERWEIGERT"-PFADEN (siehe job_assignments_rls.test.sql):
-- der lokale Supabase-Container stuerzt bei einem echten permission-denied-
-- Fehler (fehlendes GRANT) ab. Faelle, deren Verweigerung ueber ein
-- fehlendes Privileg laeuft (direkte Client-Schreibversuche auf die
-- Tabelle), werden deshalb ueber role_table_grants nachgewiesen statt durch
-- einen echten Aufruf. Verweigerungen ueber RLS (gefilterte Zeilen) oder
-- ueber eine RPC-interne Ausnahme (raise exception) loesen KEINEN
-- permission-denied-Fehler aus und werden ganz normal ausgefuehrt.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende, keine
-- Produktionsdaten. Ausfuehren lokal:
--   docker exec -i supabase_db_<projekt> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/absences_foundation.test.sql
-- =========================================================

begin;

-- ── Fixdaten ──
-- Firma E = e1…1 | Firma F (fremd) = e1…2
-- Admin E   = e2…1
-- Mitarbeiter A (Haupt-Akteur) = e2…2
-- Mitarbeiter B (Cross-Employee-Angriffe) = e2…3
-- Mitarbeiter C (inaktiv) = e2…4
-- Mitarbeiter D (wird geloescht) = e2…5
-- Admin F (fremde Firma) = e2…6
-- Mitarbeiter F (fremde Firma) = e2…7
-- Admin H (reviewt und wird DANACH geloescht, Regressionsfall reviewed_by) = e2…8
do $$
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000001','authenticated','authenticated','abs-adminE@example.test','{"full_name":"Admin E"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000002','authenticated','authenticated','abs-a@example.test','{"full_name":"Anna A"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000003','authenticated','authenticated','abs-b@example.test','{"full_name":"Bert B"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000004','authenticated','authenticated','abs-c-inaktiv@example.test','{"full_name":"Cora Inaktiv"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000005','authenticated','authenticated','abs-d-del@example.test','{"full_name":"Dirk Loeschbar"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000006','authenticated','authenticated','abs-adminF@example.test','{"full_name":"Admin F"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000007','authenticated','authenticated','abs-f@example.test','{"full_name":"Finn Fremd"}'),
    ('00000000-0000-0000-0000-000000000000','e2000000-0000-0000-0000-000000000008','authenticated','authenticated','abs-adminH-del@example.test','{"full_name":"Admin H"}');
end $$;

insert into public.profiles (id, full_name) values
  ('e2000000-0000-0000-0000-000000000001','Admin E'),
  ('e2000000-0000-0000-0000-000000000002','Anna A'),
  ('e2000000-0000-0000-0000-000000000003','Bert B'),
  ('e2000000-0000-0000-0000-000000000004','Cora Inaktiv'),
  ('e2000000-0000-0000-0000-000000000005','Dirk Loeschbar'),
  ('e2000000-0000-0000-0000-000000000006','Admin F'),
  ('e2000000-0000-0000-0000-000000000007','Finn Fremd'),
  ('e2000000-0000-0000-0000-000000000008','Admin H')
on conflict (id) do nothing;

insert into public.companies (id, name, slug) values
  ('e1000000-0000-0000-0000-000000000001','Abs Firma E','abs-firma-e-test'),
  ('e1000000-0000-0000-0000-000000000002','Abs Firma F','abs-firma-f-test');

update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='admin',    is_active=true  where id in ('e2000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000008');
update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=true  where id in ('e2000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000005');
update public.profiles set company_id='e1000000-0000-0000-0000-000000000001', role='employee', is_active=false where id='e2000000-0000-0000-0000-000000000004';
update public.profiles set company_id='e1000000-0000-0000-0000-000000000002', role='admin',    is_active=true  where id='e2000000-0000-0000-0000-000000000006';
update public.profiles set company_id='e1000000-0000-0000-0000-000000000002', role='employee', is_active=true  where id='e2000000-0000-0000-0000-000000000007';

create temporary table _abs (case_no int, beschreibung text, erwartet text, ergebnis text) on commit drop;
create temporary table _state (k text primary key, v text) on commit drop;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role','authenticated')::text, true);
end $f$;

create or replace function pg_temp.remember(p_key text, p_val uuid) returns void language sql as $f$
  insert into _state values (p_key, p_val::text) on conflict (k) do update set v = excluded.v;
$f$;

create or replace function pg_temp.recall(p_key text) returns uuid language sql as $f$
  select v::uuid from _state where k = p_key;
$f$;


-- =========================================================
-- A. SCHEMA-CONSTRAINTS
-- =========================================================
-- Direkte INSERTs als postgres (Superuser, umgeht RLS) — geprueft wird
-- ausschliesslich der CHECK-Constraint, nicht der RPC-Pfad.

-- CASE 1: gueltiger Urlaub-Zustand wird akzeptiert.
do $$
declare v text;
begin
  begin
    insert into public.employee_absences (company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, created_by)
    values ('e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','vacation','requested', current_date+10, current_date+12, 'e2000000-0000-0000-0000-000000000002');
    v := 'OK';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  insert into _abs values (1,'Gueltiger Urlaub-Zustand (requested) wird akzeptiert','OK',v);
  raise notice 'CASE 1 -> %', v;
end $$;

-- CASE 2: ungueltige Typ/Status-Kombination (Urlaub + reported) wird abgelehnt.
do $$
declare v text;
begin
  begin
    insert into public.employee_absences (company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, created_by)
    values ('e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','vacation','reported', current_date+20, current_date+21, 'e2000000-0000-0000-0000-000000000002');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  insert into _abs values (2,'Ungueltige Kombination vacation/reported wird abgelehnt','ABGELEHNT',v);
  raise notice 'CASE 2 -> %', v;
end $$;

-- CASE 3: ungueltige Typ/Status-Kombination (Krankheit + approved) wird abgelehnt.
do $$
declare v text;
begin
  begin
    insert into public.employee_absences (company_id, employee_id, employee_name_snapshot, type, status, start_date, created_by)
    values ('e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','sickness','approved', current_date, 'e2000000-0000-0000-0000-000000000002');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  insert into _abs values (3,'Ungueltige Kombination sickness/approved wird abgelehnt','ABGELEHNT',v);
  raise notice 'CASE 3 -> %', v;
end $$;

-- CASE 4: Krankheit mit end_date NULL ist gueltig.
do $$
declare v text;
begin
  begin
    insert into public.employee_absences (company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, created_by)
    values ('e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','sickness','reported', current_date, null, 'e2000000-0000-0000-0000-000000000002');
    v := 'OK';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  insert into _abs values (4,'Krankheit mit end_date=NULL ist gueltig','OK',v);
  raise notice 'CASE 4 -> %', v;
end $$;

-- CASE 5: Urlaub mit end_date NULL wird abgelehnt.
do $$
declare v text;
begin
  begin
    insert into public.employee_absences (company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, created_by)
    values ('e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','vacation','requested', current_date+30, null, 'e2000000-0000-0000-0000-000000000002');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  insert into _abs values (5,'Urlaub mit end_date=NULL wird abgelehnt','ABGELEHNT',v);
  raise notice 'CASE 5 -> %', v;
end $$;

-- CASE 6: end_date vor start_date wird abgelehnt (Urlaub).
do $$
declare v text;
begin
  begin
    insert into public.employee_absences (company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, created_by)
    values ('e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','vacation','requested', current_date+40, current_date+39, 'e2000000-0000-0000-0000-000000000002');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  insert into _abs values (6,'end_date vor start_date wird abgelehnt (Urlaub)','ABGELEHNT',v);
  raise notice 'CASE 6 -> %', v;
end $$;

-- CASE 7: end_date vor start_date wird abgelehnt (Krankheit, end_date gesetzt).
do $$
declare v text;
begin
  begin
    insert into public.employee_absences (company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, created_by)
    values ('e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','sickness','reported', current_date+40, current_date+39, 'e2000000-0000-0000-0000-000000000002');
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  insert into _abs values (7,'end_date vor start_date wird abgelehnt (Krankheit)','ABGELEHNT',v);
  raise notice 'CASE 7 -> %', v;
end $$;

-- CASE 8: reviewed_by/reviewed_at-Gleichschritt ist NICHT (mehr) per CHECK
-- erzwungen — das war chk_employee_absences_review_pair, entfernt, weil es
-- mit reviewed_by ON DELETE SET NULL kollidierte (siehe Migrationskommentar
-- bei den Spalten reviewed_by/reviewed_at). Der Gleichschritt wird
-- ausschliesslich von den beiden schreibenden RPCs garantiert (Faelle
-- weiter unten). Diese Zeile dokumentiert bewusst, dass ein direkter Insert
-- mit nur reviewed_by (kein Client-Pfad, nur zur Schema-Doku) jetzt
-- durchgeht — eine Regression zurueck zum alten Constraint waere die
-- Deletion-Blockade von vorher.
do $$
declare v text;
begin
  begin
    insert into public.employee_absences (company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, created_by, reviewed_by)
    values ('e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','vacation','approved', current_date+50, current_date+51, 'e2000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000001');
    v := 'OK';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  insert into _abs values (8,'reviewed_by ohne reviewed_at ist NICHT per CHECK blockiert (Fix: Deletion-Blockade)','OK',v);
  raise notice 'CASE 8 -> %', v;
end $$;

-- Testdaten aus Schema-Sektion wieder entfernen, damit sie die
-- RPC-Ueberlappungspruefungen unten nicht verfaelschen.
delete from public.employee_absences where employee_id = 'e2000000-0000-0000-0000-000000000002';


-- =========================================================
-- B. RLS — LESE-POLICIES UND FEHLENDE SCHREIBRECHTE
-- =========================================================

-- Fixtur: je eine Urlaubszeile fuer Mitarbeiter A (Firma E) und Mitarbeiter F (Firma F).
insert into public.employee_absences (id, company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, created_by)
values
  ('e4000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','vacation','requested', current_date+60, current_date+61, 'e2000000-0000-0000-0000-000000000002'),
  ('e4000000-0000-0000-0000-000000000002','e1000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000007','Finn Fremd','vacation','requested', current_date+60, current_date+61, 'e2000000-0000-0000-0000-000000000007');

-- CASE 9: Mitarbeiter A sieht nur die eigene Zeile.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  select count(*)::text into v from public.employee_absences;
  reset role;
  insert into _abs values (9,'Mitarbeiter sieht nur eigene Abwesenheiten','1',v);
  raise notice 'CASE 9 -> %', v;
end $$;

-- CASE 10: Mitarbeiter B (gleiche Firma, andere Person) sieht die Zeile von A nicht.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  set local role authenticated;
  select count(*)::text into v from public.employee_absences where id = 'e4000000-0000-0000-0000-000000000001';
  reset role;
  insert into _abs values (10,'Mitarbeiter B sieht die Zeile von Mitarbeiter A nicht','0',v);
  raise notice 'CASE 10 -> %', v;
end $$;

-- CASE 11: Admin E sieht alle Zeilen der eigenen Firma (nur die von A, nicht die fremde).
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  select count(*)::text into v from public.employee_absences where company_id = 'e1000000-0000-0000-0000-000000000001';
  reset role;
  insert into _abs values (11,'Admin sieht alle Abwesenheiten der eigenen Firma','1',v);
  raise notice 'CASE 11 -> %', v;
end $$;

-- CASE 12: Admin E sieht die Zeile der fremden Firma F nicht (Cross-Company).
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  select count(*)::text into v from public.employee_absences where id = 'e4000000-0000-0000-0000-000000000002';
  reset role;
  insert into _abs values (12,'Admin E sieht die Abwesenheit der fremden Firma F nicht','0',v);
  raise notice 'CASE 12 -> %', v;
end $$;

-- CASE 13: authenticated hat KEIN direktes INSERT/UPDATE/DELETE-Recht
-- (nachgewiesen ueber die Rechtevergabe, nicht ueber einen echten Aufruf —
-- siehe Kopf-Hinweis zu permission-denied).
do $$
declare v text;
begin
  select count(*)::text into v
  from information_schema.role_table_grants
  where table_name = 'employee_absences'
    and grantee = 'authenticated'
    and privilege_type in ('INSERT','UPDATE','DELETE');
  insert into _abs values (13,'authenticated hat keine INSERT/UPDATE/DELETE-Rechte auf employee_absences','0',v);
  raise notice 'CASE 13 -> %', v;
end $$;

delete from public.employee_absences where id in ('e4000000-0000-0000-0000-000000000001','e4000000-0000-0000-0000-000000000002');


-- =========================================================
-- C. MITARBEITER-RPCS
-- =========================================================

-- CASE 14: request_own_vacation legt eine Zeile im richtigen Zustand an.
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  select id into v_id from public.request_own_vacation(current_date+10, current_date+12, 'Familienurlaub');
  reset role;
  perform pg_temp.remember('vac_a', v_id);
  select 'type='||type::text||'/status='||status::text||'/emp='||employee_id::text||'/name='||employee_name_snapshot||'/created_by='||created_by::text
    into v
  from public.employee_absences where id = v_id;
  insert into _abs values (14,'request_own_vacation legt requested-Zeile mit Snapshot an',
    'type=vacation/status=requested/emp=e2000000-0000-0000-0000-000000000002/name=Anna A/created_by=e2000000-0000-0000-0000-000000000002', v);
  raise notice 'CASE 14 -> %', v;
end $$;

-- CASE 15: eine ueberlappende zweite Urlaubsanfrage wird abgelehnt.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  begin
    perform public.request_own_vacation(current_date+11, current_date+13, null);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  insert into _abs values (15,'Ueberlappende zweite Urlaubsanfrage wird abgelehnt','ABGELEHNT',v);
  raise notice 'CASE 15 -> %', v;
end $$;

-- CASE 16: eine NICHT ueberlappende zweite Urlaubsanfrage wird akzeptiert.
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  begin
    select id into v_id from public.request_own_vacation(current_date+20, current_date+21, null);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  if v = 'AKZEPTIERT' then
    delete from public.employee_absences where id = v_id;
  end if;
  insert into _abs values (16,'Nicht ueberlappende zweite Urlaubsanfrage wird akzeptiert','AKZEPTIERT',v);
  raise notice 'CASE 16 -> %', v;
end $$;

-- CASE 17: report_own_sickness mit end_date=NULL legt eine offene Krankmeldung an.
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  select id into v_id from public.report_own_sickness(current_date, null, 'Grippe');
  reset role;
  perform pg_temp.remember('sick_a', v_id);
  select 'type='||type::text||'/status='||status::text||'/end='||coalesce(end_date::text,'NULL')
    into v
  from public.employee_absences where id = v_id;
  insert into _abs values (17,'report_own_sickness mit end_date=NULL legt offene Krankmeldung an',
    'type=sickness/status=reported/end=NULL', v);
  raise notice 'CASE 17 -> %', v;
end $$;

-- CASE 18: eine zweite aktive Krankmeldung derselben Person wird abgelehnt.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  begin
    perform public.report_own_sickness(current_date+1, current_date+2, null);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  insert into _abs values (18,'Zweite aktive Krankmeldung derselben Person wird abgelehnt','ABGELEHNT',v);
  raise notice 'CASE 18 -> %', v;
end $$;

-- CASE 19: update_own_sickness_end setzt das Enddatum auf DERSELBEN Zeile (keine zweite Zeile).
do $$
declare v text; v_id uuid; v_count int;
begin
  v_id := pg_temp.recall('sick_a');
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  perform public.update_own_sickness_end(v_id, current_date+3);
  reset role;
  select count(*) into v_count from public.employee_absences where employee_id = 'e2000000-0000-0000-0000-000000000002' and type = 'sickness';
  select 'end='||end_date::text||'/zeilen='||v_count::text into v from public.employee_absences where id = v_id;
  insert into _abs values (19,'update_own_sickness_end aendert end_date ohne neue Zeile',
    'end='||(current_date+3)::text||'/zeilen=1', v);
  raise notice 'CASE 19 -> %', v;
end $$;

-- CASE 20: cancel_own_sickness storniert die eigene aktive Krankmeldung.
do $$
declare v text; v_id uuid;
begin
  v_id := pg_temp.recall('sick_a');
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  perform public.cancel_own_sickness(v_id);
  reset role;
  select status::text into v from public.employee_absences where id = v_id;
  insert into _abs values (20,'cancel_own_sickness storniert die eigene Krankmeldung','cancelled',v);
  raise notice 'CASE 20 -> %', v;
end $$;

-- CASE 21: cancel_own_vacation lehnt bereits begonnenen/vergangenen Urlaub ab.
do $$
declare v text; v_id uuid;
begin
  insert into public.employee_absences (id, company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, created_by)
  values ('e4000000-0000-0000-0000-000000000010','e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','vacation','approved', current_date-2, current_date+1, 'e2000000-0000-0000-0000-000000000002');
  v_id := 'e4000000-0000-0000-0000-000000000010';
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  begin
    perform public.cancel_own_vacation(v_id);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  insert into _abs values (21,'cancel_own_vacation lehnt bereits begonnenen Urlaub ab','ABGELEHNT',v);
  raise notice 'CASE 21 -> %', v;
end $$;

-- CASE 22: cancel_own_vacation storniert noch nicht begonnenen (zukuenftigen) Urlaub.
do $$
declare v text; v_id uuid;
begin
  v_id := pg_temp.recall('vac_a');
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  perform public.cancel_own_vacation(v_id);
  reset role;
  select status::text into v from public.employee_absences where id = v_id;
  insert into _abs values (22,'cancel_own_vacation storniert zukuenftigen Urlaub','cancelled',v);
  raise notice 'CASE 22 -> %', v;
end $$;

-- CASE 23: Mitarbeiter B kann die Krankmeldung von Mitarbeiter A NICHT stornieren (Cross-Employee-Angriff).
do $$
declare v text; v_id uuid;
begin
  insert into public.employee_absences (id, company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, created_by)
  values ('e4000000-0000-0000-0000-000000000011','e1000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000002','Anna A','sickness','reported', current_date+5, current_date+6, 'e2000000-0000-0000-0000-000000000002');
  v_id := 'e4000000-0000-0000-0000-000000000011';
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  set local role authenticated;
  begin
    perform public.cancel_own_sickness(v_id);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  select 'aufruf='||v||'/status_unveraendert='||(status='reported')::text into v from public.employee_absences where id = v_id;
  insert into _abs values (23,'Mitarbeiter B kann Krankmeldung von A nicht stornieren (Cross-Employee)','aufruf=ABGELEHNT/status_unveraendert=true',v);
  raise notice 'CASE 23 -> %', v;
end $$;

-- CASE 24: Mitarbeiter B kann fuer sich selbst KEINEN absence_id manipulieren, der A gehoert,
-- ueber update_own_sickness_end (weiterer Cross-Employee-Angriffsvektor).
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000003');
  set local role authenticated;
  begin
    perform public.update_own_sickness_end('e4000000-0000-0000-0000-000000000011', current_date+30);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  insert into _abs values (24,'Mitarbeiter B kann Enddatum der Krankmeldung von A nicht aendern','ABGELEHNT',v);
  raise notice 'CASE 24 -> %', v;
end $$;

-- CASE 25: ein deaktivierter Mitarbeiter kann keine RPC aufrufen
-- (current_user_role() liefert NULL fuer inaktive Profile).
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000004');
  set local role authenticated;
  begin
    perform public.request_own_vacation(current_date+70, current_date+72, null);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  insert into _abs values (25,'Deaktivierter Mitarbeiter kann request_own_vacation nicht aufrufen','ABGELEHNT',v);
  raise notice 'CASE 25 -> %', v;
end $$;

delete from public.employee_absences where employee_id in ('e2000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000003');


-- =========================================================
-- D. ADMIN-RPCS
-- =========================================================

-- CASE 26: admin_review_vacation genehmigt eine Anfrage.
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  select id into v_id from public.request_own_vacation(current_date+80, current_date+82, null);
  reset role;
  perform pg_temp.remember('vac_review', v_id);

  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  perform public.admin_review_vacation(v_id, 'approved', 'Passt.');
  reset role;

  select 'status='||status::text||'/reviewed_by='||reviewed_by::text||'/note='||admin_note into v
  from public.employee_absences where id = v_id;
  insert into _abs values (26,'admin_review_vacation genehmigt eine Anfrage',
    'status=approved/reviewed_by=e2000000-0000-0000-0000-000000000001/note=Passt.', v);
  raise notice 'CASE 26 -> %', v;
end $$;

-- CASE 27: eine bereits entschiedene Anfrage kann nicht erneut reviewt werden.
do $$
declare v text; v_id uuid;
begin
  v_id := pg_temp.recall('vac_review');
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  begin
    perform public.admin_review_vacation(v_id, 'rejected', null);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  insert into _abs values (27,'Bereits entschiedene Anfrage kann nicht erneut reviewt werden','ABGELEHNT',v);
  raise notice 'CASE 27 -> %', v;
end $$;

-- CASE 28: admin_review_vacation lehnt eine neue Anfrage korrekt ab (status=rejected).
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  select id into v_id from public.request_own_vacation(current_date+90, current_date+92, null);
  reset role;

  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  perform public.admin_review_vacation(v_id, 'rejected', 'Zu viele Kollegen gleichzeitig weg.');
  reset role;

  select status::text into v from public.employee_absences where id = v_id;
  insert into _abs values (28,'admin_review_vacation lehnt eine Anfrage ab','rejected',v);
  raise notice 'CASE 28 -> %', v;
end $$;

-- CASE 29: admin_review_vacation kann keine Krankmeldung reviewen (type-Filter).
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  select id into v_id from public.report_own_sickness(current_date+100, null, null);
  reset role;

  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  begin
    perform public.admin_review_vacation(v_id, 'approved', null);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  insert into _abs values (29,'admin_review_vacation kann keine Krankmeldung reviewen','ABGELEHNT',v);
  raise notice 'CASE 29 -> %', v;
end $$;

-- CASE 30: Admin F (fremde Firma) kann die Urlaubsanfrage von Firma E nicht reviewen.
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  select id into v_id from public.request_own_vacation(current_date+110, current_date+112, null);
  reset role;

  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000006');
  set local role authenticated;
  begin
    perform public.admin_review_vacation(v_id, 'approved', null);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  insert into _abs values (30,'Admin fremder Firma kann Urlaubsanfrage nicht reviewen (Cross-Company)','ABGELEHNT',v);
  raise notice 'CASE 30 -> %', v;
end $$;

delete from public.employee_absences where employee_id = 'e2000000-0000-0000-0000-000000000002';

-- CASE 31: admin_create_absence legt Urlaub direkt als 'approved' an, mit Review-Feldern.
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  select id into v_id from public.admin_create_absence(
    'e2000000-0000-0000-0000-000000000002','vacation', current_date+120, current_date+122, 'Telefonisch vereinbart');
  reset role;
  select 'status='||status::text||'/created_by='||created_by::text||'/reviewed_by='||reviewed_by::text||'/emp='||employee_id::text
    into v from public.employee_absences where id = v_id;
  insert into _abs values (31,'admin_create_absence legt Urlaub direkt genehmigt an',
    'status=approved/created_by=e2000000-0000-0000-0000-000000000001/reviewed_by=e2000000-0000-0000-0000-000000000001/emp=e2000000-0000-0000-0000-000000000002', v);
  raise notice 'CASE 31 -> %', v;
end $$;

-- CASE 32: admin_create_absence legt Krankheit direkt als 'reported' an, ohne Review-Felder.
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  select id into v_id from public.admin_create_absence(
    'e2000000-0000-0000-0000-000000000003','sickness', current_date, null, 'Telefonische Krankmeldung');
  reset role;
  select 'status='||status::text||'/reviewed_by='||coalesce(reviewed_by::text,'NULL')||'/end='||coalesce(end_date::text,'NULL')
    into v from public.employee_absences where id = v_id;
  insert into _abs values (32,'admin_create_absence legt Krankheit direkt gemeldet an, ohne Review',
    'status=reported/reviewed_by=NULL/end=NULL', v);
  raise notice 'CASE 32 -> %', v;
end $$;

-- CASE 33: admin_create_absence funktioniert auch fuer einen inaktiven Mitarbeiter
-- (bewusste Design-Entscheidung: historische Nacherfassung soll moeglich bleiben).
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  begin
    select id into v_id from public.admin_create_absence(
      'e2000000-0000-0000-0000-000000000004','sickness', current_date-5, current_date-3, 'Nachtrag');
    v := 'OK';
  exception when others then v := 'ABGELEHNT('||sqlstate||')';
  end;
  reset role;
  insert into _abs values (33,'admin_create_absence erlaubt Nacherfassung fuer inaktiven Mitarbeiter','OK',v);
  raise notice 'CASE 33 -> %', v;
end $$;

-- CASE 34: admin_create_absence lehnt einen Mitarbeiter fremder Firma ab.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  begin
    perform public.admin_create_absence(
      'e2000000-0000-0000-0000-000000000007','vacation', current_date+130, current_date+131, null);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  insert into _abs values (34,'admin_create_absence lehnt Mitarbeiter fremder Firma ab','ABGELEHNT',v);
  raise notice 'CASE 34 -> %', v;
end $$;

-- CASE 35: eine Employee-Rolle darf admin_create_absence nicht aufrufen.
do $$
declare v text;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  begin
    perform public.admin_create_absence(
      'e2000000-0000-0000-0000-000000000003','vacation', current_date+140, current_date+141, null);
    v := 'AKZEPTIERT';
  exception when others then v := 'ABGELEHNT';
  end;
  reset role;
  insert into _abs values (35,'Employee darf admin_create_absence nicht aufrufen','ABGELEHNT',v);
  raise notice 'CASE 35 -> %', v;
end $$;

delete from public.employee_absences where employee_id in ('e2000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000004');


-- =========================================================
-- E. HISTORIE NACH KONTOLOESCHUNG
-- =========================================================

-- CASE 36: Konto-Loeschung anonymisiert die Abwesenheit statt sie zu loeschen.
do $$
declare v text; v_id uuid;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000005');
  set local role authenticated;
  select id into v_id from public.request_own_vacation(current_date+150, current_date+152, 'Vor Kontoloeschung');
  reset role;

  begin
    delete from auth.users where id = 'e2000000-0000-0000-0000-000000000005';
    v := 'DELETED';
  exception when others then v := 'BLOCKED('||sqlstate||')';
  end;

  if v = 'DELETED' then
    select 'rows='||count(*)::text
           ||'/emp='||coalesce(max(employee_id::text),'NULL')
           ||'/name='||max(employee_name_snapshot)
           ||'/status='||max(status::text)
      into v
    from public.employee_absences where id = v_id;
  end if;

  insert into _abs values (36,'Konto-Loeschung anonymisiert die Abwesenheit statt sie zu loeschen',
    'rows=1/emp=NULL/name=Dirk Loeschbar/status=requested', v);
  raise notice 'CASE 36 -> %', v;
end $$;

-- CASE 37: REGRESSION fuer den Review-Fix. Ein Admin (H) reviewt eine
-- Urlaubsanfrage (reviewed_by/reviewed_at gemeinsam gesetzt), wird DANACH
-- geloescht. Vor dem Fix schlug genau diese Loeschung mit 23514
-- (chk_employee_absences_review_pair) fehl, weil ON DELETE SET NULL nur
-- reviewed_by nullt, nicht reviewed_at. Erwartet jetzt: Loeschung gelingt,
-- die Zeile bleibt vollstaendig erhalten (reviewed_by=NULL, reviewed_at
-- UNVERAENDERT gesetzt, status weiterhin approved, employee_id/Snapshot
-- unberuehrt weil NUR der Reviewer geloescht wurde, nicht der Mitarbeiter),
-- Admin E (dieselbe Firma, weiterhin aktiv) kann die Zeile lesen, Admin F
-- (fremde Firma) weiterhin nicht.
do $$
declare v text; v_id uuid; v_reviewed_at_vorher timestamptz;
begin
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000002');
  set local role authenticated;
  select id into v_id from public.request_own_vacation(current_date+160, current_date+162, 'Regressionsfall Review-Loeschung');
  reset role;

  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000008');
  set local role authenticated;
  perform public.admin_review_vacation(v_id, 'approved', 'Regressionstest');
  reset role;

  select reviewed_at into v_reviewed_at_vorher from public.employee_absences where id = v_id;
  if v_reviewed_at_vorher is null then
    raise exception 'Testfehler: reviewed_at wurde von admin_review_vacation nicht gesetzt';
  end if;

  begin
    delete from auth.users where id = 'e2000000-0000-0000-0000-000000000008';
    v := 'DELETED';
  exception when others then v := 'BLOCKED('||sqlstate||')';
  end;

  if v = 'DELETED' then
    select 'loeschung=DELETED'
           ||'/reviewed_by='||coalesce(reviewed_by::text,'NULL')
           ||'/reviewed_at_erhalten='||(reviewed_at = v_reviewed_at_vorher)::text
           ||'/status='||status::text
           ||'/emp='||employee_id::text
           ||'/name='||employee_name_snapshot
      into v
    from public.employee_absences where id = v_id;
  end if;

  insert into _abs values (37,'Loeschung eines reviewenden Admins gelingt; Zeile bleibt mit reviewed_at erhalten (Review-Fix)',
    'loeschung=DELETED/reviewed_by=NULL/reviewed_at_erhalten=true/status=approved/emp=e2000000-0000-0000-0000-000000000002/name=Anna A', v);
  raise notice 'CASE 37 -> %', v;

  -- Lesezugriffe NACH der Loeschung.
  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000001');
  set local role authenticated;
  select count(*)::text into v from public.employee_absences where id = v_id;
  reset role;
  insert into _abs values (38,'Gleiche Firma (Admin E) kann die Zeile nach Reviewer-Loeschung weiterhin lesen','1',v);
  raise notice 'CASE 38 -> %', v;

  perform pg_temp.act_as('e2000000-0000-0000-0000-000000000006');
  set local role authenticated;
  select count(*)::text into v from public.employee_absences where id = v_id;
  reset role;
  insert into _abs values (39,'Fremde Firma (Admin F) kann die Zeile weiterhin nicht lesen','0',v);
  raise notice 'CASE 39 -> %', v;
end $$;

delete from public.employee_absences where employee_id = 'e2000000-0000-0000-0000-000000000002';


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _abs order by case_no;

do $$
declare fails int;
begin
  select count(*) into fails from _abs where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'ABSENCES FOUNDATION TEST: % Fall/Faelle FEHLGESCHLAGEN', fails;
  end if;
  raise notice 'ALLE FAELLE PASS';
end $$;

rollback;
