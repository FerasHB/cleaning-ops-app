/** Keep one refresh in flight and replay one pass after overlapping invalidations. */
export function createCoalescedRefresh(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let requested = false;

  const refresh = (): Promise<void> => {
    requested = true;
    if (!inFlight) {
      inFlight = (async () => {
        let firstError: unknown;
        do {
          requested = false;
          try { await run(); }
          catch (error) { firstError ??= error; }
        } while (requested);
        if (firstError) throw firstError;
      })().finally(() => {
        inFlight = null;
        // Covers an invalidation in the microtask gap before this finalizer.
        if (requested) void refresh().catch(() => {});
      });
    }
    return inFlight;
  };

  return refresh;
}
