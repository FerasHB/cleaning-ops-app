// modules/backup-exclusion/index.ts
// Work Recovery S1.8: JS-Zugang zum lokalen Modul BackupExclusion.
// requireOptionalNativeModule liefert null, wenn das Modul im laufenden
// Binary fehlt (Expo Go, Web, älterer Build). Aufrufer müssen dann
// fail-closed reagieren (keine Exportdatei).

import { requireOptionalNativeModule } from "expo-modules-core";

export type BackupExclusionNativeModule = {
  /** iOS: setzt NSURLIsExcludedFromBackupKey und liest es zurück. */
  excludeFromBackup(uri: string): Promise<boolean>;
  /** iOS: liest NSURLIsExcludedFromBackupKey vom Dateisystem. */
  isExcludedFromBackup(uri: string): Promise<boolean>;
  /** Android: Backup-Regeln für recovery-exports/ im Build vorhanden. */
  verifyBackupRules(): Promise<boolean>;
};

export const BackupExclusion =
  requireOptionalNativeModule<BackupExclusionNativeModule>("BackupExclusion");
