// utils/dialogs.ts
// ─────────────────────────────────────────────────────────────────
// Plattformübergreifende Bestätigungs-/Hinweis-Dialoge.
//
// WARUM ES DIESE DATEI GIBT
//   `Alert.alert()` aus react-native ist im WEB eine leere Attrappe. Wörtlich
//   (node_modules/react-native-web/dist/exports/Alert/index.js):
//
//       class Alert { static alert() {} }
//
//   Der Aufruf tut also NICHTS: kein Dialog, keine Buttons, und vor allem wird
//   kein `onPress` je ausgeführt. Jede Aktion, die hinter einer Alert-
//   Bestätigung hängt, ist im Browser damit unerreichbar — und jede
//   Fehlermeldung, die per Alert gezeigt wird, ist unsichtbar. Genau das hat
//   das Abmelden auf der Web-Version blockiert: der Bestätigungsdialog kam
//   nie, also lief signOut() nie an, und es gab auch keinerlei Rückmeldung.
//
//   Wichtig: das ist KEIN Fehler in der Abmelde-Logik selbst. AuthContext
//   .signOut() ist korrekt — es wurde schlicht nie aufgerufen.
//
// VERHALTEN
//   * Native (iOS/Android): unverändert `Alert.alert` mit denselben Buttons,
//     Rollen und Texten wie bisher. Für den Nutzer ändert sich dort NICHTS.
//   * Web: `window.confirm` / `window.alert` — synchron, aber über dieselbe
//     Promise-Schnittstelle, damit der Aufrufer plattformunabhängig bleibt.
//
//   Beide Funktionen geben ein Promise zurück, statt mit Callbacks zu
//   arbeiten. Damit lässt sich der Ablauf linear als `await` schreiben, und
//   ein `try/catch` um die Folgeaktion greift auch wirklich — bei der
//   Callback-Variante lief der `onPress`-Body ausserhalb des umgebenden
//   try/catch, ein Fehler darin wurde also zu einer unbehandelten Promise.
// ─────────────────────────────────────────────────────────────────

import { Alert, Platform } from "react-native";

type ConfirmOptions = {
  title: string;
  message: string;
  /** Beschriftung des bestätigenden Buttons (z. B. "Abmelden"). */
  confirmLabel: string;
  /** Beschriftung des Abbruch-Buttons. Standard: "Abbrechen". */
  cancelLabel?: string;
  /** Rot einfärben (nur nativ wirksam) — für destruktive Aktionen. */
  destructive?: boolean;
};

/**
 * Fragt den Nutzer um Bestätigung.
 * @returns true, wenn bestätigt wurde; false bei Abbruch.
 */
export function confirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Abbrechen",
  destructive = false,
}: ConfirmOptions): Promise<boolean> {
  if (Platform.OS === "web") {
    // window.confirm kennt keine eigenen Button-Beschriftungen, deshalb wandert
    // die Aktion in den Text — sonst stünde dort nur ein nacktes "OK".
    const bestaetigt =
      typeof window !== "undefined" &&
      window.confirm(`${title}\n\n${message}`);
    return Promise.resolve(!!bestaetigt);
  }

  return new Promise((resolve) => {
    Alert.alert(title, message, [
      // onPress am Abbrechen-Button ist nötig: ohne ihn bliebe das Promise
      // offen, wenn der Nutzer per Android-Zurück-Geste abbricht.
      { text: cancelLabel, style: "cancel", onPress: () => resolve(false) },
      {
        text: confirmLabel,
        style: destructive ? "destructive" : "default",
        onPress: () => resolve(true),
      },
    ]);
  });
}

/**
 * Zeigt einen reinen Hinweis (eine Schaltfläche) und wartet, bis er
 * weggeklickt wurde. Wird vor allem für Fehlermeldungen genutzt — auf dem Web
 * wären diese über Alert.alert sonst komplett unsichtbar.
 */
export function alertDialog(title: string, message: string): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") {
      window.alert(`${title}\n\n${message}`);
    }
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    Alert.alert(title, message, [{ text: "OK", onPress: () => resolve() }]);
  });
}
