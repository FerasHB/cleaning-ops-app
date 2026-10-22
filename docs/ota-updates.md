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

## Produktions-Update veröffentlichen — Pflichtbefehl

```bash
eas update --channel production --environment production --message "..."
```

- **Nie ohne `--environment production` veröffentlichen.** Nur mit dem Flag
  lädt eas-cli die Variablen der EAS-Umgebung `production` und setzt
  `EXPO_NO_DOTENV=1` — lokale `.env`/`.env.local` werden dann ignoriert.
  Ohne das Flag liest der Export die lokalen Dateien, und `.env.local` zeigt
  lokal auf **Staging**: das Produktions-Update würde gegen die
  Staging-Datenbank laufen.
- `APP_VARIANT` darf in der Shell **nicht** gesetzt sein (sonst entsteht ein
  Update mit Staging-Identität und anderer Runtime, das kein
  Produktions-Build annimmt).
- Nur von einem sauberen, aktuellen `main` veröffentlichen.
- **Zuerst auf Staging testen** (`APP_VARIANT` ist keine EAS-Variable, es kommt
  aus der Shell):
  `APP_VARIANT=development eas update --channel staging --environment development --message "..."`,
  dann auf einem `preview-staging`-Gerät prüfen.
- Optional schrittweise ausrollen (`--rollout-percentage`), Rücknahme über
  `eas update:rollback`.

## Was per OTA geht — und was nicht

OTA nur für kompatible JS-/TS-/Asset-Änderungen. **Neuer nativer Build nötig**
bei: Expo-SDK-/React-Native-Upgrade, neuem/aktualisiertem nativen Modul,
Config-Plugins, Berechtigungen/`infoPlist`, Icon/Splash, Schema/Bundle-ID,
`google-services.json` — und bei **jeder Änderung an `eas.json`** (die Datei
geht in den Fingerprint ein und ändert die Runtime aller Varianten).
Weicht der Fingerprint ab, erreicht ein Update keinen bestehenden Build.

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
