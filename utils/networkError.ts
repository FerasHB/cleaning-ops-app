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
