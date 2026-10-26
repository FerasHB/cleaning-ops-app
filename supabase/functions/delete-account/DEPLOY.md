# delete-account — Deployment & manuelle Schritte

In-App-Kontolöschung (DSGVO / Google-Play-Account-Deletion-Policy). Der Nutzer
löscht sein **eigenes** Konto über `Profil → Support → Konto löschen`
(`app/delete-account.tsx` → `features/profile/DeleteAccountScreen.tsx`). Die
Function entfernt den Auth-User mit dem Service-Role-Key; alle abhängigen Daten
werden über die bestehenden Foreign Keys aufgelöst.

## Migrationen (müssen vor dem Deploy angewendet sein)

- `20260722000000_fix_job_photos_uploaded_by_on_delete.sql` +
  `20260722000001_job_photos_uploaded_by_drop_not_null.sql` — FK-Drift-Fix,
  siehe unten.
- `20260723000001_account_deletion_reservation_tokens.sql` — legt
  `profiles.account_deletion_token` / `account_deletion_reserved_at` an und
  die drei RPCs für den Last-Admin-Schutz (`prepare_self_account_deletion`,
  `rollback_self_account_deletion`, `recover_stale_account_deletion_
  reservations`). Ohne diese Migration schlägt jeder Löschversuch fehl, da
  die Function diese RPCs zwingend aufruft.

## Foreign Keys

`admin.deleteUser` löscht die `auth.users`-Zeile. Die vorhandenen FKs (siehe
`lib/schema.sql`) erledigen den Rest:

- `profiles.id → auth.users(id) ON DELETE CASCADE` → Profil (Name, Telefon,
  Push-Token) wird gelöscht.
- `jobs.assigned_to` / `jobs.created_by` → `ON DELETE SET NULL` (Aufträge bleiben,
  anonymisiert).
- `job_comments.author_id` / `job_photos.uploaded_by` → `ON DELETE SET NULL`.
- `job_comment_reads.user_id` → `ON DELETE CASCADE`.
- `notification_deliveries.recipient_id` → `ON DELETE CASCADE`;
  `notification_outbox.employee_id` → `ON DELETE SET NULL`.

Firmen- und Auftragsdaten bleiben also aus betrieblichen/rechtlichen Gründen
erhalten, verlieren aber jede Verknüpfung zum gelöschten Konto.

## Deployen

```bash
supabase functions deploy delete-account
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` werden für
deployte Functions automatisch injiziert. Die Function prüft die Authorization
selbst (`verify_jwt = false` in `config.toml`) und akzeptiert **keine** User-ID
aus dem Request-Body — gelöscht wird ausschließlich die Identität aus der
Session (`getUser()`).

## Letzter Admin: Konto + Firma löschen (Migration `20261026000000`)

Ist der Aufrufer der **einzige aktive Admin** seiner Firma, gibt es zwei Fälle:

- **Ohne Bestätigung** (alter Client oder Body `{}`): HTTP 409 / `code: "last_admin"`,
  es wird **nichts** gelöscht. Die Meldung verweist auf die aktuelle App-Version.
- **Mit Bestätigung** `{ "confirmCompanyDeletion": true, "confirmCompanyId": "<eigene Firma>" }`
  (die App sendet das erst nach zwei Pflicht-Checkboxen + Dialog mit Firmennamen):
  die Function ruft `public.purge_company_for_last_admin(p_caller, p_confirm_company_id)`
  (nur `service_role`) mit der **Session-Identität** auf. Die RPC prüft erneut
  Rolle, `is_active`, Firma == Bestätigung (`company_mismatch` sonst) und
  „wirklich letzter Admin" (`not_last_admin` sonst). In **einer** Transaktion
  archiviert sie zuerst minimale Arbeitszeit-/Beschäftigungsnachweise in
  `compliance_retention_records` (Migration `20261027000000`, gesperrt, siehe
  `docs/store-compliance.md`) und löscht dann den aktiven Mandanten:
  Arbeitszeit-Tabellen, Aufträge mit allen Kindern, Abwesenheiten/
  AU-Nachweise/Urlaub, Kommentare, Fotos, Outbox/Deliveries, die Firma und
  **alle Konten der Firma** (`auth.users` → `profiles`). Danach entfernt die
  Function die Storage-Dateien (`job-photos/<company_id>/…`, gemeldete Pfade +
  Präfix-Listing). Antwort: `{ success, companyDeleted: true, storageCleanup: "ok" | "partial", retainedRecordCount }`.
  `partial` heißt: DB ist gelöscht, Dateireste im Bucket → Log
  `delete-account: storage cleanup incomplete` mit `companyId`, manuell nachräumen.

Existiert ein weiterer aktiver Admin, wird nur das anfragende Konto gelöscht;
die Firma bleibt unberührt. Mitarbeiter (`role = 'employee'`) können sich
jederzeit selbst löschen.

Namens-Snapshots: `job_assignments.employee_name_snapshot` und
`employee_absences.employee_name_snapshot` bleiben beim normalen Löschpfad als
Referenz der Firmen-Nachweise erhalten (rechtlich zu prüfen, siehe
`docs/store-compliance.md`); `notification_outbox.employee_name` wird per
Trigger durch „Gelöschtes Konto" ersetzt. Die Lösch-UI formuliert neutral:
bestimmte Beschäftigungs-/Arbeitszeitnachweise können für die gesetzlich
erforderliche Dauer aufbewahrt werden.

### Normaler Pfad: Last-Admin-Reservierung

Die Prüfung läuft **atomar** über die RPC `public.prepare_self_account_deletion()`
(siehe `supabase/migrations/20260723000001_account_deletion_reservation_tokens.sql`)
— ein reines SELECT-dann-`deleteUser()` ohne gemeinsame Transaktion würde
zulassen, dass sich zwei Admins derselben Firma fast zeitgleich löschen und
beide die Prüfung bestehen. Die RPC reserviert den Admin-Platz stattdessen
vorab über `account_deletion_token`/`account_deletion_reserved_at` (**nicht**
über `is_active`, das ausschließlich der administrativen Deaktivierung
vorbehalten bleibt) und gibt einen Reservierungs-Token zurück. Schlägt
`deleteUser()` danach fehl, macht `public.rollback_self_account_deletion(token)`
die Reservierung — nur mit exakt diesem Token — rückgängig. Bricht die
Function irgendwo dazwischen ab (Crash/Timeout), bleibt eine "verwaiste"
Reservierung ohne Auswirkung auf Login/Nutzung des Kontos zurück, die
`public.recover_stale_account_deletion_reservations()` (nur `service_role`,
wird best-effort vor jedem neuen Löschversuch aufgerufen) nach 15 Minuten
automatisch abräumt.

Ist der Aufrufer bereits administrativ deaktiviert (`is_active=false`), lehnt
die RPC die Vorbereitung mit `code: "inactive_account"` ab — ein deaktiviertes
Konto darf keine Löschung anstoßen.

## Sicherheit

- Der Service-Role-Key verlässt die Function nie und liegt nur serverseitig
  (`Deno.env`) — niemals im App-Bundle.
- Es kann nur das **eigene** Konto gelöscht werden (Identität aus der Session,
  kein Body-Parameter).
- Nach erfolgreicher Löschung meldet die App den Nutzer lokal ab, leert alle
  lokalen Caches (Profil, Jobs, Offline-Queue) und leitet zum Login zurück.
