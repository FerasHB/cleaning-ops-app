# CLAUDE.md

Reinigungs-/Mitarbeiter-App: Expo + React Native (TypeScript) App mit Supabase-Backend.
Admins verwalten ein Unternehmen, legen Jobs an und weisen sie Mitarbeitern zu; Mitarbeiter sehen
und bearbeiten ihre zugewiesenen Aufträge (Start/Abschluss), auch offline.

Code-Kommentare und UI-Texte sind auf Deutsch.

## Stack

- **Expo** `~54` mit **expo-router** `~6` (file-based routing), React Native `0.81`, React `19`.
- **Supabase** (`@supabase/supabase-js`) für Auth, Datenbank und Realtime.
- **expo-notifications** für Push (Expo Push Service).
- **@react-native-community/netinfo** für Online-/Offline-Erkennung.
- Schrift: **Inter** (`@expo-google-fonts/inter`, 4 Gewichte).
- TypeScript, Pfad-Alias **`@/`** → Projektwurzel.

## Befehle

- `npm start` — Expo Dev Server (`expo start`)
- `npm run ios` / `npm run android` / `npm run web`
- `npm run lint` — `expo lint` (eslint, `eslint-config-expo`)
- `npm run reset-project` — Reset-Skript

Umgebungsvariablen: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` (siehe `lib/supabase.ts`).

## Architektur

### Routing (`app/`)
File-based via expo-router. `app/_layout.tsx` lädt Fonts, richtet Notifications ein und stellt
`AuthProvider` → `JobProvider` bereit. `app/index.tsx` ist das Routing-Gate:
nicht eingeloggt → `/welcome`; eingeloggt ohne `company_id` → `/setup-company`;
sonst rollenabhängig → `/(admin-tabs)/dashboard` bzw. `/(employee-tabs)/overview`.

- `(admin-tabs)/` — dashboard, jobs, employees, profile
- `(employee-tabs)/` — overview, jobs, profile
- Auth-Routen: `welcome`, `login`, `register`, `forgot-password`, `setup-company`
- Detail-/Form-Routen: `jobs/create`, `jobs/[id]/index`, `jobs/[id]/edit`, `employees/[id]/index`

Die Route-Dateien sind dünn — die eigentliche UI liegt in `features/` (z. B. `features/jobs/JobsListScreen.tsx`).

### State / Context (`context/`)
- **`AuthContext.tsx`** — Session, User, `profile`, `role` (`admin`|`employee`), `loading`,
  `signOut`, `refreshProfile`. Bootstrappt die Session, hört auf `onAuthStateChange`,
  registriert/speichert den Expo-Push-Token am Profil.
- **`JobContext.tsx`** — Jobs + Mitarbeiter-Liste, CRUD (`createJob`/`updateJob`/`deleteJob`),
  `startJob`/`completeJob`, sowie Offline-/Sync-Status (`online`, `pendingCount`, `pendingActions`,
  `isSyncing`, `syncFailed`, `retrySync`). Lauscht auf NetInfo (Sync bei Reconnect) und auf
  Supabase-Realtime (`jobs`-Tabelle).

### Services (`services/`)
- `profileService.ts` — `getProfileByUserId`, Typen `AppRole` / `AuthProfile`.
- `jobs/jobs.service.ts` — alle Supabase-Job-Operationen; mappt DB-Rows (snake_case) auf das
  App-`Job`-Format (camelCase). Schreib-Operationen prüfen `role === "admin"`. Versendet Push bei
  Job-Zuweisung.
- `offline/` — Offline-Queue für Job-Aktionen: `jobs.queue.ts` (Pending-Actions in AsyncStorage),
  `jobs.storage.ts` (Job-Cache), `jobs.merge.ts` (Pending-Actions über Server-/Cache-Jobs legen),
  `jobs.sync.ts` (Queue gegen Server synchronisieren).
- `auth/registerAdmin.ts`, `company/setupCompanyForAdmin.ts`, `employees/createEmployee.ts`.
- `notificationService.ts` — `setupNotifications`, `registerForPushNotifications`.

### Backend (`lib/`, `supabase/`)
- `lib/supabase.ts` — Supabase-Client (AsyncStorage als Session-Storage auf Mobile).
- `lib/schema.sql` — DB-Schema (Referenz). Tabellen u. a. `profiles`, `jobs`, Company.
  Hinweis: `profiles` hat **keine** `email`-Spalte (E-Mail liegt nur in `auth.users`).
  `jobs` hat zusätzlich Terminierungs-Spalten: `job_type` (enum `single`|`recurring`), `date`,
  `start_time`, `recurring_days text[]`, `is_active`. Wiederkehrende Aufträge werden als **eine Regel**
  gespeichert (keine vorausberechneten Einzel-Jobs).
- `supabase/functions/create-employee/` — Edge Function (Deno) zum Anlegen von Mitarbeitern.

### Typen (`types/`)
- `types/job.ts` — `Job`, `JobStatus` (`open`|`in_progress`|`completed`), `JobType` (`single`|`recurring`),
  `CreateJobInput`, `EmployeeOption`. Terminierung am `Job`: `jobType`, `date` (`YYYY-MM-DD`, nur single),
  `startTime` (`HH:mm`), `recurringDays` (Kurzcodes `mon`…`sun`, nur recurring), `isActive`.

### Theming (`constants/`, `hooks/`)
- `constants/colors.ts` — Light-/Dark-Paletten (`ColorPalette`).
- `constants/theme.ts` — zentrales Theme (`spacing`, `radius`, `typography`, `shadows`).
  Neue Screens nutzen **`useAppTheme()`** (`hooks/useAppTheme.ts`, folgt System-Color-Scheme).
  Die alten Exports `Colors`/`Spacing`/`Radius`/`Typography`/`Shadows` sind **`@deprecated`**
  (immer Light-Werte) und werden schrittweise migriert — in neuem Code nicht verwenden.

### UI (`components/`, `features/`)
- `components/ui/` — wiederverwendbare Bausteine (AppHeader, KPICard, StatusBadge, OfflineBanner,
  SkeletonCard, ScreenContainer, InitialsAvatar, DateTimeField, ErrorBanner, InfoRow …).
- `components/JobCard.tsx` — Job-Listenelement.
- `features/` — Screen-Implementierungen pro Domäne (auth, home, jobs, employees, admin, profile),
  inkl. lokaler Komponenten/Hooks (z. B. `features/jobs/hooks/useJobForm.ts`).

### Sonstiges
- `i18n/` — Übersetzungen (`translations.ts`, `useTranslation.ts`).
- `utils/` — `date.ts` (inkl. Zeit-/Datum-Helfer `formatTimeHHmm`, `formatDateISO`, `isSameLocalDate`),
  `recurrence.ts` (Wochentage `WEEKDAYS`, `getWeekdayKey`, `isWeekdayInList`, `formatRecurringDays`),
  `jobSchedule.ts` (zentrale Terminierungs-Helfer `isJobToday`, `getJobDisplayTime`, `getRecurringDaysLabel`
  — genutzt von Employee-Übersicht, Admin-Dashboard und JobCard), `debug.ts`.
- `data/` — statische/Beispiel-Daten (`jobs.ts`, `employees.ts`).

## Konventionen

- DB nutzt snake_case, die App camelCase — Mapping passiert in den Services (`mapJob` etc.).
- Job-Schreibrechte: nur `admin` (in den Services serverseitig erneut geprüft).
- Offline-First für Jobs: bei fehlender Verbindung werden Aktionen in die Queue gelegt, optimistisch
  im State gespiegelt und bei Reconnect synchronisiert — neue Job-Logik soll dieses Muster wahren.
- Neue Screens/Komponenten: `useAppTheme()` statt der deprecated Theme-Exports.
- Terminierung: Maßgeblich sind `jobType`/`date`/`startTime`/`recurringDays`/`isActive`. Für **single**-Jobs
  wird `scheduled_start` zusätzlich aus Datum+Uhrzeit befüllt (Detail-/Monats-Anzeigen bleiben lauffähig);
  **recurring**-Jobs haben `scheduled_start = null`. Validierung der Kombination erfolgt serverseitig in
  `jobs.service.ts` (`buildSchedulePayload`). Die „Heute"-Logik liegt zentral in `utils/jobSchedule.ts`
  (`isJobToday`): aktive single-Jobs mit heutigem Datum + recurring-Jobs mit heutigem Wochentag — genutzt
  von Employee-Übersicht **und** Admin-Dashboard.
