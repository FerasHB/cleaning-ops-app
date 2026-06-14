// utils/networkError.ts
// Erkennt erwartete Offline-/Netzwerkfehler (z. B. wenn NetInfo noch "connected"
// meldet, der fetch aber bereits scheitert, oder Supabase-Auth einen
// AuthRetryableFetchError wirft). Solche Fehler sind kein harter App-Fehler,
// sondern ein normaler Zustand → kein console.error / kein Redbox.

// Supabase/fetch melden Netzwerkprobleme u. a. als:
//  - "TypeError: Network request failed"  (React Native fetch)
//  - "Failed to fetch"                    (Web fetch)
//  - "AuthRetryableFetchError: Network request failed" (gotrue-js Auth)
//  - generische "Network error"
const NETWORK_ERROR_PATTERN =
  /network request failed|failed to fetch|network error|authretryablefetcherror/i;

export function isNetworkError(err: unknown): boolean {
  if (!err) return false;

  // gotrue-js wirft AuthRetryableFetchError — am Namen erkennbar,
  // auch wenn die Message nur "Network request failed" enthält.
  const name =
    typeof (err as { name?: unknown })?.name === "string"
      ? (err as { name: string }).name
      : "";
  if (/AuthRetryableFetchError/i.test(name)) return true;

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : typeof (err as { message?: unknown })?.message === "string"
          ? (err as { message: string }).message
          : "";

  return NETWORK_ERROR_PATTERN.test(message);
}

let guardInstalled = false;

// Globaler Schutz gegen rote Dev-Error-Overlays/Toasts für ERWARTETE
// Netzwerkfehler. Manche Netzwerkfehler entstehen in Hintergrund-Tasks, die wir
// nicht an jeder Aufrufstelle abfangen können (z. B. Supabase-Auth-Token-Auto-
// Refresh oder unbehandelte Offline-Rejections). Solche Fälle laufen in
// React Native über console.error/console.warn und erzeugen Redbox + Toast.
// Dieser Guard stuft NUR Netzwerkfehler herab — alle anderen Fehler bleiben
// unverändert sichtbar. Nur im Development aktiv, idempotent.
export function installNetworkErrorGuard(): void {
  if (guardInstalled || !__DEV__) return;
  guardInstalled = true;

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    if (args.some((arg) => isNetworkError(arg))) {
      // Nicht als Fehler, sondern leise als Warnung — kein Redbox.
      originalWarn("Netzwerkfehler (offline) unterdrückt:", ...args);
      return;
    }
    originalError(...args);
  };

  console.warn = (...args: unknown[]) => {
    if (args.some((arg) => isNetworkError(arg))) {
      // Erwartete Offline-Warnung still verwerfen — kein Toast.
      return;
    }
    originalWarn(...args);
  };
}
