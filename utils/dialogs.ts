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

import { Alert, Linking, Platform } from "react-native";
import { formatPhoneForDisplay, normalizePhone } from "@/utils/phone";
import { i18next } from "@/i18n";

// confirmDialog/alertDialog sind keine React-Komponenten (plain functions,
// aufgerufen aus Event-Handlern) — kein useTranslation()-Hook möglich. Die
// importierte i18next-Instanz (siehe i18n/index.ts) erlaubt trotzdem
// übersetzte Standard-Labels: i18next.t() liest den aktuell aktiven
// Sprachstand imperativ, ausgewertet bei jedem Aufruf (Default-Parameter),
// nicht einmalig beim Modul-Laden — bleibt also über Sprachwechsel hinweg
// korrekt.

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
  cancelLabel = i18next.t("common:actions.cancel"),
  destructive = false,
}: ConfirmOptions): Promise<boolean> {
  if (Platform.OS === "web") {
    // window.confirm kennt keine eigenen Button-Beschriftungen, deshalb wandert
    // die Aktion in den Text — sonst stünde dort nur ein nacktes "OK".
    const bestaetigt =
      typeof window !== "undefined" &&
      window.confirm(`${title}\n\n${message}\n\n${confirmLabel}`);
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
    Alert.alert(title, message, [
      { text: i18next.t("common:actions.ok"), onPress: () => resolve() },
    ]);
  });
}

// ─────────────────────────────────────────────────────────────────
// callPhone — die EINE wiederverwendbare Anruf-Aktion.
//
// Überall, wo eine Telefonnummer antippbar ist (Mitarbeiter-Detail, künftig
// Firmen-Kontakt, Kunden-Nummern …), läuft der Tap hier durch:
//   1. Bestätigungsdialog ("… anrufen?") — web-sicher über confirmDialog.
//   2. Erst nach Bestätigung: tel:-Link öffnen.
//   3. Scheitert das Öffnen (Desktop-Web, kein Dialer), klare Rückmeldung
//      statt stiller Nichtreaktion.
//
// `phone` darf roh oder E.164 sein — wird hier normalisiert. Ungültige
// Nummern lösen gar keinen Dialog aus (Rückgabe false).
// ─────────────────────────────────────────────────────────────────
export async function callPhone(
  phone: string | null | undefined,
  opts: { label?: string } = {},
): Promise<boolean> {
  const e164 = normalizePhone(phone);
  if (!e164) {
    await alertDialog(
      i18next.t("common:phoneCall.notPossibleTitle"),
      i18next.t("common:phoneCall.noNumberMessage"),
    );
    return false;
  }

  const pretty = formatPhoneForDisplay(e164);
  const who = opts.label?.trim();
  const confirmed = await confirmDialog({
    title: i18next.t("common:phoneCall.confirmTitle"),
    message: who
      ? i18next.t("common:phoneCall.confirmWithName", { name: who, number: pretty })
      : i18next.t("common:phoneCall.confirmGeneric", { number: pretty }),
    confirmLabel: i18next.t("common:phoneCall.confirmButton"),
  });

  if (!confirmed) return false;

  try {
    await Linking.openURL(`tel:${e164}`);
    return true;
  } catch {
    await alertDialog(
      i18next.t("common:phoneCall.notPossibleTitle"),
      i18next.t("common:phoneCall.failedMessage", { number: pretty }),
    );
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// emailContact — die EINE wiederverwendbare mailto:-Aktion.
//
// Analog zu callPhone(), aber OHNE Bestätigungsdialog: eine E-Mail zu
// öffnen ist (anders als ein platzierter Anruf) keine Aktion, die vorher
// bestätigt werden muss — der Nutzer landet nur im Compose-Screen der
// Mail-App, es wird noch nichts verschickt.
// ─────────────────────────────────────────────────────────────────
export async function emailContact(
  email: string | null | undefined,
): Promise<boolean> {
  const trimmed = email?.trim();
  if (!trimmed) {
    await alertDialog(
      i18next.t("common:emailContact.notPossibleTitle"),
      i18next.t("common:emailContact.noAddressMessage"),
    );
    return false;
  }

  try {
    await Linking.openURL(`mailto:${trimmed}`);
    return true;
  } catch {
    await alertDialog(
      i18next.t("common:emailContact.notPossibleTitle"),
      i18next.t("common:emailContact.failedMessage", { email: trimmed }),
    );
    return false;
  }
}
