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

import { i18next } from "@/i18n";
import { supabase } from "@/lib/supabase";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import type { RecoveryExportDeps } from "@/services/account/recoveryExport.core";

export const recoveryExportDeps: RecoveryExportDeps = {
  platform: Platform.OS,

  async fetchExportFile() {
    // POST (supabase-js-Standard): die Funktion legt einen Export-Nachweis an.
    const { data, error } = await supabase.rpc("get_company_recovery_export_file");
    if (error) throw error;
    return data;
  },

  async writeFile(fileName, text) {
    const dir = new Directory(Paths.document, "recovery-exports");
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, fileName);
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
