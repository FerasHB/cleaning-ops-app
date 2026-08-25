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

import { useAuth } from "@/context/AuthContext";
import { useAuthLinkUrl } from "@/features/auth/AuthLinkUrlProvider";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AUTH_DIAGNOSTICS_ENABLED } from "@/utils/authDiagnostics";
import { addDiagnosticEvent } from "@/utils/authDiagnosticsBuffer";
import { supabase } from "@/lib/supabase";
import { toFriendlyAuthLinkErrorMessage } from "@/utils/authErrorMessages";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

export type AuthLinkStatus = "checking" | "ready" | "invalid";

// Kein endloser Spinner: nach dieser Zeit ohne verwertbaren Parameter → invalid.
const RECHECK_TIMEOUT_MS = 10_000;

// Obergrenze, solange eine Einlösung NACHWEISLICH noch läuft. Ein langsamer
// (aber gültiger) Code-Tausch darf nicht als „ungültiger Link" enden — genau
// das erzeugte den P0-Fehler: Watchdog feuert nach 10 s → Nutzer tippt
// „Link erneut prüfen" → der PKCE-code_verifier ist zu diesem Zeitpunkt aber
// schon verbraucht (auth-js löscht ihn in JEDEM Ausgang von
// exchangeCodeForSession) → der zweite Versuch scheitert zwangsläufig.
// Trotzdem bleibt die Grenze ENDLICH: hängt der Tausch wirklich, greift diese
// Schranke und der Screen erreicht einen klaren Endzustand.
const REDEMPTION_TIMEOUT_MS = 30_000;


type RecoveryParams = {
  code?: string;
  accessToken?: string;
  refreshToken?: string;
  type?: string;
  errorCode?: string;
  errorDescription?: string;
};

// Nur bei aktivierter Diagnose loggen (siehe utils/authDiagnostics.ts) —
// niemals vollständige Tokens/Codes ausgeben.
function devLog(...args: unknown[]) {
  if (AUTH_DIAGNOSTICS_ENABLED) {
    // eslint-disable-next-line no-console
    console.log("[AuthLink]", ...args);
    addDiagnosticEvent("[AuthLink]", ...args);
  }
}

// ── Diagnose für den intermittierenden nativen PKCE-Fehler ──────────────
// TEMPORÄR, vor dem Merge entfernen (siehe utils/authDiagnostics.ts). Alle
// Werte sind Zähler, Zustandsnamen oder YES/NO — es wird NIE ein Code,
// Verifier, Token oder eine vollständige URL ausgegeben.

// Fortlaufende Nummer je Hook-Instanz: macht Remounts unmittelbar sichtbar
// (jede neue Instanz startet mit frischem attemptedRef und darf denselben
// Link erneut verarbeiten — genau der Verdachtsfall).
let hookInstanceCounter = 0;
// Zählt Aufrufe von processParams über ALLE Instanzen hinweg.
let processParamsCounter = 0;

// Storage-Schlüssel, unter dem auth-js den PKCE-code_verifier ablegt.
// auth-js nutzt genau EINEN Schlüssel pro Projekt (kein Flow-Namespacing).
const CODE_VERIFIER_STORAGE_KEY = (() => {
  try {
    const host = new URL(process.env.EXPO_PUBLIC_SUPABASE_URL ?? "").hostname;
    const projectRef = host.split(".")[0];
    return projectRef ? `sb-${projectRef}-auth-token-code-verifier` : null;
  } catch {
    return null;
  }
})();

// NUR Vorhandensein prüfen — der Wert wird gelesen, aber niemals geloggt,
// weitergereicht oder gespeichert.
async function codeVerifierPresence(): Promise<"YES" | "NO" | "UNBEKANNT"> {
  if (!AUTH_DIAGNOSTICS_ENABLED || !CODE_VERIFIER_STORAGE_KEY) return "UNBEKANNT";
  try {
    const raw = await AsyncStorage.getItem(CODE_VERIFIER_STORAGE_KEY);
    return raw ? "YES" : "NO";
  } catch {
    return "UNBEKANNT";
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
  // SICHERHEITSGRENZE: Nur der Passwort-Reset erzeugt eine Session, die die
  // App NICHT betreten darf. Die Einladungs-Annahme führt bewusst regulär in
  // die App (dort steuert profiles.invite_accepted_at den Zugang, siehe
  // app/index.tsx) und wird deshalb NICHT als Recovery markiert.
  flow: "recovery" | "invite" = "invite",
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
  const { isRecoverySession, beginRecoverySession, endRecoverySession } =
    useAuth();

  const params = useLocalSearchParams<{
    restored?: string;
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
  // true, solange ein Code-/Token-Tausch tatsächlich gegen Supabase läuft.
  // Unterscheidet die zwei Gründe, warum der Screen noch bei "checking" steht:
  // „es kam nie etwas an" (kurzer Timeout ist richtig) vs. „die Einlösung
  // läuft noch" (abwarten, sonst verwerfen wir einen gültigen Link).
  const redeemingRef = useRef(false);
  // Verhindert, dass die verlängerte Frist beliebig oft neu gesetzt wird.
  const redemptionDeadlineRef = useRef<number | null>(null);
  // Diagnose: eindeutige Nummer dieser Hook-Instanz. Steigt sie bei EINEM
  // Recovery-Vorgang um mehr als 1, gab es einen Remount.
  const instanceIdRef = useRef<number | null>(null);
  if (instanceIdRef.current === null) {
    instanceIdRef.current = ++hookInstanceCounter;
  }
  const instanceId = instanceIdRef.current;

  const finish = useCallback((next: AuthLinkStatus, message?: string) => {
    if (!mountedRef.current) return;
    statusRef.current = next;
    devLog("Statuswechsel:", next);
    if (message) setInvalidMessage(message);
    setStatus(next);
  }, []);

  // Nach einem Fehler beim Code-/Token-Tausch trotzdem prüfen, ob bereits eine
  // gültige Session existiert — das deckt GENAU EINEN legitimen Fall ab: auf
  // Web löst detectSessionInUrl (lib/supabase.ts setzt es nur dort auf true)
  // den Code bereits ein, bevor dieser Hook läuft; unser Tausch scheitert dann
  // mit „code already used", obwohl die Session korrekt steht.
  //
  // AUF NATIVE IST DIESER RÜCKFALL FALSCH UND WAR DIE URSACHE DES P0-FEHLERS:
  // dort gibt es kein detectSessionInUrl, also kann eine hier gefundene Session
  // NICHT aus diesem Link stammen. Sie ist eine ALTE, sachfremde Session (z.B.
  // ein noch im AsyncStorage liegender Rest-Login). Wurde sie als „ready"
  // gewertet, zeigte der Screen das Passwort-Formular OHNE Recovery-Session —
  // updateUser() lief anschließend gegen diese Fremd-Session und das Passwort
  // des eigentlichen Recovery-Links wurde nie geändert (Reset „erfolgreich",
  // Login mit neuem Passwort schlug fehl). Auf Native gilt deshalb: gescheiterte
  // Einlösung = ungültiger Link, ohne Ausnahme.
  const readySessionOrInvalid = useCallback(
    async (message?: string) => {
      // SICHERHEITSGRENZE: Gescheiterte Einlösung → Marker wieder abräumen.
      // Sonst bliebe die App nach einem ungültigen Link dauerhaft im
      // Recovery-Modus gefangen (keine Session, aber Marker gesetzt).
      if (flow === "recovery") {
        await endRecoverySession();
      }
      if (Platform.OS === "web") {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          devLog("Web-Rückfall: Session bereits durch detectSessionInUrl gesetzt.");
          finish("ready");
          return;
        }
      }
      finish("invalid", message ?? defaultInvalidMessage);
    },
    [finish, defaultInvalidMessage, flow, endRecoverySession],
  );

  const processParams = useCallback(
    async (recovery: RecoveryParams, source: string) => {
      const hasError = !!(recovery.errorCode || recovery.errorDescription);
      const hasCode = !!recovery.code;
      const hasTokens = !!(recovery.accessToken && recovery.refreshToken);

      const callNo = ++processParamsCounter;
      devLog(
        `processParams #${callNo} (Instanz ${instanceId}) Quelle=${source}`,
        `error=${hasError} code=${hasCode} tokens=${hasTokens}`,
        `bereitsEingelöst=${attemptedRef.current}`,
      );

      // Diese Quelle enthält nichts Verwertbares → anderen Quellen die Chance
      // lassen (attemptedRef NICHT setzen).
      if (!hasError && !hasCode && !hasTokens) {
        devLog(`processParams #${callNo}: nichts Verwertbares → übersprungen.`);
        return;
      }

      // Nur den ersten Treffer einlösen (Code ist ohnehin einmalig gültig).
      if (attemptedRef.current) {
        devLog(
          `processParams #${callNo}: DOPPELVERARBEITUNG durch Guard verhindert.`,
        );
        return;
      }
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
        // SICHERHEITSGRENZE: auch hier einen evtl. noch persistierten Marker
        // aus einem früheren Versuch abräumen — ein ungültiger Link darf die
        // App nicht im Recovery-Modus festhalten.
        if (flow === "recovery") {
          await endRecoverySession();
        }
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

      // Ab hier läuft eine echte Einlösung — der Watchdog darf sie nicht
      // vorzeitig als „ungültig" abbrechen (siehe REDEMPTION_TIMEOUT_MS).
      redeemingRef.current = true;
      redemptionDeadlineRef.current = Date.now() + REDEMPTION_TIMEOUT_MS;

      try {
        // SICHERHEITSGRENZE (FAIL CLOSED): Der Recovery-Marker wird gesetzt
        // und seine Persistenz BESTÄTIGT, BEVOR der Tausch überhaupt startet.
        // Entsteht die Session, ist sie damit vom ersten Moment an als reine
        // Reset-Sitzung gekennzeichnet — es gibt kein Fenster, in dem sie als
        // normale Session gelten könnte (auch nicht bei einem Absturz/
        // Force-Close mitten im Tausch). Schlägt die Persistenz fehl, wird
        // der Tausch NICHT ausgeführt — es entsteht dann gar keine Session,
        // die fälschlich als normal gelten könnte. Läuft bewusst INNERHALB
        // des try/finally: das bestehende finally setzt redeemingRef/
        // redemptionDeadlineRef zuverlässig zurück, ohne diese Aufräumarbeit
        // hier zu duplizieren.
        if (flow === "recovery") {
          const recoveryModeConfirmed = await beginRecoverySession();
          if (!recoveryModeConfirmed) {
            devLog(
              "[AuthMode] Recovery-Marker konnte nicht persistiert werden — Tausch abgebrochen (fail-closed).",
            );
            finish("invalid", defaultInvalidMessage);
            return;
          }
        }

        if (hasCode) {
          devLog(`Erkannter Flow: pkce (Quelle: ${source})`);

          // Diagnose: Session-Lage UND Verifier-Vorhandensein unmittelbar VOR
          // dem Tausch. Fehlt der Verifier hier bereits, scheitert auth-js
          // rein lokal (AuthPKCECodeVerifierMissingError, kein Serveraufruf).
          const { data: preSession } = await supabase.auth.getSession();
          const preUserId = preSession.session?.user?.id ?? null;
          devLog(
            `VOR Tausch: code_verifier vorhanden=${await codeVerifierPresence()}`,
            `| Session vorhanden=${preUserId ? "YES" : "NO"}`,
          );

          devLog("exchangeCodeForSession gestartet");
          const { data, error } = await supabase.auth.exchangeCodeForSession(
            recovery.code!,
          );
          devLog(
            "exchangeCodeForSession beendet:",
            error
              ? `FEHLER Typ=${error.name} status=${error.status ?? "-"} msg=${error.message}`
              : "erfolgreich",
          );
          devLog(
            `NACH Tausch: code_verifier vorhanden=${await codeVerifierPresence()}`,
            `| Session entstanden=${data?.session ? "YES" : "NO"}`,
          );

          if (error || !data.session) {
            await readySessionOrInvalid();
            return;
          }

          // Wechselt die Session auf einen ANDEREN Nutzer als eine zuvor
          // vorhandene? Nur MATCH/NO MATCH — keine IDs im Log.
          const newUserId = data.session.user?.id ?? null;
          devLog(
            "Recovery-User vs. vorherige Session:",
            preUserId === null
              ? "keine vorherige Session"
              : preUserId === newUserId
                ? "MATCH"
                : "NO MATCH",
          );
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
      } finally {
        // Einlösung beendet (egal mit welchem Ausgang) — ab jetzt greift wieder
        // die normale, kurze Watchdog-Frist.
        redeemingRef.current = false;
        redemptionDeadlineRef.current = null;
      }
    },
    [
      finish,
      readySessionOrInvalid,
      defaultInvalidMessage,
      expiredMessage,
      flow,
      beginRecoverySession,
      endRecoverySession,
      instanceId,
    ],
  );

  // Watchdog: steht der Screen nach RECHECK_TIMEOUT_MS immer noch bei
  // "checking", gibt es zwei GRUNDVERSCHIEDENE Ursachen — und nur eine davon
  // ist ein Fehler:
  //   1. Es kam nie ein verwertbarer Parameter an → wirklich ungültig.
  //   2. Eine Einlösung läuft noch (langsamer Kaltstart, Auth-Lock, schlechtes
  //      Netz) → der Link ist gültig, wir sind nur noch nicht fertig. Ihn hier
  //      als „ungültig" zu markieren war der Auslöser des P0-Fehlers, weil der
  //      Nutzer daraufhin „Link erneut prüfen"/„Neuen Link anfordern" tippte,
  //      der PKCE-code_verifier aber bereits verbraucht war.
  // Deshalb wird im Fall 2 bis REDEMPTION_TIMEOUT_MS nachgefasst — endlich,
  // nicht unbegrenzt: nach Ablauf der Frist wird auch eine hängende Einlösung
  // sauber als ungültig beendet (kein Endlos-Spinner).
  const armTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (statusRef.current !== "checking") return;

      const deadline = redemptionDeadlineRef.current;
      if (redeemingRef.current && deadline !== null) {
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          devLog(
            `Watchdog unterdrückt: Einlösung läuft noch (${Math.ceil(remaining / 1000)}s Restfrist).`,
          );
          // GENAU EINE Verlängerung bis zur harten Frist — danach ist Schluss.
          // Endet die Einlösung vorher, steht statusRef nicht mehr auf
          // "checking" und dieser Timer wird zum No-op.
          timeoutRef.current = setTimeout(() => {
            if (statusRef.current !== "checking") return;
            devLog("Watchdog: Höchstdauer der Einlösung erreicht → invalid.");
            finish("invalid", defaultInvalidMessage);
          }, remaining);
          return;
        }
        devLog("Watchdog: Einlösung überschreitet Höchstdauer → invalid.");
      } else {
        devLog("Watchdog-Timeout: noch bei 'checking', keine Einlösung → invalid.");
      }

      finish("invalid", defaultInvalidMessage);
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

  // ── Wiederhergestellte Recovery-Session (Kaltstart) ─────────────────────
  // Nach einem Force-Close mitten im Reset-Flow bringt der Route-Guard den
  // Nutzer zurück auf /reset-password — aber OHNE Deep-Link, also ohne
  // `code`. Der Hook fand dann "nichts Verwertbares", blieb auf "checking"
  // und lief nach 10 s in den Watchdog: fälschlich „Link ungültig", obwohl
  // Marker UND gültige Recovery-Session vorliegen und der Code längst
  // eingelöst ist.
  //
  // Dieser Pfad akzeptiert eine solche Session als bereits eingelöst — ohne
  // erneutes exchangeCodeForSession(), ohne Code-Parameter.
  //
  // ENG BEGRENZT, damit daraus keine Wiederkehr der früheren
  // „Fremd-Session gilt als gültiger Link"-Lücke wird:
  //   • nur flow === "recovery",
  //   • nur wenn die APP SELBST den Recovery-Modus kennt (isRecoverySession
  //     aus dem persistierten, fail-closed gesetzten Marker) — eine beliebige
  //     normale Supabase-Session erfüllt das nie,
  //   • nur wenn KEINE Einlösung lief oder läuft (attemptedRef),
  //   • und nur bei `restored=1` — dem DETERMINISTISCHEN Signal aus
  //     app/index.tsx. Genau diese eine Stelle setzt es; ein echter
  //     Recovery-Link von Supabase trägt es nie, weil dessen Redirect-Ziel
  //     exakt `taskopsmanager://reset-password` ohne Query ist (uri_allow_list).
  //     Damit gibt es keinen Zeitwettlauf mehr zwischen Restore und frischem
  //     Link: ein frischer Link kommt schlicht ohne dieses Signal an und
  //     löst immer seinen eigenen Code ein.
  const isRestoredEntry = firstString(params.restored) === "1";

  useEffect(() => {
    if (flow !== "recovery" || !isRecoverySession || !isRestoredEntry) return;

    let cancelled = false;
    void (async () => {
      if (cancelled || !mountedRef.current) return;
      if (attemptedRef.current || statusRef.current !== "checking") return;

      const { data } = await supabase.auth.getSession();
      if (cancelled || !mountedRef.current) return;
      if (attemptedRef.current || statusRef.current !== "checking") return;

      if (data.session) {
        attemptedRef.current = true;
        devLog("[AuthMode] restored recovery session accepted for reset form");
        finish("ready");
        return;
      }

      // Marker gesetzt, aber keine Session mehr: sicher scheitern und den
      // Modus aufheben, damit der Nutzer nicht im Reset-Flow feststeckt.
      devLog("[AuthMode] restored recovery session missing/invalid");
      attemptedRef.current = true;
      await endRecoverySession();
      finish("invalid", defaultInvalidMessage);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    flow,
    isRecoverySession,
    isRestoredEntry,
    finish,
    defaultInvalidMessage,
    endRecoverySession,
  ]);

  // ── Mount-Lifecycle + Watchdog-Timeout ──
  useEffect(() => {
    mountedRef.current = true;
    devLog(
      `HOOK MOUNT — Instanz ${instanceId} (Instanzen bisher: ${hookInstanceCounter}).`,
      instanceId > 1 ? "ACHTUNG: REMOUNT während desselben Vorgangs?" : "",
    );
    armTimeout();

    return () => {
      devLog(`HOOK UNMOUNT — Instanz ${instanceId}.`);
      mountedRef.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [armTimeout, instanceId]);

  // Hinweis zu "Link erneut prüfen": ein bereits eingelöster PKCE-Code lässt
  // sich NICHT ein zweites Mal tauschen — auth-js löscht den code_verifier in
  // jedem Ausgang von exchangeCodeForSession. Der erneute Versuch endet daher
  // korrekt bei "invalid" (statt wie früher über eine sachfremde Session als
  // "ready" durchzurutschen). Sinnvoll bleibt recheck für den Fall, dass die
  // Deep-Link-URL verspätet eintrifft.
  const recheck = useCallback(() => {
    attemptedRef.current = false;
    redeemingRef.current = false;
    redemptionDeadlineRef.current = null;
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
