-- =========================================================
-- TEST: Mehrfachzuweisung — sichere Abschlussregel
-- (Migration 20261029000000_multi_assignment_completion_rule)
-- =========================================================
-- Regel: ein Auftrag wird 'completed' genau dann, wenn
--   (1) mindestens ein Zugewiesener nachweislich GESTARTET hat,
--   (2) jeder Gestartete employee_completed_at traegt,
--   (3) keine offene Arbeitssitzung zum Auftrag existiert.
-- Nie gestartete Zuweisungen blockieren nicht.
--
-- Zwei Ebenen:
--   TEIL 1 — Zustandsmatrix: Zustaende direkt als postgres aufgebaut, dann
--            maybe_complete_job unmittelbar aufgerufen (deckt auch
--            inkonsistente Altzustaende ab, die die RPCs heute nicht mehr
--            erzeugen koennen, die in Produktion aber existieren).
--   TEIL 2 — Ende-zu-Ende ueber die echten RPCs (start_own_job,
--            complete_own_job, set_job_assignments) als echte Rollen.
--
-- Laeuft transaktional (BEGIN … ROLLBACK): keine Rueckstaende.
-- =========================================================

begin;

create temp table _r (
  case_no      text,
  beschreibung text,
  erwartet     text,
  ergebnis     text
) on commit drop;

create or replace function pg_temp.note(p_case text, p_besch text, p_erw text, p_erg text)
returns void language plpgsql as $f$
begin
  insert into _r values (p_case, p_besch, p_erw, p_erg);
  raise notice 'CASE % -> %', p_case, p_erg;
end $f$;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
end $f$;


-- ── Fixdaten ────────────────────────────────────────────────────────
-- Firma = c9a1…1 | Admin = c9a2…1 | A = c9a2…2 | B = c9a2…3 | C = c9a2…4
-- D = c9a2…5 (wird geloescht) | X = c9a2…6 (wird nach Abschluss geloescht)
-- E = c9a2…7, G = c9a2…8 (nur fuer offene Sitzungen; je Mitarbeiter ist nur
-- EINE offen, und eine offene Sitzung sperrt start_own_job in TEIL 2)
do $$
begin
  insert into auth.users (instance_id,id,aud,role,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000000','c9a20000-0000-0000-0000-000000000001','authenticated','authenticated','mac-admin@example.test','{"full_name":"MAC Admin"}'),
    ('00000000-0000-0000-0000-000000000000','c9a20000-0000-0000-0000-000000000002','authenticated','authenticated','mac-a@example.test','{"full_name":"Anna A"}'),
    ('00000000-0000-0000-0000-000000000000','c9a20000-0000-0000-0000-000000000003','authenticated','authenticated','mac-b@example.test','{"full_name":"Bert B"}'),
    ('00000000-0000-0000-0000-000000000000','c9a20000-0000-0000-0000-000000000004','authenticated','authenticated','mac-c@example.test','{"full_name":"Cleo C"}'),
    ('00000000-0000-0000-0000-000000000000','c9a20000-0000-0000-0000-000000000005','authenticated','authenticated','mac-d@example.test','{"full_name":"Dora D"}'),
    ('00000000-0000-0000-0000-000000000000','c9a20000-0000-0000-0000-000000000006','authenticated','authenticated','mac-x@example.test','{"full_name":"Xaver X"}'),
    ('00000000-0000-0000-0000-000000000000','c9a20000-0000-0000-0000-000000000007','authenticated','authenticated','mac-e@example.test','{"full_name":"Emil E"}'),
    ('00000000-0000-0000-0000-000000000000','c9a20000-0000-0000-0000-000000000008','authenticated','authenticated','mac-g@example.test','{"full_name":"Greta G"}');
end $$;

insert into public.profiles (id, full_name) values
  ('c9a20000-0000-0000-0000-000000000001','MAC Admin'),
  ('c9a20000-0000-0000-0000-000000000002','Anna A'),
  ('c9a20000-0000-0000-0000-000000000003','Bert B'),
  ('c9a20000-0000-0000-0000-000000000004','Cleo C'),
  ('c9a20000-0000-0000-0000-000000000005','Dora D'),
  ('c9a20000-0000-0000-0000-000000000006','Xaver X'),
  ('c9a20000-0000-0000-0000-000000000007','Emil E'),
  ('c9a20000-0000-0000-0000-000000000008','Greta G')
on conflict (id) do nothing;

insert into public.companies (id,name,slug,timezone) values
  ('c9a10000-0000-0000-0000-000000000001','MAC Testfirma','mac-testfirma-test','Europe/Berlin');

update public.profiles set company_id='c9a10000-0000-0000-0000-000000000001', role='admin', is_active=true
  where id='c9a20000-0000-0000-0000-000000000001';
update public.profiles set company_id='c9a10000-0000-0000-0000-000000000001', role='employee', is_active=true
  where id in ('c9a20000-0000-0000-0000-000000000002','c9a20000-0000-0000-0000-000000000003',
               'c9a20000-0000-0000-0000-000000000004','c9a20000-0000-0000-0000-000000000005',
               'c9a20000-0000-0000-0000-000000000006','c9a20000-0000-0000-0000-000000000007',
               'c9a20000-0000-0000-0000-000000000008');

create or replace function pg_temp.bdate(p timestamptz) returns date language sql as $f$
  select (p at time zone 'Europe/Berlin')::date;
$f$;

-- Auftrag direkt anlegen (Zustandsmatrix). assigned_to bleibt NULL, damit die
-- Kompatibilitaetstrigger keine eigene Zuweisungszeile erzeugen.
create or replace function pg_temp.mkjob(
  p_id uuid, p_status job_status, p_started_by uuid default null
) returns void language plpgsql as $f$
begin
  insert into public.jobs (id, company_id, created_by, customer_name, service_name,
                           location_address, status, job_type, date, start_time,
                           is_active, started_at, started_by)
  values (p_id,'c9a10000-0000-0000-0000-000000000001','c9a20000-0000-0000-0000-000000000001',
          'Kunde '||left(p_id::text,8),'Unterhaltsreinigung','Teststr. 1',
          p_status,'single',pg_temp.bdate(now() - interval '3 hours'),time '08:00',true,
          case when p_status <> 'open' then now() - interval '3 hours' end, p_started_by);
end $f$;

-- Zuweisungszeile direkt anlegen. Gibt die Zuweisungs-ID zurueck.
create or replace function pg_temp.asg(
  p_job uuid, p_emp uuid, p_started timestamptz, p_completed timestamptz,
  p_attendance attendance_state default null, p_mode text default 'legacy'
) returns uuid language plpgsql as $f$
declare v_id uuid;
begin
  insert into public.job_assignments (job_id, employee_id, employee_name_snapshot, assigned_by,
                                      employee_started_at, employee_completed_at, attendance,
                                      time_tracking_mode)
  select p_job, p_emp, coalesce(pr.full_name,'Unbekannt'), 'c9a20000-0000-0000-0000-000000000001',
         p_started, p_completed,
         coalesce(p_attendance, case when p_completed is not null then 'completed'
                                     when p_started   is not null then 'started'
                                     else 'assigned' end::attendance_state),
         p_mode
  from public.profiles pr where pr.id = p_emp
  returning id into v_id;
  return v_id;
end $f$;

-- Arbeitssitzung direkt anlegen (Schreibwaechter verlangt das RPC-Flag).
create or replace function pg_temp.sess(
  p_asg uuid, p_emp uuid, p_start timestamptz, p_end timestamptz
) returns void language plpgsql as $f$
begin
  perform set_config('taskops.work_session_rpc','on',true);
  insert into public.work_sessions (id, job_assignment_id, employee_id, started_at, ended_at)
  values (gen_random_uuid(), p_asg, p_emp, p_start, p_end);
  perform set_config('taskops.work_session_rpc','off',true);
end $f$;

-- maybe_complete_job aufrufen und den Auftragsstatus zurueckgeben.
create or replace function pg_temp.eval(p_job uuid) returns text language plpgsql as $f$
declare v text;
begin
  perform 1 from public.jobs where id = p_job for update;
  perform public.maybe_complete_job(p_job, 'c9a20000-0000-0000-0000-000000000002', now(), true);
  select status::text into v from public.jobs where id = p_job;
  return v;
end $f$;


-- =========================================================
-- TEIL 1 — Zustandsmatrix (maybe_complete_job direkt)
-- =========================================================
do $$
declare
  A uuid := 'c9a20000-0000-0000-0000-000000000002';
  B uuid := 'c9a20000-0000-0000-0000-000000000003';
  C uuid := 'c9a20000-0000-0000-0000-000000000004';
  E uuid := 'c9a20000-0000-0000-0000-000000000007';
  G uuid := 'c9a20000-0000-0000-0000-000000000008';
  t0 timestamptz := now() - interval '3 hours';
  t1 timestamptz := now() - interval '1 hour';
  v_a uuid; v_b uuid;
  v text; v_cnt int;
begin
  -- CASE A: A gestartet+abgeschlossen, B nie gestartet -> completed
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-00000000000a', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-00000000000a', A, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-00000000000a', B, null, null);
  perform pg_temp.note('A','A fertig, B nie gestartet -> completed','completed',
    pg_temp.eval('c9a40000-0000-0000-0000-00000000000a'));

  select count(*)::int into v_cnt from public.notification_outbox
  where job_id='c9a40000-0000-0000-0000-00000000000a' and event_type='job_completed';
  perform pg_temp.note('A2','Mitarbeiter-Abschluss schreibt genau ein job_completed-Event','1',v_cnt::text);

  select case when employee_started_at is null and employee_completed_at is null
              and attendance='assigned' then 'unveraendert' else 'veraendert' end into v
  from public.job_assignments
  where job_id='c9a40000-0000-0000-0000-00000000000a' and employee_id=B;
  perform pg_temp.note('A3','Nie gestartete Zeile wird nicht angefasst (kein erfundener Zeitstempel)','unveraendert',v);

  -- CASE B: beide gestartet+abgeschlossen -> completed
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-00000000000b', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-00000000000b', A, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-00000000000b', B, t0, t1);
  perform pg_temp.note('B','A fertig, B fertig -> completed','completed',
    pg_temp.eval('c9a40000-0000-0000-0000-00000000000b'));

  -- CASE C: A fertig, B gestartet aber nicht abgeschlossen -> in_progress
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-00000000000c', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-00000000000c', A, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-00000000000c', B, t0, null);
  perform pg_temp.note('C','A fertig, B gestartet/nicht fertig -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-00000000000c'));

  -- CASE D: A fertig, B mit offener Sitzung -> in_progress
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-00000000000d', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-00000000000d', A, t0, t1);
  v_b := pg_temp.asg('c9a40000-0000-0000-0000-00000000000d', G, t0, null, null, 'sessions');
  perform pg_temp.sess(v_b, G, t0, null);
  perform pg_temp.note('D','A fertig, B offene Sitzung -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-00000000000d'));

  -- CASE D2: offene Sitzung blockiert AUCH bei widerspruechlichen Zeitstempeln
  -- (Zeile traegt bereits employee_completed_at). Ohne den weichen Abbruch
  -- wuerde der Trigger guard_job_completion_with_active_session werfen.
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000d2', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000d2', A, t0, t1);
  v_b := pg_temp.asg('c9a40000-0000-0000-0000-0000000000d2', C, t0, t1, null, 'sessions');
  perform pg_temp.sess(v_b, C, t0, null);
  begin
    v := pg_temp.eval('c9a40000-0000-0000-0000-0000000000d2');
  exception when others then v := 'EXCEPTION:'||sqlerrm;
  end;
  perform pg_temp.note('D2','Offene Sitzung trotz Abschluss-Zeitstempel -> weich in_progress (keine Exception)','in_progress',v);

  -- CASE D3: offene Sitzung an einer NIE als gestartet gestempelten Zeile
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000d3', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000d3', A, t0, t1);
  v_b := pg_temp.asg('c9a40000-0000-0000-0000-0000000000d3', E, null, null, null, 'sessions');
  perform pg_temp.sess(v_b, E, t0, null);
  perform pg_temp.note('D3','Offene Sitzung ohne employee_started_at blockiert -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000d3'));

  -- CASE E: beide nie gestartet, Auftrag offen -> bleibt open
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-00000000000e', 'open');
  perform pg_temp.asg('c9a40000-0000-0000-0000-00000000000e', A, null, null);
  perform pg_temp.asg('c9a40000-0000-0000-0000-00000000000e', B, null, null);
  perform pg_temp.note('E','Beide nie gestartet (open) -> nicht abgeschlossen','open',
    pg_temp.eval('c9a40000-0000-0000-0000-00000000000e'));

  -- CASE E2: Auftrag steht in_progress, aber KEINE Zuweisung traegt einen
  -- Startbeweis (started_by NULL) -> nie automatisch schliessen
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000e2', 'in_progress', null);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000e2', A, null, null);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000e2', B, null, null);
  perform pg_temp.note('E2','in_progress ohne jeden Startbeweis -> bleibt in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000e2'));

  -- CASE E3: in_progress ohne jede Zuweisungszeile (Alt-Auftrag) -> bleibt
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000e3', 'in_progress', null);
  perform pg_temp.note('E3','in_progress ohne Zuweisungszeilen -> bleibt in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000e3'));

  -- CASE F: Sitzung beendet, aber employee_completed_at NULL (Pause bzw.
  -- Pruefungsuebergabe) -> in_progress. Auch als EINZIGE Zuweisung.
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-00000000000f', 'in_progress', A);
  v_a := pg_temp.asg('c9a40000-0000-0000-0000-00000000000f', A, t0, null, null, 'sessions');
  perform pg_temp.sess(v_a, A, t0, t1);
  perform set_config('taskops.work_session_rpc','on',true);
  update public.job_assignments set work_review_required = true where id = v_a;
  perform set_config('taskops.work_session_rpc','off',true);
  perform pg_temp.note('F','Beendete Sitzung ohne employee_completed_at -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-00000000000f'));

  -- CASE F2: wie F, aber neben einem fertigen Kollegen (Produktionsmuster 97386f87)
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000f2', 'in_progress', A);
  v_a := pg_temp.asg('c9a40000-0000-0000-0000-0000000000f2', A, t0, null, null, 'sessions');
  perform pg_temp.sess(v_a, A, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000f2', B, null, null);
  perform pg_temp.note('F2','Beendete Sitzung ohne Abschluss + nie gestarteter Kollege -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000f2'));

  -- CASE F3: Sitzungsmodus regulaer abgeschlossen (Sitzung zu, completed gesetzt)
  -- + nie gestarteter Kollege -> completed (Produktionsmuster der 13 Injoy-Auftraege)
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000f3', 'in_progress', A);
  v_a := pg_temp.asg('c9a40000-0000-0000-0000-0000000000f3', A, t0, null, null, 'sessions');
  perform pg_temp.sess(v_a, A, t0, t1);
  perform set_config('taskops.work_session_rpc','on',true);
  update public.job_assignments set employee_completed_at = t1, attendance = 'completed' where id = v_a;
  perform set_config('taskops.work_session_rpc','off',true);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000f3', B, null, null);
  perform pg_temp.note('F3','Sitzungsmodus fertig + nie gestarteter Kollege -> completed','completed',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000f3'));

  -- CASE G: Einzelzuweisung gestartet+abgeschlossen -> completed
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000a1', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a1', A, t0, t1);
  perform pg_temp.note('G','Einzelzuweisung fertig -> completed','completed',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000a1'));

  -- CASE H: Einzelzuweisung gestartet, nicht abgeschlossen -> in_progress
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000a2', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a2', A, t0, null);
  perform pg_temp.note('H','Einzelzuweisung gestartet/nicht fertig -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000a2'));

  -- CASE I: Alt-Startbeweis jobs.started_by = B (ohne employee_started_at),
  -- B ohne Abschluss -> in_progress
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000a3', 'in_progress', B);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a3', A, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a3', B, null, null, 'assigned');
  perform pg_temp.note('I','Alt-Start (jobs.started_by) ohne Abschluss -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000a3'));

  -- CASE I2: Alt-Startbeweis attendance='started' (ohne Zeitstempel) -> in_progress
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000a4', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a4', A, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a4', B, null, null, 'started');
  perform pg_temp.note('I2','Alt-Start (attendance=started) ohne Abschluss -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000a4'));

  -- CASE I3: Sitzung existiert (beendet), aber employee_started_at fehlt -> gilt
  -- als gestartet, ohne Abschluss -> in_progress
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000a5', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a5', A, t0, t1);
  v_b := pg_temp.asg('c9a40000-0000-0000-0000-0000000000a5', B, null, null, 'assigned', 'sessions');
  perform pg_temp.sess(v_b, B, t0, t1);
  perform pg_temp.note('I3','Sitzungs-Beweis ohne employee_started_at, ohne Abschluss -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000a5'));

  -- CASE K: inkonsistente Zeile "abgeschlossen ohne jeden Startbeweis" allein
  -- reicht NICHT zum Schliessen (Abschluss ist kein Startbeweis)
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000a6', 'in_progress', null);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a6', A, null, t1, 'completed');
  perform pg_temp.note('K','Nur Abschluss ohne Startbeweis -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000a6'));

  -- CASE K2: dieselbe inkonsistente Zeile blockiert einen echten Abschluss nicht
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000a7', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a7', A, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a7', C, null, t1, 'completed');
  perform pg_temp.note('K2','Echter Abschluss + Zeile nur mit Abschluss -> completed','completed',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000a7'));

  -- CASE L: bereits abgeschlossener Auftrag bleibt unangetastet (kein 2. Event)
  perform pg_temp.note('L','Erneuter Aufruf auf abgeschlossenem Auftrag ist No-Op','completed',
    pg_temp.eval('c9a40000-0000-0000-0000-00000000000a'));
  select count(*)::int into v_cnt from public.notification_outbox
  where job_id='c9a40000-0000-0000-0000-00000000000a' and event_type='job_completed';
  perform pg_temp.note('L2','Kein zweites job_completed-Event','1',v_cnt::text);

  -- CASE M: Rueckgabewert spiegelt den Uebergang
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000a8', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000a8', A, t0, t1);
  perform 1 from public.jobs where id='c9a40000-0000-0000-0000-0000000000a8' for update;
  v := public.maybe_complete_job('c9a40000-0000-0000-0000-0000000000a8', A, t1, false)::text
       || '/' || public.maybe_complete_job('c9a40000-0000-0000-0000-0000000000a8', A, t1, false)::text;
  perform pg_temp.note('M','Rueckgabe: erster Aufruf true, zweiter false','true/false',v);
  select count(*)::int into v_cnt from public.notification_outbox
  where job_id='c9a40000-0000-0000-0000-0000000000a8' and event_type='job_completed';
  perform pg_temp.note('M2','p_emit_event=false schreibt kein Event','0',v_cnt::text);
  select (completed_at = t1 and completed_by = A)::text into v
  from public.jobs where id='c9a40000-0000-0000-0000-0000000000a8';
  perform pg_temp.note('M3','completed_at/completed_by = uebergebener Zeitpunkt/Akteur','true',v);
end $$;


-- =========================================================
-- CASE J — geloeschtes/deaktiviertes Konto
-- =========================================================
do $$
declare
  A uuid := 'c9a20000-0000-0000-0000-000000000002';
  D uuid := 'c9a20000-0000-0000-0000-000000000005';
  X uuid := 'c9a20000-0000-0000-0000-000000000006';
  C uuid := 'c9a20000-0000-0000-0000-000000000004';
  t0 timestamptz := now() - interval '3 hours';
  t1 timestamptz := now() - interval '1 hour';
  v text;
begin
  -- J1: D nie gestartet, dann Konto geloescht (anonymisiert) -> blockiert nicht
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000b1', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000b1', A, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000b1', D, null, null);

  -- J2: D gestartet, nicht abgeschlossen, dann geloescht -> blockiert weiter
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000b2', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000b2', A, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000b2', D, t0, null);

  -- J3: X gestartet+abgeschlossen, dann geloescht; A nie gestartet -> schliesst
  -- (es gibt echten, abgeschlossenen Arbeitsnachweis)
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000b3', 'in_progress', X);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000b3', X, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000b3', A, null, null);

  -- J4: nur anonymisierte, nie gestartete Zeile -> kein Startbeweis -> bleibt
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000b4', 'in_progress', null);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000b4', D, null, null);

  delete from auth.users where id in (D, X);

  select case when count(*) filter (where employee_id is null) = 4 then 'anonymisiert' else 'nicht_anonymisiert' end
    into v from public.job_assignments
  where job_id in ('c9a40000-0000-0000-0000-0000000000b1','c9a40000-0000-0000-0000-0000000000b2',
                   'c9a40000-0000-0000-0000-0000000000b3','c9a40000-0000-0000-0000-0000000000b4');
  perform pg_temp.note('J0','Kontoloeschung anonymisiert die Zuweisungszeilen','anonymisiert',v);

  perform pg_temp.note('J1','Anonymisiert + nie gestartet blockiert nicht -> completed','completed',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000b1'));
  perform pg_temp.note('J2','Anonymisiert + gestartet/nicht fertig blockiert -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000b2'));
  perform pg_temp.note('J3','Anonymisiert + fertig, Kollege nie gestartet -> completed','completed',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000b3'));
  perform pg_temp.note('J4','Nur anonymisierte nie gestartete Zeile -> in_progress','in_progress',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000b4'));

  -- J5: deaktivierter, nie gestarteter Kollege blockiert nicht
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000b5', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000b5', A, t0, t1);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000b5', C, null, null);
  update public.profiles set is_active = false where id = C;
  perform pg_temp.note('J5','Deaktiviert + nie gestartet blockiert nicht -> completed','completed',
    pg_temp.eval('c9a40000-0000-0000-0000-0000000000b5'));
  update public.profiles set is_active = true where id = C;
end $$;


-- =========================================================
-- TEIL 2 — Ende-zu-Ende ueber die echten RPCs
-- =========================================================
do $$
declare
  ADM uuid := 'c9a20000-0000-0000-0000-000000000001';
  A uuid := 'c9a20000-0000-0000-0000-000000000002';
  B uuid := 'c9a20000-0000-0000-0000-000000000003';
  v text; v_cnt int;
begin
  -- R1: A startet + schliesst ab, B nie gestartet -> Auftrag completed
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000c1', 'open');
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000c1', A, null, null);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000c1', B, null, null);

  perform pg_temp.act_as(A);
  execute 'set local role authenticated';
  perform public.start_own_job('c9a40000-0000-0000-0000-0000000000c1', now() - interval '2 hours');
  perform public.complete_own_job('c9a40000-0000-0000-0000-0000000000c1', now());
  execute 'reset role';

  select status::text||'/'||(completed_by = A)::text into v
  from public.jobs where id='c9a40000-0000-0000-0000-0000000000c1';
  perform pg_temp.note('R1','RPC: A fertig, B nie gestartet -> completed, completed_by=A','completed/true',v);

  select count(*)::int into v_cnt from public.notification_outbox
  where job_id='c9a40000-0000-0000-0000-0000000000c1' and event_type='job_completed';
  perform pg_temp.note('R1b','RPC: genau ein job_completed-Event','1',v_cnt::text);

  -- R2: B versucht danach zu starten -> abgelehnt (Auftrag abgeschlossen),
  -- B-Zeile bleibt unberuehrt
  perform pg_temp.act_as(B);
  execute 'set local role authenticated';
  begin
    perform public.start_own_job('c9a40000-0000-0000-0000-0000000000c1', now());
    v := 'OK';
  exception when others then v := 'ABGELEHNT';
  end;
  execute 'reset role';
  select v || '/' || coalesce(employee_started_at::text,'null') into v
  from public.job_assignments where job_id='c9a40000-0000-0000-0000-0000000000c1' and employee_id=B;
  perform pg_temp.note('R2','RPC: spaeter Start auf abgeschlossenem Auftrag abgelehnt, Zeile unberuehrt','ABGELEHNT/null',v);

  -- R3: beide starten; A schliesst ab -> in_progress; B schliesst ab -> completed
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000c3', 'open');
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000c3', A, null, null);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000c3', B, null, null);
  perform pg_temp.act_as(A);
  execute 'set local role authenticated';
  perform public.start_own_job('c9a40000-0000-0000-0000-0000000000c3', now() - interval '2 hours');
  execute 'reset role';
  perform pg_temp.act_as(B);
  execute 'set local role authenticated';
  perform public.start_own_job('c9a40000-0000-0000-0000-0000000000c3', now() - interval '2 hours');
  execute 'reset role';
  perform pg_temp.act_as(A);
  execute 'set local role authenticated';
  perform public.complete_own_job('c9a40000-0000-0000-0000-0000000000c3', now());
  execute 'reset role';
  select status::text into v from public.jobs where id='c9a40000-0000-0000-0000-0000000000c3';
  perform pg_temp.note('R3','RPC: A fertig, B gestartet/nicht fertig -> in_progress','in_progress',v);
  perform pg_temp.act_as(B);
  execute 'set local role authenticated';
  perform public.complete_own_job('c9a40000-0000-0000-0000-0000000000c3', now());
  execute 'reset role';
  select status::text||'/'||(completed_by = B)::text into v
  from public.jobs where id='c9a40000-0000-0000-0000-0000000000c3';
  perform pg_temp.note('R3b','RPC: letzter Gestarteter schliesst ab -> completed, completed_by=B','completed/true',v);

  -- R4 (H): Einzelzuweisung nur gestartet -> in_progress
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000c4', 'open');
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000c4', A, null, null);
  perform pg_temp.act_as(A);
  execute 'set local role authenticated';
  perform public.start_own_job('c9a40000-0000-0000-0000-0000000000c4', now() - interval '2 hours');
  execute 'reset role';
  select status::text into v from public.jobs where id='c9a40000-0000-0000-0000-0000000000c4';
  perform pg_temp.note('R4','RPC: Einzelzuweisung gestartet -> in_progress','in_progress',v);

  -- R5 (G): derselbe Mitarbeiter schliesst ab -> completed
  perform pg_temp.act_as(A);
  execute 'set local role authenticated';
  perform public.complete_own_job('c9a40000-0000-0000-0000-0000000000c4', now());
  execute 'reset role';
  select status::text into v from public.jobs where id='c9a40000-0000-0000-0000-0000000000c4';
  perform pg_temp.note('R5','RPC: Einzelzuweisung fertig -> completed','completed',v);

  -- R6: Bestands-Haenger (A fertig, B nie gestartet, Auftrag in_progress —
  -- so in Produktion vorhanden). Ein unveraendertes Speichern der Zuweisung
  -- durch den Admin schliesst ihn — ohne job_completed-Event (Admin-Aktion).
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000c6', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000c6', A, now() - interval '3 hours', now() - interval '1 hour');
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000c6', B, null, null);
  perform pg_temp.act_as(ADM);
  execute 'set local role authenticated';
  perform public.set_job_assignments('c9a40000-0000-0000-0000-0000000000c6', array[A, B]);
  execute 'reset role';
  select status::text||'/'||(completed_by = ADM)::text into v
  from public.jobs where id='c9a40000-0000-0000-0000-0000000000c6';
  perform pg_temp.note('R6','RPC: Admin-Speichern auf Bestands-Haenger -> completed, completed_by=Admin','completed/true',v);
  select count(*)::int into v_cnt from public.notification_outbox
  where job_id='c9a40000-0000-0000-0000-0000000000c6' and event_type='job_completed';
  perform pg_temp.note('R6b','RPC: Admin-verursachter Abschluss ohne job_completed-Event','0',v_cnt::text);
  select count(*)::int into v_cnt from public.job_assignments
  where job_id='c9a40000-0000-0000-0000-0000000000c6';
  perform pg_temp.note('R6c','RPC: Zuweisungsmenge unveraendert (B bleibt dokumentiert)','2',v_cnt::text);

  -- R7: Admin-Speichern auf Haenger mit gestartetem, unfertigem Kollegen -> bleibt
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000c7', 'in_progress', A);
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000c7', A, now() - interval '3 hours', now() - interval '1 hour');
  perform pg_temp.asg('c9a40000-0000-0000-0000-0000000000c7', B, now() - interval '3 hours', null);
  perform pg_temp.act_as(ADM);
  execute 'set local role authenticated';
  perform public.set_job_assignments('c9a40000-0000-0000-0000-0000000000c7', array[A, B]);
  execute 'reset role';
  select status::text into v from public.jobs where id='c9a40000-0000-0000-0000-0000000000c7';
  perform pg_temp.note('R7','RPC: Admin-Speichern bei gestartetem/unfertigem Kollegen -> in_progress','in_progress',v);

  -- R8: Admin-Speichern auf offenem, nie gestartetem Auftrag -> bleibt open
  perform pg_temp.mkjob('c9a40000-0000-0000-0000-0000000000c8', 'open');
  perform pg_temp.act_as(ADM);
  execute 'set local role authenticated';
  perform public.set_job_assignments('c9a40000-0000-0000-0000-0000000000c8', array[A, B]);
  execute 'reset role';
  select status::text into v from public.jobs where id='c9a40000-0000-0000-0000-0000000000c8';
  perform pg_temp.note('R8','RPC: Admin-Zuweisung auf offenem Auftrag -> bleibt open','open',v);
end $$;


-- =========================================================
-- Ergebnisuebersicht
-- =========================================================
select case_no, beschreibung, erwartet, ergebnis,
       case when ergebnis = erwartet then 'PASS' else 'FAIL' end as verdikt
from _r order by case_no;

do $$
declare fails int; gesamt int; liste text;
begin
  select count(*), count(*) filter (where ergebnis is distinct from erwartet)
    into gesamt, fails from _r;
  select coalesce(string_agg('#'||case_no||' '||beschreibung||' (erw='||erwartet||' ist='||coalesce(ergebnis,'NULL')||')', ' ;; ' order by case_no), '')
    into liste from _r where ergebnis is distinct from erwartet;
  if fails > 0 then
    raise exception 'MULTI-ASSIGNMENT COMPLETION TEST: % von % FEHLGESCHLAGEN -> %', fails, gesamt, liste;
  end if;
  raise notice 'MULTI-ASSIGNMENT COMPLETION TEST: ALLE % FAELLE PASS', gesamt;
end $$;

rollback;
