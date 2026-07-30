// utils/authErrorMessages.ts
// Zentrale Übersetzung technischer Auth-/Edge-Function-/Netzwerk-Fehler in
// nutzerfreundliche, deutsche Meldungen — für alle Auth-Screens (Login,
// Registrierung, Firma einrichten, Passwort vergessen/ändern/zurücksetzen,
// Einladungs-Annahme, Mitarbeiter einladen/erneut einladen). Nutzer sollen
// nie rohe Supabase-/Netzwerk-/Edge-Function-Fehlertexte sehen (z.B. "Edge
// Function returned a non-2xx status code", "Failed to fetch", "Invalid
// JWT", "AuthApiError", "Unexpected error").

import { isNetworkError } from "@/utils/networkError";
import { FunctionsHttpError } from "@supabase/supabase-js";

export const GENERIC_AUTH_ERROR_MESSAGE =
  "Es ist ein unerwarteter Fehler aufgetreten.";
export const OFFLINE_ERROR_MESSAGE =
  "Keine Internetverbindung. Bitte überprüfe deine Verbindung und versuche es erneut.";
export const SERVER_UNAVAILABLE_ERROR_MESSAGE =
  "Der Server ist momentan nicht erreichbar. Bitte versuche es später erneut.";

// Bekannte technische GoTrue-/Supabase-Auth-Fehlertexte → deutsche
// Nutzer-Meldung. Reihenfolge relevant: spezifischere Muster zuerst.
const KNOWN_ERROR_PATTERNS: readonly {
  pattern: RegExp;
  message: string;
}[] = [
  {
    pattern: /invalid login credentials/i,
    message: "E-Mail oder Passwort ist falsch.",
  },
  {
    pattern: /email not confirmed/i,
    message: "Bitte bestätige zuerst deine E-Mail-Adresse.",
  },
  {
    pattern: /user already registered|already been registered/i,
    message:
      "Diese E-Mail wurde bereits eingeladen oder ist bereits registriert.",
  },
  {
    pattern:
      /invalid refresh token|refresh_token_not_found|invalid jwt|jwt expired|session.{0,15}(missing|not found)/i,
    message: "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.",
  },
  {
    pattern: /rate limit|too many requests/i,
    message: "Zu viele Versuche. Bitte warte kurz und versuche es erneut.",
  },
  {
    pattern: /password.{0,25}(should be at least|too short|weak)/i,
    message: "Das Passwort erfüllt nicht die Mindestanforderungen.",
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

// Übersetzt einen beliebigen Fehler (Supabase AuthError, geworfene Errors,
// rohe Strings) in eine nutzerfreundliche deutsche Meldung. `fallback`
// erlaubt jedem Aufrufer einen zum Kontext passenden Default (z.B. "E-Mail
// oder Passwort ist falsch." beim Login), falls kein bekanntes Muster greift.
export function toFriendlyAuthErrorMessage(
  err: unknown,
  fallback: string = GENERIC_AUTH_ERROR_MESSAGE,
): string {
  if (isNetworkError(err)) return OFFLINE_ERROR_MESSAGE;

  const message = extractMessage(err);
  if (!message) return fallback;

  if (
    /^5\d{2}\b|internal server error|service unavailable|bad gateway/i.test(
      message,
    )
  ) {
    return SERVER_UNAVAILABLE_ERROR_MESSAGE;
  }

  for (const { pattern, message: friendly } of KNOWN_ERROR_PATTERNS) {
    if (pattern.test(message)) return friendly;
  }

  if (RAW_TECHNICAL_PATTERN.test(message)) return fallback;

  // Meldungen, die der Server (RPC/Edge Function) bereits selbst
  // verständlich auf Deutsch formuliert (z.B. "Nur Admins dürfen Mitarbeiter
  // erstellen.", "Mitarbeiter nicht gefunden."), unverändert durchreichen
  // statt sie durch den Fallback zu ersetzen.
  return message;
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
  fallback: string = GENERIC_AUTH_ERROR_MESSAGE,
): Promise<string> {
  if (isNetworkError(error)) return OFFLINE_ERROR_MESSAGE;

  if (error instanceof FunctionsHttpError) {
    try {
      const body = await (error.context as Response).json();
      const bodyMessage = typeof body?.error === "string" ? body.error : "";
      if (bodyMessage) {
        return toFriendlyAuthErrorMessage(bodyMessage, fallback);
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
// je einen eigenen, bereits deutschen Text für "ungültig" bzw. "abgelaufen".
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
