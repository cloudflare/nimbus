/**
 * Load one content collection for the agent-surface index, turning a thrown
 * error into a caller-surfaced warning instead of a silent drop.
 *
 * Astro's `getCollection` does not throw for an unregistered/empty collection
 * (it warns and returns `[]`), so a throw here means a registered collection
 * genuinely failed. The error path is unit-testable with an injected
 * `getCollection`.
 */
export interface CollectionLoadOutcome<E> {
  /** Loaded entries, or `[]` when the load failed. */
  entries: E[];
  /** Set when a registered collection failed; caller surfaces via `runtimeWarn`. */
  warning?: string;
}

export async function loadCollectionOrWarn<E>(
  name: string,
  getCollection: (name: string) => Promise<E[]>,
): Promise<CollectionLoadOutcome<E>> {
  try {
    return { entries: await getCollection(name) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      entries: [],
      warning: `getIndexedEntries: collection "${name}" failed to load and was skipped — ${detail}`,
    };
  }
}
