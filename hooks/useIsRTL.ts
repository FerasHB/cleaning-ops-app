// hooks/useIsRTL.ts
// Phase F: EINZIGE Stelle, die "ist die aktuelle UI-Sprache RTL?" beantwortet.
// Reagiert auf Sprachwechsel (useTranslation löst bei i18next.changeLanguage
// einen Re-Render aus) — kein zusätzlicher State/Listener nötig.
//
// WARUM ein Hook statt I18nManager.getConstants().isRTL direkt: Web setzt nie
// das native RTL-Flag (siehe i18n/rtl.ts — react-native-webs I18nManager ist
// eine Attrappe, isRTL bleibt dort IMMER false). Nur `isRTLLocale(sprache)`
// beantwortet die Frage auf beiden Plattformen korrekt — nativ UND web.
import { isRTLLocale, type AppLocale } from "@/i18n/config";
import { useTranslation } from "react-i18next";

export function useIsRTL(): boolean {
  const { i18n } = useTranslation();
  return isRTLLocale(i18n.language as AppLocale);
}
