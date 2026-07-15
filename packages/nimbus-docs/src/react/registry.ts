/**
 * Page-scoped Diagram registry.
 *
 * Module-level singleton — shared across Astro islands because Vite
 * de-duplicates module imports per page (both in dev HMR and in prod
 * via shared chunks). React Context cannot bridge separate islands;
 * a plain singleton can.
 *
 * Subscribed via useSyncExternalStore from <DiagramPauseAll>.
 */

interface RegistryEntry {
  id: string;
  /** Set the user-paused flag directly (idempotent). */
  setPaused: (paused: boolean) => void;
  /** Read the current user-paused flag at call time. */
  userPaused: () => boolean;
}

class DiagramRegistry {
  private entries = new Map<string, RegistryEntry>();
  private listeners = new Set<() => void>();
  /** Bumped on every membership change — useSyncExternalStore snapshot key. */
  private version = 0;

  register(entry: RegistryEntry): () => void {
    this.entries.set(entry.id, entry);
    this.version++;
    this.notify();
    return () => {
      this.entries.delete(entry.id);
      this.version++;
      this.notify();
    };
  }

  /**
   * Pause everything when at least one diagram is unpaused; resume
   * everything otherwise. A single shared target avoids inverting mixed
   * states (which would resume diagrams a reader had paused).
   */
  toggleAll(): void {
    const anyUnpaused = [...this.entries.values()].some((e) => !e.userPaused());
    for (const entry of this.entries.values()) {
      entry.setPaused(anyUnpaused);
    }
  }

  // Arrow fields so these stay bound when passed to useSyncExternalStore.
  count = (): number => this.entries.size;

  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const diagramRegistry = new DiagramRegistry();
