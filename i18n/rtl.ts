// i18n/rtl.ts
// RTL-Grundlage: synchronisiert die Layout-Richtung mit der aktiven Sprache,
// getrennt nach Plattform-Mechanismus.
//
// NATIV (iOS/Android): I18nManager.forceRTL() ändert nur, welche Ausrichtung
// beim NÄCHSTEN nativen App-Start geladen wird — die bereits gemounteten
// nativen Views der laufenden Session drehen sich nicht live um. Der
// Aufrufer muss bei geändertem Rückgabewert (`true`) selbst einen
// Neustart-Hinweis zeigen; diese Datei löst nie selbst einen
// Neustart/Reload aus (kein Risiko einer Neustart-Schleife).
// `I18nManager.isRTL` ist auf React Native selbst eine echte Property, aber
// NICHT Teil des Web-Shims — nur `getConstants().isRTL` existiert auf beiden
// Plattformen. Deshalb hier bewusst getConstants() statt der bequemeren
// `.isRTL`-Kurzform.
//
// WEB (Phase F): react-native-webs I18nManager ist eine reine Attrappe
// (allowRTL/forceRTL sind No-Ops, getConstants().isRTL ist immer false —
// siehe node_modules/react-native-web/dist/exports/I18nManager) und wirkt
// auf Web schlicht nicht. Echtes Web-RTL läuft stattdessen über das
// `dir`-Attribut auf <html>: react-native-web übersetzt RNs logische
// Style-Properties (marginStart/paddingStart/start → marginInlineStart/
// paddingInlineStart/insetInlineStart, siehe preprocess.js) in ECHTE CSS-
// Logical-Properties, und normales `flexDirection: "row"` folgt in CSS
// ohnehin der Schreibrichtung (`direction`) des Dokuments — beides kippt
// dadurch automatisch um, SOBALD `dir="rtl"` gesetzt ist. Anders als nativ
// braucht Web dafür KEINEN Neustart: `dir` ist eine normale DOM-Eigenschaft,
// der Browser layoutet bei jeder Änderung sofort neu (kein Remount, kein
// Reload-Trick, kein Risiko einer Neustart-Schleife). Physische Properties
// (marginLeft/Right, paddingLeft/Right, left/right, textAlign:"left"/"right")
// kippen NICHT automatisch — weder nativ noch web — das ist der Teil, den
// Phase F pro Vorkommen manuell auf Start/End migriert.

import { I18nManager, Platform } from "react-native";
import { type AppLocale, isRTLLocale } from "./config";

// Web: dir/lang auf dem Dokument-Root setzen. Bewusst außerhalb von
// syncRTLFlag() als eigene Funktion, damit sie sowohl beim Kaltstart
// (initI18n) als auch bei jedem Laufzeit-Wechsel (changeAppLanguage)
// identisch aufgerufen werden kann, ohne die native Neustart-Semantik unten
// zu verändern. Kein SSR in dieser App (Expo-Client-Bundle) — `document`
// existiert auf Web immer, die Guard-Prüfung ist trotzdem billig und macht
// die Funktion robust gegen einen zukünftigen SSR-Kontext.
function applyWebDirection(locale: AppLocale): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dir = isRTLLocale(locale) ? "rtl" : "ltr";
  root.lang = locale;
}

/**
 * Synchronisiert die Layout-Richtung mit der übergebenen Sprache.
 * @returns true, wenn sich das NATIVE RTL-Flag geändert hat (→ Neustart
 * nötig, damit die Layout-Richtung der aktuellen Sprache entspricht). false,
 * wenn bereits passend (häufigster Fall: de/en/tr sind alle LTR) — oder immer
 * auf Web, wo die Richtung live über `dir` greift und nie ein Neustart nötig
 * ist.
 */
export function syncRTLFlag(locale: AppLocale): boolean {
  if (Platform.OS === "web") {
    applyWebDirection(locale);
    return false;
  }

  const shouldBeRTL = isRTLLocale(locale);
  const currentIsRTL = I18nManager.getConstants().isRTL;
  if (currentIsRTL === shouldBeRTL) {
    return false;
  }
  I18nManager.allowRTL(shouldBeRTL);
  I18nManager.forceRTL(shouldBeRTL);
  return true;
}
