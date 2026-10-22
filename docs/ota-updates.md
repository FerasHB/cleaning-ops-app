# OTA-Updates (EAS Update)

Beide App-Varianten nutzen EAS Update über dasselbe EAS-Projekt
(`https://u.expo.dev/e746276f-fbd7-49bd-aab6-dc3176e7661a`) mit
`runtimeVersion: { policy: "fingerprint" }` (`app.config.js`).

| Build-Profil | Kanal | Branch | Backend | App-Identität |
|---|---|---|---|---|
| `production` | `production` | `production` | Produktion | `com.ferash.taskopsmanager`, Schema `taskopsmanager` |
| `preview-staging` | `staging` | `staging` | Staging | iOS `com.ferash.taskopsmanager.dev`, Schema `taskopsmanagerdev` |
| `preview`, `development` | – | – | – | kein Kanal → empfängt keine OTA-Updates |

Getrennt wird zweifach: über den **Kanal** (im Build fest eingebrannt) und über
die **Fingerprint-Runtime** (Bundle-ID/Schema/Name unterscheiden sich, daher
andere Runtime). Ein Update erreicht nur Builds mit exakt gleichem Kanal UND
gleicher Runtime.

## Updates veröffentlichen — nur über die npm-Skripte

```bash
# 1. Immer zuerst Staging
npm run ota:staging -- --message "..."

# 2. Danach Produktion — nur von sauberem, aktuellem main
npm run ota:production -- --message "..."
```

Die Skripte (`package.json`) setzen alles Nötige selbst:

| Skript | `APP_VARIANT` | Kanal | EAS-Umgebung | Backend |
|---|---|---|---|---|
| `ota:production` | entfernt (`env -u`) | `production` | `production` | Produktion |
| `ota:staging` | `development` | `staging` | `development` | Staging |

Weitere `eas update`-Argumente nach `--` anhängen (z. B.
`--platform ios`, `--rollout-percentage 10`). Rücknahme über
`eas update:rollback`.

Warum keine rohen `eas update`-Befehle:

- Nur mit `--environment` lädt eas-cli die Variablen der EAS-Umgebung und
  setzt `EXPO_NO_DOTENV=1` — lokale `.env`/`.env.local` werden ignoriert.
  Ohne das Flag liest der Export die lokalen Dateien, und `.env.local` zeigt
  lokal auf **Staging**: ein Produktions-Update liefe gegen die
  Staging-Datenbank.
- `APP_VARIANT` ist keine EAS-Variable, sie kommt aus der Shell. Bleibt sie
  beim Produktions-Publish versehentlich `development`, entsteht ein Update mit
  Staging-Identität.
- Beide Skripte setzen `TASKOPS_ENV_GUARD=1`: `app.config.js` bricht dann ab,
  wenn Variante und Supabase-Projekt nicht zusammenpassen (Produktion ⇒ nie
  Staging, Staging ⇒ nie Produktion). Derselbe Guard greift automatisch in
  jedem EAS-Build (`EAS_BUILD=true`). Lokale Entwicklung ist nicht betroffen.

## Was per OTA geht — und was nicht

OTA nur für kompatible JS-/TS-/Asset-Änderungen. **Neuer nativer Build nötig**
bei: Expo-SDK-/React-Native-Upgrade, neuem/aktualisiertem nativen Modul,
Config-Plugins, Berechtigungen/`infoPlist`, Icon/Splash, Schema/Bundle-ID,
`google-services.json`.

**Fingerprint beachten:** Die Runtime wird aus den nativen Eingaben
berechnet. `fingerprint.config.js` nimmt genau zwei Dinge bewusst heraus:

- **`package.json`-`scripts`** (`SourceSkips.PackageJsonScriptsAll`) — reine
  Skript-Änderungen brauchen **keine** neue Runtime. Abhängigkeiten und alle
  anderen `package.json`-Felder zählen weiter.
- **`eas.json` → `build.<profil>.channel`** — reine Kanal-Änderungen brauchen
  **keine** neue Runtime. Der Rest von `eas.json` (z. B. `env`,
  `environment`, `buildConfiguration`, `gradleCommand`, `buildType`) bleibt im
  Fingerprint, weil er die native Ausgabe beeinflussen kann.

Alle anderen nativen Änderungen (siehe oben, inkl. `app.json`/`app.config.js`
und nicht-Kanal-Felder in `eas.json`) ergeben weiterhin eine neue Runtime →
neuer nativer Build. Weicht der Fingerprint ab, erreicht ein Update keinen
bestehenden Build. `eas update` warnt, wenn es für die berechnete Runtime
keinen passenden Build gibt — diese Warnung nie ignorieren.

**`fingerprint.config.js` nicht leichtfertig lockern.** Jede weitere
Ausnahme kann ein JS-Bundle auf eine inkompatible Binary schicken (Absturz
beim Start). Eine Änderung an der Datei ändert selbst die Runtime aller
Varianten — also nur zusammen mit einem neuen nativen Build.

Zusätzlich beachten:

- Die serverseitige Mindestversion (`enforce_min_client_version`) prüft die
  **native** Build-Nummer. Ein OTA-Update ändert sie nicht — ein
  Server-Mindeststand kann deshalb nur einen neuen nativen Build erzwingen.
- Updates werden im Hintergrund geladen und beim nächsten Kaltstart aktiv.
  Formate der Offline-Queue/des Caches (AsyncStorage) müssen zwischen alter
  und neuer JS-Version lesbar bleiben.

## Welche Builds empfangen Updates

- Die Produktions-Builds **iOS 13 / Android 9 (und älter) können keine
  OTA-Updates empfangen** — sie wurden ohne Update-URL, Runtime und Kanal
  gebaut. Das lässt sich nachträglich nicht ändern.
- Erst der nächste Produktions-Build mit dieser Konfiguration (1.0.1) und
  spätere Builds mit identischem Fingerprint empfangen Updates.
- Die bestehenden Staging-Builds (`preview-staging`, Stand Oktober 2026)
  haben noch die alte Runtime. Updates, die mit dieser Konfiguration
  veröffentlicht werden, erreichen sie **nicht** — vor dem nächsten
  Staging-OTA-Test einen neuen `preview-staging`-Build erstellen.
