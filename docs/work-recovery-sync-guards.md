# Work Recovery S1.6: recovery guards and assignment synchronization

Migration: `supabase/migrations/20261122000000_work_recovery_sync_guards.sql`
Phase: Work Recovery System, slice S1.6. It comes after S1.5 (deletion and export safety, PR #148)
and before S2 (the first code path that creates real recovery cases).

## Problem

A recovery case (`work_recovery_cases`) points to one job and one assignment with `ON DELETE RESTRICT`.
S1 also added a `BEFORE DELETE` guard on `job_assignments` for open cases (`22023`).

Three automatic synchronization paths delete assignment rows or occurrence jobs. Each path is a single
`DELETE` statement. One protected row therefore aborted the whole statement, so every other change was lost:

| Path | Trigger | Effect before S1.6 |
|---|---|---|
| `inherit_occurrence_assignments` | rule edit (`update_job_occurrences` → generate), horizon worker, `reset_job_occurrence_assignments` | Admin rule edit fails (`PartialUpdateError` in the app). The horizon worker catches the error per rule, so that rule stopped extending every night. |
| `compat_sync_assignments_from_legacy` | an old client writes `jobs.assigned_to` | The old client's job update is rejected. |
| PRUNE in `update_job_occurrences` | admin removes a weekday or shortens the date range | Rule edit fails with `23503`. |

An open case failed on the guard (`22023`). A closed case failed on the RESTRICT foreign key (`23503`).

## Behavior after S1.6

| Situation | Behavior |
|---|---|
| Assignment with a case in **any** state (`open`, `under_review`, `approved`, `partially_approved`, `declined`, `superseded`) | The sync path skips it. The row stays unchanged: attendance, timestamps, `work_revision`. |
| Occurrence job with a case in any state (PRUNE) | The job stays, with all its assignments. Like jobs with comments or photos, it stays as leftover history. No skip tombstone is written for it. |
| Other employees on the same job (inherit, compat) | Synced normally. Protection is per assignment. |
| Other jobs, rules and companies | Synced normally. |
| Rule with a protected occurrence in the horizon worker | The run finishes with `errors = 0`. The rule extends normally. |
| Explicit admin action: `set_job_assignments`, job delete, rule delete | **Still fails, visibly.** An open case keeps the existing message. A closed case now gives a clear `22023` message ("…einen abgeschlossenen Prüffall (Nachweis)…") instead of a raw `23503`. Skipping silently would show the admin a removal that did not happen. |

Unchanged:
- case states; no case is opened, resolved or changed;
- job completion (`maybe_complete_job`), the shared job clock, the timesheet and the worktime export;
- the company purge and the S1.5 export and acknowledgement;
- retention.

A kept assignment row with attendance `assigned` does not block job completion. Since `20261029000000`, only started assignees can block completion.

### Invariant: kept evidence never keeps permission for new work

The first review found two functional risks. A rolled-back local run confirmed the first: an employee removed
from a rule, who is still active, could start and complete the occurrence kept for the case, online or
through the offline queue. S1.6 closes both on the server:

| Risk | Fix | Where enforced |
|---|---|---|
| A removed employee keeps a case-protected assignment and could start new work on it | The sync path that would have removed the row now marks it instead: `job_assignments.retained_for_recovery = true` (inherit step 1c, compat sync). The employee's **own** start on a marked row is rejected with `22023` "Diese Zuweisung wurde entfernt und bleibt nur als Nachweis erhalten…". | `guard_retained_assignment_start` (BEFORE UPDATE OF `employee_started_at`). Every start path sets that column on the employee's own row: `start_own_job` (open → in_progress and the late-joiner branch), and `start_own_job_v2` through `_execute_work_session_operation`. The block therefore covers both paths, online and offline replay, and rolls back the whole start. Pause, resume and complete need a start first. |
| A PRUNE-kept case occurrence on a slot the rule no longer has still counts as scheduled work | SYNC sets `is_active = false` on it. This is the existing paused-occurrence marker: hidden from employee and planning lists and KPIs (`excludePausedOccurrences`), with no start button (`canRunJobActions`), and rejected by both start RPCs. If the slot comes back into the rule, SYNC sets it to `parent.is_active` again. | `update_job_occurrences` step 3 (SYNC) and the existing start-RPC guard from `20260829000000` |

Details:
- **Who is blocked:** only the employee, `auth.uid() = employee_id`. Admin corrections and later recovery
  decisions on the same row still work.
- **The flag is cleared on deliberate re-assignment:** the employee is back in the rule's active set
  (inherit step 2b), the legacy pointer is set to them again (compat), or an admin selects them in
  `set_job_assignments`.
- **Existing valid work is never affected:** every sync path excludes started rows
  (`employee_started_at IS NOT NULL`), so a flagged row has never been started. Work sessions, timestamps,
  attendance, case rows and the job clock are untouched.
- **`22023` is the client's business-conflict class:** the offline sync treats it as a permanent rejection,
  does not retry, and keeps the local data (`services/offline/jobs.sync.ts`, `workJournal.core.ts`).
- **Deactivated employees** were already blocked: `start_own_job` and the session RPCs require an active
  profile, and RLS hides their jobs.
- **Scope:** occurrences kept for comments, photos or read markers keep their previous behavior (still active).
  That gap existed before S1.6 and is listed as a separate follow-up.

### Remaining semantic notes (shown here on purpose, not hidden)

1. **A removed employee still sees the retained occurrence** (RLS `is_assigned_to_job`). They cannot start it,
   but the app shows it like normal work until the client reads `retained_for_recovery`, and only a start
   attempt shows the server rejection. Hiding it or showing it as "evidence only" is a client follow-up.
   The same RLS path still allows comments and photos; these are not new work.
2. **A legacy write (`assigned_to`) keeps the protected employee in the set**, flagged, next to the new pointer.
3. **A PRUNE-skipped occurrence stays as an inactive row** on a slot the rule no longer has. RESCHEDULE ignores
   it. SYNC keeps the content fields current. `inherit_occurrence_assignments` can still add new rule members
   to it, with no effect, because the row is inactive.
4. **PRUNE protection is per job.** One case keeps the whole occurrence, and therefore every assignment on it.
   This is unavoidable, because deleting the job would cascade to the protected assignment. The occurrence is
   inactive, so nobody can start new work on it.
5. **Pre-existing, not S1.6:** occurrences kept for comments, photos or read markers on a removed slot stay
   active and startable. Same pattern, separate follow-up.

## Race with case creation

A case `INSERT` takes `FOR KEY SHARE` on the company, job and assignment rows through its foreign keys.
A plain `DELETE … AND NOT EXISTS (case)` waits on that lock. It then continues with its **old** snapshot:
the row itself did not change, so PostgreSQL does not re-evaluate the condition. The new case is
invisible to it, and only the guard stops the delete, with `22023`, aborting the whole sync. That is safe
but noisy.

All three paths therefore use two statements (READ COMMITTED):

1. `SELECT … FOR UPDATE` on the candidate rows, without the case filter. This waits for any uncommitted
   case insert.
2. `DELETE … AND NOT EXISTS (case)` as a separate statement, with a new snapshot, which sees the committed case.

The reverse order also holds. A case insert that starts after step 1 waits, because `FOR KEY SHARE`
conflicts with `FOR UPDATE`. After the sync commits, the insert either fails on the foreign key (`23503`,
the row was deleted) or succeeds (the row stayed). The server never stores a case whose assignment is gone.

Limit: step 1 locks the rows that are candidates at that moment. A row can become a candidate between step 1
and step 2, for example because a concurrent transaction commits. If a case is inserted on exactly that row
in the same window, the `DELETE` waits on it unlocked. The guard then aborts the sync with `22023`, as before
S1.6. This fails closed: nothing is deleted silently. It is narrower than the original window, not gone.

**S2 rule:** when a case insert fails with `23503` or `22023`, the evidence is **not** stored on the server.
The client must keep it locally and never discard it.

Proof: `supabase/tests/work_recovery_sync_guards_concurrency.test.sh`, races 1–3.
- Race 1 fails without step 1: in a local run with a function body that had only the skip check, the sync aborted with `22023`. This was a development check, not a committed test.
- The S1 guard and the RESTRICT foreign keys stay as the fallback.

## Lock contract for recovery writers (S2 and later)

**This replaces the `FOR SHARE` wording in the S1.5 document and migration comment.**

Every function that writes `work_recovery_*` creates a case, changes its state, or appends a submission
or event. Each such function starts with:

```sql
perform public._lock_company_for_recovery_write(v_company_id);
```

- **Mode `FOR KEY SHARE`.** It conflicts only with `FOR UPDATE`, which is exactly the company purge
  (`purge_company_for_last_admin` locks `companies FOR UPDATE`).
  - It does not block ordinary company updates (`update_own_company`, which takes `FOR NO KEY UPDATE`).
  - `FOR SHARE` would block them for no benefit.
  - Proof: race 4 of the concurrency test. A company update with `lock_timeout = 2s` passes while the lock
    is held, and the purge waits.
- **Order:** company → job → assignment → case (`FOR UPDATE`) → inserts.
  - Never lock a case, profile or job before the company.
  - Lock the job before its assignment. This matches PRUNE (job `FOR UPDATE`, then the cascade to its
    assignments) and the order of the foreign-key checks on a case insert: company, job, assignment.
    The constraint triggers fire in name order, and the names sort by creation oid, as checked locally.
    An S2 function that locks the assignment first, then the job, can deadlock (`40P01`) against PRUNE.
  - The purge locks company → admin profiles → all `work_recovery_*` rows, so a writer in another order can deadlock.
- **Why an explicit call when the foreign key already locks on insert:**
  1. The foreign key locks only at the end of the statement, after any case locks the function already holds.
  2. Pure case `UPDATE`s do not touch the company row.
  3. It gives a clear error (`P0002 recovery_company_not_found`) instead of `23503`.
- The helper is `SECURITY INVOKER` with a fixed `search_path`. `EXECUTE` is revoked from
  `public`/`anon`/`authenticated`/`service_role`. Only `SECURITY DEFINER` RPCs owned by the table owner call it.

No current function writes recovery rows outside the purge, so S1.6 changes no existing writer. S2 must follow the contract.

### Deadlocks that remain (fail safe, existed before)

- **Employee account deletion vs. company purge:** the profile row against case rows (`ON DELETE SET NULL`).
  PostgreSQL detects it (`40P01`) and rolls back one side. Nothing is lost.
- **`set_job_assignments`/`update_job_occurrences` vs. company purge:** job → company against company → job.
  This only happens when the last admin edits and deletes in parallel. Detected and rolled back.

## Index

`work_recovery_cases (assignment_id)`, not partial. The existing index covers only open cases. It served
neither the state-free skip check nor the RESTRICT check that runs on every assignment delete.

## Tests

- `supabase/tests/work_recovery_sync_guards.test.sql`, 53 checks:
  - groups S (structure), I (inherit, open and closed case, other employees), P (PRUNE, open and closed, other weekdays, tombstones),
    L (legacy write, open case plus all four closed states), H (horizon worker), B (company without cases),
    E (explicit admin action still fails, with a clear message), R (idempotence), W (no side effect: worktime,
    status, case fingerprint, case states, `assigned_to` coverage, no duplicates).
  - Group X covers the invariant:
    - the flag is set on exactly the 8 retained rows;
    - case occurrences kept by PRUNE are inactive and other occurrences stay active;
    - a real `start_own_job` by the removed employee is rejected, and the job, assignment and case are unchanged;
    - a regular co-worker starts the same job normally;
    - a direct or session-path start on a flagged row is rejected;
    - an admin correction on that row still works;
    - re-assignment via `set_job_assignments`, the legacy pointer, or the rule clears the flag, and the occurrence becomes active again.
  - Negative control (run once locally during the first iteration, not a committed test): with the pre-S1.6
    function bodies and guard loaded in the same transaction, 19 of the then 41 checks fail. The rule edit fails
    with `22023`/`23503`, the horizon worker reports `errors = 1`, and the legacy write is rejected.
- `supabase/tests/work_recovery_sync_guards_concurrency.test.sh`: 18 checks, races 1–4 (see above).

## Still open before S2 creates real cases

1. **Admin recovery export UI and acknowledgement workflow** (S1.5 server side exists, no UI). Until it
   exists, a company with recovery data cannot be deleted.
2. **Retention decision.** The owner has not approved a retention period or the legal handling of
   recovery evidence when a company is deleted. No Production deletion involving recovery records may rely
   on an assumed policy.
3. **S2 writers must follow the lock contract above**, and the client must keep evidence when a case insert
   fails (`23503`/`22023`).
4. **Client follow-up (UX, not a safety gap):** read `retained_for_recovery` and show such an occurrence as
   "evidence only" or hide it, instead of letting the server reject the start. The server rule holds without it.
5. **Separate follow-up (pre-existing, not S1.6):** occurrences that PRUNE keeps for comments, photos or read
   markers stay active and startable on a slot that was removed.

S1.6 passing does not make S2 ready.
