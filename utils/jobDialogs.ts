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

/**
 * Fragt vor dem Abschließen eines Auftrags nach.
 * @returns true, wenn der Nutzer bestätigt hat.
 */
export function confirmCompleteJob(): Promise<boolean> {
  return confirmDialog({
    title: "Auftrag abschließen?",
    message: "Der Auftrag wird als erledigt markiert.",
    confirmLabel: "Abschließen",
    cancelLabel: "Abbrechen",
  });
}
