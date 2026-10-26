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

## Verhalten der Kontolöschung (erster öffentlicher Release: Export → Bestätigen → Löschen)

| Fall | Ergebnis |
|---|---|
| Mitarbeiter / Admin mit weiterem aktiven Admin | Login-Konto und Profil (Name, E-Mail, Telefon, Push-Token, Sprache) werden gelöscht. Die Firma (Arbeitgeber) besteht weiter; Aufträge, Kommentare, Fotos und Arbeitszeit-/Abwesenheitseinträge bleiben bei der Firma, die Verknüpfung zum Konto wird entfernt (`SET NULL`). In Zuweisungen/Abwesenheiten bleibt der Namens-Snapshot als Referenz der Firmen-Unterlagen (siehe Annahmen). Der Name in `notification_outbox` wird durch „Gelöschtes Konto“ ersetzt. |
| Letzter aktiver Admin | 1. App erklärt: Konto **und** Firma samt Firmendaten werden dauerhaft gelöscht. 2. Neutraler Hinweis: für den Arbeitgeber können gesetzliche Aufbewahrungspflichten für Beschäftigungs-/Arbeitszeitunterlagen gelten. 3. Angebot **„Arbeitszeitnachweise herunterladen“** (PDF, zusätzlich CSV). 4. Drei Pflicht-Checkboxen (Konto, Firma, „Ich habe verstanden, dass ich für gesetzliche Aufbewahrungspflichten meiner Unternehmensunterlagen selbst verantwortlich bin.“) + Bestätigungsdialog mit Firmennamen (warnt zusätzlich, falls nicht exportiert). 5. Löschung: Login-Konten **aller** Firmenmitglieder, Profile, Firma, Aufträge, Zuweisungen, Arbeitssitzungen, Korrekturen, Abwesenheiten, Urlaubsdaten, Kommentare, Fotos (inkl. Storage), Benachrichtigungen, Einladungen/Tokens — eine DB-Transaktion + Storage-Aufräumen. |

**NovaFlow behält nach der Firmenlöschung kein separates Beschäftigungs-/
Arbeitszeitarchiv.** Das zwischenzeitlich gebaute Archiv
(`compliance_retention_records`, Migration `20261027000000`) ist durch
`20261028000000` ersetzt: die Purge-Funktion archiviert nicht mehr, Tabelle und
Archiv-Funktionen werden entfernt (nur wenn leer). Das Design bleibt in der
Git-Historie für eine spätere rechtliche Prüfung erhalten.

### Arbeitszeit-Export (`get_company_worktime_export`, Migration `20261028000000`)

- Aufruf nur durch **aktive Admins**, nur für die **eigene Firma** (aus dem
  Profil, kein Parameter). Mitarbeiter, inaktive/gelöschte Konten und anon
  werden abgelehnt.
- Die Dateien entstehen **auf dem Gerät** (Cache), werden über den
  Teilen-Dialog gespeichert/gesendet und danach gelöscht. Es wird keine
  Exportdatei auf einem Server abgelegt.
- Formate: **PDF** (lesbar, je Mitarbeiter mit Summe) und **CSV** (`;`, UTF-8
  mit BOM, Formel-Injection-Schutz).

| CSV-Spalte | Inhalt |
|---|---|
| `employee_name`, `employee_id` | Zuordnung zum Mitarbeiter (aktueller Name bzw. Namens-Snapshot; interne ID) |
| `work_date` | Arbeitstag (Zeitzone der Firma) |
| `start_local`, `end_local` | Beginn/Ende lokal (`YYYY-MM-DD HH:MM`) |
| `duration_minutes` | Dauer in Minuten (leer bei nicht beendeter Sitzung) |
| `record_kind` | `session` (Arbeitssitzung) oder `assignment` (Legacy-Auftragszeit) |
| `corrected`, `correction_count`, `last_correction_origin`, `last_corrected_at` | Korrekturen der Arbeitssitzung (effektive Zeiten = letzte Korrektur) |
| `raw_started_at`, `raw_ended_at` | Ursprünglich erfasste Zeiten der Sitzung (UTC) |
| `started_at`, `ended_at` | Effektive Zeiten (UTC) |
| `time_adjustment_count` | Anzahl Admin-Zeitanpassungen (Legacy) |
| `job_id`, `assignment_id` | Interne Referenzen |
| `timezone` | Zeitzone der Firma |

**Nicht** im Export: Abwesenheiten/Krankmeldungen (Gesundheitsdaten),
Urlaub, Notizen, Begründungstexte, Kommentare, Fotos, Kunde/Adresse/Service,
E-Mail/Telefon, Push-Daten.

### Aussagen für die Datenschutzerklärung

- TaskOps bietet dem Arbeitgeber vor der Firmenlöschung einen Export der
  erfassten Arbeitszeiten an.
- Der Arbeitgeber bleibt für seine gesetzlichen Aufbewahrungspflichten
  verantwortlich.
- Nach bestätigter Konto-/Firmenlöschung löscht TaskOps die Firmendaten.
- NovaFlow hält derzeit kein separates Beschäftigungsarchiv nach Ende der
  Firma vor.
- Löscht sich ein einzelnes Konto, bleiben Einträge, die zur Firma gehören,
  bei der Firma (Arbeitgeber).

### Rechtliche Grundlage und offene Annahmen (anwaltlich prüfen)

- **§ 17 MiLoG** (i. V. m. § 2a SchwarzArbG, u. a. Gebäudereinigung): der
  **Arbeitgeber** muss Beginn, Ende und Dauer der täglichen Arbeitszeit
  aufzeichnen und mindestens **zwei Jahre** aufbewahren. Der Export liefert
  diese Werte; ob er die Pflicht im Einzelfall erfüllt, entscheidet der
  Arbeitgeber.
- NovaFlow ist für Mitarbeiter-/Arbeitszeitdaten Auftragsverarbeiter. Eine
  eigene Aufbewahrungspflicht oder -befugnis nach Ende der Verarbeitung ist
  nicht bestätigt — deshalb kein Archiv.
- Ob eine Löschung **ohne** vorherigen Export (nur Hinweis + Bestätigung)
  ausreicht, oder ob der Export verpflichtend sein sollte, ist eine
  Produkt-/Rechtsentscheidung. Derzeit: dringend angeboten, nicht erzwungen.
- Ob der Namens-Snapshot beim Löschen eines einzelnen Kontos bei der Firma
  verbleiben darf, ist nicht entschieden (Arbeitgeber als Verantwortlicher).
- Backups des Hosting-Anbieters (Supabase) können gelöschte Daten für deren
  Backup-Frist noch enthalten — in der Datenschutzerklärung nennen.

## Native Konfiguration

- iOS: `supportsTablet: false` (nur iPhone) für den ersten öffentlichen Release.
- Android: `blockedPermissions` entfernt `SYSTEM_ALERT_WINDOW`,
  `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`. Die Galerie-Auswahl
  braucht auf Android keine Berechtigung (System-Photo-Picker); `JobPhotos`
  fragt dort deshalb nicht mehr vorab.
- Beides ändert den Fingerprint → neuer nativer Build nötig, kein OTA auf
  bestehende Builds.
