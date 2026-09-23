-- Regression für 20260923000000: die Prüfkette ist auch für die EIGENE
-- Zuweisung lesbar, damit der exportierte Stundenzettel für Admin und
-- Mitarbeiter inhaltsgleich ist — und für nichts darüber hinaus.
begin;

create temp table _checks(name text, ok boolean, detail text) on commit drop;
grant select, insert on _checks to authenticated;
create function pg_temp.check(p_name text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin insert into _checks values(p_name, coalesce(p_ok,false), p_detail); end $$;

create function pg_temp.act_as(p_actor uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub',p_actor::text,'role','authenticated')::text, true);
end $$;

create function pg_temp.audit_rows(p_actor uuid, p_assignment uuid)
returns int language plpgsql as $$
declare n int;
begin
  perform pg_temp.act_as(p_actor);
  execute 'set local role authenticated';
  select count(*) into n from public.get_session_correction_audit(array[p_assignment]);
  execute 'reset role';
  return n;
end $$;

create function pg_temp.audit_fails(p_actor uuid, p_assignment uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.audit_rows(p_actor, p_assignment);
  return 'NO-ERROR';
exception when others then
  execute 'reset role';
  return sqlerrm;
end $$;

insert into auth.users(instance_id,id,aud,role,email,raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000000','c9000000-0000-0000-0000-0000000000a0','authenticated','authenticated','ca-admin@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','c9000000-0000-0000-0000-0000000000a1','authenticated','authenticated','ca-e1@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','c9000000-0000-0000-0000-0000000000a2','authenticated','authenticated','ca-e2@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000000','c9000000-0000-0000-0000-0000000000b0','authenticated','authenticated','ca-admin-b@test.invalid','{}');
insert into public.companies(id,name,slug,timezone) values
 ('c9000000-0000-0000-0000-0000000000c1','CA Company A','ca-company-a','Europe/Berlin'),
 ('c9000000-0000-0000-0000-0000000000c2','CA Company B','ca-company-b','Europe/Berlin');
insert into public.profiles(id,full_name,role,company_id,is_active) values
 ('c9000000-0000-0000-0000-0000000000a0','CA Admin','admin','c9000000-0000-0000-0000-0000000000c1',true),
 ('c9000000-0000-0000-0000-0000000000a1','CA E1','employee','c9000000-0000-0000-0000-0000000000c1',true),
 ('c9000000-0000-0000-0000-0000000000a2','CA E2','employee','c9000000-0000-0000-0000-0000000000c1',true),
 ('c9000000-0000-0000-0000-0000000000b0','CA Admin B','admin','c9000000-0000-0000-0000-0000000000c2',true)
on conflict (id) do update set full_name=excluded.full_name, role=excluded.role,
 company_id=excluded.company_id, is_active=excluded.is_active;

do $$
declare
  v_start timestamptz := timestamptz '2026-03-02 08:00+01';
  v_a1 uuid := 'c9000000-0000-0000-0000-0000000000d1';
  v_a2 uuid := 'c9000000-0000-0000-0000-0000000000d2';
begin
  insert into public.jobs(id,company_id,created_by,customer_name,service_name,
    location_address,status,job_type,date,start_time,is_active,started_at,started_by)
  values('c9000000-0000-0000-0000-0000000000e1','c9000000-0000-0000-0000-0000000000c1',
    'c9000000-0000-0000-0000-0000000000a0','CA Kunde','Reinigung','CA Weg 1','in_progress',
    'single',(v_start at time zone 'Europe/Berlin')::date,'08:00',true,v_start,
    'c9000000-0000-0000-0000-0000000000a1');
  insert into public.job_assignments(id,job_id,employee_id,employee_name_snapshot) values
   (v_a1,'c9000000-0000-0000-0000-0000000000e1','c9000000-0000-0000-0000-0000000000a1','CA E1'),
   (v_a2,'c9000000-0000-0000-0000-0000000000e1','c9000000-0000-0000-0000-0000000000a2','CA E2');

  perform set_config('taskops.work_session_rpc','on',true);
  update public.job_assignments set time_tracking_mode='sessions' where id in (v_a1,v_a2);
  update public.job_assignments set employee_started_at=v_start, attendance='started'
    where id in (v_a1,v_a2);
  insert into public.work_sessions(id,job_assignment_id,employee_id,started_at,ended_at) values
   ('c9000000-0000-0000-0000-0000000000f1',v_a1,'c9000000-0000-0000-0000-0000000000a1',
    v_start, v_start + interval '26 hours'),
   ('c9000000-0000-0000-0000-0000000000f2',v_a2,'c9000000-0000-0000-0000-0000000000a2',
    v_start, v_start + interval '26 hours');
  perform set_config('taskops.work_session_rpc','off',true);

  -- Je eine Korrektur pro Mitarbeiter, damit "nur die eigene" pruefbar ist.
  insert into public.session_time_corrections(
    correction_id, work_session_id, job_assignment_id, job_id, employee_id,
    revision_no, origin, raw_started_at, raw_ended_at, raw_duration_seconds,
    effective_ended_at, effective_duration_seconds, performed_by, reason) values
   (gen_random_uuid(),'c9000000-0000-0000-0000-0000000000f1',v_a1,
    'c9000000-0000-0000-0000-0000000000e1','c9000000-0000-0000-0000-0000000000a1',
    1,'admin_reduced',v_start,v_start + interval '26 hours',93600,
    v_start + interval '8 hours 30 minutes',30600,'c9000000-0000-0000-0000-0000000000a0',
    'Mitarbeiter hat vergessen, den Auftrag zu beenden.'),
   (gen_random_uuid(),'c9000000-0000-0000-0000-0000000000f2',v_a2,
    'c9000000-0000-0000-0000-0000000000e1','c9000000-0000-0000-0000-0000000000a2',
    1,'admin_reduced',v_start,v_start + interval '26 hours',93600,
    v_start + interval '9 hours',32400,'c9000000-0000-0000-0000-0000000000a0',
    'Zweite Person ebenfalls geprueft.');
end $$;

do $$
declare v_msg text;
begin
  -- DER KERN: der Mitarbeiter liest die eigene Kette (vorher 42501).
  perform pg_temp.check('employee reads the audit chain of the own assignment',
    pg_temp.audit_rows('c9000000-0000-0000-0000-0000000000a1',
      'c9000000-0000-0000-0000-0000000000d1') = 1);

  -- Und wirklich nur die eigene: die Kette des Kollegen bleibt unsichtbar.
  perform pg_temp.check('employee cannot read a co-worker audit chain',
    pg_temp.audit_rows('c9000000-0000-0000-0000-0000000000a1',
      'c9000000-0000-0000-0000-0000000000d2') = 0);

  -- Der Admin sieht unveraendert die ganze Firma.
  perform pg_temp.check('admin still reads every assignment in the company',
    pg_temp.audit_rows('c9000000-0000-0000-0000-0000000000a0',
      'c9000000-0000-0000-0000-0000000000d1') = 1
    and pg_temp.audit_rows('c9000000-0000-0000-0000-0000000000a0',
      'c9000000-0000-0000-0000-0000000000d2') = 1);

  -- Firmengrenze unveraendert.
  perform pg_temp.check('foreign admin reads nothing',
    pg_temp.audit_rows('c9000000-0000-0000-0000-0000000000b0',
      'c9000000-0000-0000-0000-0000000000d1') = 0);

  -- Der Grund erreicht den Mitarbeiter jetzt bewusst — genau dafuer gibt es
  -- diese Migration, sonst waere der PDF-Export nicht inhaltsgleich.
  perform pg_temp.act_as('c9000000-0000-0000-0000-0000000000a1');
  execute 'set local role authenticated';
  perform pg_temp.check('employee receives the reason text for the own assignment',
    (select a.reason = 'Mitarbeiter hat vergessen, den Auftrag zu beenden.'
     from public.get_session_correction_audit(
       array['c9000000-0000-0000-0000-0000000000d1'::uuid]) a));
  perform pg_temp.check('employee receives raw and delta for the own assignment',
    (select a.raw_duration_seconds = 93600 and a.delta_seconds = -63000
       and a.effective_duration_seconds = 30600
     from public.get_session_correction_audit(
       array['c9000000-0000-0000-0000-0000000000d1'::uuid]) a));
  -- Die Tabelle selbst bleibt Admin-only; die Funktion ist der einzige Weg.
  perform pg_temp.check('direct table select stays closed for the employee',
    (select count(*)=0 from public.session_time_corrections));
  execute 'reset role';
end $$;

select name, ok, detail from _checks order by name;

do $$ declare n int; details text;
begin
  select count(*), string_agg(name||': '||coalesce(detail,''), E'\n  ')
    into n, details from _checks where not ok;
  if n > 0 then
    raise exception 'CORRECTION AUDIT SCOPE: % check(s) FAILED:%  %', n, E'\n', details;
  end if;
end $$;

rollback;
