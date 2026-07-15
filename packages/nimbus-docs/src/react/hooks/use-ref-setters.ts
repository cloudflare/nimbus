"use client";

import { useRef, type RefObject } from "react";

/**
 * Stable per-id ref callbacks for a refs map — the ergonomic half of the
 * "refs map + setter factory" pattern. Instead of N individual `useRef`s
 * and N inline `ref={(el) => …}` arrows (which churn refs every render),
 * keep one map and hand each element a cached callback:
 *
 * ```tsx
 * const nodeRefs = useRef<Partial<Record<NodeId, HTMLDivElement | null>>>({});
 * const setNode = useRefSetters(nodeRefs);
 *
 * <div ref={setNode("prompt")}>Prompt</div>
 * <div ref={setNode("model")}>Model</div>
 * ```
 *
 * Measurement stays caller-side (read `refs.current` inside a `useMeasure`
 * selector) — this hook owns only the ref plumbing.
 */
export function useRefSetters<K extends string, E extends Element = HTMLDivElement>(
  refs: RefObject<Partial<Record<K, E | null>>>,
) {
  const cache = useRef(new Map<K, (el: E | null) => void>());
  return (id: K) => {
    let cb = cache.current.get(id);
    if (!cb) {
      cb = (el) => {
        refs.current[id] = el;
      };
      cache.current.set(id, cb);
    }
    return cb;
  };
}
