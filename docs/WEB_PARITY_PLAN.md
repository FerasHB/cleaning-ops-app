# Web-Version auf Mobile-App-Stand bringen

> Stand: 2026-06-09 · Planungsdokument (kein Code geändert).
> Web-Repo: `/Users/ferashababa/admin-panel` (Next.js 16, eigenes Git-Repo).
> Mobile-Repo: `/Users/ferashababa/cleaning-employee-app-2` (Expo/RN).
> Beide nutzen **dasselbe** Supabase-Projekt (`ivzsbspopudqgobunsdv`).
>
> **Verhältnis zu anderen Docs:** Ergänzt `docs/APP_REVIEW_AND_WEB_PLAN.md` (Gesamt-Review).
> **Reihenfolge (aktualisiert):** **Block A** (fachliche Kern-Parität) → **Block B** (Light-SaaS-
> Politur + Demo-Daten) → **🎯 NovaFlow-Screenshots** → **Block C** (Realbetrieb/später).
> **Kein Dark Theme** — Web bleibt Light SaaS. Screenshots sind **nach A+B** möglich; auf die
> Betriebsfeatures aus Block C muss **nicht** gewartet werden.

---

## 1. Ziel

Die bestehende Web-Version (`admin-panel`) **fachlich auf den Stand der Mobile-App heben** — und zwar
so, dass danach **zügig präsentable NovaFlow-Screenshots** möglich sind, ohne den vollen Realbetrieb
abzuwarten.

- Web kennt/nutzt das **vollständige Job-Modell** (`job_type`/`date`/`start_time`/`recurring_days`/
  `is_active`) — nicht mehr nur `scheduled_start`.
- Web unterstützt **einmalige *und* wiederkehrende** Aufträge (Anlegen/Bearbeiten/Anzeigen, „heute fällig").
- Web bekommt **Kommentare** und eine echte **Auftrags-Detailseite** (Read-View + Verlauf/Timeline).
- **Realtime** wird company-scoped.
- **Eine** gemeinsame `create-employee` Edge Function.
- Danach: **Light-SaaS-Politur + Demo-Daten** → Screenshots.
- Erst dann: Betriebsfeatures (Mitarbeiter-Lifecycle, Push, Pagination, Reporting, Kalender …).

**Zwei klare Meilensteine:**
- **M1 „Parität":** Web kann fachlich, was der Mobile-Admin kann (Ende Block A).
- **M2 „Screenshot-ready":** Web sieht als Light-SaaS professionell aus + Demo-Daten (Ende Block B).

---

## 2. Nicht-Ziele

- **Kein Dark Theme.** Web bleibt Light SaaS.
- **Keine große Repo-Umstrukturierung am Anfang.** Kein Monorepo/`packages/shared` in Block A —
  gemeinsame Helfer werden vorerst **in den Web-Repo portiert/dupliziert** (Konsolidierung in Block C).
- **Keine Politur vor der Kern-Parität.** Block B startet erst, wenn Block A steht (sonst poliert man
  Screens, die sich durch recurring-Felder/Detail-View noch ändern).
- **Keine Betriebsfeatures vor den Screenshots.** Mitarbeiter-Lifecycle, Push, Pagination, Reporting,
  Kalender sind **Block C** (nach den Screenshots).
- **Kein Offline-Modus / kein Employee-Web-UI** (Web bleibt online-only, Admin-only).
- Das **Recurring-Occurrence-Problem** (Tages-Status, Review §4.1) wird hier **nicht** gelöst — Web
  übernimmt das bestehende Mobile-Verhalten 1:1.

---

## 3. Was Mobile bereits kann

| Fähigkeit | Beleg (Mobile) |
|---|---|
| Job-Modell single/recurring (`jobType`/`date`/`startTime`/`recurringDays`/`isActive`) | `types/job.ts`, `services/jobs/jobs.service.ts` |
| Schedule-Validierung (single: Datum+Zeit; recurring: ≥1 Wochentag+Zeit) | `buildSchedulePayload`, `useJobForm.ts` |
| „Heute fällig?" zentral (recurring per Wochentag, nur aktive) | `utils/jobSchedule.ts` (`isJobToday`/`getJobDisplayTime`/`getRecurringDaysLabel`) |
| Wochentags-/Zeit-Helfer | `utils/recurrence.ts`, `utils/date.ts` |
| Job-CRUD + Start/Complete via RPC | `jobs.service.ts` (`start_own_job`/`complete_own_job`) |
| Kommentare lesen/schreiben + Ungelesen-Status | `services/comments/comments.service.ts`, RPC `get_unread_comment_job_ids` |
| Auftrags-Detail-Read-View (Status/Mitarbeiter/Zeitstempel/Maps/Kommentare) | `features/jobs/JobDetailScreen.tsx` |
| Mitarbeiter-Anlage (Edge Function) | `services/employees/createEmployee.ts` |
| Realtime + Offline-Queue | `context/JobContext.tsx` |
| Push bei Zuweisung (clientseitig — soll serverseitig werden) | `jobs.service.ts:564` |

---

## 4. Was Web aktuell kann

| Fähigkeit | Beleg (Web) | Einschränkung |
|---|---|---|
| Admin-Auth + mehrschichtiger Guard | `lib/supabase/middleware.ts`, `proxy.ts`, `login/page.tsx` | gut, teils strenger als Mobile |
| Atomares Onboarding (RPC) | `register/page.tsx` (`register_admin_with_company`) | besser als Mobile |
| Dashboard (Status/Heute/Team/Tagesplan/Recent) | `app/(admin)/dashboard/page.tsx` | „Heute" nur per `scheduled_start` → recurring fehlt |
| Jobs-Liste (Tabelle, Suche, Statusfilter) | `app/(admin)/jobs/page.tsx`, `hooks/use-admin-jobs.ts` | kein Mitarbeiter-Filter, keine Pagination |
| Job anlegen/bearbeiten/löschen | `jobs/new/page.tsx`, `jobs/[id]/page.tsx` | **nur `scheduled_start`**, kein recurring; Admin setzt Status frei; `(emp.email)`-Bug |
| Mitarbeiter-Liste + Anlage (Edge Function) | `app/(admin)/employees/page.tsx` | kein Detail/Deaktivieren/Reassign/Kontakt |
| Realtime (inkrementell) | `hooks/use-admin-jobs.ts` | ungefiltert, merged `payload.new` direkt |
| Firmenname in Sidebar | `components/sidebar.tsx` | Sidebar unter `md` ausgeblendet |
| UI-Kit (badge/button/card/table/input/select) | `components/ui/*` | Light, Status-Farben hardcodiert |

**Wurzelproblem:** `lib/supabase/database.types.ts` ist **veraltet** — kennt `job_type`/`date`/
`start_time`/`recurring_days`/`is_active`/`job_comments`/`job_comment_reads` **gar nicht**. Deshalb
ist Web „blind" für Recurring/Kommentare. **Das ist Schritt 1 (Block A).**

---

## 5. Gap-Analyse Mobile vs. Web

| Feature | Mobile | Web | Gap | Block |
|---|:--:|:--:|---|:--:|
| Supabase-Typen aktuell | ✅ | ❌ | groß | **A** |
| `create-employee` Function einheitlich | eigene Kopie | eigene Kopie | **Konflikt** | **A** |
| Job-Modell single (Felder vollständig) | ✅ | ⚠️ nur `scheduled_start` | mittel | **A** |
| Job-Modell recurring | ✅ | ❌ | groß | **A** |
| „Heute fällig" recurring-fähig | ✅ `isJobToday` | ❌ | mittel | **A** |
| Schedule-Validierung | ✅ `buildSchedulePayload` | ❌ | mittel | **A** |
| Auftrags-Detail (Read-View) | ✅ | ❌ (nur Edit) | groß | **A** |
| Kommentare lesen/schreiben | ✅ | ❌ | groß | **A** |
| Verlauf/Timeline | ✅ | ❌ | mittel | **A** |
| Realtime company-scoped | ⚠️ Voll-Refetch | ⚠️ ungefiltert+Direkt-Merge | mittel | **A** |
| Light-SaaS-Optik / Status-Badges | (RN) | ⚠️ ok, ausbaufähig | mittel | **B** |
| `alert/confirm` → UI | — | ❌ Browser-Dialoge | klein | **B** |
| Demo-Daten | — | ❌ | klein | **B** |
| Mitarbeiter-Detail | ✅ | ❌ | mittel | **C** |
| Deaktivieren/Reaktivieren | ❌ (Stub) | ❌ | — | **C** |
| Jobs neu zuweisen | ❌ | ❌ | — | **C** |
| Kontakt (`phone`/E-Mail) | ❌ | ❌ | — | **C** |
| Push bei Zuweisung (serverseitig) | ⚠️ clientseitig | ❌ | mittel | **C** |
| Pagination / Mitarbeiter-Filter | — | ❌ | klein | **C** |
| Ungelesen-Kommentar-Status | ✅ | ❌ | klein | **C** |

> **Datenkonsistenz Web↔Mobile:** Web muss single-Jobs **wie Mobile** schreiben — `date`
> (`YYYY-MM-DD`), `start_time` (`HH:mm`), `scheduled_start` (ISO aus Datum+Zeit, lokal),
> `recurring_days=null`, `is_active=true`, `job_type='single'`. Recurring: `recurring_days`,
> `start_time`, `is_active`, `scheduled_start=null`, `date=null`, `job_type='recurring'`. (Spiegelbild
> von Mobiles `buildSchedulePayload`/`formatToISO`.)

---

## 6. Technische Reihenfolge

### 🅰️ Block A — Fachliche Kern-Parität (vor allem anderen)
1. **Supabase Types aktualisieren** — `database.types.ts` aus Live-DB generieren (Fundament).
2. **`create-employee` Edge Function vereinheitlichen** — eine Kopie, gleiche Parameter.
3. **Web-Job-Modell an Mobile angleichen** — Create/Edit schreiben **alle** Felder wie Mobile.
4. **Recurring im Web anlegen/anzeigen** — Auftragstyp-Umschalter + recurring-fähige Reads/„heute".
5. **Auftrags-Detailseite** — Routing `[id]` = Read-View, `[id]/edit` = Formular.
6. **Kommentare im Web** — lesen/schreiben + Timeline.
7. **Realtime company-scoped** — `company_id`-Filter, kein Fremddaten-Merge, RLS-für-Realtime prüfen.

### ──────── 🎯 M1: Parität erreicht ────────

### 🅱️ Block B — Light-SaaS-Politur + Demo-Daten (Screenshot-Vorbereitung)
8. Dashboard optisch verfeinern (Light SaaS).
9. Jobs-Seite optisch verfeinern.
10. Mitarbeiter-Seite optisch verfeinern.
11. Status-Badges schöner (weiterhin Light, semantisch klar).
12. `alert()/confirm()` durch Inline-UI/Modal ersetzen.
13. Demo-Daten vorbereiten (Seed: „NovaFlow Cleaning", Jobs/Mitarbeiter über alle Status).
14. *(quer)* Tablet-Navigation + Branding/Sprache (DE durchziehen).

### ──────── 🎯 M2: Screenshot-ready → NovaFlow-Screenshots ────────

### 🅲️ Block C — Realbetrieb / spätere Professionalisierung (nach den Screenshots)
15. Mitarbeiter-Detailseite.
16. Mitarbeiter deaktivieren/reaktivieren.
17. Offene/laufende Jobs neu zuweisen.
18. Push-Backend (DB-Webhook → Edge Function); Mobile-Client-Push entfernen.
19. Pagination + Mitarbeiter-Filter (Jobs-Liste).
20. Ungelesen-Kommentar-Status; Kontakt (E-Mail via Service-Role / `contact_email`).
21. Reporting/CSV, Kalender/Wochenplan, Settings/Firmenprofil, Kundenstamm.
22. `packages/shared` / Monorepo-Konsolidierung der portierten Helfer.

---

## 7. Betroffene Dateien im Web-Repo

**Block A — neu (vorerst lokal portiert):**
- `lib/jobs/schedule.ts` — Port von `buildSchedulePayload` + Felder-Mapping.
- `lib/jobs/jobSchedule.ts` — Port von `isJobToday`/`getJobDisplayTime`/`getRecurringDaysLabel`.
- `lib/recurrence.ts`, `lib/date.ts` — Wochentags-/Zeit-Helfer.
- `lib/comments/comments.ts` — `getJobComments`/`addJobComment`.
- `app/(admin)/jobs/[id]/page.tsx` — **wird Read-View**.
- `app/(admin)/jobs/[id]/edit/page.tsx` — bisheriges Edit-Formular hierher verschieben.
- `components/jobs/JobScheduleFields.tsx` — Auftragstyp/Wochentage/Datum/Uhrzeit.
- `components/jobs/JobComments.tsx`, `components/jobs/JobTimeline.tsx`.

**Block A — ändern:**
- `lib/supabase/database.types.ts` — **generiert ersetzen** (Schritt 1).
- `hooks/use-admin-jobs.ts` — Realtime-`company_id`-Filter; „Heute" via `isJobToday`; recurring-Sort.
- `app/(admin)/jobs/new/page.tsx` — recurring-Felder; `date`/`start_time`/`scheduled_start` schreiben;
  `(emp.email)`-Bug raus; Status-Default sauber.
- `app/(admin)/jobs/page.tsx` — recurring-Anzeige (Wochentage/Zeit); Detail-Link.
- `app/(admin)/dashboard/page.tsx` — „Heute"/„Tagesplan" recurring-fähig.
- `app/(admin)/employees/page.tsx` — Anlage-Parameter an vereinheitlichte Edge Function.
- `lib/supabase.ts` — **löschen** (Altdatei).
- `supabase/functions/create-employee/index.ts` — kanonische Version.

**Block B — Optik (erst nach Block A):**
- `app/globals.css` — Light-Token-Feinschliff (kein Dark Theme).
- `components/ui/badge.tsx`, `components/ui/card.tsx`, `components/ui/table.tsx` — Politur.
- `app/(admin)/dashboard|jobs|employees/*` — Layout/Spacing/States.
- `components/sidebar.tsx`, `app/(admin)/layout.tsx` — responsive Nav, Branding.
- `app/layout.tsx` — `lang="de"`; Metadaten.
- Seed-Script für Demo-Daten (z. B. `scripts/seed-demo.ts` oder SQL).

**Block C — neu/ändern:**
- `app/(admin)/employees/[id]/page.tsx` (Detail + Deaktivieren + Reassign).
- `hooks/use-admin-jobs.ts` / `jobs/page.tsx` (Pagination/Filter).
- später: `app/(admin)/calendar`, `app/(admin)/reports`, `app/(admin)/settings`.

---

## 8. Betroffene Dateien im Mobile-Repo

Mobile ist die **Referenz** — wenige Änderungen:

- `services/employees/createEmployee.ts` — Parameter an gemeinsame Edge Function (`full_name`),
  Passwort-Mindestlänge an kanonische Regel (≥8). **(Block A)**
- `supabase/functions/create-employee/index.ts` — löschen oder deckungsgleich machen (eine Quelle).
  **(Block A)**
- `services/jobs/jobs.service.ts` — Client-Push entfernen, sobald Backend-Push steht. **(Block C)**
- `features/auth/RegisterScreen.tsx` / `services/auth/registerAdmin.ts` — (optional) Mindestlänge 6→8;
  perspektivisch `register_admin_with_company`. **(Block C)**
- `lib/schema.sql` — Referenz nachziehen / durch generierten Stand ablösen. **(Block C)**

> Edge-Function-Vereinheitlichung **koordiniert** deployen — beide Clients gleichzeitig auf neue
> Parameter, sonst bricht die Anlage kurz auf einer Seite.

---

## 9. Betroffene Supabase-Bereiche

- **Typen-Generierung (Block A):** `supabase gen types typescript --project-id <id> --schema public`.
  Keine Schemaänderung — nur Wahrheit abbilden.
- **Vorab-Check (Block A, einmalig):** bestätigen, dass die Live-DB `jobs.job_type/date/start_time/
  recurring_days/is_active` + `job_comments`/`job_comment_reads` enthält (Mobile nutzt sie → sollte da
  sein). Falls nicht, zuerst Schema angleichen.
- **Edge Function `create-employee` (Block A):** eine kanonische Version (Parameter `full_name`,
  Passwort ≥8, Orphan-Cleanup wie in der admin-panel-Kopie).
- **Realtime/Authorization (Block A):** für `jobs` (später `job_comments`) **RLS-für-Realtime** prüfen/
  aktivieren, damit der `company_id`-Filter nicht der einzige Schutz ist.
- **RLS für neue Web-Aktionen (vorhanden, nur nutzen):** Kommentare (`admin read/insert …` ✅, Block A);
  Deaktivieren (`admin update profiles …` ✅, Block C); Reassign (`admin update jobs …` ✅, Block C);
  Unread (`job_comment_reads` + RPC ✅, Block C).
- **Demo-Daten (Block B):** Seed gegen die DB (Demo-Firma + Jobs + Mitarbeiter); RLS beachten (am
  einfachsten via Service-Role-Seed-Script oder als eingeloggter Demo-Admin).
- **Push (Block C):** DB-Webhook auf `jobs` (INSERT, UPDATE von `assigned_to`) → Edge Function
  `notify-assignment`.
- **Optionales Hardening (Block C):** DB-CHECK/Trigger, der die Schedule-Kombination erzwingt.

---

## 10. Risiken

1. **Typen-Regen deckt Typfehler auf** (lose `any`-Stellen werden rot). Gewollt, aber Aufwand einplanen.
2. **Edge-Function-Umstellung kann kurz die Anlage brechen** — beide Clients + Deploy synchron, testen.
3. **Datenkonsistenz single-Jobs** — Web muss `date`/`start_time`/`scheduled_start` exakt wie Mobile
   schreiben (lokale Zeitzone für `scheduled_start`). Gegenseitig testen.
4. **Detail-Routing-Refactor** (`[id]` → Read, `[id]/edit` → Form) — alle Links (Tabelle/Dashboard)
   mitziehen, sonst 404.
5. **Realtime-Filter & Reihenfolge** — `company_id` muss vor `subscribe()` bekannt sein (async).
6. **Duplizierte Helfer driften** (portierte `jobSchedule`/`recurrence`/Validierung) — bewusst für
   Block A akzeptiert; Konsolidierung Block C.
7. **Status-Semantik** — wenn Web dem Admin freies `completed` entzieht, ändert das den Workflow
   (Produktentscheidung, §13).
8. **Demo-Daten vs. echte Daten** — Seed nicht in eine produktive Firma mischen; eigene Demo-Company.

---

## 11. Konkrete Umsetzung in Phasen

### 🅰️ BLOCK A — Fachliche Kern-Parität

**Phase A1 — Fundament · ~1–2 Tage**
- `database.types.ts` generieren & ersetzen; Web grün bekommen.
- `lib/supabase.ts` (Altdatei) entfernen.
- `create-employee` vereinheitlichen; Web + Mobile darauf zeigen; koordiniert deployen & testen.

**Phase A2 — Job-Modell + Recurring · ~3–5 Tage**
- Helfer portieren: `lib/date.ts`, `lib/recurrence.ts`, `lib/jobs/jobSchedule.ts`, `lib/jobs/schedule.ts`.
- `JobScheduleFields` (Einmalig/Wiederkehrend, Wochentage, Datum/Uhrzeit).
- `jobs/new` + (verschobenes) `jobs/[id]/edit` schreiben **alle** Felder wie Mobile; `(emp.email)`-Bug raus.
- Reads recurring-fähig: `use-admin-jobs.ts` (Heute via `isJobToday`, Sortierung), `jobs/page.tsx`
  (Wochentage/Zeit), `dashboard` (Heute/Tagesplan).

**Phase A3 — Detail + Kommentare · ~3–5 Tage**
- Routing: `jobs/[id]` = Read-View; Edit nach `jobs/[id]/edit`; Links anpassen.
- Read-View: Status, Mitarbeiter (Name auflösen), Zeitstempel, Auftragstyp/Wochentage, Notizen, „Bearbeiten".
- `lib/comments/comments.ts` + `JobComments` (lesen/schreiben) + `JobTimeline`.

**Phase A4 — Realtime härten · ~1 Tag**
- companyId laden; `filter: company_id=eq.<id>`; UPDATE/Zuweisungswechsel sauber; RLS-für-Realtime prüfen.

> **🎯 M1 erreicht:** Web == Mobile fachlich.

### 🅱️ BLOCK B — Light-SaaS-Politur + Demo-Daten

**Phase B1 — Optik (Light) · ~2–3 Tage**
- Dashboard/Jobs/Mitarbeiter Layout-, Spacing-, State-Feinschliff (Light SaaS).
- Status-Badges schöner (semantisch, weiterhin hell).
- `alert()/confirm()` → Inline-Fehler + Bestätigungs-Modal.
- Tablet-Navigation (Sidebar-Drawer); Branding + `lang="de"`.

**Phase B2 — Demo-Daten · ~0,5–1 Tag**
- Seed: Demo-Firma „NovaFlow Cleaning", 10–15 Jobs über alle Status (mehrere heute, single+recurring),
  4–6 Mitarbeiter (einige `in_progress`).

> **🎯 M2 erreicht:** Screenshot-ready → **NovaFlow-Screenshots machen.**

### 🅲️ BLOCK C — Realbetrieb / später

**Phase C1 — Mitarbeiter-Lifecycle · ~3–4 Tage**
- `employees/[id]` (Detail); Kontakt (`phone`); Deaktivieren/Reaktivieren; **Job-Reassign** beim Offboarding.

**Phase C2 — Push-Backend · ~1–2 Tage**
- Edge Function `notify-assignment` + DB-Webhook; Mobile-Client-Push entfernen.

**Phase C3 — Listen-Reife & Konsistenz · ~1–2 Tage**
- Pagination + Mitarbeiter-Filter; Status-Set-Härtung; Ungelesen-Kommentar-Status.

**Phase C4 — über Parität hinaus**
- Reporting/CSV, Kalender/Wochenplan, Settings/Firmenprofil, Kundenstamm.
- `packages/shared` / Monorepo (Helfer-Konsolidierung).

---

## 12. Prioritäten P0 / P1 / P2

| Prio | Inhalt | Block | Vor Screenshots? |
|---|---|:--:|:--:|
| **P0** | Typen, Edge Function, Job-Modell, Recurring, Detail, Kommentare, Realtime | **A** | **Ja (Pflicht)** |
| **P1** | Light-Politur, Status-Badges, `alert/confirm`→UI, Demo-Daten, Tablet-Nav, Branding | **B** | **Ja (für gute Screenshots)** |
| **P2** | Mitarbeiter-Lifecycle, Push, Pagination, Reporting, Kalender, Shared Package | **C** | **Nein (nach Screenshots)** |

**Screenshot-Gate:** Alles in **P0 + P1** ist die Voraussetzung für M2. **P2 ist ausdrücklich
NICHT erforderlich**, um Screenshots zu machen.

---

## 13. Was zuerst umgesetzt werden soll

**Die ersten drei Schritte (Block A, in dieser Reihenfolge):**
1. **`database.types.ts` aus der Live-DB generieren.** Ohne das kennt Web Recurring/Kommentare nicht —
   alles hängt daran. Klein, risikoarm, maximaler Hebel.
2. **`create-employee` Edge Function vereinheitlichen.** Beseitigt den latenten Anlage-Bug (zwei
   abweichende Kopien); isoliert erledigbar.
3. **Job-Modell + Recurring angleichen** (Phase A2). Größter fachlicher Sprung Richtung Parität.

**Ehrliche Antworten auf deine Fragen:**
- **Was muss wirklich *vor* Screenshots fertig sein?** → **Block A + Block B** (P0 + P1): das korrekte
  Datenmodell/Recurring/Detail/Kommentare (sonst zeigen Screens falsche/leere Daten) **plus** die
  Light-Politur + Demo-Daten (damit es professionell aussieht).
- **Was ist nur für echten Betrieb wichtig?** → **Block C** (P2): Mitarbeiter deaktivieren/reassign,
  Push, Pagination, Reporting, Kalender, Shared Package. Für Screenshots irrelevant.
- **Was kann nach den Screenshots kommen?** → **kompletter Block C.**

> **Wenn es schnell gehen muss (Minimal-Set für die *ersten 3* Screens — Dashboard/Jobs/Mitarbeiter):**
> A1 (Typen/Edge) + A2 (Job-Modell/Recurring-Anzeige) + A4 (Realtime-Filter) + B1/B2 (Politur+Demo).
> A3 (Detail/Kommentare) ist dann nur nötig, wenn du **auch** den Detail-/Timeline-Screen
> fotografieren willst. Empfohlen bleibt der volle Block A, weil A3 den stärksten Produkt-Screenshot
> liefert — aber es ist kein harter Blocker für die drei Kern-Screens.

---

## 14. Was erst später kommt

**Block C (nach den Screenshots):**
- Mitarbeiter-Detail, Deaktivieren/Reaktivieren, Jobs neu zuweisen.
- Push-Backend (Webhook → Edge Function); Mobile-Client-Push entfernen.
- Pagination + Mitarbeiter-Filter.
- Ungelesen-Kommentar-Status; E-Mail-Anzeige (Service-Role / `contact_email`).
- Reporting/CSV, Kalender/Wochenplan, Settings/Firmenprofil, Kundenstamm.
- `packages/shared` / Monorepo — beendet die in Block A bewusst in Kauf genommene Helfer-Duplikation.
- **Recurring-Occurrence-Modell** (Tages-Status, Review §4.1) — betrifft Mobile **und** Web, eigenes
  Thema, hier ausgeklammert.

---

### Anhang: Schnell-Checkliste

**🎯 M1 — Parität (Block A):**
- [ ] `database.types.ts` generiert (job_type/date/start_time/recurring_days/is_active/job_comments/job_comment_reads)
- [ ] **Eine** `create-employee` Function für beide Clients
- [ ] Web legt single-Jobs mit `date`+`start_time`+`scheduled_start` an (wie Mobile)
- [ ] Web legt recurring-Jobs mit `recurring_days`+`start_time`+`is_active` an (`scheduled_start=null`)
- [ ] Web zählt „heute" recurring-fähig (`isJobToday`-Port)
- [ ] Auftrags-Detail-Read-View (Status/Mitarbeiter/Zeitstempel/Verlauf)
- [ ] Kommentare lesen/schreiben im Web
- [ ] Realtime company-scoped, kein Fremddaten-Merge

**🎯 M2 — Screenshot-ready (Block B):**
- [ ] Dashboard/Jobs/Mitarbeiter Light-poliert; Status-Badges schön
- [ ] `alert/confirm` ersetzt; Tablet-Nav; DE/Branding
- [ ] Demo-Daten geseedet → **NovaFlow-Screenshots**

**Block C — Realbetrieb (nach Screenshots):**
- [ ] Mitarbeiter-Detail/Deaktivieren/Reassign · Push-Backend · Pagination · Reporting · Kalender · Shared Package
