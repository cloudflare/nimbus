"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type RefObject,
} from "react";

export interface UseTabIndicatorReturn {
  /** Inline rect of the active tab, relative to the container. Null until first measure. */
  style: { top: number; left: number; width: number; height: number } | null;
}

/**
 * Headless sliding-indicator measurement for a tab group.
 *
 * Pure state + lifecycle — no DOM produced, no styling assumed. The
 * consumer renders the indicator however it wants, applying `style`
 * positionally.
 *
 * Re-measures on `activeId` change and on container resize. Returns
 * `null` style when `activeId` is null or its tab ref isn't mounted —
 * consumer renders nothing in that case, which also prevents a
 * "mount-from-zero" transition the first time the indicator appears.
 */
export function useTabIndicator(
  containerRef: RefObject<HTMLElement | null>,
  getTab: (id: string) => HTMLElement | null,
  activeId: string | null,
): UseTabIndicatorReturn {
  const [style, setStyle] = useState<UseTabIndicatorReturn["style"]>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container || activeId == null) {
      setStyle(null);
      return;
    }
    const btn = getTab(activeId);
    if (!btn) {
      setStyle(null);
      return;
    }
    const cRect = container.getBoundingClientRect();
    const bRect = btn.getBoundingClientRect();
    setStyle({
      top: bRect.top - cRect.top,
      left: bRect.left - cRect.left,
      width: bRect.width,
      height: bRect.height,
    });
  }, [containerRef, getTab, activeId]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef, measure]);

  return { style };
}
