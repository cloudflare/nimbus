"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface UseMeasureOptions {
  /**
   * Additional dependencies that should re-trigger measurement when they
   * change. Use when component state changes the layout in a way the
   * container's ResizeObserver might miss — e.g. an animated CSS `gap`
   * that grows the container only as the transition progresses, or a
   * state-driven layout swap that doesn't change the container's size.
   */
  deps?: unknown[];
}

/**
 * DOM rect + optional selector callback. The selector receives the
 * observed element and its rect, and returns whatever derived geometry
 * the author needs (NodeRect, EdgeData, etc.).
 *
 * For multi-element measurements (e.g. measuring a container plus 5
 * child nodes), pass the container ref and read the other refs from
 * closure inside the selector. The selector recomputes when the
 * container resizes — which it typically does when children grow
 * because the container's intrinsic size is content-derived. For
 * state-driven re-layouts that the ResizeObserver might miss, pass
 * `options.deps`.
 */
export function useMeasure<T extends HTMLElement | SVGElement, R = DOMRectReadOnly>(
  ref: RefObject<T | null>,
  selector?: (el: T, rect: DOMRectReadOnly) => R,
  options: UseMeasureOptions = {},
): { rect: DOMRectReadOnly | null; selected: R | null } {
  const { deps = [] } = options;
  const [rect, setRect] = useState<DOMRectReadOnly | null>(null);
  const [selected, setSelected] = useState<R | null>(null);

  // Pin the latest selector to a ref so the observer effect doesn't
  // re-bind on every render when selector identity changes.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Manual re-sample, used by both the observer effect and the deps
  // layout-effect below.
  const sampleRef = useRef<() => void>(() => {});

  const boundElRef = useRef<T | null>(null);
  const unbindRef = useRef<(() => void) | null>(null);

  const bind = (el: T): (() => void) => {
    const sample = (r: DOMRectReadOnly) => {
      setRect(r);
      const s = selectorRef.current;
      if (s) setSelected(s(el, r));
    };

    sampleRef.current = () => {
      sample(el.getBoundingClientRect());
    };

    // Web-font swap can re-flow text-sized children without changing the
    // observed container's box — the ResizeObserver never fires. Re-sample
    // once font metrics settle.
    let cancelled = false;
    el.ownerDocument.fonts?.ready.then(() => {
      if (!cancelled) sampleRef.current();
    });

    const win = el.ownerDocument.defaultView ?? window;
    if (typeof win.ResizeObserver === "undefined") {
      sampleRef.current();
      return () => {
        cancelled = true;
      };
    }

    // Re-sample getBoundingClientRect() rather than reading
    // entry.contentRect: contentRect is content-box with element-local
    // coordinates (top/left ≈ 0), while the initial sample below is a
    // viewport-relative border-box rect. Mixing the two hands consumers
    // a rect whose coordinate space depends on which path fired last.
    const ro = new win.ResizeObserver(() => {
      sample(el.getBoundingClientRect());
    });
    ro.observe(el);

    // Synchronous initial sample so selector results land on first paint.
    sampleRef.current();

    return () => {
      cancelled = true;
      ro.disconnect();
    };
  };

  // Rebind after every commit if the element identity changed — covers a
  // ref that is still null on first commit (element mounts later) and an
  // element swap (key remount) that would otherwise leave the observer on
  // a detached node. No-op when the element is unchanged.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === boundElRef.current) return;
    unbindRef.current?.();
    boundElRef.current = el;
    unbindRef.current = el ? bind(el) : null;
  });

  useLayoutEffect(
    () => () => {
      unbindRef.current?.();
      unbindRef.current = null;
      boundElRef.current = null;
    },
    [],
  );

  // Re-sample when caller-supplied deps change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    sampleRef.current();
  }, deps);

  return { rect, selected };
}
