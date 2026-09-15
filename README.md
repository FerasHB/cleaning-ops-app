# TaskOps Manager

TaskOps Manager ist eine mobile App zur Mitarbeiter- und Auftragsverwaltung für Teams im Außeneinsatz, entwickelt mit React Native, Expo und Supabase. Administratoren planen und verteilen Aufträge. Mitarbeitende verwalten ihre Einsätze, verfolgen den Fortschritt, kommunizieren und melden Abwesenheiten direkt in der App.

Ursprünglich für die Abläufe eines Reinigungsunternehmens entwickelt, unterstützt TaskOps Manager inzwischen auch andere Dienstleistungsbetriebe im Außeneinsatz. Die Reinigung bleibt ein praktisches Anwendungsbeispiel, wie die Staging-Daten und Bildschirmaufnahmen unten zeigen.

Die App wurde für deutschsprachige Dienstleistungsbetriebe entwickelt. Diese Dokumentation beschreibt Funktionen, Architektur und den aktuellen Beta-Stand.

## Beta testen

**TaskOps Manager befindet sich in der Beta-Phase und wird aktiv weiterentwickelt. Die App ist noch nicht allgemein veröffentlicht.**

| Plattform | Beta-Zugang |
|---|---|
| iOS | [Über TestFlight an der Beta teilnehmen](https://testflight.apple.com/join/nG5cwtP9) |
| Android | [TaskOps Manager bei Google Play öffnen](https://play.google.com/store/apps/details?id=com.ferash.taskopsmanager) — Zugang nur für freigeschaltete Testpersonen. |

**Zugang für Android:** Die E-Mail-Adresse deines Google-Kontos muss vorab zur Testerliste hinzugefügt werden. Wende dich dafür privat an die Person, die deinen Beta-Zugang organisiert. Folge anschließend deren Anleitung zur Testteilnahme mit demselben Google-Konto. Der Link oben führt zur App-Seite, nicht zur Anmeldung für den Test, und schaltet den Zugang nicht automatisch frei. Veröffentliche deine E-Mail-Adresse oder Zugangsdaten bitte nicht in öffentlichen Issues.

## Bildschirmaufnahmen

Die Aufnahmen stammen aus der laufenden App mit einer befüllten Staging-Umgebung. Alle gezeigten Daten sind fiktive Demodaten — siehe [Aktueller Stand](#aktueller-stand).

| Admin-Übersicht | Auftragsverwaltung | Admin-Kalender |
|---|---|---|
| ![Admin-Übersicht](docs/screenshots/admin-dashboard.png) | ![Auftragsverwaltung](docs/screenshots/admin-jobs.png) | ![Admin-Kalender](docs/screenshots/admin-calendar.png) |

| Mitarbeiterdetails und Abwesenheiten | Auftragskommentare | Aktiver Auftrag und gemeinsame Zeiterfassung |
|---|---|---|
| ![Mitarbeiterdetails und Abwesenheiten](docs/screenshots/admin-absences.png) | ![Auftragskommentare](docs/screenshots/job-comments.png) | ![Aktiver Auftrag](docs/screenshots/employee-job-active.png) |

<details>
<summary>3 weitere Bildschirmaufnahmen (Mitarbeiterübersicht, Auftragsstart, Zuweisung)</summary>

| Mitarbeiterübersicht | Auftragsdetails vor dem Start | Auftragsdetails mit Zuweisung |
|---|---|---|
| ![Mitarbeiterübersicht](docs/screenshots/employee-overview.png) | ![Auftragsdetails vor dem Start](docs/screenshots/employee-job-detail.png) | ![Auftragsdetails mit Zuweisung](docs/screenshots/job-detail.png) |

</details>

## So funktioniert die App

Ein Administrator registriert sich, richtet das Unternehmen ein und fügt Mitarbeitende hinzu. Anschließend erstellt er einmalige oder nach Wochentagen wiederkehrende Aufträge mit Kunde, Leistungsart, Einsatzort, Termin und einer oder mehreren zugewiesenen Personen. Mitarbeitende sehen ihre heutigen und kommenden Aufträge. Beim Start eines Auftrags beginnt die gemeinsame Zeiterfassung. Nach Abschluss können sie den Auftrag abschließen, Kommentare hinterlassen und Fotos als Arbeitsnachweis anhängen. Abwesenheiten wie Urlaub und Krankheit werden über einen Melde- bzw. Genehmigungsablauf mit grundlegender Prüfung auf Überschneidungen verwaltet. Änderungen werden in Echtzeit zwischen Geräten synchronisiert. Die zentrale Auftragsliste funktioniert auch offline; Aktionen werden bis zur nächsten Verbindung zwischengespeichert.

## Zentrale Funktionen

**Einsatzverwaltung**

- Admin-Übersicht mit aktuellen Kennzahlen (offen / in Bearbeitung / abgeschlossen / heute fällig) und einer Anzeige, wer gerade an welchem Auftrag arbeitet
- Aufträge erstellen und bearbeiten: einmalig mit Datum und Uhrzeit oder wiederkehrend mit Wochentagen und Uhrzeit sowie einer Umschaltung zwischen aktiv und pausiert
- Mehrere Mitarbeitende pro Auftrag, mit Nachverfolgung je Zuweisung und gespeichertem Namen, der auch nach einer Kontolöschung erhalten bleibt
- Kalenderansichten für Administratoren und Mitarbeitende

**Arbeitsablauf für Mitarbeitende**

- Persönliche Auftragsliste und Tagesübersicht
- Serverseitige Prüfung von Start- und Abschlussaktionen über RLS und RPC, zusätzlich zur Prüfung in der Oberfläche
- Gemeinsame Zeiterfassung: eine maßgebliche Dauer pro Auftrag (`completed_at - started_at`), die allen zugewiesenen Mitarbeitenden angerechnet wird, unabhängig davon, wer den Auftrag startet oder abschließt
- Foto-Upload als Arbeitsnachweis, gespeichert in einem privaten Speicherbereich mit Zugriffsbeschränkung nach Unternehmen und Auftrag

**Kommunikation**

- Auftragskommentare mit Verfassernamen, sichtbar für Administratoren und alle zugewiesenen Personen; Kommentare können nur hinzugefügt werden
- Kennzeichnung ungelesener Kommentare je Nutzer und Auftrag

**Abwesenheit und Urlaub**

- Eigenständige Urlaubsanträge und Krankmeldungen durch Mitarbeitende mit Prüfung auf Überschneidungen
- Genehmigungsablauf für Urlaub, einschließlich Urlaubstagekonto und individuell konfigurierbarem Urlaubsanspruch
- Manuelle Erfassung von Abwesenheiten durch Administratoren, etwa nach einer telefonischen Meldung

**Planung und Arbeitszeitnachweise**

- Geplante Auftragsdauer, Erfassung geleisteter Arbeitszeit und Export von Arbeitszeitnachweisen als PDF für Administratoren

**Benachrichtigungen**

- Push-Benachrichtigungen über Expo Push Service / FCM bei Auftragszuweisungen, Statusänderungen und neuen Kommentaren

**Zuverlässigkeit und Offline-Nutzung**

- Lokale Warteschlange für Auftragsaktionen wie Start und Abschluss; die Oberfläche zeigt Änderungen sofort an und synchronisiert sie bei erneuter Verbindung
- Echtzeitsynchronisierung der Auftragstabelle über Supabase Realtime

**Anmeldung und Sicherheit**

- Supabase Auth mit rollenbasierter Navigation für Administratoren und Mitarbeitende, Zurücksetzen des Passworts und Vorgabe einer Mindestlänge für Passwörter
- Row Level Security schützt die Anwendungsdaten; sensible Schreibvorgänge werden serverseitig über RPCs geprüft
- Kontaktangaben des Unternehmens (E-Mail und Telefon), die Administratoren in der App einsehen und bearbeiten können

## Eingesetzte Technologien

| Bereich | Technologie |
|---|---|
| Framework | React Native 0.81, Expo SDK 54, expo-router 6 (dateibasierte Navigation) |
| Programmiersprache | TypeScript |
| Backend | Supabase — Postgres, Auth, Realtime, Storage, Edge Functions (Deno) |
| Push-Benachrichtigungen | Expo Notifications |
| Offline-Nutzung | `@react-native-community/netinfo` und eine über AsyncStorage gespeicherte Aktionswarteschlange |
| Schriftart | Inter (`@expo-google-fonts/inter`) |
| Erstellung und Verteilung | EAS Build (Profile: development / preview / production), EAS Submit |

## Architektur

- **Rollenbasierter Zugriff:** Jede Ansicht und Aktion prüft `role` (`admin` | `employee`) aus dem Nutzerprofil. Die Prüfung in der Oberfläche dient der Nutzerführung; die tatsächliche Zugriffskontrolle erfolgt durch Postgres Row Level Security und `SECURITY DEFINER`-RPCs, etwa `start_own_job`, `complete_own_job`, `set_job_assignments` und `admin_review_vacation`. Ein Client kann keine Aktion ausführen, die RLS nicht erlaubt.
- **Serverseitige Statuswechsel:** Auftragsstart und -abschluss, Urlaubsgenehmigungen und die Unternehmenseinrichtung laufen über RPCs statt über direkte Schreibzugriffe auf Tabellen. Geschäftsregeln werden dadurch zentral in der Datenbank durchgesetzt, etwa dass ein Auftrag erst nach seinem Start abgeschlossen werden kann und ein Urlaubsabzug verbindlich bestätigt statt nur berechnet wird.
- **Zuweisung mehrerer Mitarbeitender:** Eine eigene Tabelle `job_assignments` erfasst alle Zuweisungen eines Auftrags statt nur einer einzelnen Spalte `assigned_to`. Ein gespeicherter Namensstand erhält die Historie auch nach einer Kontolöschung. Zwei Berechtigungsprüfungen — für Start und Abschluss sowie für Kommentare und Fotos — sind zentral in `utils/jobAssignees.ts` definiert und werden in den Ansichten wiederverwendet.
- **Wiederkehrende Aufträge als Regeln:** Ein wiederkehrender Auftrag wird als einzelner Datensatz mit Wochentagen und Uhrzeit gespeichert. Es werden keine separaten Datensätze für einzelne Einsatztage vorab angelegt. Dies ist eine bewusste Begrenzung des MVP-Umfangs — siehe [Aktueller Stand](#aktueller-stand).
- **Offline-fähige Auftragsaktionen:** Start, Abschluss und Bearbeitung werden ohne Verbindung lokal zwischengespeichert, sofort in der Oberfläche angezeigt und bei erneuter Verbindung mit dem Server synchronisiert. Kommentare und Fotos benötigen bewusst eine Online-Verbindung; sie können nur hinzugefügt werden und besitzen keine Offline-Warteschlange.
- **Serviceschicht:** Alle Supabase-Aufrufe liegen in `services/`. Dort werden Datenbankfelder in snake_case auf die camelCase-Typen der App abgebildet. Ansichten greifen nicht direkt auf Supabase zu.

## Technische Grundlagen für den produktiven Einsatz

Die Umsetzung umfasst folgende Maßnahmen:

- Getrennte Supabase-Projekte für **Staging** und **Production**, mit clientseitig durchgesetzter Umgebungstrennung, sichtbarer Staging-Kennzeichnung in nichtproduktiven Builds und Prüfung vor datenverändernden Vorgängen
- Schutz aller Schreibzugriffe durch **Row Level Security**, unabhängig von den Prüfungen in der Oberfläche
- Absicherung der Anmeldung durch Passwort-Mindestlänge, Begrenzung der Anfragerate und verständliche deutsche Fehlermeldungen, die aus Supabase-Fehlercodes abgeleitet werden
- **EAS Build** mit separaten Profilen für development, preview und production; Verteilung zur Beta-Erprobung über TestFlight und zugangsbeschränkte Google-Play-Tests
- Schemaverwaltung über Migrationen (`supabase/migrations/`) mit begleitenden SQL-Tests im Stil von `pgTAP` (`supabase/tests/`) für RLS- und RPC-Verhalten
- Serverseitige Prüfung von Planungsdaten (`buildSchedulePayload`), damit einmalige und wiederkehrende Aufträge unabhängig von den Client-Eingaben nicht in einem widersprüchlichen Zustand angelegt werden können

## Aktueller Stand

Beta- und Pilotphase mit aktiver Weiterentwicklung; noch keine allgemeine Veröffentlichung. Informationen zum Zugang für iOS und Android stehen unter [Beta testen](#beta-testen). Für Android ist die vorherige Aufnahme in die Testerliste erforderlich.

Bekannte, bewusst gewählte Einschränkungen des Funktionsumfangs:

- **Wiederkehrende Aufträge haben noch keine separaten Einträge pro Einsatztag.** Ein wiederkehrender Auftrag ist eine Regel. Status und Zeitstempel beziehen sich auf diese Regel und nicht auf einen einzelnen Besuch, etwa am kommenden Dienstag. Dies ist eine dokumentierte, bewusste Begrenzung des MVP-Umfangs.
- **Kommentare und Fotos benötigen eine Online-Verbindung.** Anders als Start, Abschluss und Bearbeitung von Aufträgen besitzen sie keine Offline-Warteschlange.

## Lokale Entwicklung

Vorausgesetzt werden Node.js 18+ und ein Supabase-Projekt mit dem Schema aus `lib/schema.sql`. Diese Datei dient nur als Referenz; tatsächliche Schemaänderungen werden über `supabase/migrations/` angewendet.

*Hinweis: Das GitHub-Repository heißt weiterhin `cleaning-ops-app`, entsprechend dem ursprünglichen Projektumfang. Der Produktname lautet TaskOps Manager.*

```bash
git clone https://github.com/FerasHB/cleaning-ops-app.git
cd cleaning-ops-app
npm install
cp .env.example .env
# EXPO_PUBLIC_SUPABASE_URL und EXPO_PUBLIC_SUPABASE_ANON_KEY eintragen
# Nur einen Publishable-/Anon-Schlüssel verwenden, niemals einen Service-Role-/Secret-Schlüssel
npm start
```

```bash
npm run ios      # iOS-Simulator
npm run android   # Android-Emulator
npm run web       # Webansicht (nur für die Entwicklung)
npm run lint      # Codeprüfung mit Expo
```
