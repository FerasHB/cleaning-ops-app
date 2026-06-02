# Architektur (Kurzüberblick)

Praktische Landkarte für die Navigation im Code. Für Stack/Befehle siehe `CLAUDE.md`.
Reinigungs-/Mitarbeiter-App: Expo + RN (TypeScript), Supabase-Backend. Code/UI auf Deutsch.

## Datenfluss (Standardfall)

```
Screen (features/)  →  Context (context/)  →  Service (services/)  →  Supabase (lib/supabase.ts)
        ↑                     │
        └── useAuth/useJobs ──┘   (+ Offline-Queue & Realtime im JobContext)
```

- DB ist snake_case, App ist camelCase. Mapping passiert **nur** in den Services (`mapJob` etc.).
- Job-Schreibrechte: nur `admin` — serverseitig in den Services erneut geprüft.

## Wo finde ich was?

| Aufgabe | Datei(en) |
|---|---|
| Routing-Entscheidung (eingeloggt? Rolle? Company?) | `app/index.tsx` |
| Provider-Reihenfolge, Fonts, Notification-Setup | `app/_layout.tsx` |
| Session / User / `role` / `signOut` | `context/AuthContext.tsx` |
| Jobs-State, CRUD, Start/Complete, Offline-Status | `context/JobContext.tsx` |
| Supabase-Job-Operationen + Row-Mapping | `services/jobs/jobs.service.ts` |
| Job-Kommentare + Unread/Read-State (online-only) | `services/comments/comments.service.ts` |
| Profil laden, Typen `AppRole`/`AuthProfile` | `services/profileService.ts` |
| Offline-Queue / Cache / Merge / Sync | `services/offline/*.ts` |
| Mitarbeiter/Company/Admin anlegen | `services/{employees,company,auth}/...` |
| Push-Notifications | `services/notificationService.ts` |
| Supabase-Client | `lib/supabase.ts` |
| DB-Schema (Referenz) | `lib/schema.sql` |
| Typen (`Job`, `JobStatus`, `JobType`, `EmployeeOption`) | `types/job.ts` |
| Typen (`JobComment`, `CreateCommentInput`) | `types/comment.ts` |
| „Heute fällig?" + Anzeige-Zeit/Wochentage (single + recurring) | `utils/jobSchedule.ts` |
| Wochentag-/Zeit-Helfer | `utils/recurrence.ts`, `utils/date.ts` |
| Job erstellen/bearbeiten (Formular + Validierung) | `features/jobs/{hooks/useJobForm.ts,components/JobFormFields.tsx}` |
| Job-Kommentare-UI + Keyboard-Scroll | `features/jobs/{components/JobComments.tsx,JobDetailScreen.tsx}` |
| Theme / Farben | `constants/theme.ts`, `constants/colors.ts`, `hooks/useAppTheme.ts` |
| Wiederverwendbare UI | `components/ui/`, `components/JobCard.tsx` |
| Screen-Implementierungen | `features/<domäne>/` |

## Routen (`app/`, expo-router)

- Gate: `index.tsx` → `/welcome` | `/setup-company` | `/(admin-tabs)/dashboard` | `/(employee-tabs)/overview`
- `(admin-tabs)/`: dashboard, jobs, employees, profile
- `(employee-tabs)/`: overview, jobs, profile
- Auth: welcome, login, register, forgot-password, setup-company
- Detail/Form: `jobs/create`, `jobs/[id]/index`, `jobs/[id]/edit`, `employees/[id]/index`

> Route-Dateien sind dünn; die UI liegt in `features/` (z. B. `features/jobs/JobsListScreen.tsx`).

## Wichtige Muster (nicht brechen)

- **Offline-First für Jobs:** Bei fehlender Verbindung Aktion in die Queue (`services/offline/jobs.queue.ts`),
  optimistisch im State spiegeln, bei Reconnect via `jobs.sync.ts` synchronisieren. JobContext lauscht
  dafür auf NetInfo + Supabase-Realtime (`jobs`-Tabelle).
- **Theming:** Neue Screens nutzen `useAppTheme()`. `Colors`/`Spacing`/`Radius`/`Typography`/`Shadows`
  aus `constants/theme.ts` sind `@deprecated` (immer Light-Werte) — in neuem Code meiden.
- **Profile haben keine `email`-Spalte** (E-Mail nur in `auth.users`) — in Job-/Mitarbeiter-Queries nicht selektieren.
- **Job erstellen/bearbeiten:** Admin wählt *Einmalig* (Datum + Uhrzeit) oder *Wiederkehrend* (Wochentage +
  Uhrzeit + Aktiv/Inaktiv). Validierung in `useJobForm`/`buildSchedulePayload`: single = Datum + Uhrzeit;
  recurring = mind. ein Wochentag + Uhrzeit. Kunde/Ort/Service bleiben Pflicht.
- **Kommentare (append-only, online-only):** `job_comments` + Read-State `job_comment_reads`. Ungelesene
  Kommentare → roter Punkt (`Job.hasUnreadComments`, im JobContext gemerged); RPC `get_unread_comment_job_ids`
  liefert die IDs. `JobDetailScreen` markiert beim Öffnen via `markJobCommentsAsRead`. Keine Offline-Queue.
- **Keyboard (Kommentar-Eingabe):** `JobDetailScreen` = `KeyboardAvoidingView` + ScrollView-Ref; `onInputFocus`
  scrollt ans Ende. `Input` (`components/ui`) führt internen Focus-State und durchgereichte `onFocus`/`onBlur`
  zusammen, damit der interne State nicht überschrieben wird.
- **Supabase-Schema manuell anwenden:** `lib/schema.sql` ist nur Referenz. Nach Code-Änderungen die SQL im
  Supabase SQL Editor ausführen, sonst z. B. `column jobs.job_type does not exist` oder fehlende
  `job_comments`/`job_comment_reads`-Tabellen.

## Stolperfallen

- Context-Verzeichnis heißt `context/` (Singular), Alias `@/context/...`.
- `Job.employeeName` wird aus der Supabase-Relation `profiles:assigned_to` gemappt (kann Objekt, Array oder null sein).
- **Einmalig vs. wiederkehrend:** `jobs.job_type` = `single` (date + start_time) oder `recurring`
  (recurring_days + start_time, `is_active`). Wiederkehrende Aufträge sind **eine Regel** in der DB,
  nicht viele Einzel-Jobs. Für single wird `scheduled_start` zusätzlich befüllt (Alt-Anzeigen);
  recurring → `scheduled_start = null`.
- **Zentrale Terminierungs-Helfer:** `utils/jobSchedule.ts` (`isJobToday`, `getJobDisplayTime`,
  `getRecurringDaysLabel`) — genutzt von `EmployeeOverviewScreen`, `AdminDashboardScreen` und `JobCard`,
  damit „Heute fällig"/Anzeige nicht doppelt implementiert wird. Das Admin-Dashboard zählt „Heute fällig"
  jetzt über `isJobToday` (vorher nur `scheduledStart`) → recurring Jobs werden korrekt mitgezählt.
- **Lokale Artefakte gitignored:** `.claude/` und `supabase/.temp/` gehören nicht ins Repo.
- **TODO – kein Occurrence-System (bewusst, MVP-Scope):** Recurring Jobs sind aktuell Templates/Regeln.
  Status (`open`/`in_progress`/`completed`) und `started_at`/`completed_at` gelten global pro Regel,
  **nicht pro konkretem Tag** — d. h. „Montag abgeschlossen" markiert fälschlich auch den Donnerstag.
  Sauber wäre später ein echtes Occurrence-Modell: *recurring job = Regel*, *job occurrence = Ausführung an
  einem Tag*. Noch nicht gebaut (für MVP zu groß). Bis dahin beantwortet `isJobToday()` nur „ist heute
  fällig?" ohne tagesgenauen Status.
