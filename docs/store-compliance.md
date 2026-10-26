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
| Mitarbeiter / Admin mit weiterem aktiven Admin | Login-Konto und Profil (Name, E-Mail, Telefon, Push-Token, Sprache) werden gelöscht. Die Firma besteht weiter; Aufträge, Kommentare, Fotos und Arbeitszeit-/Abwesenheitseinträge bleiben bei der Firma, die Verknüpfung zum Konto wird entfernt (`SET NULL`). In Zuweisungen/Abwesenheiten bleibt der Namens-Snapshot als Referenz der Firmen-Nachweise (siehe Annahmen unten). Der Name in `notification_outbox` wird durch „Gelöschtes Konto“ ersetzt. |
| Letzter aktiver Admin (nach doppelter Bestätigung) | Login-Konten **aller** Firmenmitglieder, Profile, Firma, Aufträge, Kommentare, Fotos (inkl. Storage-Dateien), Benachrichtigungen und alle übrigen Firmendaten werden gelöscht; niemand hat danach Zugriff. Vorher werden minimale Arbeitszeit-/Beschäftigungsnachweise in das gesperrte Archiv `compliance_retention_records` kopiert (siehe unten). |

### Aussagen für die Datenschutzerklärung

- Konto- und Login-Daten werden gelöscht.
- Gewöhnliche Firmendaten werden gelöscht.
- Bestimmte gesetzlich erforderliche Beschäftigungs- bzw. Arbeitszeitnachweise
  können aufbewahrt werden.
- Aufbewahrte Daten sind auf das notwendige Minimum beschränkt, gesperrt und
  in der App nicht mehr zugänglich.
- Die **Aufbewahrungsfrist** je Datenkategorie muss in der finalen
  Datenschutzerklärung dokumentiert werden. Sie ist im System noch **nicht**
  festgelegt (`retain_until = NULL`, kein automatisches Löschen).

### Compliance-Archiv (`compliance_retention_records`, Migration `20261027000000`)

Nur beim Löschen durch den letzten Admin. Keine Fremdschlüssel in aktive
Tabellen, RLS ohne Policy, keine Rechte für `anon`/`authenticated` — Zugriff
nur mit `service_role`.

| `record_type` | Quelle | Aufbewahrte Felder (Payload) | Nicht übernommen |
|---|---|---|---|
| `work_session` | `work_sessions` | Zuweisung, Auftrag (IDs), Start, Ende | — |
| `session_time_correction` | `session_time_corrections` | Session/Zuweisung/Auftrag (IDs), Revision, Herkunft, Roh- und effektive Zeiten/Dauern, Korrekturzeitpunkt | Begründung (Freitext), ausführender Admin |
| `assignment_work_time` | `job_assignments` mit erfasster Arbeit + `jobs` | Auftrag-ID, geteilte Job-Uhr (Start/Ende), Mitarbeiter-Start/-Ende, Anwesenheit, Erfassungsmodus, `counts_for_timesheet`, Revision | Kunde, Adresse, Service, Notizen |
| `time_adjustment` | `employee_time_adjustments` | Zuweisung/Auftrag (IDs), alte/neue Zeiten, Zeitpunkt | Begründung, ausführender Admin |
| `absence` | `employee_absences` (+ `absence_evidence`) | Art (Urlaub/Krankheit), Status, Zeitraum, abgezogene Urlaubstage, Prüfzeitpunkt, Nachweis-Status | Notizen von Mitarbeiter/Admin, Dokumentpfad |
| `vacation_ledger_entry` | `vacation_ledger` + `vacation_years` | Jahr, Buchungsart, Tage, Bezug zur Abwesenheit | Notiz, Ersteller |

Gemeinsame Spalten: ehemalige Firmen-ID + Firmenname (Arbeitgeber-Referenz),
ehemalige User-ID + Namens-Snapshot (Arbeitnehmer-Referenz), fachliches
Datum, Archivierungszeitpunkt, `retain_until`.

**Nicht** aufbewahrt: E-Mail, Telefon, Push-Token, Zugangsdaten, Sprache,
Firmen-Kontaktdaten, Kundendaten, Kommentare, Fotos, Notizen,
Benachrichtigungen, künftige/offene Aufträge ohne erfasste Arbeit,
Einladungen, Caches.

Spätere Löschung (nur `service_role`):

- `set_compliance_retain_until(company_id, date, record_types[])` — Frist setzen,
  sobald sie rechtlich geklärt ist.
- `purge_expired_compliance_records()` — löscht Zeilen mit abgelaufener Frist
  (für einen späteren Cron-Job geeignet).
- `purge_compliance_records_for_company(company_id, record_types[])` — gezielte
  Löschung.

### Rechtliche Grundlage und offene Annahmen (anwaltlich prüfen)

- **§ 17 MiLoG** (i. V. m. § 2a SchwarzArbG, u. a. Gebäudereinigung):
  Arbeitgeber müssen Beginn, Ende und Dauer der täglichen Arbeitszeit
  aufzeichnen und diese Aufzeichnungen **mindestens zwei Jahre** aufbewahren.
  Das betrifft die Arbeitszeit-Datensätze (`work_session`,
  `assignment_work_time`, Korrekturen/Anpassungen) — nicht jedes andere
  gespeicherte Feld.
- Für Abwesenheiten (inkl. Krankmeldungen = Gesundheitsdaten) und
  Urlaubsbuchungen ist offen, ob und wie lange eine Aufbewahrung erforderlich
  ist (z. B. als lohnrelevante Unterlage). Keine Frist im System hinterlegt.
- Ob zur Zuordnung der Name nötig ist oder eine pseudonyme Kennung genügt, ist
  nicht entschieden. Das System speichert den Namens-Snapshot als einzige
  menschenlesbare Zuordnung, weil die User-ID nach der Kontolöschung nicht
  mehr auflösbar ist.
- Verantwortlichkeit: Aufbewahrungspflichten treffen den **Arbeitgeber**
  (die Kundenfirma). Wer nach der Firmenlöschung Auskunft/Herausgabe aus dem
  Archiv erhält und wie, ist nicht geregelt (Auftragsverarbeitungsvertrag).
- Ob Begründungstexte von Zeitkorrekturen für die Nachweisführung nötig sind,
  ist offen (derzeit nicht archiviert).

## Native Konfiguration

- iOS: `supportsTablet: false` (nur iPhone) für den ersten öffentlichen Release.
- Android: `blockedPermissions` entfernt `SYSTEM_ALERT_WINDOW`,
  `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`. Die Galerie-Auswahl
  braucht auf Android keine Berechtigung (System-Photo-Picker); `JobPhotos`
  fragt dort deshalb nicht mehr vorab.
- Beides ändert den Fingerprint → neuer nativer Build nötig, kein OTA auf
  bestehende Builds.
