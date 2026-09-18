// utils/authErrorMessages.ts
// Zentrale Übersetzung technischer Auth-/Edge-Function-/Netzwerk-Fehler in
// nutzerfreundliche, ÜBERSETZTE Meldungen — für alle Auth-Screens (Login,
// Registrierung, Firma einrichten, Passwort vergessen/ändern/zurücksetzen,
// Einladungs-Annahme, Mitarbeiter einladen/erneut einladen) sowie
// Profil-Flows, die denselben Auth-Client nutzen (Logout, Konto löschen).
// Nutzer sollen nie rohe Supabase-/Netzwerk-/Edge-Function-Fehlertexte sehen
// (z.B. "Edge Function returned a non-2xx status code", "Failed to fetch",
// "Invalid JWT", "AuthApiError", "Unexpected error").
//
// Plain-function-Datei (keine Komponente) — kein useTranslation()-Hook
// möglich. Nutzt wie utils/dialogs.ts/utils/userMessages.ts die exportierte
// i18next-Instanz direkt: i18next.t() liest die aktuell aktive Sprache bei
// JEDEM Aufruf frisch.

import { isNetworkError } from "@/utils/networkError";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { i18next } from "@/i18n";

// Stabile GoTrue-Fehlercodes (AuthApiError.code / REST-Body error_code) →
// i18next-Key. Wird VOR den Text-Mustern unten geprüft — ein Code ist
// robuster als ein Textmuster, weil Supabase die Wortwahl der Meldung ändern
// kann, ohne den Code zu ändern. Werte siehe @supabase/auth-js
// ErrorCode-Union (node_modules/@supabase/auth-js/dist/*/lib/error-codes.d.ts).
const KNOWN_ERROR_CODE_KEYS: Readonly<Record<string, string>> = {
  invalid_credentials: "common:authErrors.invalidCredentials",
  email_not_confirmed: "common:authErrors.emailNotConfirmed",
  email_address_invalid: "common:authErrors.invalidEmail",
  email_address_not_authorized: "common:authErrors.invalidEmail",
  user_already_exists: "common:authErrors.emailExists",
  email_exists: "common:authErrors.emailExists",
  weak_password: "common:authErrors.weakPassword",
  over_email_send_rate_limit: "common:authErrors.rateLimit",
  over_request_rate_limit: "common:authErrors.rateLimit",
  refresh_token_not_found: "common:errors.sessionExpired",
  session_expired: "common:errors.sessionExpired",
  session_not_found: "common:errors.sessionExpired",
};

// Fallback für Fehler ohne erhaltenen Code (z.B. Edge-Function-Bodies, die
// nur einen String liefern — siehe toFriendlyEdgeFunctionErrorMessage):
// bekannte technische GoTrue-/Supabase-Auth-Fehlertexte → i18next-Key.
// Reihenfolge relevant: spezifischere Muster zuerst.
const KNOWN_ERROR_PATTERNS: readonly {
  pattern: RegExp;
  key: string;
}[] = [
  {
    pattern: /invalid login credentials/i,
    key: "common:authErrors.invalidCredentials",
  },
  {
    pattern: /email not confirmed/i,
    key: "common:authErrors.emailNotConfirmed",
  },
  {
    // Deckt sowohl "Unable to validate email address" als auch GoTrues
    // "Email address "x@y.z" is invalid" ab (unterschiedliche Wortstellung,
    // beide bedeuten dasselbe email_address_invalid). Eng genug, um nicht
    // versehentlich unabhängige Fehler zu treffen: verlangt "email" +
    // "invalid" UND (address/adresse-Kontext) im selben Satz.
    pattern: /unable to validate email address|invalid email|email address.{0,60}is invalid/i,
    key: "common:authErrors.invalidEmail",
  },
  {
    pattern: /user already registered|already been registered/i,
    key: "common:authErrors.emailExists",
  },
  {
    pattern:
      /invalid refresh token|refresh_token_not_found|invalid jwt|jwt expired|session.{0,15}(missing|not found)/i,
    key: "common:errors.sessionExpired",
  },
  {
    pattern: /rate limit|too many requests/i,
    key: "common:authErrors.rateLimit",
  },
  {
    pattern: /password.{0,25}(should be at least|too short|weak)/i,
    key: "common:authErrors.weakPassword",
  },
];

// Technische Fehlertexte, die NIE roh angezeigt werden dürfen (auch nicht,
// wenn sie aus einem geparsten Edge-Function-Body stammen) — landen immer
// beim übergebenen Fallback statt beim Nutzer.
const RAW_TECHNICAL_PATTERN =
  /edge function returned a non-2xx|failed to send a request to the edge function|failed to fetch|network request failed|authapierror|functionshttperror|functionsfetcherror|functionsrelayerror|typeerror:|unexpected error/i;

function extractMessage(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const maybeMessage = (err as { message?: unknown })?.message;
  return typeof maybeMessage === "string" ? maybeMessage : "";
}

// AuthApiError.code (supabase-js) bzw. REST-Body error_code (Edge Functions,
// die den Fehler roh durchreichen) — siehe KNOWN_ERROR_CODE_KEYS oben.
function extractErrorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const maybeCode =
    (err as { code?: unknown }).code ?? (err as { error_code?: unknown }).error_code;
  return typeof maybeCode === "string" ? maybeCode : "";
}

// Übersetzt einen beliebigen Fehler (Supabase AuthError, geworfene Errors,
// rohe Strings) in eine nutzerfreundliche, übersetzte Meldung. `fallback`
// erlaubt jedem Aufrufer einen zum Kontext passenden, bereits übersetzten
// Default (z.B. t("...", "E-Mail oder Passwort ist falsch.") beim Login),
// falls kein bekanntes Muster greift.
export function toFriendlyAuthErrorMessage(
  err: unknown,
  fallback: string = i18next.t("common:authErrors.generic"),
): string {
  if (isNetworkError(err)) return i18next.t("common:authErrors.offline");

  const code = extractErrorCode(err);
  if (code && KNOWN_ERROR_CODE_KEYS[code]) {
    return i18next.t(KNOWN_ERROR_CODE_KEYS[code]);
  }

  const message = extractMessage(err);
  if (!message) return fallback;

  if (
    /^5\d{2}\b|internal server error|service unavailable|bad gateway/i.test(
      message,
    )
  ) {
    return i18next.t("common:errors.serverUnavailable");
  }

  for (const { pattern, key } of KNOWN_ERROR_PATTERNS) {
    if (pattern.test(message)) return i18next.t(key);
  }

  if (RAW_TECHNICAL_PATTERN.test(message)) return fallback;

  // Meldungen, die der Server (RPC/Edge Function) bereits selbst
  // verständlich auf DEUTSCH formuliert (z.B. "Nur Admins dürfen Mitarbeiter
  // erstellen.", "Mitarbeiter nicht gefunden."), unverändert durchreichen —
  // ABER NUR, wenn die aktive UI-Sprache Deutsch ist (server-seitige
  // Lokalisierung ist eine spätere Phase, siehe utils/userMessages.ts für
  // dieselbe Überlegung). Sonst würde eine deutsche RPC-/Edge-Function-
  // Meldung in eine englische/arabische/türkische Oberfläche durchsickern;
  // der Aufrufer fällt dann stattdessen auf den übersetzten `fallback`
  // zurück.
  if (i18next.language?.startsWith("de")) return message;
  return fallback;
}

// Liest den JSON-Body einer fehlgeschlagenen Edge-Function-Antwort aus.
// supabase-js liefert bei JEDEM Nicht-2xx-Status nur "Edge Function returned
// a non-2xx status code" in error.message — die eigentliche, von der
// Function selbst formulierte Meldung (meist schon Deutsch, siehe z.B.
// supabase/functions/create-employee/index.ts) steckt im Response-Body unter
// error.context (siehe supabase-js-Doku für invoke()). Fällt auf
// toFriendlyAuthErrorMessage zurück, wenn der Body nicht gelesen werden kann
// (Netzwerkfehler, kaputtes JSON, o.ä.).
export async function toFriendlyEdgeFunctionErrorMessage(
  error: unknown,
  fallback: string = i18next.t("common:authErrors.generic"),
): Promise<string> {
  if (isNetworkError(error)) return i18next.t("common:authErrors.offline");

  if (error instanceof FunctionsHttpError) {
    try {
      const body = await (error.context as Response).json();
      const bodyMessage = typeof body?.error === "string" ? body.error : "";
      const bodyCode = typeof body?.code === "string" ? body.code : "";
      if (bodyMessage || bodyCode) {
        // Ein `code`-Feld (siehe z.B. create-employee: "email_exists") ist
        // robuster als der Text — Edge Functions formulieren ihre Meldung
        // bereits selbst auf Deutsch, aber der Code erlaubt trotzdem den
        // stabilen KNOWN_ERROR_CODE_KEYS-Treffer statt Text-Musterabgleich.
        return toFriendlyAuthErrorMessage(
          { message: bodyMessage, code: bodyCode },
          fallback,
        );
      }
    } catch {
      // Body nicht lesbar (kein/kaputtes JSON) → unten generisch zuordnen.
    }
  }

  return toFriendlyAuthErrorMessage(error, fallback);
}

// ── Auth-Link-Fehler (Passwort-Reset & Einladungs-Annahme) ──────────────────
// Supabase hängt bei ungültigen/abgelaufenen Links error/error_description
// als Query-/Hash-Parameter an die Redirect-URL an (z.B. "Email link is
// invalid or has expired") — dieser Text darf NIE direkt angezeigt werden.
// Die aufrufenden Screens (AcceptInviteScreen, ResetPasswordScreen) liefern
// je einen eigenen, übersetzten Text für "ungültig" bzw. "abgelaufen".
export function toFriendlyAuthLinkErrorMessage(
  errorCode: string | undefined,
  errorDescription: string | undefined,
  invalidMessage: string,
  expiredMessage: string,
): string {
  const looksExpired =
    /expired/i.test(errorCode ?? "") || /expired/i.test(errorDescription ?? "");
  return looksExpired ? expiredMessage : invalidMessage;
}
