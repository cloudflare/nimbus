/**
 * Work that the requests one isolate serves share, such as a file several of
 * them need at once.
 *
 * A Workers request runs only on its own events. One that awaits a promise
 * another request settles, with nothing of its own pending, is cancelled as
 * hung; one that awaits a promise another request created resumes inside that
 * request, where its I/O fails or dies with it. So requests here share finished
 * values only. A request that finds the work claimed awaits a promise it made
 * itself, which the claim's release settles, beside a timer of its own that
 * keeps it alive and makes it look again.
 *
 * A cancelled request may never run its cleanup, so claims and waits expire
 * by the clock and any later request sweeps them.
 */
export function createRequestClaims(leaseMs: number) {
  // Each claim is its own object, so a release after the lease ran out frees nothing newer.
  const held = new Map<string, { at: number }>();
  const waits = new Set<{ key: string | undefined; wake: () => void; expires: number }>();
  function sweep() {
    const now = Date.now();
    for (const [key, claim] of held)
      if (now - claim.at > leaseMs) held.delete(key);
    // A live wait removes itself when its timer fires; one still here well
    // after that belongs to a request that was cancelled.
    for (const wait of waits) if (wait.expires < now) waits.delete(wait);
  }
  return {
    has(key: string): boolean {
      sweep();
      return held.has(key);
    },
    get size(): number {
      sweep();
      return held.size;
    },
    /** Requests waiting, for `key` or for any key. */
    waiting(key?: string): number {
      sweep();
      let count = 0;
      for (const wait of waits) if (key === undefined || wait.key === key) count++;
      return count;
    },
    /**
     * Claims `key`. `held()` says whether the claim is still this one: past
     * its lease another request may hold the key. `release()` frees it and
     * wakes every waiting request.
     */
    claim(key: string): { held(): boolean; release(): void } {
      const claim = { at: Date.now() };
      held.set(key, claim);
      return {
        held: () => {
          sweep();
          return held.get(key) === claim;
        },
        release: () => {
          if (held.get(key) === claim) held.delete(key);
          for (const wait of waits) {
            waits.delete(wait);
            wait.wake();
          }
        },
      };
    },
    /** Waits, counted against `key`, until the next release or `timeoutMs` at the latest. */
    async released(key?: string, timeoutMs = 1_000): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = { key, wake: () => {}, expires: Date.now() + 2 * timeoutMs };
      const woken = new Promise<void>((resolve) => (wait.wake = resolve));
      waits.add(wait);
      try {
        await Promise.race([
          woken,
          new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
        ]);
      } finally {
        clearTimeout(timer);
        waits.delete(wait);
      }
    },
  };
}
