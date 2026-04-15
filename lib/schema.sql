-- =========================================================
-- RLS: JOBS
-- =========================================================

drop policy if exists "read jobs in same company" on public.jobs;
drop policy if exists "admin read jobs in own company" on public.jobs;
drop policy if exists "employee read own assigned jobs" on public.jobs;
drop policy if exists "admin insert jobs in own company" on public.jobs;
drop policy if exists "admin update jobs in own company" on public.jobs;
drop policy if exists "employee update own assigned jobs" on public.jobs;
drop policy if exists "admin delete jobs in own company" on public.jobs;
drop policy if exists "read profiles in same company" on public.profiles;
drop policy if exists "employee read own profile" on public.profiles;
drop policy if exists "admin read profiles in own company" on public.profiles;

create policy "employee read own profile"
on public.profiles
for select
to authenticated
using (
  id = auth.uid()
);

create policy "admin read profiles in own company"
on public.profiles
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);
create policy "admin read jobs in own company"
on public.jobs
for select
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

create policy "employee read own assigned jobs"
on public.jobs
for select
to authenticated
using (
  public.current_user_role() = 'employee'
  and assigned_to = auth.uid()
  and company_id = public.current_user_company_id()
);

create policy "admin insert jobs in own company"
on public.jobs
for insert
to authenticated
with check (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

create policy "admin update jobs in own company"
on public.jobs
for update
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
)
with check (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);

create policy "employee update own assigned jobs"
on public.jobs
for update
to authenticated
using (
  public.current_user_role() = 'employee'
  and assigned_to = auth.uid()
  and company_id = public.current_user_company_id()
)
with check (
  public.current_user_role() = 'employee'
  and assigned_to = auth.uid()
  and company_id = public.current_user_company_id()
);

create policy "admin delete jobs in own company"
on public.jobs
for delete
to authenticated
using (
  public.current_user_role() = 'admin'
  and company_id = public.current_user_company_id()
);




alter table public.profiles
add column if not exists expo_push_token text;