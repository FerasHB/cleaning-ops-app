// services/account/recoveryExport.ts
// Work Recovery S1.7: echte Geräte-Abhängigkeiten für den Recovery-Export
// vor der Firmenlöschung. Ablauf und Prüfregeln: recoveryExport.core.ts.
//
// Datei: im App-Dokumentverzeichnis (Paths.document/recovery-exports), NICHT
// im Cache und NICHT nach dem Teilen gelöscht — sie ist der Nachweis, den der
// Admin danach selbst sichert. Eine neue Datei für dieselbe Firma ersetzt
// eine ältere nicht automatisch (Dateiname enthält die export_id); nichts
// wird serverseitig abgelegt.
//
// Datenschutz: kein Logging, keine Analytics. Die Datei enthält interne
// Admin-Notizen und personenbezogene Nachweise.
//
// S1.8 Backup-Ausschluss (fail closed, Details:
// docs/work-recovery-export-file-security.md):
//   * iOS: NSURLIsExcludedFromBackupKey auf Verzeichnis UND Datei, jeweils
//     gesetzt und vom Dateisystem zurückgelesen (modules/backup-exclusion).
//   * Android: Backup-Regeln aus plugins/withRecoveryExportBackupRules.js;
//     das Modul prüft, dass der installierte Build sie enthält.
//   * Fehlt das Modul (Expo Go, alter Build) oder schlägt eine Prüfung fehl,
//     wird keine Datei angelegt.
// Dateien werden nie automatisch gelöscht; nur deleteFile() auf
// ausdrücklichen Wunsch, und nur über einen geprüften Dateinamen im festen
// Verzeichnis (nie über eine übergebene URI).

import { BackupExclusion } from "@/modules/backup-exclusion";
import { i18next } from "@/i18n";
import { supabase } from "@/lib/supabase";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import {
  RECOVERY_EXPORT_DIR_NAME,
  type RecoveryExportDeps,
} from "@/services/account/recoveryExport.core";

function exportDirectory(): Directory {
  return new Directory(Paths.document, RECOVERY_EXPORT_DIR_NAME);
}

// Löst einen Dateinamen im festen Exportverzeichnis auf. Der Name ist in
// recoveryExport.core.ts bereits gegen das strikte Muster geprüft; hier wird
// zusätzlich verlangt, dass das Ergebnis direkt im Verzeichnis liegt.
function exportFile(fileName: string): File {
  if (!/^[A-Za-z0-9_.-]+$/.test(fileName) || fileName.includes("..")) {
    throw new Error("invalid_file_name");
  }
  const dir = exportDirectory();
  const file = new File(dir, fileName);
  const base = dir.uri.replace(/\/+$/, "");
  if (file.uri !== `${base}/${fileName}`) throw new Error("invalid_file_name");
  return file;
}

export const recoveryExportDeps: RecoveryExportDeps = {
  platform: Platform.OS,

  async fetchExportFile() {
    // POST (supabase-js-Standard): die Funktion legt einen Export-Nachweis an.
    const { data, error } = await supabase.rpc("get_company_recovery_export_file");
    if (error) throw error;
    return data;
  },

  async ensureSecureDirectory() {
    if (!BackupExclusion) return false;
    if (Platform.OS === "android") {
      // Regeln zuerst: ohne sie wird nicht einmal das Verzeichnis angelegt.
      if ((await BackupExclusion.verifyBackupRules()) !== true) return false;
      const dir = exportDirectory();
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      return true;
    }
    if (Platform.OS === "ios") {
      const dir = exportDirectory();
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      // Bei jedem Export neu setzen (Apple: Dateioperationen können das Flag
      // zurücksetzen) und zurücklesen. Deckt auch ältere Dateien im Ordner.
      return (
        (await BackupExclusion.excludeFromBackup(dir.uri)) === true &&
        (await BackupExclusion.isExcludedFromBackup(dir.uri)) === true
      );
    }
    return false;
  },

  async protectFile(uri) {
    if (!BackupExclusion) return false;
    if (Platform.OS === "android") return true; // Regeln gelten für das ganze Verzeichnis
    if (Platform.OS === "ios") {
      return (
        (await BackupExclusion.excludeFromBackup(uri)) === true &&
        (await BackupExclusion.isExcludedFromBackup(uri)) === true
      );
    }
    return false;
  },

  async fileExists(fileName) {
    return exportFile(fileName).exists;
  },

  async deleteFile(fileName) {
    const file = exportFile(fileName);
    if (file.exists) file.delete();
  },

  async writeFile(fileName, text) {
    const dir = exportDirectory();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = exportFile(fileName);
    if (file.exists) file.delete();
    try {
      file.create();
      file.write(text);
    } catch (err) {
      // Keine unvollständige Datei zurücklassen (z. B. Speicher voll).
      // Aufräumen ist best effort; der ursprüngliche Fehler zählt.
      try {
        if (file.exists) file.delete();
      } catch {
        // ignorieren
      }
      throw err;
    }
    return { uri: file.uri };
  },

  async readFile(uri) {
    return new File(uri).text();
  },

  sha256Hex(text) {
    // Hasht die UTF-8-Bytes (iOS: data(using: .utf8), Android: toByteArray()).
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, {
      encoding: Crypto.CryptoEncoding.HEX,
    });
  },

  async acknowledge(exportId) {
    const { error } = await supabase.rpc("acknowledge_company_recovery_export", {
      p_export_id: exportId,
    });
    if (error) throw error;
  },
};

/**
 * Öffnet den Teilen-Dialog für die bereits geprüfte Datei. Das Ergebnis
 * beweist NICHTS (Abbruch und Erfolg sind auf iOS/Android nicht
 * unterscheidbar) und wird deshalb für die Bestätigung nicht verwendet.
 */
export async function shareRecoveryExportFile(uri: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error(i18next.t("timesheets:shareNotSupported"));
  }
  await Sharing.shareAsync(uri, {
    mimeType: "application/json",
    UTI: "public.json",
    dialogTitle: i18next.t("profile:deleteAccount.recovery.shareTitle"),
  });
}
