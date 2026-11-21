# Work Recovery S1.5: deletion and export safety

Migration: `supabase/migrations/20261121000000_work_recovery_deletion_safety.sql`
Phase: Work Recovery System, slice S1.5. It sits between S1 (foundation, PR #147) and S2 (the first
code path that creates real recovery cases).

## Approved business rules (owner decision)

| Rule | Text | Where enforced |
|---|---|---|
| A | A company must not be deleted while it has open recovery cases. | `purge_company_for_last_admin()` raises `open_recovery_cases`. |
| B | Before deletion, the recovery records must be in an authorized export, and the admin must confirm that export. | `purge_company_for_last_admin()` raises `recovery_export_required` or `recovery_export_stale`. |
| C | No silent evidence loss. | The purge deletes recovery rows only after A and B pass. No other code path can delete them (append-only triggers from S1). |
| D | No invented retention period. | Nothing in this slice sets one. See "Open decisions". |

## When can a company be deleted?

The purge runs these steps in this order, in one transaction:

1. It runs the existing checks: caller has a profile, is active, is an admin, and the confirmed company matches.
2. It locks `companies` (`FOR UPDATE`), then all admin profiles of the company (existing order).
3. It runs the existing last-admin check (`not_last_admin`).
4. **New:** it locks all `work_recovery_cases` rows of the company (`FOR UPDATE`).
5. **New (rule A):** if any case is in state `open` or `under_review`, it raises `open_recovery_cases`.
6. **New (rule B):** if the company has any recovery case at all, it does these checks:
   - The caller's newest *acknowledged* row in `company_deletion_exports` for this company must exist.
     If not, it raises `recovery_export_required`.
   - The fingerprint of that row must equal the fingerprint of the current recovery data.
     If not, it raises `recovery_export_stale`.
7. Only then does it set the purge flag and delete the data (unchanged from S1).

A company with **no** recovery rows is deleted exactly as before; no export confirmation is needed.
Today this is every company, because nothing creates recovery cases before S2. So installed app
builds keep working, and the store-compliance account deletion path does not change.

Submissions, action references and events always belong to a case (NOT NULL foreign keys). So
"the company has a case" is the same as "the company has recovery rows".

## Export

`get_company_recovery_export()` (SECURITY DEFINER, `authenticated` only):

- **Who:** only an active admin. The company always comes from the caller's profile, never from a
  parameter. Employees, deactivated admins, sessions without a user and `anon` are refused.
- **What:** every column of every row in `work_recovery_cases`, `work_recovery_submissions`
  (including the raw `claimed_ops`), `work_recovery_action_refs` and `work_recovery_events` for the
  caller's company. This includes the internal `admin_note`. Only admins of the same company can call
  the function, so the note does not reach employees or other companies.
- **Response:** `export_id`, `fingerprint`, `generated_at`, `record_counts`, `open_case_count`,
  `recovery` (the document) and `people` (a map from profile ID to name, outside the fingerprint so
  a name change does not invalidate an export).
- **Side effect:** it inserts an unacknowledged row in `company_deletion_exports`. If the same admin
  already has a row with the same fingerprint, it returns that row instead, so repeated exports of
  unchanged data do not grow the table.

The worktime export `get_company_worktime_export()` is **not changed**.

### Fingerprint

`_work_recovery_export_doc(company)` builds the document in one SQL statement, so it reads one
snapshot. `_work_recovery_fingerprint(doc)` is SHA-256 (hex) over its `jsonb` text form. Each
array has a fixed sort order. The document function runs with `TimeZone = UTC`, because
`to_jsonb(timestamptz)` renders in the session time zone and the export (PostgREST session) and the
purge (service-role session) could otherwise produce different text for the same data.

Any change to the recovery data changes the fingerprint and so makes an acknowledgement stale.
Examples: a new case, submission, action reference or event; a state, revision or note change; an
account deletion that sets `employee_id`/`actor_id` to NULL. This fails closed: the admin must export
again.

## Acknowledgement

`acknowledge_company_recovery_export(p_export_id)` (SECURITY DEFINER, `authenticated` only):

- Only the admin who created that export, and only in their current company. An unknown ID, another
  admin's export and another company's export all give the same error (`42501 export_not_found`),
  so the function does not reveal whether an ID exists.
- It recomputes the fingerprint. On a mismatch it raises `recovery_export_stale`.
- It is idempotent for a still-current export.

The client checkbox is still shown, but it is no longer the proof. The proof is the server row with
`acknowledged_at` set and a fingerprint that still matches at purge time.

## Concurrency

- Any INSERT into a `work_recovery_*` table takes `FOR KEY SHARE` on the company row through the
  `company_id` foreign key. The purge holds `FOR UPDATE` on that row. These lock modes conflict
  (PostgreSQL docs, "Conflicting Row-Level Locks"), so:
  - an insert that commits first is seen by the purge's later statements (READ COMMITTED takes a new
    snapshot per statement), and the purge refuses;
  - an insert that starts after the purge waits, then fails on the foreign key.
- Case UPDATEs, and the `ON DELETE SET NULL` updates after an account deletion, do not touch the
  company row. The purge therefore locks all recovery rows of the company (cases, submissions,
  action references, events) before it checks them.
- `supabase/tests/work_recovery_purge_concurrency.test.sh` proves both insert orders and the
  "new event during export" case with real parallel sessions.

**Contract for S2 and later:** every RPC that writes recovery data must first lock the company row.
Lock order is company, then case. Never lock admin profiles before the company row.
**Updated in S1.6:** the mode is `FOR KEY SHARE`, not `FOR SHARE`, through
`_lock_company_for_recovery_write()`. See `docs/work-recovery-sync-guards.md`.

## Error codes (Edge Function `delete-account`)

| SQL message | HTTP | `code` | Client text key |
|---|---|---|---|
| `open_recovery_cases` | 409 | `recovery_cases_open` | `profile:deleteAccount.recoveryCasesOpenMessage` |
| `recovery_export_required` | 409 | `recovery_export_required` | `profile:deleteAccount.recoveryExportMessage` |
| `recovery_export_stale` | 409 | `recovery_export_stale` | `profile:deleteAccount.recoveryExportMessage` |

An app build without these codes shows the German server text in a generic error dialog. Nothing is
deleted in any of these cases. The purge signature is unchanged, so the SQL migration and the Edge
Function can be deployed in either order. An old Edge Function maps the new messages to
`purge_failed` (500, "nothing deleted").

## Not in S1.5 (deliberately)

- **No recovery export screen in the app.** No case can exist before S2. S2 must ship the admin UI
  that calls `get_company_recovery_export()`, writes the file on the device (like the worktime
  export), and then calls `acknowledge_company_recovery_export()`. Until that UI exists, a company
  with recovery data cannot be deleted. This is the safe failure direction.
- **Automatic assignment synchronization.** Done in S1.6 (`docs/work-recovery-sync-guards.md`).
  Original note: `inherit_occurrence_assignments`,
  `compat_sync_assignments_from_legacy` and the PRUNE step of `update_job_occurrences` delete
  assignment rows. They will fail on the S1 assignment guard (`22023`) or the RESTRICT foreign keys
  (`23503`) once a case exists. This is unrelated to company deletion. The company purge sets
  `taskops.company_purge`, which the guard honours, and deletes recovery rows first. It must be fixed
  **before or together with S2**: skip assignments or jobs that have any recovery case
  (`not exists (select 1 from work_recovery_cases c where c.assignment_id = …)`), and keep the guard
  as the backstop. Tests needed: rule edit, horizon worker and legacy `assigned_to` change, each
  with an open case and with a closed case.
- **No authentication or session changes.**
- **No change to worktime, job completion or the worktime export.**

## Open decisions (not decided by this slice)

1. **Retention (rule D).** After a verified export, the purge still deletes decided cases together
   with the company, the same way the approved worktime flow deletes worktime after its export.
   Rule B allows deletion after export and confirmation. Whether recovery evidence needs a legal
   retention period beyond the admin's export is open. If the answer is yes, the purge must block
   on any recovery rows until an archive design exists.
2. **Server-verified worktime export.** The worktime export (20261028000000) still has only a client
   checkbox. Binding it to the same mechanism would make every worktime change invalidate the
   confirmation. That is a product decision.
3. **Attribution after account deletion (O6).** An employee account deletion sets `employee_id` to
   NULL on cases, and there is no name snapshot. The evidence stays, but the person's name is lost.
4. **Export size.** `claimed_ops` can be large. One JSON response may need paging later.
