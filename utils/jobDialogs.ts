// utils/jobDialogs.ts
// ─────────────────────────────────────────────────────────────────
// Job-bezogene Bestätigungsdialoge mit EINER kanonischen Formulierung.
//
// Warum zentral: das Abschließen eines Auftrags ist unumkehrbar — der erste
// erfolgreiche Übergang setzt completed_at, jeder weitere ist serverseitig ein
// No-Op (siehe „Geteilte Job-Uhr" in CLAUDE.md). Es gibt drei Einstiegspunkte
// (Job-Detail, JobCard-Quick-Action, Aktiver-Job-Karte der Employee-Übersicht),
// die deshalb denselben Dialog mit demselben Wortlaut zeigen müssen.
//
// Bewusst KEIN Dialog beim Starten: Start ist zeitkritisch, unschädlich und
// über das Abschließen ohnehin korrigierbar — eine Rückfrage würde dort nur
// Zeit im Feld kosten.
//
// Läuft über confirmDialog (utils/dialogs.ts), nicht über Alert.alert:
// Alert ist im Web eine leere Attrappe, der onPress-Callback liefe dort nie.
// ─────────────────────────────────────────────────────────────────

import { confirmDialog } from "@/utils/dialogs";
import { i18next } from "@/i18n";

/**
 * Fragt vor dem Abschließen eines Auftrags nach.
 * @returns true, wenn der Nutzer bestätigt hat.
 */
export function confirmCompleteJob(): Promise<boolean> {
  return confirmDialog({
    title: i18next.t("jobs:dialogs.completeTitle"),
    message: i18next.t("jobs:dialogs.completeMessage"),
    confirmLabel: i18next.t("jobs:actions.complete"),
    cancelLabel: i18next.t("common:actions.cancel"),
  });
}

export function confirmCompleteWhilePaused(): Promise<boolean> {
  return confirmDialog({
    title: i18next.t("jobs:work.completePausedTitle"),
    message: i18next.t("jobs:work.completePausedMessage"),
    confirmLabel: i18next.t("jobs:actions.complete"),
    cancelLabel: i18next.t("common:actions.cancel"),
  });
}
