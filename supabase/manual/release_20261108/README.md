# Release 2026-11-08 — Mehrfachzuweisung: Abschluss, Auftragsuhr, Export, Recovery-Queue

Ziel: Production `ivzsbspopudqgobunsdv` („TaskOps Manager“). Staging
`legzogskvcmicdgowyax` ist seit 2026-11-08 auf diesem Stand.

| Datei | Zweck | Freigabe |
|---|---|---|
| `01_deploy_bundle.sql` | Migrationen `20261029000000`, `20261030000000`, `…01`, `…02` in **einer** Transaktion inkl. `schema_migrations`-Zeilen. Vorprüfung (Stand `20261028000000`, Funktions-Hashes) und Nachprüfung (Hashes = Staging, Grants). Bei Abweichung Abbruch ohne Änderung. | Deploy-Freigabe |
| `02_rollback_functions.sql` | Stellt die vor dem Deploy read-only erfassten Prod-Definitionen wieder her, entfernt die 4 Buchungszeilen, prüft die Hashes. Öffnet keine Aufträge. | nur im Fehlerfall |
| `03_remediate_stuck_jobs.sql` | Schließt die 19 im Preflight gefundenen hängenden Aufträge (heute datierte werden übersprungen). Backup-Tabelle, kein Push, Abbruch wenn ein Auftrag nicht mehr berechtigt ist. | **eigene** Freigabe |
| `04_remediation_rollback.sql` | Öffnet die von 03 geschlossenen Aufträge wieder (aus der Backup-Tabelle). | nur im Fehlerfall |

Ablauf, Prüfungen und Generalprobe: siehe Preflight-Bericht im Release-PR.
Fachregel für Zugewiesene ohne Start: `docs/assigned-never-started.md`.

Erwartete Hashes (`md5(prosrc)`):

| Funktion | vorher (Prod) | nachher (Staging/Repo) |
|---|---|---|
| `maybe_complete_job` | `733e7d14135b2791ce20c8918c00a906` | `3d4520449939c219b2523a4d229347ad` |
| `get_company_worktime_export` | `95dd11d181b31210c8656b432ab405e4` | `ccf2d4925e26c51416fb2414b1d65144` |
| `get_work_recovery_queue` | `1aece1d361efaf30ec5a2bafd06bac18` | `f8ae16059f11776a4a98bc39c68a9d32` |
