-- Local-only regression. All fixture writes roll back.
begin;
set local time zone 'UTC';

insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000',
        'd2000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
        'timezone-admin@example.test', '{"full_name":"Timezone Admin"}');
insert into public.profiles (id, full_name)
values ('d2000000-0000-0000-0000-000000000001', 'Timezone Admin')
on conflict (id) do nothing;
insert into public.companies (id, name, slug, timezone)
values ('d1000000-0000-0000-0000-000000000001', 'Timezone Test',
        'timezone-test', 'Europe/Berlin');
update public.profiles
set company_id = 'd1000000-0000-0000-0000-000000000001',
    role = 'admin', is_active = true
where id = 'd2000000-0000-0000-0000-000000000001';

create or replace function pg_temp.act_as_admin() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', 'd2000000-0000-0000-0000-000000000001',
    'role', 'authenticated')::text, true);
end $f$;

do $$
declare
  test_year int := greatest(2027, extract(year from current_date)::int + 1);
begin
  insert into public.jobs
    (id, company_id, created_by, customer_name, service_name, location_address,
     status, job_type, recurring_days, start_time, is_active,
     recurrence_start_date, recurrence_end_date)
  values
    ('d3000000-0000-0000-0000-000000000001',
     'd1000000-0000-0000-0000-000000000001',
     'd2000000-0000-0000-0000-000000000001',
     'Timezone Test', 'Cleaning', 'Test address', 'open', 'recurring',
     array['mon','tue','wed','thu','fri','sat','sun']::text[], '14:30:00', true,
     make_date(test_year, 9, 21), make_date(test_year + 1, 3, 31));
end $$;

select pg_temp.act_as_admin();
set local role authenticated;
select public.generate_job_occurrences('d3000000-0000-0000-0000-000000000001');
reset role;

do $$
declare
  test_year int := greatest(2027, extract(year from current_date)::int + 1);
  summer_day date := make_date(test_year, 9, 21);
  winter_day date := make_date(test_year, 11, 26);
  fall_day date := make_date(test_year, 10, 31);
  spring_day date := make_date(test_year + 1, 3, 31);
  test_day date;
  actual timestamptz;
  expected timestamptz;
begin
  -- Exact requested 2026 examples; independent of session timezone.
  if (timestamp '2026-09-21 14:30' at time zone 'Europe/Berlin')
     is distinct from timestamptz '2026-09-21 12:30:00+00'
     or (timestamp '2026-10-26 14:30' at time zone 'Europe/Berlin')
     is distinct from timestamptz '2026-10-26 13:30:00+00' then
    raise exception 'Berlin 2026 seasonal timezone rules differ from expected values';
  end if;

  -- Last Sunday of October and March are DST transition dates.
  fall_day := fall_day - extract(dow from fall_day)::int;
  spring_day := spring_day - extract(dow from spring_day)::int;
  foreach test_day in array array[summer_day, winter_day, fall_day, spring_day] loop
    select scheduled_start into actual from public.jobs
    where parent_job_id = 'd3000000-0000-0000-0000-000000000001'
      and date = test_day;
    expected := (test_day + time '14:30') at time zone 'Europe/Berlin';
    if actual is distinct from expected then
      raise exception 'generation mismatch on %: got %, expected %', test_day, actual, expected;
    end if;
  end loop;

  if (make_date(test_year, 9, 21) + time '14:30') at time zone 'Europe/Berlin'
     is distinct from make_timestamptz(test_year, 9, 21, 12, 30, 0, 'UTC')
     or (make_date(test_year, 11, 26) + time '14:30') at time zone 'Europe/Berlin'
     is distinct from make_timestamptz(test_year, 11, 26, 13, 30, 0, 'UTC') then
    raise exception 'generated seasonal offsets wrong';
  end if;
end $$;

create temporary table _original_occurrences on commit drop as
select id, date from public.jobs
where parent_job_id = 'd3000000-0000-0000-0000-000000000001';
update public.jobs set start_time = '15:00:00'
where id = 'd3000000-0000-0000-0000-000000000001';
select pg_temp.act_as_admin();
set local role authenticated;
select public.update_job_occurrences('d3000000-0000-0000-0000-000000000001');
reset role;

do $$
declare bad_count int;
begin
  select count(*) into bad_count
  from _original_occurrences o
  join public.jobs j on j.id = o.id
  where j.date is distinct from o.date
     or j.start_time is distinct from time '15:00:00'
     or j.scheduled_start is distinct from
        ((o.date + time '15:00:00') at time zone 'Europe/Berlin');
  if bad_count <> 0 then raise exception 'reschedule mismatch: % rows', bad_count; end if;
  if (select count(*) from _original_occurrences) is distinct from
     (select count(*) from public.jobs where parent_job_id = 'd3000000-0000-0000-0000-000000000001') then
    raise exception 'reschedule changed occurrence count';
  end if;
end $$;

-- Invalid company timezone must use existing Europe/Berlin fallback.
update public.companies set timezone = 'Invalid/Zone'
where id = 'd1000000-0000-0000-0000-000000000001';
update public.jobs set start_time = '16:00:00'
where id = 'd3000000-0000-0000-0000-000000000001';
select pg_temp.act_as_admin();
set local role authenticated;
select public.update_job_occurrences('d3000000-0000-0000-0000-000000000001');
reset role;
do $$
begin
  if exists (
    select 1 from public.jobs j
    where j.parent_job_id = 'd3000000-0000-0000-0000-000000000001'
      and j.scheduled_start is distinct from
          ((j.date + time '16:00:00') at time zone 'Europe/Berlin')
  ) then raise exception 'invalid timezone fallback failed'; end if;
end $$;

-- Non-Berlin companies must use their own timezone rules.
update public.companies set timezone = 'America/New_York'
where id = 'd1000000-0000-0000-0000-000000000001';
update public.jobs set start_time = '17:00:00'
where id = 'd3000000-0000-0000-0000-000000000001';
select pg_temp.act_as_admin();
set local role authenticated;
select public.update_job_occurrences('d3000000-0000-0000-0000-000000000001');
reset role;
do $$
begin
  if exists (
    select 1 from public.jobs j
    where j.parent_job_id = 'd3000000-0000-0000-0000-000000000001'
      and j.scheduled_start is distinct from
          ((j.date + time '17:00:00') at time zone 'America/New_York')
  ) then raise exception 'company timezone not used'; end if;
end $$;

rollback;
