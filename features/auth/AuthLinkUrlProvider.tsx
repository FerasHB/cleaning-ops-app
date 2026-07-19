// features/auth/AuthLinkUrlProvider.tsx
// Fängt Deep-Link-URLs für Auth-Flows (Passwort-Reset, Einladungs-Annahme) für
// die GESAMTE App-Lebensdauer ab — nicht erst beim Mount von ResetPasswordScreen/
// AcceptInviteScreen. Grund: expo-router registriert seinen eigenen
// Linking-"url"-Listener (für die Navigation selbst) bereits beim App-Start
// zusammen mit dem Root-<Stack>. Das "url"-Event ist ein Single-Fire-Event an
// ALLE zum Zeitpunkt des Auftretens bereits registrierten Listener — kein
// Replay für später hinzukommende. Der Screen, der erst ALS FOLGE dieser
// Navigation gemountet wird, registriert seinen eigenen Listener (in
// useAuthLinkSession) zwangsläufig zu spät und sieht das auslösende Event nie
// — weder das "url"-Event noch (bei bereits laufendem Prozess) verlässlich
// getInitialURL(). Dieser Provider lebt in app/_layout.tsx oberhalb des
// <Stack> und liefert die zuletzt empfangene Auth-Link-URL über Context,
// unabhängig davon, wann der Ziel-Screen mountet.

import * as Linking from "expo-linking";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type AuthLinkUrlState = {
  url: string | null;
  // Monoton steigende Versionsnummer statt nur url — erlaubt Consumern, per
  // useEffect-Dependency zuverlässig auf eine NEUE URL zu reagieren, auch
  // falls zufällig zweimal dieselbe URL ankommt (z.B. erneuter Link-Tap).
  version: number;
  source: "initial" | "event" | null;
};

const INITIAL_STATE: AuthLinkUrlState = { url: null, version: 0, source: null };

const AuthLinkUrlContext = createContext<AuthLinkUrlState | undefined>(
  undefined,
);

export function AuthLinkUrlProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = useState<AuthLinkUrlState>(INITIAL_STATE);
  const versionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    // Kaltstart-URL so früh wie möglich lesen — oberhalb von <Stack>/
    // expo-router, bevor dessen eigene Linking-Auflösung läuft.
    Linking.getInitialURL()
      .then((url) => {
        if (cancelled || !url) return;
        versionRef.current += 1;
        setState({ url, version: versionRef.current, source: "initial" });
      })
      .catch(() => {
        // Ignorieren — betroffene Screens haben ihren eigenen Watchdog-Timeout.
      });

    // Laufzeit-Events: EINMALIG für die gesamte App-Lebensdauer abonniert,
    // nicht an den Mount eines Ziel-Screens gebunden.
    const subscription = Linking.addEventListener("url", ({ url }) => {
      versionRef.current += 1;
      setState({ url, version: versionRef.current, source: "event" });
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return (
    <AuthLinkUrlContext.Provider value={state}>
      {children}
    </AuthLinkUrlContext.Provider>
  );
}

export function useAuthLinkUrl(): AuthLinkUrlState {
  const context = useContext(AuthLinkUrlContext);
  if (!context) {
    throw new Error(
      "useAuthLinkUrl must be used within an AuthLinkUrlProvider",
    );
  }
  return context;
}
