// utils/authLinkScheme.ts
// Welches URL-Schema tragen Auth-Links (Passwort-Reset, Einladung), die DIESE
// App-Installation anfordert? Es muss exakt das Schema sein, das das laufende
// native Binary registriert — sonst öffnet die Mail eine ANDERE Installation,
// in der der PKCE-code_verifier fehlt (Phase 14: ein auf Staging angeforderter
// Reset-Link öffnete die Produktions-App).
//
// Warum nicht einfach Linking.createURL() ohne `scheme`? Im Development-Build
// stammt Constants.expoConfig NICHT aus dem Build, sondern aus dem
// Metro-Manifest — und das kennt die Variante nur, wenn Metro mit
// APP_VARIANT=development gestartet wurde. Ohne die Variable lieferte
// createURL "taskopsmanager://" im Dev-Build (natives Schema
// "taskopsmanagerdev") → der Link landete in der TestFlight-App.
//
// Regel:
//   • __DEV__ (Metro-Bundle — läuft nur im Development-Build) → Dev-Schema,
//     unabhängig davon, wie Metro gestartet wurde.
//   • Release-Bundle → das zur Build-Zeit eingebettete Schema. Es entsteht in
//     derselben app.config.js-Auswertung wie die nativen URL-Schemes und kann
//     daher nicht abweichen. Alles außer dem Dev-Schema → Produktions-Schema
//     (= exakt das bisherige Verhalten jedes Produktions-Builds).
//
// Seiteneffektfrei, ohne RN-/Expo-Imports — testbar per
// `node --experimental-strip-types scripts/check-auth-link-scheme.mjs`.
// Muss mit app.config.js (`scheme`) und
// supabase/functions/_shared/appUrlScheme.ts übereinstimmen.

export const PRODUCTION_APP_SCHEME = "taskopsmanager";
export const DEVELOPMENT_APP_SCHEME = "taskopsmanagerdev";

export function resolveAuthLinkScheme(
  isDev: boolean,
  embeddedScheme: string | string[] | null | undefined,
): string {
  if (isDev) return DEVELOPMENT_APP_SCHEME;

  const scheme = Array.isArray(embeddedScheme)
    ? embeddedScheme[0]
    : embeddedScheme;
  return scheme === DEVELOPMENT_APP_SCHEME
    ? DEVELOPMENT_APP_SCHEME
    : PRODUCTION_APP_SCHEME;
}
