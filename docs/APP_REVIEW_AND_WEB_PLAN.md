# Cleaning Employee App – Technischer Review & Web-Version Plan

> Stand: 2026-06-09 (aktualisiert) · Mobile-Branch `feature/job-detail-polish`
> Web-Repo: `/Users/ferashababa/admin-panel` (Next.js, **eigenes Git-Repo**, nicht Teil der Mobile-App).
> Basis: vollständige Code-Analyse beider Projekte (Schema/RLS/RPCs, Contexts, Services, Offline,
> Edge Functions, Screens/Pages, Routing, Theme, Config). Keine Code-Änderungen vorgenommen.
>
> **Korrektur ggü. erster Fassung:** Die Web-Version ist **kein Greenfield** — es existiert bereits
> ein Next.js-Admin-Dashboard (`admin-panel`) am **selben Supabase-Projekt** wie Mobile. Der Web-Plan
> unten ist entsprechend von „neu bauen" auf **„bestehendes Dashboard erweitern & professionalisieren"**
> umgestellt (siehe §8–§15).
>
> **Hinweis zu Altdokumenten:** Dieses Dokument ersetzt den älteren `Project Implementation Report.md`
> (Mobile, veraltet: nennt Offline/Recurring/Kommentare noch als „fehlend") sowie ergänzt
> `admin-panel/docs/web-admin-alignment-report.md` (Web, Stand 2026-05-21 — mehrere dort gelistete
> Bugs sind inzwischen **behoben**, siehe §9).

---

## 1. Kurzfazit

Die **Mobile-App** ist ein überdurchschnittlich solides MVP: saubere Schichtung, **ernst gemeinte
RLS**, echte Offline-Queue, Realtime, Push. Gute Grundlage. Für echten Betrieb blockieren drei Dinge:
(1) **wiederkehrende Aufträge ohne Tages-Status** (Produktfehler im Kernfeature), (2) **Realtime als
Lastbombe + mögliches Cross-Tenant-Leck**, (3) **fragiles Onboarding**.

Die **Web-Version** (`admin-panel`, Next.js 16 / React 19 / Tailwind 4 / Supabase-SSR) ist
**strukturell weiter, als man denkt**: vollständiger Admin-Guard, sauberes SSR-Auth, **atomares
Onboarding (besser als Mobile!)**, ein wirklich brauchbares Dashboard, Tabellen, Mitarbeiter-Anlage.
**Aber:** sie hängt an einem **veralteten Typ-/Datenmodell** (kennt `job_type`/`recurring_days`/
Kommentare gar nicht), ist **bewusst Light-Mode** (dark wird sogar erzwungen aus), hat ein paar
echte Bugs und divergiert spürbar von Mobile (keine Kommentare, kein Recurring, Admin setzt Status
frei). Sie sieht **nicht** wie ein Schulprojekt aus — aber auch **noch nicht** wie das „moderne Dark
SaaS Dashboard", das du für NovaFlow zeigen willst.

**Für NovaFlow-Screenshots gilt:** 3 Screens (Dashboard, Aufträge, Mitarbeiter) sind inhaltlich
schon nah dran — es fehlt v. a. ein **Dark-Theme + Demo-Daten + ein paar Politur-Fixes**. Für 5–7
starke Portfolio-Screens braucht es 2–3 zusätzliche/überarbeitete Seiten (Auftrags-Detail/Timeline,
Kalender). Details in §11.

**Reifegrad:** Mobile = *fortgeschrittenes MVP*. Web = *funktionsfähiges Admin-MVP mit veraltetem
Datenmodell-Stand und Light-Look* — gut erweiterbar, nicht verkaufs-/präsentationsfertig ohne §11/§12.

---

## 2. Aktueller Stand (Mobile)

### Stack
Expo ~54 / expo-router ~6, React Native 0.81, React 19, TypeScript, Supabase (`supabase-js`),
expo-notifications, NetInfo, `@react-native-community/datetimepicker`. New Architecture + React
Compiler. EAS-Projekt vorhanden.

### Funktionsumfang (verifiziert)
| Bereich | Status | Beleg |
|---|---|---|
| Auth + Session-Persistenz | ✅ | `context/AuthContext.tsx` |
| Rollen Admin/Employee + Routing-Gate | ✅ | `app/index.tsx` |
| Multi-Tenant (company_id überall) | ✅ | `lib/schema.sql` |
| Job-CRUD (Admin) | ✅ | `services/jobs/jobs.service.ts` |
| Start/Complete (Employee) via RPC | ✅ | RPCs `start_own_job`/`complete_own_job` |
| Offline-Queue + Reconnect-Sync | ✅ | `services/offline/*` |
| Realtime auf `jobs` | ⚠️ (s. §4.2) | `context/JobContext.tsx:313` |
| Kommentare + Ungelesen-Punkt | ⚠️ (s. §4.6) | `services/comments/comments.service.ts` |
| Recurring (Regel-Modell) | ⚠️ (s. §4.1) | `utils/jobSchedule.ts` |
| Push bei Zuweisung | ⚠️ client-seitig | `jobs.service.ts:564` |
| Mitarbeiter anlegen (Edge Function) | ✅ | `supabase/functions/create-employee/` |
| Mitarbeiter deaktivieren / Profil bearbeiten | ❌ Stub | `EmployeeDetailScreen.tsx:150`, `ProfileScreen.tsx` |
| Dark Mode | ✅ | `hooks/useAppTheme.ts` |
| i18n | ❌ Alibi | `i18n/translations.ts` |
| Tests | ❌ | — |

---

## 3. Was gut gelöst ist (Mobile)

1. **Saubere Schichtung** `Screen → Context → Service → Supabase`, Mapping isoliert in Services.
2. **RLS ist ernst gemeint**: Company+Rollen-Scope, Anti-Privilege-Escalation (keine generische
   „update own profile"; Push-Token nur via RPC), Employees ohne direktes Job-UPDATE (nur RPC),
   Kommentare append-only auf DB-Ebene.
3. **Edge Function** für Mitarbeiter-Anlage: Service-Role serverseitig, Admin/Company geprüft.
4. **Offline-First mit Substanz**: Queue mit echten Offline-Zeitstempeln, optimistisches Merging,
   Sync nur bei Erfolg.
5. **Multi-Tenancy von Tag 1**; Scoping ausschließlich über RLS (Clients filtern bewusst nicht).
6. **Dokumentierte Trade-offs** (`CLAUDE.md`, `docs/ARCHITECTURE.md`).
7. **Theme-/Komponentensystem** konsistent (Light/Dark).
8. **Datums-/Zeit-Logik entschärft** (echte Picker, strukturierte Felder, zentrale Helfer).

---

## 4. Kritische Probleme / Risiken (Mobile)

### 4.1 🔴 Recurring ohne Tages-Status (Produktfehler)
`status`/`started_at`/`completed_at` hängen an der **Regel-Zeile**, nicht am Tag. „Montag erledigt"
markiert auch Donnerstag. Für eine Reinigungsfirma mit Wochenverträgen ist genau das Kernfeature
kaputt. Beleg: `utils/jobSchedule.ts:6-12`. Optionen: recurring **ausblenden** (schnell) oder
**`job_occurrences`** einführen (sauber, nützt auch Web/Kalender/Reporting).

### 4.2 🔴 Realtime: Lastbombe + mögliches Cross-Tenant-Leck
`JobContext.tsx:313` abonniert `jobs` ungefiltert (`event:"*"`) und macht bei **jeder** Änderung
einen **Voll-Refetch** → skaliert mit *N* Online-Usern quadratisch. Ob Realtime hier RLS erzwingt,
hängt von der Supabase-Realtime-Authorization ab → **verifizieren** (sonst Payload-Leck). Fix:
`company_id`-Filter + inkrementelles Merge.

### 4.3 🟠 Onboarding fragil (Mobile)
`services/auth/registerAdmin.ts`: signUp → erwartet sofort Session → `setup_company_for_admin`.
Bricht bei aktiver E-Mail-Bestätigung; **kein Rollback** → verwaiste Auth-User möglich.
**Hinweis:** Die Web-Version hat das bereits besser gelöst (atomare RPC `register_admin_with_company`,
§9) — Mobile sollte auf dieselbe RPC umstellen.

### 4.4 🟠 Push client-seitig
`jobs.service.ts:378` pusht aus dem Client, nur bei `createJob` mit Sofort-Zuweisung; Reassignment/
Offline lösen nichts aus. Gehört in DB-Webhook → Edge Function.

### 4.5 🟠 `getJobs()` ohne Pagination/Zeitfenster — wächst unbegrenzt (`jobs.service.ts:171`).

### 4.6 🟡 Kommentare nicht live; Ungelesen-Punkt aktualisiert nur bei `jobs`-Realtime, nicht bei
neuen Kommentaren (`useJobComments.ts`).

### 4.7 🟡 RLS ist der einzige Sicherungspunkt — Clients filtern nicht selbst. Bei manuellem
Schema-Apply (s. §7) ist versehentliches RLS-Deaktivieren ein reales Risiko.

### 4.8 🟡 Kein Error-Boundary / kein Crash-Reporting (`app/_layout.tsx`).

### 4.9 🟡 Loser Job-Zustandsautomat (`complete_own_job` erlaubt Complete ohne Start).

### 4.10 🟢 Platzhalter (Firmenname „FieldService Pro", Fake-Wetter), unsichtbare Mitarbeiter-
Kontaktdaten (`phone` ungenutzt), i18n tot, `scheduled_end`/Dauer Halb-Feature.

---

## 5. MVP-Readiness (Mobile)

**Fortgeschrittenes MVP — pilotfähig für Single-Jobs nach P0.1–P0.3; nicht Self-Service-SaaS.**
- Schon tauglich: kompletter Single-Job-Flow, Auth/Rollen, Liste+Suche, Detail, Kommentare, Dark
  Mode, Offline Start/Complete.
- Blockierend: Recurring (§4.1), Realtime-Härtung (§4.2), Onboarding/E-Mail (§4.3),
  Mitarbeiter-Lifecycle.

---

## 6. Mobile App: Was noch fehlt

**Muss:** Recurring-Entscheidung; Realtime filtern+inkrementell; Push serverseitig; Onboarding
atomar (RPC wie Web); Error-Boundary + Crash-Reporting.
**Soll:** Mitarbeiter-Lifecycle (deaktivieren/reassign/Kontakt); echte Firmendaten statt Platzhalter;
Kommentare live; Server-Pagination; Passwort/Profil echt.
**Kann:** i18n entscheiden; Tests (zuerst `offline/*` + `jobSchedule`); Foto-Nachweis; Zeiterfassung.

---

## 7. Supabase / Backend Bewertung (gemeinsam für Mobile + Web)

**Stärkstes Asset — und der gemeinsame Nenner beider Clients.** Mobile und Web hängen am **selben
Projekt** (`ivzsbspopudqgobunsdv.supabase.co`), denselben Tabellen, Enums, RLS-Policies.

| Aspekt | Bewertung | Anmerkung |
|---|---|---|
| RLS | 🟢 stark | Schützt **beide** Clients identisch. |
| RPCs | 🟢 gut | `start_/complete_own_job`, `current_user_*`, **`register_admin_with_company`** (von Web genutzt — fehlt in `lib/schema.sql`!), `get_unread_comment_job_ids`. |
| Schema | 🟡 | Recurring ohne Occurrences; `recurring_days` ohne Constraint; `scheduled_*` (alt) **und** `date/start_time` (neu) parallel → Web schreibt nur alt, Mobile beides → **Drift**. |
| Edge Functions | 🟠 | **Zwei divergente Kopien** von `create-employee` (Mobile vs. admin-panel) — Parameter `fullName` vs. `full_name`, Passwort ≥6 vs. ≥8 (§9). |
| Realtime | 🔴 | Ungefiltert in beiden Clients; Web merged Payload **direkt** (riskanter, §9). |
| Migrations-Prozess | 🔴 | Schema **manuell** im SQL-Editor. `lib/schema.sql` (Mobile) und `database.types.ts` (Web) sind **beide veraltet/uneinheitlich** ggü. der echten DB. **Dringend `supabase/migrations` + `supabase gen types` als Single Source of Truth.** |

**Wichtigste gemeinsame Backend-Empfehlung:** Migrations einführen **und** Typen aus der Live-DB
generieren. Solange zwei Repos je ein eigenes (veraltetes) Schema-Bild pflegen, driften Mobile und
Web garantiert auseinander — das sieht man bereits (Web kennt Recurring/Kommentare gar nicht).

---

## 8. Web-Version: Ausgangslage — es existiert bereits ein Dashboard

**Repo:** `/Users/ferashababa/admin-panel` (separates Git-Repo).
**Stack:** Next.js **16.2.3** (App Router, RSC), React **19.2.4**, TypeScript, **Tailwind v4**,
`@supabase/ssr` (Cookie-basiertes SSR-Auth) + `supabase-js`, `lucide-react`, `date-fns`, `motion`,
`clsx`, `tailwind-merge`. Deployt vermutlich auf Vercel-Klasse-Infra.

**Struktur:**
```
app/
  page.tsx                 → redirect /dashboard
  login/page.tsx           Admin-Login (+ Rollencheck)
  register/page.tsx        Voll-Registrierung + „incomplete"-Recovery (atomare RPC)
  (admin)/layout.tsx       Sidebar + Content-Shell
  (admin)/dashboard/page.tsx
  (admin)/jobs/page.tsx              Tabelle + Suche + Statusfilter
  (admin)/jobs/new/page.tsx         Auftrag erstellen
  (admin)/jobs/[id]/page.tsx        Auftrag bearbeiten (+ löschen) — KEIN Read-Detail
  (admin)/employees/page.tsx        Liste + Mitarbeiter anlegen (Edge Function)
components/ui/*            badge, button, card, input, select, table, page-header, empty-state
components/sidebar.tsx     Sidebar mit echtem Firmennamen
hooks/use-admin-jobs.ts   Jobs laden + Realtime (inkrementell)
lib/supabase/{client,server,middleware}.ts  SSR-Clients
lib/supabase/database.types.ts              ⚠️ veraltet (s. §9)
lib/supabase.ts                              ⚠️ Altdatei (Nicht-SSR-Client) → löschen
proxy.ts                  Next-16-Middleware (Admin-Guard)
supabase/functions/create-employee/         ⚠️ zweite, abweichende Kopie
```

**Routing/Auth läuft über Next 16 `proxy.ts`** (in Next 16 wurde `middleware` → `proxy` umbenannt) —
der Guard ist also aktiv, nicht toter Code.

---

## 9. Existing Web Version Review

### 9.1 Was bereits vorhanden ist & wahrscheinlich funktioniert
- **Admin-Auth & Guard (stark):** `lib/supabase/middleware.ts` blockt Unauth → `/login`, **meldet
  Nicht-Admins aktiv ab** (`signOut`) → `/login?error=access_denied`, und schickt Admins **ohne
  company_id** nach `/register?incomplete=true`. Login prüft die Rolle zusätzlich client-seitig.
  → Sauberer, mehrschichtiger Zugriffsschutz, **strenger als Mobile**.
- **Onboarding (besser als Mobile):** `register/page.tsx` nutzt die **atomare** RPC
  `register_admin_with_company(p_full_name, p_company_name, p_company_slug)` und behandelt
  E-Mail-Bestätigung **und** verwaiste Accounts (`?incomplete=true`-Recovery) explizit.
- **Dashboard (gut):** Status-Übersicht (Offen/In Arbeit/Erledigt mit Zahlen), „Heutige Aufträge",
  „Team", **Tagesplan** (heutige Jobs mit Uhrzeit), „Aktuelle Aufträge". Inhaltlich nah an Mobile.
- **Aufträge-Liste:** Tabelle, **Suche** (Kunde + `service_name`), **Statusfilter**, semantische
  Status-Badges, Ergebniszähler, Empty-States.
- **Auftrag erstellen/bearbeiten/löschen:** Vollständige Formulare, Admin-Re-Check vor dem Schreiben.
- **Mitarbeiter:** Liste mit Avataren/Initialen + „Gerade aktiv"-Indikator, Summary-Cards (gesamt/
  aktiv/offene Zuweisungen), **Mitarbeiter-Anlage** über die Edge Function (mit Passwort-Generator).
- **Realtime:** `use-admin-jobs.ts` merged Insert/Update/Delete **inkrementell** (effizienter als
  Mobiles Voll-Refetch).
- **Firmenname** wird echt aus `companies` geladen und in der Sidebar gezeigt (Mobile hardcodet ihn!).

### 9.2 Was noch fehlt
- **Kommentare:** komplett abwesend (kein Lesen/Schreiben, kein Ungelesen-Status).
- **Recurring-Aufträge:** werden **nicht** unterstützt — weder Anlage/Bearbeitung (Formular kennt nur
  `scheduled_start`) noch Anzeige (recurring hat `scheduled_start = null` → kein Datum, nie „heute",
  sortiert ans Ende).
- **Auftrags-Detail (Read-View):** existiert nicht — Klick auf einen Job führt direkt ins
  Bearbeiten-Formular. Keine Anzeige von `started_at`/`completed_at`, Mitarbeitername, Verlauf.
- **Mitarbeiter-Lifecycle:** kein Deaktivieren/Reaktivieren, **kein Neu-Zuweisen** von Jobs, keine
  Detailseite, **kein** angezeigter Kontakt (E-Mail/`phone`).
- **Pagination & Mitarbeiter-Filter** auf der Jobs-Liste (lädt **alle** Jobs).
- **Push:** Zuweisung per Web löst **keine** Benachrichtigung aus (kein Trigger).
- **Settings/Firmenprofil-Seite, Reporting/Export, Passwort-Reset.**
- **Dark Mode / Mobile-Navigation** (s. §9.4/§11).

### 9.3 Verifizierte Bugs & technische Risiken (aktueller Stand)
1. 🔴 **`jobs/new/page.tsx:188`:** `{emp.full_name} ({emp.email})` — **`email` existiert nicht** auf
   `profiles` → das Zuweisungs-Dropdown rendert „Name (undefined)". (Edit-Seite ist korrekt.)
2. 🔴 **Duplizierte, abweichende `create-employee` Edge Function:** admin-panel-Kopie erwartet
   `full_name` + Passwort **≥8**; Mobile-Kopie erwartet `fullName` + **≥6**. Es ist nur **eine**
   deployt → **der jeweils andere Client bricht** bei der Mitarbeiter-Anlage (Parameter-Name) bzw.
   driftet bei der Passwortlänge. Muss konsolidiert werden.
3. 🔴 **`database.types.ts` ist veraltet:** kennt **nur** die Legacy-Job-Spalten — **kein**
   `job_type`/`date`/`start_time`/`recurring_days`/`is_active`, **keine** `job_comments`/
   `job_comment_reads`, **kein** `job_type`-Enum, und von den RPCs nur `current_user_*` +
   `register_admin_with_company`. **Das ist die Wurzel** dafür, dass Web Recurring/Kommentare „nicht
   kennt". Fix: `supabase gen types typescript` gegen die Live-DB.
4. 🟠 **Realtime ungefiltert + Direkt-Merge:** `use-admin-jobs.ts` schreibt `payload.new` **direkt**
   in den State. Ist die Realtime-Authorization (RLS-für-Realtime) nicht korrekt, landen
   **fremde-Firmen-Jobs direkt in der Admin-Liste** — riskanter als Mobile (das per RLS neu lädt).
5. 🟠 **Kein `company_id`-Filter** in irgendeiner Query → 100 % RLS-abhängig (wie Mobile).
6. 🟠 **`alert()` / `confirm()`** für alle Fehler/Bestätigungen in Job-Anlage/-Bearbeitung/-Löschen →
   nicht SaaS-würdig (und unschön in Demos/Screenshots).
7. 🟠 **Admin setzt `status` frei** (inkl. „Erledigt") im Create/Edit, **ohne** `started_at`/
   `completed_at` zu setzen → Inkonsistenz (`status=completed`, `completed_at=null`). Mobile lässt
   das bewusst nicht zu (nur Employee via RPC). → **Produktlogik-Divergenz + Datenqualität.**
8. 🟡 **`lib/supabase.ts`** (Nicht-SSR-Client) liegt neben `lib/supabase/client.ts` → toter/gefährlicher
   Code (teilt die SSR-Session nicht). Löschen.
9. 🟡 **Sprache inkonsistent:** `<html lang="en">` bei deutscher UI; ein englischer Satz im
   Register (`"Create your company workspace…"`).

### 9.4 Direkte Antworten auf deine Prüf-Fragen
| Frage | Antwort |
|---|---|
| Dieselben Supabase-Tabellen wie Mobile? | **Ja** (`profiles`, `jobs`, `companies`) — aber Web nutzt nur eine **Teilmenge** der Spalten (Legacy-Scheduling). |
| Dieselben Status-Werte? | **Ja, identisch** — `open`/`in_progress`/`completed` (Enum `job_status`). |
| Dieselben Rollen/RLS-Annahmen? | **Ja** (admin/employee, gleiche RLS). Web hat **zusätzlich** einen Middleware-Admin-Guard (strenger). |
| Unterschiede beim Job-Modell? | **Ja, deutlich:** Web kennt nur `scheduled_start` (kein `job_type`/`recurring_days`/`date`/`start_time`); Web setzt `status` frei; schreibt nur Legacy-Felder → Schema-Drift. |
| Kommentare? | **Nein** — gar nicht vorhanden. |
| Recurring Jobs? | **Nein** — kann sie nicht anlegen und zeigt sie falsch an. |
| Mitarbeiterverwaltung? | **Teilweise** — Liste + Anlage + Statistik; **kein** Deaktivieren/Reassign/Detail/Kontakt. |
| Admin-/Auth-Guard? | **Ja, gut** — Middleware + Login-Rollencheck + Company-Recovery. |
| Pagination / Filter / Suche? | Suche **ja**, Statusfilter **ja**, Mitarbeiter-Filter **nein**, Pagination **nein** (lädt alles). |
| Design professionell genug für NovaFlow? | **Sauber & kompetent, aber Light-Mode** (dark wird erzwungen aus) → **nicht** der gewünschte „Dark SaaS"-Look. Mit Dark-Theme + Demo-Daten + Politur sind 3 Screens portfolio-reif (§11). |

---

## 10. Web ↔ Mobile: gemeinsame Logik, Doppelungen, Divergenzen

### Doppelter Code (gleiche Absicht, getrennt gepflegt → driftet)
- **`create-employee` Edge Function** (zwei abweichende Kopien, §9.3 #2).
- **Job-Mapping/Status-Labels/Datumsformat** (`STATUS_LABEL`, `formatDate`) in Web mehrfach inline,
  in Mobile in Services/Utils.
- **Onboarding-Logik** (Web-RPC vs. Mobile-Zwei-Schritt) — gleiche Aufgabe, zwei Implementierungen.
- **Schema-Wissen** doppelt **und** unterschiedlich veraltet (`lib/schema.sql` vs.
  `database.types.ts`).

### Gemeinsame Logik, die geteilt werden **sollte** (`packages/shared`)
Plattformunabhängiges TypeScript, das beide Clients identisch brauchen:
- **Typen** aus `supabase gen types` (eine generierte `database.types.ts` für beide).
- **Services** (`jobs`, `comments`, `profiles`) — `supabase-js` läuft in Browser **und** RN identisch;
  nur der Client-Factory unterscheidet sich (SSR-Cookies vs. AsyncStorage).
- **Validierung** (`buildSchedulePayload`) + **Helfer** (`date`, `recurrence`, `jobSchedule`).
> **Realität:** Mobile und Web sind **zwei getrennte Git-Repos**. Teilen heißt also entweder
> **Monorepo** (beide als Workspaces), **publiziertes Package** oder **git submodule**. Das ist mehr
> Aufwand als „nur verschieben" — aber ohne diesen Schritt bleibt die heutige Drift (Recurring/
> Kommentare/Edge-Function/Schema) der Normalzustand.

### Bewusste Plattform-Unterschiede (so lassen)
- Web **online-only** (keine Offline-Queue/NetInfo) — richtig für ein Desktop-Dashboard.
- RN-UI vs. Tailwind/HTML — keine UI teilen, nur **Design-Tokens** (Farben) spiegeln.
- expo-notifications nur Mobile.

---

## 11. Web UI / NovaFlow Screenshot Plan

**Ziel:** Screenshots, die wie moderne Business-/SaaS-Software aussehen (Dark, saubere Sidebar, gute
Tabellen, KPI-Cards, klare Status-Badges, hochwertige Typo/Spacing), nicht wie ein Schulprojekt.

### Ehrliche Ist-Bewertung der Optik
Das Dashboard ist **handwerklich ordentlich** (gutes Spacing, semantische Status-Farben, saubere
Cards/Tabellen, Inter-Font wie Mobile) — **kein** Schulprojekt-Look. **Aber** zwei Dinge stehen dem
NovaFlow-Ziel im Weg:
1. **Es ist Light-Mode, hart verdrahtet.** `globals.css` setzt `color-scheme: light` und **überschreibt
   sogar `prefers-color-scheme: dark` zurück auf Hell**; Status-Farben sind als **feste hellen
   Pastelltöne** (`bg-emerald-50` …) in `badge.tsx` **und** im Dashboard inline gesetzt. → Ein
   Dark-Theme ist **nicht** „nur CSS-Variablen umstellen", sondern erfordert das Anfassen dieser
   hardcodierten Klassen.
2. **Rauheiten, die im Screenshot auffallen:** der `(undefined)`-Bug im Zuweisungs-Dropdown,
   `alert()/confirm()`-Browser-Dialoge, gemischtes DE/EN, und **unter Tablet-Hochkant keine Navigation**
   (Sidebar `hidden md:flex`).

### Screen-für-Screen
| Screen | Screenshot-tauglich? | Was fehlt für „premium" |
|---|---|---|
| **Dashboard** | 🟢 stärkster Kandidat | Dark-Theme; Demo-Daten; evtl. Mini-Chart/Sparkline |
| **Aufträge (Tabelle)** | 🟢 gut | Dark-Theme; Mitarbeiter-Spalte/-Filter; aktive Filter im Bild |
| **Mitarbeiter** | 🟢 gut (Avatare, „aktiv", Summary-Cards) | Dark-Theme; Demo-Team; Anlage-Formular offen zeigen |
| **Login / Register** | 🟡 ok, generisch | NovaFlow-Branding/Logo; DE durchziehen; Dark |
| **Auftrag erstellen/bearbeiten** | 🟡 schwach | `alert/confirm` raus; Dark; sieht wie Standardformular aus |
| **Auftrags-Detail/Timeline** | 🔴 fehlt | Neu bauen (Status-Verlauf, Mitarbeiter, Kommentare) — sehr screenshot-stark |
| **Kalender/Wochenplan** | 🔴 fehlt | Neu bauen (recurring sichtbar) — klassischer „SaaS-Wow"-Screen |

### Demo-Daten (Pflicht für gute Screenshots)
- Eine glaubhafte Firma: z. B. **„NovaFlow Cleaning GmbH"** (Firmenname in Sidebar/Branding).
- **10–15 Aufträge** quer über alle Status, mehrere **mit heutiger Uhrzeit** (für „Tagesplan"/„Heute"),
  realistische deutsche Services (Grundreinigung, Unterhaltsreinigung, Fensterreinigung, Treppenhaus)
  und Adressen.
- **4–6 Mitarbeiter** mit deutschen Namen, **einige `in_progress`** (für „Gerade aktiv"-Punkte und
  die Team-/Aktiv-KPIs).
- Optional: 2–3 Kommentare (sobald Kommentar-View existiert), damit der Detail-Screen lebt.

### Empfohlene 5–7 Portfolio-Screens (in Reihenfolge der Erreichbarkeit)
1. **Dashboard (Dark, Demo-Daten)** — Hero-Shot.
2. **Aufträge-Tabelle (Dark, Filter aktiv)**.
3. **Mitarbeiter (Dark, mit „Gerade aktiv" + Anlage-Formular sichtbar)**.
4. **Login oder Register mit NovaFlow-Branding (Dark)**.
5. **Auftrag erstellen/bearbeiten (Dark, ohne Browser-Alerts)**.
6. *(neu)* **Auftrags-Detail/Timeline** — wenn gebaut, der stärkste „Produkt"-Screen.
7. *(neu)* **Wochen-/Kalenderansicht** — wenn gebaut, der stärkste „SaaS"-Screen.

> **Schnellster Weg zu 4 starken Screens:** Dark-Theme + Demo-Daten + die zwei Politur-Fixes
> (Dropdown-Bug, `alert/confirm`) → Screens 1–4 sofort. Screens 6–7 sind Neubau (P1/P2).

---

## 12. Web-Plan: Vorhanden / Erweitern / Refactoren / Später

### ✅ Bereits vorhanden (nicht neu bauen)
Admin-Auth + Guard, atomares Onboarding, Dashboard, Jobs-Liste (Suche/Statusfilter), Job-Create/Edit/
Delete, Mitarbeiter-Liste + Anlage, Realtime (inkrementell), Firmenname in Sidebar, UI-Kit
(badge/button/card/table/input/select), SSR-Supabase-Clients.

### ➕ Muss erweitert werden
- **Dark-Theme** (für NovaFlow) inkl. hardcodierter Status-Farben.
- **Recurring** (Anlage/Anzeige/Heute-Zählung) — nach Typen-Regen.
- **Kommentare** (Lesen/Schreiben) + Auftrags-**Detail/Read-View** mit Verlauf.
- **Mitarbeiter:** Deaktivieren/Reaktivieren, **Job-Reassign**, Detailseite, Kontakt (`phone`).
- **Jobs-Liste:** Pagination + Mitarbeiter-Filter.
- **Responsive:** Tablet/Mobile-Navigation (Sidebar-Drawer).

### 🔧 Muss refactored werden
- **`database.types.ts` → generiert** (`supabase gen types`) als Single Source of Truth.
- **`create-employee` Edge Function konsolidieren** (eine Kopie, einheitliche Parameter/Passwortregel).
- **`alert()/confirm()` → Inline-UI / Modal**, Error-Boundary/Fehlerseite.
- **`lib/supabase.ts` löschen**; `database.types`-Drift beheben.
- **Status-Setzen härten** (Admin setzt nicht frei `completed` ohne `completed_at`).
- **Realtime:** `company_id`-Filter + RLS-für-Realtime verifizieren (Direkt-Merge!).
- **Sprache:** `<html lang="de">`, englische Strings raus.

### 🕒 Sollte später kommen
Kalender/Wochenplan, Reporting/CSV-Export, Settings/Firmenprofil, Kundenstamm (`customers`),
`packages/shared`-Konsolidierung (Monorepo), Passwort-Reset.

---

## 13. Prioritätenliste (aktualisiert: Mobile + Web)

**P0 — Blocker / Fundament**
1. **Backend-Fundament (gemeinsam):** `supabase/migrations` + `supabase gen types`; `lib/schema.sql`
   und `database.types.ts` durch generierte Wahrheit ersetzen. *(Behebt die Recurring-/Kommentar-
   Blindheit der Web-Version an der Wurzel.)*
2. **`create-employee` konsolidieren** (eine Edge Function) — sonst ist Mitarbeiter-Anlage auf einem
   der beiden Clients defekt.
3. **Realtime härten** (beide Clients): `company_id`-Filter + RLS-für-Realtime verifizieren; Web
   nicht ungeprüft `payload.new` mergen.
4. **Recurring entscheiden** (ausblenden ODER `job_occurrences`).
5. **Push serverseitig** (DB-Webhook → Edge Function); deckt Web-Zuweisungen mit ab.
6. **Onboarding vereinheitlichen** auf die atomare RPC (Mobile nachziehen).

**P1 — Professionalisierung Web + brauchbares MVP**
7. **Dark-Theme + Demo-Daten + Politur-Fixes** (NovaFlow-Screenshots, §11).
8. **Web: Kommentare + Auftrags-Detail/Read-View.**
9. **Web + Mobile: Mitarbeiter-Lifecycle** (deaktivieren/reassign/Kontakt).
10. **Web: Recurring-Anlage/-Anzeige** (nach #1).
11. **Web: Pagination + Mitarbeiter-Filter; `alert/confirm` → UI; Error-Boundary.**
12. **`packages/shared`** (Monorepo) für Typen/Services/Utils/Validierung.

**P2 — nach MVP**
13. Kalender/Wochenplan, Reporting/CSV, Settings/Firmenprofil, Kundenstamm, i18n-Entscheidung, Tests.

---

## 14. Konkreter Umsetzungsplan (für die bestehende Web-Version)

### Phase 0 — Schneller NovaFlow-Sprint (≈3–5 Tage, rein Web/Optik)
Ziel: präsentable Screenshots **ohne** auf die großen Refactors zu warten.
- **0.1 Dark-Theme:** `globals.css` Dark-Tokens; `badge.tsx` + Dashboard-Inline-Status-Farben auf
  Theme-Variablen/Dark-Varianten umstellen; Force-Light entfernen.
- **0.2 Demo-Daten** (Seed-Script gegen die DB, eigene Demo-Firma „NovaFlow Cleaning").
- **0.3 Politur:** `(emp.email)`-Bug raus; `alert/confirm` → Inline/Modal (mind. auf den Screens, die
  fotografiert werden); NovaFlow-Branding in Sidebar/Login; `lang="de"` + EN-Strings raus.
- **0.4 Tablet-Navigation** (Sidebar-Drawer) — für „responsive"-Screenshots.

### Phase 1 — Backend-Fundament (gemeinsam, ≈1 Woche)
- **1.1** `supabase/migrations` + erste Migration aus Live-DB; **`supabase gen types`** →
  generierte `database.types.ts` (Web) / Typen (Mobile).
- **1.2** **Eine** `create-employee` Edge Function (Parameter/Passwortregel vereinheitlichen); beide
  Clients darauf zeigen.
- **1.3** Realtime: `company_id`-Filter (Web + Mobile) + Realtime-RLS verifizieren/dokumentieren.
- **1.4** Push: DB-Webhook → Edge Function `notify-assignment` (ersetzt Mobile-Client-Push, deckt Web).

### Phase 2 — Recurring & Kommentare auf Web (≈1–2 Wochen)
- **2.1** Recurring-Entscheidung (B0 ausblenden ODER B1 `job_occurrences`).
- **2.2** Web-Job-Formulare um Auftragstyp/Wochentage/Uhrzeit erweitern (nach Typen-Regen).
- **2.3** **Auftrags-Detail/Read-View** (Status, Zeitstempel, Mitarbeiter, **Kommentare** lesen/
  schreiben — Service-Logik aus Mobile teilen).

### Phase 3 — Mitarbeiter & Listen-Reife (≈1 Woche)
- **3.1** Mitarbeiter-Detail + Deaktivieren/Reaktivieren + **Job-Reassign** (RLS/RPC dafür).
- **3.2** Kontakt (`phone`) pflegen/anzeigen.
- **3.3** Jobs-Liste: Pagination + Mitarbeiter-Filter; Status-Set-Härtung.

### Phase 4 — Konsolidierung & später
- **4.1** `packages/shared` (Monorepo) für Typen/Services/Utils.
- **4.2** Kalender/Wochenplan, Reporting/CSV, Settings/Firmenprofil, Kundenstamm.

---

## 15. Empfehlung: Was als Nächstes gemacht werden soll

**Zwei Stränge parallel, klar getrennt:**

**Strang A — „NovaFlow zuerst" (Optik, sofort, Phase 0).** Da dein nächstes Ziel Screenshots sind:
Dark-Theme + Demo-Daten + die zwei Politur-Fixes (`(emp.email)`-Bug, `alert/confirm`) + Tablet-Nav.
Das bringt in wenigen Tagen 4 präsentable Screens **ohne** Backend-Risiko.

**Strang B — „Fundament" (parallel, Phase 1).** `supabase gen types` + Migrations + **eine**
`create-employee`-Funktion + Realtime-Filter. Das behebt die **Wurzel** der Web↔Mobile-Drift und
einen latenten Anlage-Bug. Ohne B baust du jede neue Web-Funktion auf veraltete Typen.

**Erst danach** Recurring/Kommentare/Detail-View (Phase 2) und Mitarbeiter-Lifecycle (Phase 3) — die
das Web von „funktioniert" zu „verkaufbar" heben.

---

### Web Extension Priority Plan

| # | Task | Warum wichtig | Betroffene Dateien / Bereiche | Risiko | Prio | Vor NovaFlow-Screenshots? |
|---|---|---|---|---|---|---|
| 1 | **Dark-SaaS-Theme** | Kern des NovaFlow-Looks; aktuell Light hart verdrahtet | `app/globals.css`, `components/ui/badge.tsx`, `app/(admin)/dashboard/page.tsx` (Inline-Farben), `components/ui/*` | Mittel (hardcodierte Farben) | **P0** | **Ja** |
| 2 | **Demo-Daten-Seed** (NovaFlow Cleaning) | Leere/dünne Daten ruinieren Screenshots | Seed-Script gegen DB; `companies`/`profiles`/`jobs` | Niedrig | **P0** | **Ja** |
| 3 | **Bug: `(emp.email)` im Zuweisungs-Dropdown** | Zeigt „(undefined)" — sichtbar im Create-Screen | `app/(admin)/jobs/new/page.tsx:188` | Niedrig | **P0** | **Ja** |
| 4 | **`alert()/confirm()` → Inline/Modal** | Browser-Dialoge wirken unfertig in Demo | `jobs/new`, `jobs/[id]`, ` employees` | Niedrig–Mittel | **P0/P1** | **Ja** (für Formular-Screens) |
| 5 | **Tablet/Mobile-Navigation** | Sidebar `hidden md:flex` → keine Nav unter md | `components/sidebar.tsx`, `app/(admin)/layout.tsx` | Niedrig | **P1** | **Ja** (wenn Tablet-Shots) |
| 6 | **NovaFlow-Branding** (Logo/Name, DE durchziehen) | Marken-Wiedererkennung in Screenshots | `sidebar.tsx`, `login`, `register`, `app/layout.tsx` (`lang`) | Niedrig | **P1** | **Ja** |
| 7 | **`database.types.ts` generieren** | Wurzel der Recurring/Kommentar-Blindheit; Drift | `lib/supabase/database.types.ts` + `supabase gen types` | Niedrig | **P0** | Nein |
| 8 | **`create-employee` konsolidieren** | Eine Kopie deployt → anderer Client bricht | `admin-panel/supabase/functions/...` + Mobile-Pendant | **Hoch** (Anlage evtl. aktuell defekt) | **P0** | Nein |
| 9 | **Realtime: `company_id`-Filter + RLS-Check** | Direkt-Merge von `payload.new` → Cross-Tenant-Risiko | `hooks/use-admin-jobs.ts` + Supabase-Realtime-Config | Mittel (Sicherheit) | **P0** | Nein |
| 10 | **`lib/supabase.ts` löschen** | Toter Nicht-SSR-Client, Verwechslungsgefahr | `lib/supabase.ts` | Niedrig | **P1** | Nein |
| 11 | **Auftrags-Detail/Read-View + Kommentare** | Stärkster Produkt-Screen; Feature-Parität zu Mobile | neu: `app/(admin)/jobs/[id]/` (Read), Kommentar-Service | Mittel | **P1** | Optional (starker Screenshot) |
| 12 | **Recurring auf Web** (Anlage/Anzeige/Heute) | Kernfeature, aktuell blind/falsch | `jobs/new`, `jobs/[id]`, `use-admin-jobs.ts` (Heute-Logik) | Mittel (nach #7) | **P1** | Nein |
| 13 | **Mitarbeiter-Lifecycle** (deaktivieren/reassign/Kontakt) | Realbetrieb (Offboarding); fehlt ganz | `employees`, neue Detailseite, RLS/RPC | Mittel | **P1** | Nein |
| 14 | **Pagination + Mitarbeiter-Filter (Jobs)** | Skaliert nicht (lädt alle); Admin-Komfort | `jobs/page.tsx`, `use-admin-jobs.ts` | Niedrig | **P1** | Nein |
| 15 | **Status-Set-Härtung** | `completed` ohne `completed_at` = inkonsistent | `jobs/new`, `jobs/[id]` | Niedrig–Mittel | **P1** | Nein |
| 16 | **`packages/shared` (Monorepo)** | Beendet Web↔Mobile-Drift dauerhaft | beide Repos → Workspaces | Mittel (Repo-Umbau) | **P1/P2** | Nein |
| 17 | **Kalender/Wochenplan** | „SaaS-Wow"-Screen; recurring sichtbar | neu (nach #12) | Mittel | **P2** | Optional (starker Screenshot) |
| 18 | **Reporting/CSV, Settings, Kundenstamm** | Verkaufsargumente nach MVP | neu | Mittel | **P2** | Nein |

---

### Anhang: Belege (Kurzreferenz)

**Mobile** (`/Users/ferashababa/cleaning-employee-app-2`)
- RLS/RPCs/Schema: `lib/schema.sql` · Realtime+Offline: `context/JobContext.tsx:313`
- Job-Service (Push `:564`, kein Pagination `:171`): `services/jobs/jobs.service.ts`
- Recurring-Tages-Status: `utils/jobSchedule.ts:6-12` · Kommentare nicht live: `features/jobs/hooks/useJobComments.ts`
- Onboarding-Fragilität: `services/auth/registerAdmin.ts`

**Web** (`/Users/ferashababa/admin-panel`)
- Admin-Guard: `lib/supabase/middleware.ts`, `proxy.ts` · Atomares Onboarding: `app/register/page.tsx`
- Realtime (Direkt-Merge): `hooks/use-admin-jobs.ts:62-90` · Stale Typen: `lib/supabase/database.types.ts`
- `(emp.email)`-Bug: `app/(admin)/jobs/new/page.tsx:188` · Status frei setzbar: `app/(admin)/jobs/[id]/page.tsx`
- Light-Mode erzwungen: `app/globals.css:44-77` · Status-Farben hardcodiert: `components/ui/badge.tsx:19-23`
- Zweite Edge-Function-Kopie: `admin-panel/supabase/functions/create-employee/index.ts` (Parameter `full_name`, Passwort ≥8)
- Altdatei: `lib/supabase.ts` · Sidebar `hidden md:flex`: `components/sidebar.tsx:79`
