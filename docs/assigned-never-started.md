# Zugewiesen, aber nie gestartet

Stand: 2026-11-08, Branch `fix/multi-assignment-job-completion`
(Migrationen `20261029000000` bis `20261030000002`).

Diese Seite beschreibt das fachlich korrekte Verhalten für Mitarbeiter, die
einem Auftrag zugewiesen sind, ihn aber nie gestartet haben. Sie gilt für
Aufträge mit mehreren Zugewiesenen ebenso wie für Einzelaufträge.

## Grundsatz

**Eine Zuweisung ist ein Plan, keine Arbeit.** Arbeitszeit entsteht nur aus
echten Ereignissen des Mitarbeiters (Start/Pause/Fortsetzen/Abschluss über die
RPCs) oder aus einer begründeten, auditierten Admin-Korrektur, die eine
tatsächlich geleistete Arbeit nachträgt. Zeitstempel werden **nie** erfunden —
weder um einen Auftrag abzuschließen noch um einen Hinweis auszublenden.

## Regeln

| Bereich | Verhalten | Durchgesetzt in |
|---|---|---|
| Auftragsabschluss | Nie Gestartete blockieren nicht. Der Auftrag schließt, wenn ≥ 1 Zugewiesener gestartet hat, jeder Gestartete selbst abgeschlossen hat und keine Sitzung offen ist. | `maybe_complete_job` (`20261029000000`) |
| Offizielle Auftragsuhr | `jobs.completed_at` = spätester eigener Abschluss der Gestarteten. Nie der Zeitpunkt eines Admin-Speicherns. | `maybe_complete_job` (`20261030000001`) |
| Arbeitszeit / Stundenzettel | Keine Arbeitszeit. Die geteilte Auftragsdauer eines Kollegen wird **nicht** übertragen. | `services/timesheets/timesheet.service.ts` (`mapEntry`) |
| Arbeitszeit-Export | Keine Zeile. Kein geliehener Start, kein geliehenes Ende. | `get_company_worktime_export` (`20261030000000`) |
| Korrektur-Hinweis | Bei abgeschlossenen Aufträgen nach dem Stichtag 2026-08-12 erscheint im Admin-Stundenzettel ein Hinweis „keine Zeit erfasst“ (`no_time`). Das ist eine **korrekte Tatsachenmeldung**, kein Datenfehler. | `mapGap` |
| Später Start | Ist der Auftrag bereits abgeschlossen, kann ein später eintreffender Kollege nicht mehr starten (harte Ablehnung, Fehlercode `22023`, keine Mutation). Bewusste Produktentscheidung vom 2026-10-27. | `start_own_job`, `_execute_work_session_operation` |
| Zuweisung entfernen | Bei laufenden Aufträgen möglich (nie Gestartete sind entfernbar), bei abgeschlossenen abgelehnt. | `set_job_assignments` |

## Was ein Admin mit dem Hinweis tun darf

- **Hat die Person tatsächlich gearbeitet** (z. B. App vergessen): eigene Zeit
  über die Admin-Zeitkorrektur nachtragen. Pflicht: begründeter Text, echtes
  Intervall; die Korrektur wird in `employee_time_adjustments` protokolliert.
- **Hat die Person nicht gearbeitet:** nichts tun. Der Hinweis bleibt sichtbar
  und dokumentiert korrekt, dass keine Arbeitszeit vorliegt.
- **Nicht erlaubt:** Start-/Endzeiten eintragen, nur damit der Hinweis
  verschwindet. Das wäre erfundene, bezahlte Arbeitszeit.

## Bekannte Lücke (Folgearbeit, nicht Teil dieses Releases)

Es gibt keine Aktion „nicht gearbeitet bestätigen“. Die Spalte
`job_assignments.review` kennt bereits `absent` (dann
`counts_for_timesheet = false`), wird aber von keinem RPC und keiner UI
geschrieben. Eine saubere Lösung wäre eine auditierte Admin-Aktion, die
`review = 'absent'` setzt und den Hinweis als erledigt ausblendet — **ohne**
Zeitstempel zu schreiben.

## Produktion 2026-11-08

Nach dem Deploy und der getrennt freizugebenden Bereinigung der 19 hängenden
Aufträge (`supabase/manual/release_20261108/03_remediate_stuck_jobs.sql`)
entstehen 24 solche Hinweise für Zugewiesene, die nie gestartet haben. Sie
sind korrekt und werden bewusst **nicht** unterdrückt.
