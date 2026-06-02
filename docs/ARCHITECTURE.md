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
| Profil laden, Typen `AppRole`/`AuthProfile` | `services/profileService.ts` |
| Offline-Queue / Cache / Merge / Sync | `services/offline/*.ts` |
| Mitarbeiter/Company/Admin anlegen | `services/{employees,company,auth}/...` |
| Push-Notifications | `services/notificationService.ts` |
| Supabase-Client | `lib/supabase.ts` |
| DB-Schema (Referenz) | `lib/schema.sql` |
| Typen (`Job`, `JobStatus`, `JobType`, `EmployeeOption`) | `types/job.ts` |
| Wochentag-/Zeit-Helfer (recurring) | `utils/recurrence.ts`, `utils/date.ts` |
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

## Stolperfallen

- Context-Verzeichnis heißt `context/` (Singular), Alias `@/context/...`.
- `Job.employeeName` wird aus der Supabase-Relation `profiles:assigned_to` gemappt (kann Objekt, Array oder null sein).
- **Einmalig vs. wiederkehrend:** `jobs.job_type` = `single` (date + start_time) oder `recurring`
  (recurring_days + start_time, `is_active`). Wiederkehrende Aufträge sind **eine Regel** in der DB,
  nicht viele Einzel-Jobs. Für single wird `scheduled_start` zusätzlich befüllt (Alt-Anzeigen);
  recurring → `scheduled_start = null`.
- **Zentrale Terminierungs-Helfer:** `utils/jobSchedule.ts` (`isJobToday`, `getJobDisplayTime`,
  `getRecurringDaysLabel`) — genutzt von `EmployeeOverviewScreen`, `AdminDashboardScreen` und `JobCard`,
  damit „Heute fällig"/Anzeige nicht doppelt implementiert wird.
- **TODO – kein Occurrence-System:** Recurring Jobs sind aktuell Templates/Regeln. Status
  (`open`/`in_progress`/`completed`) und `started_at`/`completed_at` gelten global pro Regel, **nicht pro Tag**.
  Für sauberes Tages-Status-Tracking brauchen wir später echte **Job-Occurrences**; bis dahin beantwortet
  `isJobToday()` nur „ist heute fällig?" ohne tagesgenauen Status.
