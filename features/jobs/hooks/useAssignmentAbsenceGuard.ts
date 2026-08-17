// features/jobs/hooks/useAssignmentAbsenceGuard.ts
// Phase D — EIN wiederverwendbarer Speichern-Ablauf für Job erstellen/
// bearbeiten (single UND recurring, Create UND Edit): prüft Zuweisung ×
// Abwesenheit einmal vor dem eigentlichen Speichern, zeigt bei Konflikten
// EINE Warnung, übergibt danach unverändert an performSave().
//
// attemptSave() → checkAbsenceConflicts() → keine Konflikte → performSave()
//                                          → Konflikte → Warnung
//                                              → bestätigt → performSave()
//                                              → abgebrochen → nichts (Formular unangetastet)
//
// Die Konflikt-Prüfung SPEICHERT SELBST NICHTS — sie ruft ausschließlich
// die übergebene performSave() auf, nie eigene Schreib-Operationen.

import { useCallback, useRef } from "react";
import {
  checkAssignmentAbsenceConflicts,
  formatAssignmentAbsenceWarning,
  type AssignmentAbsenceCheckInput,
} from "@/features/jobs/utils/assignmentAbsenceWarning";
import { confirmDialog } from "@/utils/dialogs";

export function useAssignmentAbsenceGuard() {
  // Re-Entrancy-Schutz für den Prüfungs-/Warnungs-Ablauf selbst (getrennt
  // vom submittingRef der Aufrufer-Screens, der das eigentliche
  // Doppel-Absenden abdeckt): verhindert eine zweite Prüfung, während der
  // Warn-Dialog der ersten noch auf eine Antwort wartet.
  const checkingRef = useRef(false);

  const guardSave = useCallback(
    async (
      input: AssignmentAbsenceCheckInput,
      performSave: () => Promise<void>,
    ): Promise<void> => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        let conflicts: Awaited<ReturnType<typeof checkAssignmentAbsenceConflicts>>;
        try {
          conflicts = await checkAssignmentAbsenceConflicts(input);
        } catch {
          // Die Prüfung ist rein informativ (WARNUNG, NIE SPERRE). Ein
          // Fehler hier (z. B. Netzwerk) darf das Speichern nicht
          // verhindern — der Admin muss immer speichern können.
          conflicts = [];
        }

        if (conflicts.length === 0) {
          await performSave();
          return;
        }

        const { title, message, confirmLabel } = formatAssignmentAbsenceWarning(
          conflicts,
          input.jobType,
        );
        const confirmed = await confirmDialog({ title, message, confirmLabel });
        if (confirmed) {
          await performSave();
        }
        // Abbrechen: bewusst kein performSave(), keine Fehlermeldung — das
        // Formular bleibt exakt so stehen, wie der Admin es verlassen hat.
      } finally {
        checkingRef.current = false;
      }
    },
    [],
  );

  return { guardSave };
}
