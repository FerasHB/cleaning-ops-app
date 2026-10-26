# Store-Compliance (App Store / Google Play)

Stand: 2026-10-27, Branch `fix/store-compliance-readiness`.

## Öffentliche Webseiten — müssen vor dem Store-Build live sein

Die URLs stehen in `app.json` → `expo.extra.legal` und werden in die Binary
eingebacken (`utils/legalLinks.ts`). Prüfung: `npm run check:legal-urls`
(muss grün sein, bevor `eas build --profile production` läuft).

| Schlüssel | Vorgesehene URL | Zweck | Stand |
|---|---|---|---|
| `privacyPolicyUrl` | `https://novaflowdigital.de/taskops/datenschutz` | Datenschutzerklärung der App (Profil + Registrierung, App Store Connect, Play Console) | **404 — fehlt** |
| `accountDeletionUrl` | `https://novaflowdigital.de/taskops/konto-loeschen` | Play Console „Data deletion“: Web-Anleitung/-Anfrage zur Kontolöschung | **404 — fehlt** |
| `supportUrl` | `https://novaflowdigital.de/taskops/support` | App Store Connect „Support URL“ | **404 — fehlt** |

Andere Pfade sind möglich. Dann `app.json` anpassen, **bevor** gebaut wird.
Die Seiten gelten für Staging- und Produktions-Builds gleich; sie hängen
nicht am Backend.

### Mindestinhalt Datenschutzerklärung (aus dem tatsächlichen App-Verhalten)

- Verantwortlicher (NovaFlow Digital) und Rolle: für Firmendaten handelt die
  App als Auftragsverarbeiter der jeweiligen Firma.
- Daten: Name, E-Mail, Telefon, Firma, Aufträge/Kundenadressen, Arbeitszeiten,
  Abwesenheiten **inkl. Krankmeldungen (Gesundheitsdaten)**, Urlaub,
  Kommentare, Fotos (ohne EXIF/GPS), Push-Token, App-Version/Plattform.
- Kein Tracking, keine Werbung, kein Analytics-/Crash-SDK.
- Empfänger/Auftragsverarbeiter: Supabase (Hosting EU/Frankfurt), Expo
  (Push-Versand), Apple APNs / Google FCM, Resend (E-Mail).
- Löschung: In-App unter Profil → Konto löschen. Was gelöscht wird und was
  bleibt (siehe unten), inkl. Aufbewahrung der Namens-Snapshots in
  Arbeitszeit-/Abwesenheitsnachweisen.

### Mindestinhalt Konto-Löschseite (Google Play)

- App-Name „TaskOps Manager“ und Entwickler wie im Store-Eintrag.
- Schritte in der App: Profil → Konto löschen.
- Weg ohne App (z. B. E-Mail an die Support-Adresse) mit Bearbeitungsfrist.
- Was gelöscht wird, was wie lange bleibt (Tabelle unten).

## Verhalten der Kontolöschung

| Fall | Ergebnis |
|---|---|
| Mitarbeiter / Admin mit weiterem aktiven Admin | Auth-Konto + Profil gelöscht. Aufträge, Kommentare, Fotos, Arbeitszeiten bleiben bei der Firma, Konto-Verknüpfung entfernt (`SET NULL`). Namens-Snapshots in Zuweisungen/Abwesenheiten bleiben (Aufzeichnungspflicht). Push-Text-Name in `notification_outbox` → „Gelöschtes Konto“. |
| Letzter aktiver Admin | Nach doppelter Bestätigung: Firma, alle Firmendaten, alle Konten der Firma und die Storage-Dateien werden gelöscht (eine DB-Transaktion + Storage-Aufräumen). |

Technik: `supabase/migrations/20261026000000_store_compliance_account_deletion.sql`,
`supabase/functions/delete-account/`, Tests
`supabase/tests/store_compliance_account_deletion.test.sql` und
`supabase/functions/tests/delete_account.test.ts`.

## Native Konfiguration

- iOS: `supportsTablet: false` (nur iPhone) für den ersten öffentlichen Release.
- Android: `blockedPermissions` entfernt `SYSTEM_ALERT_WINDOW`,
  `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`. Die Galerie-Auswahl
  braucht auf Android keine Berechtigung (System-Photo-Picker); `JobPhotos`
  fragt dort deshalb nicht mehr vorab.
- Beides ändert den Fingerprint → neuer nativer Build nötig, kein OTA auf
  bestehende Builds.
