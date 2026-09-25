/**
 * Serialize a refresh and coalesce requests made while it runs: at most one
 * run is in flight, and any request that arrives during a run schedules
 * exactly one more run after it. A request is never dropped, and never
 * satisfied by a run that started before it.
 *
 * The returned function resolves when no request is pending. Errors from a
 * run go to `onError` and don't stop later runs.
 */
export function coalesce(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let pending = false;
  let draining: Promise<void> | null = null;

  const drain = async () => {
    try {
      while (pending) {
        pending = false;
        try {
          await run();
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      draining = null;
    }
  };

  return () => {
    pending = true;
    draining ??= drain();
    return draining;
  };
}
