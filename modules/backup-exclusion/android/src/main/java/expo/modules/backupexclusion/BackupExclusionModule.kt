// Work Recovery S1.8: prüft zur Laufzeit, dass der Build die Backup-Regeln
// für recovery-exports/ enthält (plugins/withRecoveryExportBackupRules.js).
//
// Android kennt kein Flag pro Datei; maßgeblich sind die Manifest-Regeln
// android:dataExtractionRules (Android 12+, Cloud-Backup und
// Gerät-zu-Gerät-Übertragung) und android:fullBackupContent (bis Android 11).
// Diese Prüfung liest die beiden XML-Ressourcen aus dem installierten Build
// und verlangt den Ausschluss in jedem Abschnitt und kein <include>. Fehlt
// etwas (alter Build, Expo Go, fremde Regeln), meldet sie false und die App
// legt keine Exportdatei an.

package expo.modules.backupexclusion

import android.content.res.XmlResourceParser
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.xmlpull.v1.XmlPullParser

class BackupExclusionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BackupExclusion")

    AsyncFunction("verifyBackupRules") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      val res = context.resources
      val pkg = context.packageName
      val rulesId = res.getIdentifier(DATA_EXTRACTION_RULES, "xml", pkg)
      val legacyId = res.getIdentifier(FULL_BACKUP_CONTENT, "xml", pkg)
      if (rulesId == 0 || legacyId == 0) return@AsyncFunction false
      val rules = excludedSections(res.getXml(rulesId)) ?: return@AsyncFunction false
      val legacy = excludedSections(res.getXml(legacyId)) ?: return@AsyncFunction false
      rules.contains("cloud-backup") &&
        rules.contains("device-transfer") &&
        legacy.contains("full-backup-content")
    }

    // iOS-Gegenstücke; auf Android gilt der Ausschluss über die Regeln.
    AsyncFunction("excludeFromBackup") { _: String -> false }
    AsyncFunction("isExcludedFromBackup") { _: String -> false }
  }

  // Abschnitte, die den Ausschluss enthalten; null, sobald ein <include>
  // vorkommt (dann wären nur noch die eingeschlossenen Dateien gesichert —
  // eine andere Regelart, die hier nicht bewertet wird).
  private fun excludedSections(parser: XmlResourceParser): Set<String>? {
    try {
      val found = mutableSetOf<String>()
      val stack = ArrayList<String>()
      var event = parser.eventType
      while (event != XmlPullParser.END_DOCUMENT) {
        if (event == XmlPullParser.START_TAG) {
          val name = parser.name
          if (name == "include") return null
          if (name == "exclude" &&
            parser.getAttributeValue(null, "domain") == "file" &&
            parser.getAttributeValue(null, "path") == EXCLUDED_PATH &&
            stack.isNotEmpty()
          ) {
            found.add(stack[stack.size - 1])
          }
          stack.add(name)
        } else if (event == XmlPullParser.END_TAG && stack.isNotEmpty()) {
          stack.removeAt(stack.size - 1)
        }
        event = parser.next()
      }
      return found
    } finally {
      parser.close()
    }
  }

  companion object {
    const val DATA_EXTRACTION_RULES = "taskops_data_extraction_rules"
    const val FULL_BACKUP_CONTENT = "taskops_full_backup_content"
    const val EXCLUDED_PATH = "recovery-exports/"
  }
}
