# Phase 5 — React Native Read Path (`Job.assignees[]`)

Status: UEBERARBEITET nach zwei adversarialen Reviews. Bereit fuer Feature-Branch + PR. Nicht gemergt, nicht deployt.
Scope: **READ ONLY**. Kein Editing, kein Merge, kein Deploy.

---

## 1. Ausgangsbefund (am Code erhoben, nicht angenommen)

### Wo `assigned_to` heute gelesen wird

| Ort | Art des Lesens |
| --- | --- |
| `services/jobs/jobs.service.ts` — `JOB_SELECT` + 4 inline-Selects | Spalte + `profiles:assigned_to` Embed |
| `services/jobs/jobs.service.ts` — `mapJob` | → `Job.employeeId` / `Job.employeeName` |
| `services/jobs/jobs.service.ts` — `applyEmployeeFilter` | serverseitiger Filter (`.eq`/`.is`) |
| `services/timesheets/timesheet.service.ts:98` | `.eq("assigned_to", employeeId)` |
| `features/employees/EmployeeDetailScreen.tsx:83` | `jobs.filter(j => j.employeeId === id)` |
| `features/admin/AdminDashboardScreen.tsx:137` | aktiver Job je Mitarbeiter |
| `features/jobs/JobsListScreen.tsx:97,107` | Filter + Suchtext |
| `features/jobs/JobDetailScreen.tsx:377,384,395` | Anzeige **und** Aktions-Gating |
| `components/JobCard.tsx:176` | Anzeige `employeeName` |
| `features/jobs/components/RuleOccurrences.tsx:266` | Anzeige |
| `features/jobs/AdminRecurringRulesScreen.tsx:445,602` | Anzeige + Regel-Gesundheit |
| `utils/recurringRule.ts`, `utils/recurringRuleFilter.ts`, `utils/scheduleView.ts` | Regel-Health / Filter / Suchindex |

### Was die DB bereits liefert

* `job_assignments` hat **SELECT-Grant + 2 Policies** (Admin: ganze Firma; Employee: alle Zuweisungen der Jobs, denen er selbst zugewiesen ist). Der Read-Path ist serverseitig also bereits freigeschaltet.
* Realtime funktioniert **ohne Änderung**: `job_assignments` ist nicht in der Publication, aber `touch_job_on_assignment_change_trg` hebt `jobs.updated_at` an → das bestehende `jobs`-Realtime-Abo in `JobContext` feuert und lädt neu.
* Occurrences besitzen dank Phase 4 **eigene** `job_assignments`-Zeilen → ein Embed pro Job-Zeile ist ausreichend, es braucht keine Parent-Auflösung im Client.

---

## 2. Blocker

### B1 — `jobs`-RLS für Employees hängt weiter an `assigned_to` (**echter Blocker, DB**)

`lib/schema.sql:1247` — Policy `employee read own assigned jobs`:

```sql
using (company_id = current_user_company_id() and assigned_to = auth.uid())
```

Keine Migration der Phasen 1–4.1 fasst die `jobs`-Policies an (verifiziert: kein `create policy … on public.jobs` in `supabase/migrations/`).

**Folge:** ein *sekundärer* Zuweisungsempfänger sieht die Job-Zeile überhaupt nicht — er kann die zugehörigen `job_assignments`-Zeilen zwar lesen, aber `jobs` liefert kein Ergebnis. Dieselbe Kopplung besteht bei `job_comments` (`schema.sql:1321,1338`).

**ENTSCHIEDEN UND UMGESETZT** in `20260730000000_employee_read_via_assignments.sql`: die Employee-**SELECT**-Policies auf `jobs`, `job_comments`, `job_photos`, `storage.objects` sowie die read-only RPC `get_unread_comment_job_ids()` wurden um `or public.is_assigned_to_job(...)` erweitert. Keine einzige Schreibberechtigung geändert. 28 SQL-Fälle in `supabase/tests/employee_read_via_assignments.test.sql`.

**Beim Testen entdeckt (wichtigster Befund der Phase):** zwei Policies aus der Remote-Baseline — `job_photos: Firma darf Fotos lesen` und `… hochladen` — prüfen die Zuweisung nicht selbst, sondern nur, ob der Aufrufer die `jobs`-Zeile sehen kann (Unterabfrage auf `jobs` unter der RLS des Aufrufers). Genau diese Sichtbarkeit erweitert Abschnitt 1. Damit hätte die Lese-Änderung **transitiv ein Schreibrecht geöffnet**: ein sekundär Zugewiesener konnte `job_photos`-Zeilen anlegen (im Testlauf reproduziert, Fall 16 schlug fehl). Beide Policies sind vollständig redundant zu den strengen aus `lib/schema.sql` und wurden entfernt; die Nettowirkung auf Schreibrechte ist damit null (Fälle 24–27).

### B2 — `start_own_job` / `complete_own_job` verlangen weiter `assigned_to = auth.uid()`

Bestätigt in `lib/schema.sql:665,693,739,765`. Das Aktions-Gating in `JobDetailScreen` (`canStart`, `canComplete`, `canUploadPhotos`) und in `JobsListScreen` **darf deshalb NICHT** auf `assignees[]` umgestellt werden — ein sekundärer Zugewiesener bekäme sonst einen Button, der mit „Job not found or not allowed" fehlschlägt.

→ Gating bleibt in Phase 5 bewusst auf `job.employeeId` (= Legacy-Primär), mit Kommentar-Verweis auf Phase 7. **Anzeige** und **Gating** werden getrennt.

### B3 — `assigned_to IS NULL` ist **kein** verlässlicher Proxy für „keine Zuweisung"

`compat_primary_assignee()` liefert NULL nicht nur bei leerer Menge, sondern auch dann, wenn keine Zuweisung *spurenfrei* (`attendance='assigned'`, kein Review, keine Zeitstempel) und der Mitarbeiter *aktiv* ist. Ein Auftrag mit einem gestarteten oder inaktiven Zugewiesenen kann `assigned_to IS NULL` haben und trotzdem Zuweisungen besitzen.

→ Der Filter „Nicht zugewiesen" (`applyEmployeeFilter`, `AdminScheduleScreen`, `recurringRuleFilter`) muss auf die Zuweisungsmenge umgestellt werden, nicht auf die Legacy-Spalte.

### B4 — PostgREST: Filter- und Anzeige-Embed derselben Relation (Risiko, kein Blocker)

Für „Jobs des Mitarbeiters X" bei gleichzeitiger Anzeige **aller** Zugewiesenen braucht es zwei Embeds derselben Tabelle:

```
assignments:job_assignments(...)                  -- Anzeige, ungefiltert
_f:job_assignments!inner(employee_id)             -- Prädikat
&_f.employee_id=eq.<id>
```

Aliasierte Mehrfach-Embeds derselben Relation sind PostgREST-Standard, in diesem Projekt aber noch nirgends verwendet. **Erste Implementierungs-Aufgabe ist ein Spike gegen Staging**, bevor die Filter-Queries darauf aufgebaut werden. Fallback: zweistufige Abfrage (`job_assignments` → `job_id[]` → `.in("id", …)`), begrenzt durch die URL-Länge, deshalb nur Fallback.

---

## 3. Zielmodell

`types/job.ts`:

```ts
export type JobAssignee = {
  assignmentId: string;
  employeeId: string | null;      // null = Konto gelöscht (anonymisiert)
  fullName: string;               // lebender Profilname, sonst Snapshot
  attendance: "assigned" | "started" | "completed";
  countsForTimesheet: boolean;
  isDeleted: boolean;             // employeeId === null
};

export type Job = {
  …
  /** Vollständige Zuweisungsmenge (Phase 5). Leeres Array = nicht zugewiesen. */
  assignees: JobAssignee[];
  /** @deprecated Legacy-Primär. Nur noch für Aktions-Gating (Phase 7 entfernt). */
  employeeId?: string | null;
  /** @deprecated → assignees. */
  employeeName?: string | null;
};
```

`employeeId`/`employeeName` bleiben in Phase 5 **erhalten und befüllt** — sie tragen das Aktions-Gating (B2) und den Offline-Cache alter App-Versionen. Sie werden `@deprecated` markiert und in Phase 7/11 entfernt.

---

## 4. Umsetzung

**S0 — Spike. ERLEDIGT, B4 aufgelöst.** Gegen die lokale PostgREST-Instanz mit echten Daten verifiziert:
* `assignments:job_assignments(...)` + `f:job_assignments!inner(employee_id)` mit `f.employee_id=eq.<id>` filtert die Zeilenmenge, lässt den Anzeige-Embed **vollständig** (Auftrag mit 2 Zugewiesenen zeigt beide) und dupliziert keine Zeilen.
* „Nicht zugewiesen": `f:job_assignments!left(employee_id)` + `f=is.null` liefert genau die Aufträge ohne Zuweisung.
Kein Fallback nötig — beide Filter laufen serverseitig.

**S1 — Service-Layer.**
* `JOB_SELECT` um `job_assignments(id, employee_id, employee_name_snapshot, attendance, counts_for_timesheet, profiles:employee_id(id, full_name))` erweitern.
* Die **vier inline duplizierten Selects** (`getJobs`, `createJob`, `updateJob`, `getJobOccurrences`) auf `JOB_SELECT` konsolidieren — sie sind heute wortgleiche Kopien und würden sonst dreifach driften.
* `mapJob` → `mapAssignees(row.job_assignments)`, stabil sortiert (`assigned_at`, dann Name), Name = lebendes Profil ?? Snapshot.
* `applyEmployeeFilter` auf die Zuweisungsmenge umstellen (B3/B4).

**S2 — Offline-Cache.** `getCachedJobs()` liefert bei Caches aus alten App-Versionen Jobs **ohne** `assignees`. Migrations-Shim beim Lesen: fehlt `assignees`, aus `employeeId`/`employeeName` ein Ein-Element-Array ableiten (bzw. `[]`). Ohne diesen Shim zeigt der erste Offline-Start nach dem Update „Nicht zugewiesen".

**S3 — UI (Anzeige, kein Gating).**
* `JobCard`: bis 2 Namen + „+N", `accessibilityLabel` mit voller Liste.
* `JobDetailScreen`: Zeile „Mitarbeiter" → Liste aller Zugewiesenen (gelöschte Konten kursiv/als „(ehemalig)"). Gating unverändert (B2).
* `EmployeeDetailScreen`: `assignees.some(a => a.employeeId === id)`.
* `AdminDashboardScreen`: aktiver Job je Mitarbeiter über `assignees`.
* `JobsListScreen`: Filter + Suchindex über alle Namen.
* `RuleOccurrences`, `AdminRecurringRulesScreen`, `utils/recurringRule.ts`, `utils/recurringRuleFilter.ts`, `utils/scheduleView.ts` analog.

**S4 — Timesheets.** `.eq("assigned_to", …)` → Join über `job_assignments` mit `counts_for_timesheet = true`. Das ist laut Phase-1-Migration die **einzige** zulässige Berechtigungsquelle. Der Phase-1-Backfill bildet `status='completed'` → `attendance='completed'` → `counts=true` ab, die historische Ausgabe bleibt also identisch. Wird als **eigener, separat prüfbarer Commit** geliefert, weil es eine Abrechnungsfläche ist.

---

## 5. Bewusst NICHT in Phase 5

* Kein Schreiben von Zuweisungen, kein Aufruf von `set_job_assignments` (Phase 6).
* Kein Umstellen von `start_own_job`/`complete_own_job` oder ihres Gatings (Phase 7).
* Keine Änderung an Tabellen, Triggern, Kompatibilitätsschicht (per Auftrag).
* Kein Entfernen von `jobs.assigned_to` oder `Job.employeeId` (Phase 11).
* Offene Entscheidung: `jobs`/`job_comments`-RLS auf `is_assigned_to_job()` erweitern (B1).

## 6. Verifikation

Ausgeführt:
* `npx tsc --noEmit` — sauber.
* `npm run lint` — sauber.
* Vollständige SQL-Suite lokal, inkl. der neuen Datei: **11/11 Dateien, 0 FAIL**.
* PostgREST-Spike mit echten Zeilen (siehe S0).

Noch offen (Review/Staging, bewusst nicht von mir ausgeführt):
* Staging-Deploy der Migration und erneuter Suite-Lauf dort.
* Manuell: Auftrag mit 0 / 1 / 2 / gelöschtem Zugewiesenen in Karte, Detail, Dashboard, Mitarbeiter-Detail, Filter, Suche.
* Offline-Kaltstart mit einem VOR dem Update geschriebenen Cache (Shim S2).
* Sicht des sekundär Zugewiesenen in der echten App: Auftrag sichtbar, **kein** Start-/Fertig-/Upload-Button.
* Realtime: `set_job_assignments` per SQL absetzen und prüfen, dass die App ohne Pull-to-Refresh nachzieht.

## 7. Was diese Phase NICHT liefert

* Schreiben von Zuweisungen aus der App (Phase 6) — `set_job_assignments` wird weiterhin von keinem Client aufgerufen.
* Sekundär Zugewiesene können weiterhin **nicht** starten/abschließen, kommentieren oder Fotos hochladen (Phase 7). Sie sehen den Auftrag, die Kommentare und die Fotos — schreiben dürfen sie nicht. Diese Asymmetrie ist in der Migration dokumentiert und in den Tests festgehalten.
* `jobs.assigned_to` und `Job.employeeId` bleiben bestehen (Phase 11).

## 8. Nebenbefund, NICHT in dieser Phase behoben

`lib/schema.sql` dokumentiert „absichtlich KEINE direkte employee update policy auf jobs" — in der Datenbank existiert sie aber (`employee update own assigned jobs`, aus der Remote-Baseline, also auch produktiv). Sie ist hart an `assigned_to = auth.uid()` gebunden und daher von dieser Migration **nicht** betroffen. Trotzdem eine Abweichung zwischen Referenz und Realität, die eigenständig geprüft werden sollte.


---

## 9. Nacharbeit nach dem adversarialen Review (2026-07-26)

Der Review hat einen release-blockierenden Befund und drei Folgefehler
gefunden. Alle sind behoben; die Ursachen sind hier festgehalten, damit sie
nicht erneut entstehen.

### 1. Stundenzettel vollstaendig zurueckgenommen (BLOCKER)

`counts_for_timesheet` wird nach dem Phase-1-Backfill von **nichts** mehr
gepflegt — `attendance` zu schreiben ist Phase 7. Nachgewiesen mit dem
echten Ablauf (zuweisen → `start_own_job` → `complete_own_job`):

```
NACH ABSCHLUSS: job_status=completed / attendance=assigned / counts=false
Filter NEU (counts_for_timesheet): 0 Zeilen
Filter ALT (assigned_to):          1 Zeile
```

Jeder nach dem Backfill abgeschlossene Auftrag waere lautlos aus dem
Stundenzettel gefallen. `services/timesheets/timesheet.service.ts` ist
wieder **byte-identisch mit HEAD** (`assigned_to`). Die Umstellung gehoert
in Phase 7, gemeinsam mit dem Schreiben von `attendance`.

### 2. Ungelesen-Kennzeichnung: RPC-Erweiterung zurueckgenommen

Gewaehlt wurde die **kleinere** der beiden Optionen. Statt den Schreibpfad
`job_comment_reads` zu oeffnen, bleibt `get_unread_comment_job_ids()`
unveraendert am Legacy-Primaer. Grund: Markieren-als-gelesen ist ein
Schreibvorgang; nur die RPC zu erweitern erzeugte einen dauerhaft
haengenden roten Punkt (RPC meldet ungelesen → Upsert scheitert mit 42501 →
Fehler wird im JobContext geschluckt → Punkt kommt bei jedem Refresh
zurueck).

Folge: ein sekundaer Zugewiesener liest Kommentare mit, bekommt dafuer aber
(noch) keine Ungelesen-Kennzeichnung — ein fehlender Hinweis, kein kaputter
Zustand, und exakt das heutige Verhalten. `JobDetailScreen` setzt fuer ihn
zusaetzlich gar keinen Markier-Versuch mehr ab. Abgesichert durch die
Faelle 12 / 12b / 12c.

### 3. `JobComments` hat jetzt ein Pflicht-Prop `canComment`

Vorher: `canSend = draft.trim().length > 0 && !submitting` — jeder Leser sah
ein aktives Senden-Feld und lief in einen RLS-Fehler. Jetzt wird ohne
Schreibrecht gar kein Eingabefeld gerendert, sondern ein erklaerender Satz.
Bewusst **kein** Default `true`: ein vergessenes Prop soll ausblenden, nicht
freischalten.

### 4. Frisches Nachlesen nach Anlegen/Bearbeiten

Der RETURNING-Embed sieht die von den Phase-2-AFTER-Triggern geschriebenen
`job_assignments` nicht:

```
INSERT (assigned_to=Erika) -> assignments: []        | frisch: [Erika]
UPDATE (assigned_to=Zoe)   -> assignments: [Erika]   | frisch: [Zoe]
```

`createJob`/`updateJob` lesen den Job jetzt ueber `readBackJob()` einmal
frisch nach. Faellt das Nachlesen aus, wird die RETURNING-Zeile
zurueckgegeben — ein erfolgreicher Schreibvorgang darf nie nachtraeglich
als Fehler erscheinen.

### 5. Bewusst NICHT in diesem PR

* **`employee update own assigned jobs`** (jobs UPDATE, existiert in
  Baseline, nach Clean Reset und in Produktion): erlaubt dem Legacy-Primaer,
  jede Spalte seines Auftrags per REST zu aendern — inklusive `status`,
  `started_at`, `completed_at`, also der Grundlage der Stundenzettel-Dauer.
  Vorbestehend und von Phase 5 **nicht** beruehrt (haengt an `assigned_to`,
  das hier nicht erweitert wird). → eigener Security-PR.
* **Produktions-Drift im storage-Schema**: die prod-only Policies
  `job-photos storage: Lesen/Hochladen in eigenen Firma-Ordner` pruefen nur
  Bucket und Firmenordner und machen die strenge Lese-Policy dort wirkungslos
  (lokal mit dem Produktionsstand reproduziert: fremder Mitarbeiter liest und
  laedt hoch). Ausserdem fehlen die storage-INSERT/DELETE-Policies in jeder
  Migration. → eigener PR.
* **`job-photos delete own upload`**: einzige verbliebene transitive
  Nebenwirkung dieser Migration (Firmen-only-Unterabfrage), begrenzt auf
  eigene Uploads. Im Migrations-Header ausdruecklich dokumentiert statt still
  mitgefixt.

### Verifikation nach der Nacharbeit

* `npx supabase db reset` (Clean Reset, alle Migrationen from scratch) ✓
* Volle SQL-Regression: 11 Dateien, **260 Faelle, 0 FAIL** ✓
* Neue Suite 3x hintereinander: 30/30, nicht flaky ✓
* `npx tsc --noEmit` ✓, `npm run lint` ✓
* Staging: siehe offene Frage im PR — das CLI kann `db query` nur gegen das
  **verlinkte** Projekt ausfuehren, und verlinkt ist derzeit PRODUKTION.


---

## 10. Nacharbeit nach dem zweiten Review (2026-07-27)

Verdikt war APPROVE WITH FOLLOW-UP mit einem Medium (M-1) und zwei Lows.

### M-1 — Fallback von `readBackJob()` (behoben)

Vorher fiel `readBackJob()` auf `mapJob(row)` zurueck. Das trug exakt die
unzuverlaessige Embed-Menge: nach dem Anlegen `[]` (ununterscheidbar von
„niemandem zugewiesen"), nach dem Bearbeiten die ALTE Menge — und der
JobContext schrieb das in State UND AsyncStorage. Der Null-Pfad
(`getJobById` liefert keinen Datensatz) wurde ausserdem gar nicht geloggt.

Jetzt:

* **beide** Fehlerpfade loggen (Ausnahme und leeres Ergebnis), jeweils mit
  Job-ID und dem Hinweis, dass abgeleitet wird;
* der Fallback leitet die Menge aus dem Legacy-Zeiger ab
  (`buildLegacyAssignees`) — genau ein Mitarbeiter, nie mehrere, nie geraten;
* ein erfolgreicher Schreibvorgang wird weiterhin nie zum Fehler.

Tragende Voraussetzung, gegen PostgREST verifiziert: `assigned_to` im
RETURNING ist **frisch**, nur die eingebettete Beziehung hinkt hinterher.

```
INSERT RETURNING : assigned_to=Erika | embed=[]        -> Fallback: Erika
PATCH  RETURNING : assigned_to=Zoe   | embed=[Erika]   -> Fallback: Zoe
Nachlesen (ok)   : [Erika] bzw. [Zoe]                  -> vollstaendige Menge
```

Die Ableitung ist jetzt EIN gemeinsamer Helfer fuer beide Stellen, die
dasselbe Problem haben (`readBackJob` und `normalizeCachedJob` im
Offline-Cache) — vorher zwei Implementierungen, die auseinanderlaufen konnten.

### L-1 — `countsForTimesheet` (entfernt)

Ersatzlos aus `JobAssignee`, aus `JOB_SELECT`, aus dem Row-Typ und aus dem
Mapping entfernt. Es hatte keinen Konsumenten, und der Offline-Shim erfand
den Wert aus `job.status` — ein erfundener Wert fuer die Stundenzettel-
BERECHTIGUNG ist eine Abrechnungsfalle.

`attendance` wurde aus demselben Grund mitentfernt: ebenfalls ohne
Konsumenten, ebenfalls im Fallback erfunden. Ohne diese Entfernung haette der
neue Fallback weiterhin Anwesenheitsdaten erfinden muessen. Beide Felder
kommen in Phase 7 zurueck, wenn `attendance` serverseitig gepflegt wird.

### L-2 — Migrations-Kommentar zu Abschnitt 4 (korrigiert)

Der Kommentar beschreibt jetzt beide Ausgangslagen: in Produktion ERSETZT
das DROP+CREATE eine bereits vorhandene Policy, in einer aus Migrationen
gebauten Umgebung legt es sie ERSTMALS an (dort existierte vorher gar keine
SELECT-Policy auf dem Bucket). Ausfuehrbares SQL unveraendert.

### Verifikation des Fallbacks

Das Repo hat keinen JS-Test-Runner. Die Ableitung wurde deshalb als **reine
Funktion** herausgezogen und ist ueber ein eigenes Skript pruefbar:

```
node scripts/verify-job-assignees.mjs
```

Es kompiliert `utils/jobAssignees.ts` isoliert (echte Quelle, keine Kopie)
und prueft 8 Zusicherungen: create-Fallback liefert einen Zugewiesenen statt
`[]`; update-Fallback liefert den NEUEN statt des alten; nie mehr als einer;
geloeschtes Konto -> leer ohne Platzhalter; leerer Name -> „Unbekannt";
stabile, als abgeleitet erkennbare `assignmentId`; keine Abrechnungs-/
Anwesenheitsfelder; Ergebnis rendert korrekt in den Anzeige-Helfern.

Nicht per Skript pruefbar (braucht Netz/Supabase) und deshalb manuell gegen
PostgREST verifiziert — Vorgehen oben dokumentiert:
* dass beide Fehlerpfade in `readBackJob()` loggen (Code-Inspektion),
* dass ein erfolgreiches Nachlesen die vollstaendige Menge liefert.
