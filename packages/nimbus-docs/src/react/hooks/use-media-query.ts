"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Reactive `window.matchMedia` subscription, SSR-safe.
 *
 * The server snapshot returns `defaultValue` (default `false`), so static
 * builds render the no-match branch and hydrate without mismatch warnings;
 * the first client render corrects it if the query matches.
 *
 * ```ts
 * const isMobile = useMediaQuery("(max-width: 640px)");
 * ```
 */
export function useMediaQuery(query: string, defaultValue = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => defaultValue,
  );
}
