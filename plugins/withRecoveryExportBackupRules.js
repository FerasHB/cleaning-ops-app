// plugins/withRecoveryExportBackupRules.js
// Work Recovery S1.8: nimmt NUR das Recovery-Exportverzeichnis von Android-
// Backups aus. Alles andere bleibt wie bisher (allowBackup unverändert).
//
// Paths.document von expo-file-system ist Context.getFilesDir(), also Domain
// "file". Zwei Regelwerke, weil die App ab minSdk 24 läuft:
//   * android:dataExtractionRules (Android 12+): <cloud-backup> UND
//     <device-transfer> brauchen je einen eigenen Ausschluss — ein Modus ohne
//     Regeln wäre vollständig aktiv.
//   * android:fullBackupContent (Android 6–11).
// Nur <exclude>, kein <include>: ohne <include> sichert Android weiterhin alle
// übrigen Daten. Ist eines der Attribute bereits von einem anderen Plugin mit
// anderem Wert gesetzt, bricht der Build ab, statt Regeln still zu ersetzen.
// Laufzeitprüfung im Build: modules/backup-exclusion (verifyBackupRules).

const fs = require("fs");
const path = require("path");
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");

const EXCLUDED_PATH = "recovery-exports/";
const DATA_EXTRACTION_RULES = "taskops_data_extraction_rules";
const FULL_BACKUP_CONTENT = "taskops_full_backup_content";
const EXCLUDE = `<exclude domain="file" path="${EXCLUDED_PATH}"/>`;

const DATA_EXTRACTION_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Work Recovery S1.8 (generiert): Recovery-Exportdateien nie sichern oder übertragen. -->
<data-extraction-rules>
  <cloud-backup>
    ${EXCLUDE}
  </cloud-backup>
  <device-transfer>
    ${EXCLUDE}
  </device-transfer>
</data-extraction-rules>
`;

const FULL_BACKUP_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Work Recovery S1.8 (generiert): Recovery-Exportdateien nie sichern. -->
<full-backup-content>
  ${EXCLUDE}
</full-backup-content>
`;

function setOrThrow(application, attr, value) {
  const current = application.$[attr];
  if (current !== undefined && current !== value) {
    throw new Error(
      `[withRecoveryExportBackupRules] ${attr} ist bereits "${current}" gesetzt. ` +
        "Backup-Regeln zusammenführen statt überschreiben.",
    );
  }
  application.$[attr] = value;
}

function applyBackupRulesToManifest(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  setOrThrow(application, "android:dataExtractionRules", `@xml/${DATA_EXTRACTION_RULES}`);
  setOrThrow(application, "android:fullBackupContent", `@xml/${FULL_BACKUP_CONTENT}`);
  return manifest;
}

async function writeBackupRuleFiles(platformProjectRoot) {
  const dir = path.join(platformProjectRoot, "app", "src", "main", "res", "xml");
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${DATA_EXTRACTION_RULES}.xml`), DATA_EXTRACTION_XML);
  await fs.promises.writeFile(path.join(dir, `${FULL_BACKUP_CONTENT}.xml`), FULL_BACKUP_XML);
}

function withRecoveryExportBackupRules(config) {
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyBackupRulesToManifest(cfg.modResults);
    return cfg;
  });
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      await writeBackupRuleFiles(cfg.modRequest.platformProjectRoot);
      return cfg;
    },
  ]);
}

module.exports = withRecoveryExportBackupRules;
module.exports.applyBackupRulesToManifest = applyBackupRulesToManifest;
module.exports.DATA_EXTRACTION_XML = DATA_EXTRACTION_XML;
module.exports.FULL_BACKUP_XML = FULL_BACKUP_XML;
module.exports.EXCLUDED_PATH = EXCLUDED_PATH;
