# Work Recovery S1.7: admin recovery export and acknowledgement

Builds on S1.5 (`docs/work-recovery-deletion-safety.md`): the server already requires a current,
acknowledged recovery export before the last admin can delete a company that has recovery records.
S1.7 adds the app flow that produces and confirms that export.

## Files

| File | Role |
|---|---|
| `supabase/migrations/20261123000000_recovery_export_file.sql` | `get_company_recovery_export_file()`: the S1.5 export as exact text plus SHA-256 |
| `services/account/recoveryExport.core.ts` | Pure validation and flow (dependencies injected, no Expo imports) |
| `services/account/recoveryExport.ts` | Device dependencies: Supabase RPCs, `expo-file-system`, `expo-crypto`, `expo-sharing` |
| `features/profile/components/RecoveryExportSection.tsx` | UI section on the company-deletion screen |
| `features/profile/DeleteAccountScreen.tsx` | Shows the section; delete button stays disabled while it blocks |
| `i18n/locales/{de,en,ar,tr}/profile.json` | `deleteAccount.recovery.*` |

## Why a new server function

`get_company_recovery_export()` returns `jsonb`. supabase-js parses the response with `JSON.parse`, which
changes numbers that JavaScript cannot represent exactly: `1.50` becomes `1.5`, and
`12345678901234567890` becomes `12345678901234567000`. Employee evidence (`claimed_ops`, event `detail`)
can contain such values. A file serialized again from the parsed object would therefore not be a complete,
unchanged copy of the evidence.

`get_company_recovery_export_file()` calls the S1.5 function, so authorization, the
`company_deletion_exports` row and fingerprint reuse are unchanged. It returns:
- `file_text`: the full response as text (`jsonb::text`);
- `file_sha256`: SHA-256 of `file_text` (UTF-8);
- the header fields (`export_id`, `fingerprint`, `record_counts`, `open_case_count`, `generated_at`).

A JSON string survives transport without loss. Grants: `authenticated` only, SECURITY DEFINER, fixed `search_path`.

## Flow

1. **Export records.** The app refuses on web before calling anything: `expo-file-system` is a stub there,
   so the app cannot prove that a file was saved. On iOS and Android, the app:
   - calls `get_company_recovery_export_file()`;
   - validates the response: format, IDs, 64-hex hashes, header counts equal the array lengths in the file,
     `export_id`, `fingerprint` and `open_case_count` in the file equal the header;
   - writes `file_text` **unchanged** to `Paths.document/recovery-exports/taskops-recovery-<company>-<date>-<id>.json`;
   - reads the file back and checks that the text is identical and its SHA-256 equals `file_sha256`.

   Only then does the export count as `verified`. With zero recovery records, nothing is written and no
   acknowledgement is needed (S1.5: a company without recovery rows deletes as before).
2. **Share or save the file** (optional). On iOS and Android the share sheet resolves the same way for
   "saved" and "cancelled" (expo-sharing 14), so its result is **not** used for anything. The file stays in
   the app's document directory. It is not cache, and it is not deleted after sharing.
3. **Explicit confirmation.** The admin ticks "I have saved the file outside this device" and taps
   "Confirm export". `acknowledgeRecoveryExport()` calls `acknowledge_company_recovery_export(export_id)`
   only when the export is verified **and** `userConfirmed === true`. Nothing acknowledges automatically.
   With open cases (`open_case_count > 0`), the checkbox and the button are disabled, and the app explains
   that the cases must be decided first.
4. **Stale.** If the data changed after the export, the server answers `recovery_export_stale`, either at
   acknowledgement or later at deletion. The section then returns to the start and the admin must export
   again. If deletion fails for this reason, the screen resets the section (`resetAfterPathChange`).
5. **Delete button.** The button stays disabled while the section knows that records exist and are not
   acknowledged, or while cases are open. Before the first export the app does not know whether records
   exist, so the first deletion attempt can be rejected by the server. After a rejection with
   `recovery_export_required`, `recovery_export_stale` or `recovery_cases_open`, the button stays
   disabled until the section reports an acknowledged export (or a fresh export with no records). The
   binding check is still on the server (purge).
6. **Failed write.** If writing the file fails (for example, the disk is full), the partial file is
   deleted (best effort) and the export is not usable.

## Security properties

- **Authorization:** unchanged from S1.5. Only an active admin, only their own company, and only their own
  export can be acknowledged.
- **Acknowledgement requires two things:** a verified file and an explicit user action. A checkbox alone
  cannot authorize deletion: without the server acknowledgement the purge returns
  `recovery_export_required`, which the integration test checks. Cancelling, a write error, a read-back
  difference or a hash mismatch never leads to an acknowledgement.
- **No evidence in logs:** the core, device module and component contain no `console.*`, and errors carry
  only their kind (`recovery_export_<kind>`). There are no analytics.
- **Worktime export unchanged.**

## Limits (stated openly)

- **No proof of a backup outside the device.** The app proves that a complete, unchanged file exists on the
  device. It cannot prove that the admin also saved it outside the device: the share sheet does not report
  that, so the admin attests it with the checkbox. This is the same trust model as the server-side
  acknowledgement in S1.5.
- **Web is not supported** for this export, and the flow refuses there.
- **The file stays in the app's document directory** after deletion. It contains personal data and internal
  notes. It is not deleted automatically, because the evidence must not be lost by accident (rule C). A
  cleanup rule is part of the open retention decision.
- **Device backups include the file.** iOS backs up the app's `Documents` folder to iCloud or the computer
  (no exclude-from-backup flag is set), and Android Auto Backup is on by default in Expo 54
  (`allowBackup` defaults to `true`, no backup rules in `app.json`). The file is therefore copied to the
  admin's own device backup. It is not visible in the iOS Files app or to other apps, and no screen lists
  it, so another account on the same installation cannot open it. Excluding `recovery-exports/` from
  backups (iOS backup flag, Android backup rules via a config plugin) must be decided and done before
  the release build; it needs a real-device check.
- **Size:** the export is one response with no paging (open item 4 in the S1.5 document).
- **Not tested on a real device.** The flow is tested with injected dependencies (Node) and against the real
  database (`supabase/tests/recovery_export_client_flow.test.sh`, which runs the same TypeScript core with
  real files and real RPCs). `expo-file-system`, `expo-crypto` and the share sheet themselves need a manual
  check on an iOS and an Android build before release.

## Tests

- `supabase/tests/recovery_export_file.test.sql` (20 checks):
  - grants, and refusal for employees, signed-out callers and `anon`;
  - the text matches the S1.5 response, the hash matches, and numbers and umlauts are preserved;
  - no data from other companies, and the export row is reused;
  - the client flow: download only means deletion stays blocked; a stale acknowledgement is refused, then a
    new export, acknowledgement and purge succeed;
  - a deactivated or demoted admin cannot acknowledge.
- `supabase/tests/recovery_export_client_flow.test.sh` (10 checks, real database plus the TypeScript core).
- `scripts/check-recovery-export.mjs` (16 checks):
  - validation, write and verification paths, acknowledgement only with `true`;
  - stale handling, and retry with the same `export_id`;
  - no `console.*`;
  - wiring in the screen and component;
  - i18n parity across de, en, ar and tr.
