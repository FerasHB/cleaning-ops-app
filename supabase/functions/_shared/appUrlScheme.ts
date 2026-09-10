// supabase/functions/_shared/appUrlScheme.ts
// Deep-Link-Schema für server-seitig versendete Auth-Mails (Einladung,
// Passwort-Reset über resend-invite). Die Function kennt die App-Installation
// nicht — nur das Projekt, in dem sie läuft. Staging-Mails müssen in der
// Development-/Staging-App landen (taskopsmanagerdev://), Produktions-Mails in
// der Produktions-App (taskopsmanager://) — sonst öffnet ein Staging-Link die
// Produktions-App (Phase 14).
//
// Abgeleitet aus dem automatisch injizierten SUPABASE_URL (kein neues Secret,
// gleiches Prinzip wie utils/backendEnvironment.ts). PROD-SICHER: nur der
// Staging-Ref schaltet um; Produktion und jede unbekannte URL (z. B. lokales
// `supabase functions serve`) behalten exakt das bisherige Schema.
//
// Muss mit utils/authLinkScheme.ts und app.config.js übereinstimmen.
// Seiteneffektfrei — testbar per scripts/check-auth-link-scheme.mjs.

const STAGING_PROJECT_REF = "legzogskvcmicdgowyax";

export const PRODUCTION_APP_SCHEME = "taskopsmanager";
export const DEVELOPMENT_APP_SCHEME = "taskopsmanagerdev";

export function resolveAppUrlScheme(
  supabaseUrl: string | undefined | null,
): string {
  return typeof supabaseUrl === "string" &&
    supabaseUrl.includes(STAGING_PROJECT_REF)
    ? DEVELOPMENT_APP_SCHEME
    : PRODUCTION_APP_SCHEME;
}
