// services/auth/authRedirect.ts
// EINZIGER Weg, client-seitig eine Auth-Redirect-URL zu bauen (`redirectTo`
// für resetPasswordForEmail u. ä.). Produktions-Build → taskopsmanager://,
// Development-Build → taskopsmanagerdev:// — Begründung und Regel siehe
// utils/authLinkScheme.ts. Neue Auth-Links IMMER hierüber erzeugen, nie über
// Linking.createURL() ohne `scheme`.
//
// Die Pfade sind bewusst auf die Routen beschränkt, die in der uri_allow_list
// der Supabase-Projekte stehen — ein neuer Pfad braucht dort zuerst einen
// Eintrag (siehe supabase/functions/create-employee/DEPLOY.md).

import { resolveAuthLinkScheme } from "@/utils/authLinkScheme";
import Constants from "expo-constants";
import * as Linking from "expo-linking";

export type AuthLinkPath = "reset-password" | "accept-invite";

export function createAuthRedirectUrl(path: AuthLinkPath): string {
  return Linking.createURL(path, {
    scheme: resolveAuthLinkScheme(__DEV__, Constants.expoConfig?.scheme),
  });
}
