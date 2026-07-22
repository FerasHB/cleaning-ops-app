# delete-account — Deployment & manuelle Schritte

In-App-Kontolöschung (DSGVO / Google-Play-Account-Deletion-Policy). Der Nutzer
löscht sein **eigenes** Konto über `Profil → Support → Konto löschen`
(`app/delete-account.tsx` → `features/profile/DeleteAccountScreen.tsx`). Die
Function entfernt den Auth-User mit dem Service-Role-Key; alle abhängigen Daten
werden über die bestehenden Foreign Keys aufgelöst — es ist **keine SQL-Migration
nötig**.

## Voraussetzung: keine Schema-Änderung

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

## Schutz „letzter Admin"

Ist der Aufrufer der **einzige aktive Admin** seiner Firma, wird die Löschung mit
HTTP 409 / `code: "last_admin"` abgelehnt (die App zeigt einen erklärenden
Hinweis). Er muss zuerst die Firma auflösen bzw. einen weiteren aktiven Admin
haben. Existiert ein weiterer aktiver Admin, wird nur das anfragende Konto
gelöscht; die Firma bleibt unberührt. Mitarbeiter (`role = 'employee'`) können
sich jederzeit selbst löschen.

## Sicherheit

- Der Service-Role-Key verlässt die Function nie und liegt nur serverseitig
  (`Deno.env`) — niemals im App-Bundle.
- Es kann nur das **eigene** Konto gelöscht werden (Identität aus der Session,
  kein Body-Parameter).
- Nach erfolgreicher Löschung meldet die App den Nutzer lokal ab, leert alle
  lokalen Caches (Profil, Jobs, Offline-Queue) und leitet zum Login zurück.
