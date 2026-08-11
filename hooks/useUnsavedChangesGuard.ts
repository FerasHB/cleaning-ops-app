// hooks/useUnsavedChangesGuard.ts
// ─────────────────────────────────────────────────────────────────
// Warnt vor dem Verlassen eines Formulars mit ungespeicherten Änderungen.
//
// Deckt ALLE Wege aus dem Screen mit EINEM Mechanismus ab, weil
// `usePreventRemove` (react-navigation, bereits über expo-router vorhanden —
// keine neue Dependency) am Navigations-Dispatch ansetzt und nicht an einem
// einzelnen Button:
//   * eigener Zurück-Button im Header (er ruft router.back() → GO_BACK)
//   * Android-Hardware-Zurück
//   * iOS-Swipe-Back / natives Zurück (der Hook meldet den Zustand zusätzlich
//     an den Navigator, damit die Geste selbst abgefangen wird)
//
// Kein Endlos-Loop beim erneuten Dispatch: react-navigation markiert die Action
// intern mit den bereits besuchten Route-Keys (VISITED_ROUTE_KEYS in
// useOnPreventRemove.js) und überspringt das beforeRemove-Event beim zweiten
// Durchlauf. Das ist das offiziell dokumentierte Muster.
//
// Dialog läuft über confirmDialog (utils/dialogs) — Alert.alert ist im Web
// eine leere Attrappe und würde den Nutzer dort aussperren.
// ─────────────────────────────────────────────────────────────────

import { confirmDialog } from "@/utils/dialogs";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { useCallback, useRef } from "react";

export const DISCARD_TITLE = "Änderungen verwerfen?";
export const DISCARD_MESSAGE = "Nicht gespeicherte Änderungen gehen verloren.";
export const DISCARD_CONFIRM = "Verwerfen";
export const DISCARD_CANCEL = "Weiter bearbeiten";

export function useUnsavedChangesGuard(hasUnsavedChanges: boolean) {
  const navigation = useNavigation();
  // Synchron umlegbar — im Gegensatz zu State wirkt der Ref sofort. Genau das
  // braucht der Pfad „erfolgreich gespeichert → zurück": dort darf die Warnung
  // nicht mehr kommen, obwohl hasUnsavedChanges im selben Tick noch true ist.
  const bypassRef = useRef(false);

  usePreventRemove(hasUnsavedChanges, ({ data }) => {
    if (bypassRef.current) {
      navigation.dispatch(data.action);
      return;
    }

    void (async () => {
      const discard = await confirmDialog({
        title: DISCARD_TITLE,
        message: DISCARD_MESSAGE,
        confirmLabel: DISCARD_CONFIRM,
        cancelLabel: DISCARD_CANCEL,
        destructive: true,
      });

      // Bei „Weiter bearbeiten" passiert bewusst nichts: das beforeRemove-Event
      // wurde bereits verhindert, der Nutzer bleibt im Formular.
      if (discard) {
        navigation.dispatch(data.action);
      }
    })();
  });

  /**
   * Navigiert ohne Rückfrage — für Wege, bei denen die Änderungen gerade
   * gespeichert (oder der Datensatz gelöscht) wurden.
   */
  const leaveWithoutWarning = useCallback((navigate: () => void) => {
    bypassRef.current = true;
    navigate();
  }, []);

  return { leaveWithoutWarning };
}
