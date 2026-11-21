// Work Recovery S1.8: schließt Recovery-Exportdateien von iOS-Backups aus.
//
// Apple: NSURLIsExcludedFromBackupKey (URLResourceValues.isExcludedFromBackup)
// gilt für das Element und — bei einem Verzeichnis — für dessen Inhalt. Der
// Wert kann durch Dateioperationen zurückgesetzt werden; deshalb setzt die App
// ihn bei jedem Export erneut und liest ihn hier vom Dateisystem zurück
// (Cache geleert), statt sich auf den Setzaufruf zu verlassen.
// Apple nennt das Flag ausdrücklich keine Garantie gegen jede Kopie (z. B.
// Gerätewechsel) — siehe docs/work-recovery-export-file-security.md.

import ExpoModulesCore

public class BackupExclusionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BackupExclusion")

    // Setzt das Flag und gibt true nur zurück, wenn es danach vom
    // Dateisystem als gesetzt gemeldet wird.
    AsyncFunction("excludeFromBackup") { (url: URL) -> Bool in
      guard url.isFileURL else { return false }
      var target = url
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try target.setResourceValues(values)
      return try BackupExclusionModule.readExcluded(url)
    }

    AsyncFunction("isExcludedFromBackup") { (url: URL) -> Bool in
      guard url.isFileURL else { return false }
      return try BackupExclusionModule.readExcluded(url)
    }

    // Android-Gegenstück; auf iOS nie gültig.
    AsyncFunction("verifyBackupRules") { () -> Bool in
      return false
    }
  }

  // Frische URL mit geleertem Cache: der Wert kommt vom Dateisystem, nicht
  // aus dem Speicher der URL-Instanz.
  private static func readExcluded(_ url: URL) throws -> Bool {
    var fresh = URL(fileURLWithPath: url.path)
    fresh.removeAllCachedResourceValues()
    let values = try fresh.resourceValues(forKeys: [.isExcludedFromBackupKey])
    return values.isExcludedFromBackup == true
  }
}
