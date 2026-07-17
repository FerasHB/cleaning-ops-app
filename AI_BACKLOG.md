# AI Backlog

## Regeln
- Arbeite niemals direkt auf main.
- Erstelle immer einen neuen Branch.
- Keine Supabase-RLS-Änderungen ohne meine Zustimmung.
- Keine Secrets oder .env-Dateien ändern.
- Immer kurz testen.
- Am Ende einen klaren Bericht schreiben.

## Zuletzt erledigt

### 2026-07-06 — Branch `ai/daily-task-2026-07-06`
- **Ergebniszähler in der Jobliste ausgeblendet, wenn 0 Treffer:** Über dem
  `EmptyState` stand vorher zusätzlich „0 Jobs" — doppelt gemoppelt mit der
  Empty-State-Meldung. Zähler wird jetzt nur noch gerendert, wenn
  `filteredJobs.length > 0`. Änderung nur in `features/jobs/JobsListScreen.tsx`
  (rein bedingtes Rendering, keine Logik-/State-Änderung, kein DB-Zugriff).
  → Push vom Mac nötig (Sandbox hat keinen GitHub-Token).
  Hinweis: Dieser Branch wurde von `origin/main` erstellt (aktuellster Stand:
  `.env.example`, `app.json`-Android-Configs). Der Branch
  `ai/daily-task-2026-06-30` (Kommentar-Zeitstempel) liegt weiterhin lokal
  unverändert vor und ist noch nicht gepusht/gemerged — bitte bei Gelegenheit
  vom Mac aus pushen und mergen, sonst gehen ältere Backlog-Einträge aus dem
  Blick.

### 2026-06-30 — Branch `ai/daily-task-2026-06-30`
- **Kommentar-Zeitstempel verbessert:** Heutige Kommentare zeigen jetzt
  „Heute um HH:mm" statt des vollständigen Datums. Ältere Kommentare
  behalten „dd.mm.yyyy um HH:mm". Änderung nur in
  `features/jobs/components/JobComments.tsx` (Hilfsfunktion `isSameDay`
  + angepasste `formatDateTime`). Kein DB-Zugriff, kein RLS-Impact.
  → Push vom Mac nötig (Sandbox hat keinen GitHub-Token).

### 2026-06-24 — Branch `ai/daily-task-2026-06-24`
- OfflineBanner: Fade+Slide-Animation beim Ein-/Ausblenden (220 ms rein,
  250 ms raus, 1,5 s Pause nach „gespeichert").

## Priorität 1
- Offline-Fehler in der Employee App weiter reduzieren.
- Kommentare UI schöner machen. ← Zeitstempel erledigt (30.06.2026)
- Foto-Upload UX verbessern.
- Admin Dashboard Job-Details verbessern.
- Kleine Bugs finden und fixen. ← Ergebniszähler-Doppelung erledigt (06.07.2026)

## Priorität 2
- Code aufräumen.
- Komponenten kleiner machen.
- Fehlermeldungen verständlicher machen.
- Performance verbessern.