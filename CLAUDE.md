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
  Supabase-Realtime (`jobs`-Tabelle). Merged zusätzlich das Ungelesen-Flag `hasUnreadComments`
  pro Job (online, best-effort) und bietet `markJobCommentsAsRead(jobId)`.

### Services (`services/`)
- `profileService.ts` — `getProfileByUserId`, Typen `AppRole` / `AuthProfile`.
- `jobs/jobs.service.ts` — alle Supabase-Job-Operationen; mappt DB-Rows (snake_case) auf das
  App-`Job`-Format (camelCase). Schreib-Operationen prüfen `role === "admin"`. Versendet Push bei
  Job-Zuweisung. Terminierung wird in `buildSchedulePayload` serverseitig validiert (single vs. recurring).
- `comments/comments.service.ts` — Job-Kommentare (append-only, **online-only**, keine Offline-Queue):
  `getJobComments`, `addJobComment`, `getUnreadCommentJobIds` (RPC `get_unread_comment_job_ids`),
  `markJobCommentsAsRead` (Upsert auf `job_comment_reads`).
- `offline/` — Offline-Queue für Job-Aktionen: `jobs.queue.ts` (Pending-Actions in AsyncStorage),
  `jobs.storage.ts` (Job-Cache), `jobs.merge.ts` (Pending-Actions über Server-/Cache-Jobs legen),
  `jobs.sync.ts` (Queue gegen Server synchronisieren).
- `auth/registerAdmin.ts`, `company/setupCompanyForAdmin.ts`, `employees/createEmployee.ts`.
- `notificationService.ts` — `setupNotifications`, `registerForPushNotifications`.

### Backend (`lib/`, `supabase/`)
- `lib/supabase.ts` — Supabase-Client (AsyncStorage als Session-Storage auf Mobile).
- `lib/schema.sql` — DB-Schema (Referenz). Tabellen u. a. `companies`, `profiles`, `jobs`,
  `job_comments`, `job_comment_reads`.
  Hinweis: `profiles` hat **keine** `email`-Spalte (E-Mail liegt nur in `auth.users`).
  `jobs` hat zusätzlich Terminierungs-Spalten: `job_type` (enum `single`|`recurring`), `date`,
  `start_time`, `recurring_days text[]`, `is_active`. Wiederkehrende Aufträge werden als **eine Regel**
  gespeichert (keine vorausberechneten Einzel-Jobs).
  RPCs u. a.: `start_own_job`/`complete_own_job` (Employee-Aktionen trotz RLS), `setup_company_for_admin`,
  `update_my_push_token`, `get_unread_comment_job_ids` (ungelesene Kommentar-Job-IDs).
  **Wichtig:** `lib/schema.sql` ist nur Referenz — Schema-Änderungen müssen **manuell im Supabase
  SQL Editor** angewandt werden. Sonst Fehler wie `column jobs.job_type does not exist` (oder fehlende
  `job_comments`/`job_comment_reads`-Tabellen).
- `supabase/functions/create-employee/` — Edge Function (Deno) zum Anlegen von Mitarbeitern.
- `supabase/.temp/` — lokale CLI-Artefakte, **gitignored** (nicht ins Repo).

### Typen (`types/`)
- `types/job.ts` — `Job`, `JobStatus` (`open`|`in_progress`|`completed`), `JobType` (`single`|`recurring`),
  `CreateJobInput`, `EmployeeOption`. Terminierung am `Job`: `jobType`, `date` (`YYYY-MM-DD`, nur single),
  `startTime` (`HH:mm`), `recurringDays` (Kurzcodes `mon`…`sun`, nur recurring), `isActive`.
  Job trägt zusätzlich `hasUnreadComments` (gemerged im JobContext, nicht in `mapJob`).
- `types/comment.ts` — `JobComment`, `CreateCommentInput` (Job-Kommentare).

### Theming (`constants/`, `hooks/`)
- `constants/colors.ts` — Light-/Dark-Paletten (`ColorPalette`).
- `constants/theme.ts` — zentrales Theme (`spacing`, `radius`, `typography`, `shadows`).
  Neue Screens nutzen **`useAppTheme()`** (`hooks/useAppTheme.ts`, folgt System-Color-Scheme).
  Die alten Exports `Colors`/`Spacing`/`Radius`/`Typography`/`Shadows` sind **`@deprecated`**
  (immer Light-Werte) und werden schrittweise migriert — in neuem Code nicht verwenden.

### UI (`components/`, `features/`)
- `components/ui/` — wiederverwendbare Bausteine (AppHeader, KPICard, StatusBadge, OfflineBanner,
  SkeletonCard, ScreenContainer, InitialsAvatar, DateTimeField, ErrorBanner, InfoRow …).
  `DateTimeField` kennt `mode="datetime"` (Datum→Uhrzeit, für single) und `mode="time"` (nur Uhrzeit,
  für recurring). Das `Input` führt internen Focus-State **und** durchgereichte `onFocus`/`onBlur` zusammen
  (Spread darf den internen Handler nicht überschreiben).
- `components/JobCard.tsx` — Job-Listenelement. Zeigt Zeit/Wochentage via `utils/jobSchedule` und im
  Heute-Kontext (Prop `dueToday`) einfache Hinweis-Chips: „Heute fällig", „Startet um HH:mm",
  „Noch nicht gestartet"; recurring zeigt Wochentage wie „Mo, Do".
- `features/jobs/components/JobFormFields.tsx` — Job-Formular (Kunde/Ort/Service/Mitarbeiter/Notizen)
  inkl. Auftragstyp-Umschalter (Einmalig/Wiederkehrend), Wochentag-Auswahl, Uhrzeit und Aktiv-Schalter.
- `features/jobs/components/JobComments.tsx` (+ Hook `useJobComments`) — Kommentar-Liste + Eingabe;
  `onInputFocus` triggert Auto-Scroll im `JobDetailScreen` (siehe Keyboard-Handling unten).
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
  `jobs.service.ts` (`buildSchedulePayload`).
- Job erstellen/bearbeiten (`AdminScreen`, `EditJobScreen` über `useJobForm` + `JobFormFields`): Admin wählt
  **Einmalig** (Datum + Uhrzeit) oder **Wiederkehrend** (Wochentage + Uhrzeit + Aktiv/Inaktiv). Validierung:
  single braucht Datum **und** Uhrzeit; recurring braucht mind. **einen** Wochentag **und** Uhrzeit. Kunde,
  Ort/Location, Service bleiben Pflicht; Mitarbeiter-Zuweisung und Notizen optional.
- **Heute-Logik nicht duplizieren:** Die „heute fällig?"-Entscheidung liegt zentral in `utils/jobSchedule.ts`
  (`isJobToday`/`getJobDisplayTime`/`getRecurringDaysLabel`) und wird von `EmployeeOverviewScreen`,
  `AdminDashboardScreen` und `JobCard` genutzt. Neue Screens diesen Helper verwenden, keine eigene
  Wochentag-/Datums-Logik in Screens schreiben.
- Kommentare sind **append-only und online-only** (kein Edit/Delete, keine Offline-Queue). Ungelesen-Status
  läuft über `job_comment_reads` + RPC; `JobDetailScreen` markiert Kommentare beim Öffnen als gesehen.
- **Keyboard-Handling Kommentare:** `JobDetailScreen` nutzt `KeyboardAvoidingView` + ScrollView-Ref; bei
  Fokus auf das Kommentarfeld (`onInputFocus`) wird ans Ende gescrollt, damit Eingabe + Senden über der
  Tastatur sichtbar bleiben.
- Lokale Dateien gehören nicht ins Repo: `.claude/` und `supabase/.temp/` sind in `.gitignore`.

## Recurring-Job-Occurrences (materialisiert)

- **Recurring Jobs werden in konkrete Occurrences materialisiert.** Ein *recurring job* ist die Regel/Template
  (`job_type='recurring'`, `parent_job_id IS NULL`); pro fälligem Tag entsteht eine *Occurrence*
  (`job_type='single'`, `parent_job_id` gesetzt) mit **eigenem** `status`/`started_at`/`completed_at`.
- **Generierung:** RPC `generate_job_occurrences(uuid)` (Admin) bei Create, `update_job_occurrences(uuid)`
  bei Edit (löscht nur **zukünftige offene** Occurrences und regeneriert; laufende/erledigte bleiben). Beide
  delegieren an die interne Kernfunktion `_generate_occurrences_core(jobs)` (siehe `lib/schema.sql`).
- **Rollierender Horizont:** heute … +90 Tage (gedeckelt durch `recurrence_end_date`, hartes Max 730 Tage).
  Der tägliche **pg_cron**-Lauf `cron_generate_due_occurrences()` (02:00 UTC) füllt den Horizont automatisch
  nach, damit Serien ohne Enddatum nie „versiegen". **pg_cron muss in Supabase aktiviert sein.**
- **is_active:** serverseitig durchgesetzt — inaktive Serien erzeugen keine Occurrences, die Employee-RLS und
  `start_own_job`/`complete_own_job` filtern auf `is_active = true`. Screens filtern zusätzlich (Defense-in-Depth).
- **Hinweis Schema:** `lib/schema.sql` ist die kanonische Referenz; Migrationen unter `supabase/migrations/`
  konvergieren zum selben Stand (Funktions-Overloads sind in `20260701_…` bereinigt).
