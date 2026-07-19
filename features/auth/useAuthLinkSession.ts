// features/auth/useAuthLinkSession.ts
// Gemeinsame Logik für Deep-Links, die eine temporäre Supabase-Session
// herstellen (Passwort-Reset UND Einladungs-Annahme — beide liefern denselben
// Link-Aufbau, nur mit type=recovery bzw. type=invite):
//   • PKCE:     ...?code=...                      → exchangeCodeForSession(code)
//   • Implicit: ...#access_token=...&refresh_token=...&type=... → setSession(...)
// Die Parameter können aus zwei Quellen kommen (expo-router useLocalSearchParams
// UND der app-weite AuthLinkUrlProvider für Kaltstart-URL + Laufzeit-Events).
// Die Kaltstart-URL/Events kommen bewusst NICHT aus einem eigenen
// Linking.getInitialURL()/addEventListener() hier im Hook: expo-router
// registriert seinen eigenen "url"-Listener (für die Navigation selbst)
// bereits beim App-Start zusammen mit dem Root-<Stack>. Das "url"-Event wird
// nur an zu diesem Zeitpunkt bereits registrierte Listener zugestellt — ein
// Listener, der erst mit DIESEM Screen (als Folge ebenjener Navigation)
// gemountet wird, sieht das auslösende Event nie. Siehe
// features/auth/AuthLinkUrlProvider.tsx.
// attemptedRef sorgt dafür, dass derselbe Link nicht mehrfach eingelöst wird.
// Zustände: checking → ready, oder invalid bei ungültigem/abgelaufenem Link
// bzw. Timeout. "success" ist bewusst NICHT Teil dieses Hooks — das ist eine
// Folge dessen, was der jeweilige Screen mit der bereiten Session tut (z.B.
// Passwort setzen), nicht Teil der Link-Einlösung selbst.

import { useAuthLinkUrl } from "@/features/auth/AuthLinkUrlProvider";
import { supabase } from "@/lib/supabase";
import { toFriendlyAuthLinkErrorMessage } from "@/utils/authErrorMessages";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";

export type AuthLinkStatus = "checking" | "ready" | "invalid";

// Kein endloser Spinner: nach dieser Zeit ohne verwertbaren Parameter → invalid.
const RECHECK_TIMEOUT_MS = 10_000;

type RecoveryParams = {
  code?: string;
  accessToken?: string;
  refreshToken?: string;
  type?: string;
  errorCode?: string;
  errorDescription?: string;
};

// Nur in Entwicklung loggen — niemals vollständige Tokens/Codes ausgeben.
function devLog(...args: unknown[]) {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log("[AuthLink]", ...args);
  }
}

// Parst Query (?a=b) UND Hash (#a=b) einer Deep-Link-URL und merged beide.
// PKCE liefert den Code im Query, Implicit die Tokens im Hash-Fragment.
function parseUrlParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");

  const segments: string[] = [];
  if (queryIndex !== -1) {
    const end = hashIndex > queryIndex ? hashIndex : url.length;
    segments.push(url.substring(queryIndex + 1, end));
  }
  if (hashIndex !== -1) {
    segments.push(url.substring(hashIndex + 1));
  }

  for (const segment of segments) {
    for (const pair of segment.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.substring(0, eq);
      const rawValue = eq === -1 ? "" : pair.substring(eq + 1);
      if (!rawKey) continue;
      try {
        out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
      } catch {
        out[rawKey] = rawValue;
      }
    }
  }
  return out;
}

function toRecoveryParams(raw: Record<string, string>): RecoveryParams {
  return {
    code: raw.code || undefined,
    accessToken: raw.access_token || undefined,
    refreshToken: raw.refresh_token || undefined,
    type: raw.type || undefined,
    errorCode: raw.error_code || raw.error || undefined,
    errorDescription: raw.error_description || undefined,
  };
}

// Fasst eine URL für Logs zusammen, ohne Geheimwerte: nur Schema+Pfad und die
// vorhandenen Parameter-Schlüssel (Werte werden bewusst weggelassen).
function safeUrlSummary(url: string): string {
  const base = url.split(/[?#]/)[0];
  const keys = Object.keys(parseUrlParams(url));
  return `${base} [params: ${keys.length ? keys.join(", ") : "keine"}]`;
}

function firstString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export function useAuthLinkSession(
  defaultInvalidMessage: string,
  // Eigene Meldung für den Fall, dass Supabase den Link explizit als
  // abgelaufen kennzeichnet (error_code/error_description enthält
  // "expired") — fehlt sie, wird defaultInvalidMessage auch dafür verwendet.
  expiredMessage: string = defaultInvalidMessage,
): {
  status: AuthLinkStatus;
  invalidMessage: string;
  /** Nochmals die Kaltstart-URL auswerten (z.B. wenn der Deep-Link verzögert ankam). */
  recheck: () => void;
} {
  const [status, setStatus] = useState<AuthLinkStatus>("checking");
  const [invalidMessage, setInvalidMessage] = useState(defaultInvalidMessage);

  // Quelle B+C: Kaltstart-URL UND Laufzeit-Deep-Links — siehe Kommentar oben,
  // kommt bewusst aus dem app-weiten Provider statt aus einem eigenen
  // Linking-Listener hier im Hook.
  const authLinkUrl = useAuthLinkUrl();

  const params = useLocalSearchParams<{
    code?: string;
    access_token?: string;
    refresh_token?: string;
    type?: string;
    error?: string;
    error_code?: string;
    error_description?: string;
  }>();

  const mountedRef = useRef(true);
  // Sobald ein verwertbarer Link (Code/Token/Fehler) eingelöst wird → true.
  // Verhindert doppelte Verarbeitung, wenn mehrere Quellen dieselbe URL liefern.
  const attemptedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Spiegelt den aktuellen Status synchron — der Watchdog-Timeout darf NICHT
  // von attemptedRef abhängen: Hinge exchangeCodeForSession trotz allem (z.B.
  // erneuter Auth-Deadlock), bliebe attemptedRef zwar true, der Kontrollfluss
  // erreichte aber nie einen Endzustand. Der Watchdog prüft daher unabhängig,
  // ob der Screen noch bei "checking" steht.
  const statusRef = useRef<AuthLinkStatus>("checking");

  const finish = useCallback((next: AuthLinkStatus, message?: string) => {
    if (!mountedRef.current) return;
    statusRef.current = next;
    devLog("Statuswechsel:", next);
    if (message) setInvalidMessage(message);
    setStatus(next);
  }, []);

  // Nach einem Fehler beim Code-/Token-Tausch trotzdem prüfen, ob bereits eine
  // gültige Session existiert — z.B. wenn detectSessionInUrl (Web) den Code
  // schon eingelöst hat. Nur dann ready, sonst invalid.
  const readySessionOrInvalid = useCallback(
    async (message?: string) => {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        finish("ready");
        return;
      }
      finish("invalid", message ?? defaultInvalidMessage);
    },
    [finish, defaultInvalidMessage],
  );

  const processParams = useCallback(
    async (recovery: RecoveryParams, source: string) => {
      const hasError = !!(recovery.errorCode || recovery.errorDescription);
      const hasCode = !!recovery.code;
      const hasTokens = !!(recovery.accessToken && recovery.refreshToken);

      // Diese Quelle enthält nichts Verwertbares → anderen Quellen die Chance
      // lassen (attemptedRef NICHT setzen).
      if (!hasError && !hasCode && !hasTokens) return;

      // Nur den ersten Treffer einlösen (Code ist ohnehin einmalig gültig).
      if (attemptedRef.current) return;
      attemptedRef.current = true;

      if (hasError) {
        devLog(
          `Fehler im Link (Quelle: ${source}):`,
          recovery.errorCode ?? "?",
          recovery.errorDescription ?? "",
        );
        // Supabase liefert error/error_description als englischen,
        // technischen Text (z.B. "Email link is invalid or has expired") —
        // NIE direkt anzeigen, sondern nur zur Unterscheidung
        // ungültig/abgelaufen verwenden (siehe toFriendlyAuthLinkErrorMessage).
        finish(
          "invalid",
          toFriendlyAuthLinkErrorMessage(
            recovery.errorCode,
            recovery.errorDescription?.replace(/\+/g, " "),
            defaultInvalidMessage,
            expiredMessage,
          ),
        );
        return;
      }

      try {
        if (hasCode) {
          devLog(`Erkannter Flow: pkce (Quelle: ${source})`);
          devLog("exchangeCodeForSession gestartet");
          const { data, error } = await supabase.auth.exchangeCodeForSession(
            recovery.code!,
          );
          devLog(
            "exchangeCodeForSession beendet",
            error ? `Fehler: ${error.message}` : "erfolgreich",
          );
          if (error || !data.session) {
            await readySessionOrInvalid();
            return;
          }
          devLog("PKCE-Session hergestellt.");
          finish("ready");
          return;
        }

        // Implicit: Tokens direkt aus Hash/Query.
        devLog(`Erkannter Flow: implicit (Quelle: ${source})`);
        const { data, error } = await supabase.auth.setSession({
          access_token: recovery.accessToken!,
          refresh_token: recovery.refreshToken!,
        });
        if (error || !data.session) {
          devLog("setSession Fehler:", error?.message ?? "keine Session");
          await readySessionOrInvalid();
          return;
        }
        devLog("Implicit-Session hergestellt.");
        finish("ready");
      } catch (err) {
        devLog(
          "Unerwarteter Fehler bei Recovery:",
          err instanceof Error ? err.message : String(err),
        );
        finish("invalid", defaultInvalidMessage);
      }
    },
    [finish, readySessionOrInvalid, defaultInvalidMessage, expiredMessage],
  );

  // Unabhängiger Watchdog: steht der Screen nach RECHECK_TIMEOUT_MS immer noch
  // bei "checking" (egal ob ein Tausch läuft, hängt oder nie etwas ankam) →
  // klarer Fehlerzustand statt Endlos-Spinner.
  const armTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (statusRef.current === "checking") {
        devLog("Watchdog-Timeout: noch bei 'checking' → invalid.");
        finish("invalid", defaultInvalidMessage);
      }
    }, RECHECK_TIMEOUT_MS);
  }, [finish, defaultInvalidMessage]);

  // ── Quelle A: expo-router Query-Parameter (deckt PKCE ?code= ab) ──
  useEffect(() => {
    const routerParams = toRecoveryParams({
      code: firstString(params.code),
      access_token: firstString(params.access_token),
      refresh_token: firstString(params.refresh_token),
      type: firstString(params.type),
      error: firstString(params.error),
      error_code: firstString(params.error_code),
      error_description: firstString(params.error_description),
    });
    void processParams(routerParams, "router-params");
  }, [
    params.code,
    params.access_token,
    params.refresh_token,
    params.error,
    params.error_code,
    params.error_description,
    params.type,
    processParams,
  ]);

  // ── Quelle B+C: URLs aus dem app-weiten AuthLinkUrlProvider (Kaltstart-URL
  // UND Laufzeit-Events, siehe Kommentar oben) — reagiert per Dependency auf
  // authLinkUrl.version, damit auch eine wiederholte identische URL (erneuter
  // Link-Tap) zuverlässig eine neue Verarbeitung auslöst.
  useEffect(() => {
    if (!authLinkUrl.url) return;
    devLog(
      authLinkUrl.source === "initial" ? "Initiale URL:" : "Deep-Link Event:",
      safeUrlSummary(authLinkUrl.url),
    );
    void processParams(
      toRecoveryParams(parseUrlParams(authLinkUrl.url)),
      authLinkUrl.source === "initial" ? "getInitialURL" : "url-event",
    );
  }, [authLinkUrl.url, authLinkUrl.version, authLinkUrl.source, processParams]);

  // ── Mount-Lifecycle + Watchdog-Timeout ──
  useEffect(() => {
    mountedRef.current = true;
    armTimeout();

    return () => {
      mountedRef.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [armTimeout]);

  const recheck = useCallback(() => {
    attemptedRef.current = false;
    statusRef.current = "checking";
    setStatus("checking");
    if (authLinkUrl.url) {
      void processParams(
        toRecoveryParams(parseUrlParams(authLinkUrl.url)),
        "recheck",
      );
    }
    armTimeout();
  }, [processParams, armTimeout, authLinkUrl.url]);

  return { status, invalidMessage, recheck };
}
