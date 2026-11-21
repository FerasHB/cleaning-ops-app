# Work Recovery S1.8: export file security and lifecycle

Builds on S1.7 (`docs/work-recovery-export-ui.md`). S1.7 writes the recovery export (internal admin notes,
evidence about named employees) to `Paths.document/recovery-exports/` on the device. On both platforms
that folder was part of automatic device backups, and nothing ever removed the file. S1.8 changes two
things:

1. The export folder is excluded from device backups. If the app cannot confirm the exclusion, it
   creates no file (fail closed).
2. After the server has accepted the confirmation, the admin can delete the local copy explicitly.

Server functions, acknowledgement rules and the worktime export are unchanged. There is no migration.

## Files

| File | Role |
|---|---|
| `modules/backup-exclusion/` | Local Expo module (autolinked from `./modules`): iOS Swift, Android Kotlin, JS wrapper `index.ts` |
| `plugins/withRecoveryExportBackupRules.js` | Config plugin: Android backup rules for `recovery-exports/` only |
| `app.json` | Registers the plugin (last entry) |
| `services/account/recoveryExport.core.ts` | `ensureSecureDirectory` / `protectFile` in the flow, file-name check, `deleteLocalRecoveryCopy` |
| `services/account/recoveryExport.ts` | Device implementation of the new dependencies |
| `features/profile/components/RecoveryExportSection.tsx` | "Delete local copy" button and its confirmation dialog |
| `i18n/locales/{de,en,ar,tr}/profile.json` | New `deleteAccount.recovery.*` texts |

## iOS

- **Mechanism:** `URLResourceValues.isExcludedFromBackup` (`NSURLIsExcludedFromBackupKey`). Apple: the
  key excludes the item "from all backups of app data"; for a directory, its contents are excluded too.
  expo-file-system 19 has no API for it, so the local module `BackupExclusion` sets it.
- **Set and read back:** `excludeFromBackup(uri)` sets the flag and then reads it again from a fresh URL
  with its resource cache cleared. It returns `true` only if the file system reports the flag as set.
  The app does not trust the set call alone.
- **Order on every export:**
  1. create the directory if needed, set the flag on it and read it back;
  2. only then write the file;
  3. set and read back the flag on the file itself (Apple notes that some file operations reset the flag);
  4. read the file back and check text and SHA-256 as in S1.7.
  If step 1 fails, nothing is written (`insecure_storage`). If step 3 fails, the file is deleted and the
  export fails with `insecure_storage`.
- **Limit:** Apple describes the flag as a hint, "not a mechanism to guarantee those items never appear
  in a backup or on a restored device". Its effect on device-to-device migration (Quick Start) is not
  documented. The flag is therefore the strongest available measure, not a guarantee.

## Android

- **Mechanism:** backup rules in the manifest, written by the config plugin at prebuild:
  - `android:dataExtractionRules="@xml/taskops_data_extraction_rules"` (Android 12+), with
    `<exclude domain="file" path="recovery-exports/"/>` in both `<cloud-backup>` and `<device-transfer>`.
    A mode without rules would be fully enabled, so both sections are needed.
  - `android:fullBackupContent="@xml/taskops_full_backup_content"` (Android 6 to 11, minSdk 24), with
    the same exclude.
  - Only `<exclude>`, no `<include>`: all other app data is backed up as before. `allowBackup` stays
    `true`. `disableIfNoEncryptionCapabilities` is not used, because it would change backups of all data.
  - `Paths.document` is `Context.getFilesDir()`, which is the `file` domain.
- **No silent overwrite:** if another plugin has already set either attribute to a different value, the
  build fails with an error instead of replacing those rules. No installed library sets them today.
- **Runtime check:** Android has no per-file flag. Before creating the folder, `verifyBackupRules()` reads
  both XML resources from the installed build and requires the exclude in every section and no
  `<include>`. A build without the rules (Expo Go, an older build) gets `false`, and no file is created.
  The check proves that the rules are in the build. That the manifest points to them is checked at
  prebuild (test below), not at runtime.
- **Not covered:** the Android 16 QPR2 `<cross-platform-transfer>` section (transfer to iOS) is not
  configured; its default behaviour without the section is not clearly documented.

## Delete local copy

- **Shown only** after the server accepted the confirmation (phase `acknowledged`), for the file of that
  export, and only while the file is verified and its name passes the check below.
- **Separate confirmation:** a destructive dialog says that the file is deleted permanently, that the
  server confirmation does not prove a copy outside the device, and that server data stays unchanged.
  Cancelling deletes nothing.
- **What it deletes:** exactly one file, resolved from its name inside `recovery-exports/`. The name must
  match `taskops-recovery-<slug>-<YYYY-MM-DD>-<8 hex>.json`, where the 8 hex characters are the start of
  this export's `export_id` (lower case). Names with `/`, `..`, `%`, URIs or another export's id are
  refused. The device code also requires the resolved URI to sit directly in the folder. A URI is never
  accepted for deletion.
- **What it never deletes:** anything on the server. The function calls no RPC: review cases,
  submissions, events and `company_deletion_exports` rows are untouched. The integration test checks the
  row counts before and after.
- **No folder listing, no bulk delete.** Files from earlier exports, or from another admin on a shared
  device, are never offered or removed. This protects evidence that another person may still rely on.
- **Failures:** a failed delete, or a file still present afterwards, reports `delete_failed` and the
  button stays available. Deleting a file that is already gone returns `already_gone`. A second tap
  while deleting is ignored (busy state).
- **No automatic deletion:** sharing, signing out, deleting the account and deleting the company still
  leave the file in place.
- **No retention period** is defined. When files should be removed is part of the open retention decision.

## Upgrades and existing files

- S1.7 was merged but never shipped in an app build, so no device should have export files from it.
- If a folder from an earlier build does exist on iOS, the next export sets the flag on the folder again,
  which also covers the older files inside it. On Android, the rules of the new build cover the whole
  folder, including older files.
- Older files are not listed and not deleted automatically.
- The module and the plugin change native code. With `runtimeVersion.policy = "fingerprint"`, this is a
  new runtime: it needs a new EAS build and cannot be delivered by OTA. A JS bundle that somehow runs
  without the module finds `BackupExclusion === null` and refuses the export. For an admin on such a
  build, company deletion stays blocked when recovery records exist (the server requires the export).

## Remaining limits

- Interrupted writes (app killed during the write) can leave a partial file. It sits in the excluded
  folder, is never verified or offered, and is not cleaned up automatically.
- Each new export creates a new file; earlier files of the same company stay on the device.
- The share sheet still cannot prove a copy outside the device; the admin attests it.

## Tests

- `scripts/check-recovery-export-file-security.mjs` (22 tests):
  - fail closed: no confirmed exclusion means no write; an unprotected file is deleted;
  - order of the steps, and the flag set again on every export (older files);
  - file names: traversal, URIs, another export's id, upper-case ids;
  - delete only after acknowledgement and an explicit `true`; cancel; repeat; delete failures; two exports;
  - device code fails closed without the module and deletes only inside the fixed folder;
  - Swift sets and reads back the flag; Kotlin requires the exclude in every section;
  - autolinking resolves the module for iOS and Android;
  - the plugin sets both attributes, is idempotent, refuses foreign rules, and its XML has no `<include>`;
  - a real `expo prebuild --platform android` in a temporary folder produces the manifest attributes
    and both XML files;
  - UI wiring, no automatic deletion paths, translations in de/en/ar/tr.
- `scripts/check-recovery-export.mjs`: S1.7 tests, with the new dependencies in the fake device.
- `supabase/tests/recovery_export_client_flow.test.sh`: adds "no file without exclusion" and "delete
  local copy leaves all server rows unchanged, purge still possible".

CI cannot prove that a real device keeps the file out of a backup. That remains a mandatory test on real
iOS and Android release builds before release.
