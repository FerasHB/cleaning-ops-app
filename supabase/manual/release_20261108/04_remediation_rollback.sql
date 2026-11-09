-- =========================================================
-- ROLLBACK of 03: reopen exactly the jobs the remediation closed, using
-- the backup table. Only touches rows that are still in the state the
-- remediation produced (completed, no later change of completed_at).
-- =========================================================
begin;
with b as (select * from public._multi_assignment_completion_fix_20261108)
update public.jobs j
set status = b.status, completed_at = b.completed_at, completed_by = b.completed_by
from b
where j.id = b.job_id and j.status = 'completed'
  and j.completed_at = (select max(ja.employee_completed_at) from public.job_assignments ja
                        where ja.job_id = j.id and ja.employee_completed_at is not null);
commit;
