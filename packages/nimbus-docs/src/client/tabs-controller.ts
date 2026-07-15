/**
 * Shared tab activation primitive.
 *
 * Handles aria-selected, panel visibility, roving tabindex,
 * keyboard navigation, sliding indicator, and cross-instance sync.
 *
 * Used by: Tabs.astro, PackageManagers.astro
 */

import { FOCUSABLE } from "./dom";

export interface TabsConfig {
  /** Root container holding tabs + panels */
  container: Element;
  /** CSS selector for tab trigger buttons */
  tabSelector: string;
  /** CSS selector for tab panels */
  panelSelector: string;
  /**
   * Selector identifying a tab container. When set, tabs/panels are scoped
   * to this container only — a descendant belongs to it iff its nearest
   * ancestor matching `boundarySelector` is `container` itself. This keeps
   * a nested `<Tabs>`'s triggers/panels out of the parent instance. When
   * unset, all descendants match `tabSelector`/`panelSelector` are used
   * (no nesting support — the prior behaviour).
   */
  boundarySelector?: string;
  /** Optional sliding indicator element */
  indicator?: HTMLElement | null;
  /** Enable roving tabindex + arrow key navigation (default: true) */
  rovingTabindex?: boolean;
  /** Cross-instance persistence config */
  sync?: {
    key: string;
    storage?: "local" | "session";
    /** Extract sync label from a tab element. Default: textContent.trim() */
    getLabel?: (tab: HTMLElement) => string;
  };
  /** Called after a tab is activated */
  onActivate?: (index: number) => void;
}

export interface TabsInstance {
  activate(index: number, options?: { emitSync?: boolean }): void;
  readonly currentIndex: number;
  destroy(): void;
}

export function initTabs(config: TabsConfig): TabsInstance {
  const { container, tabSelector, panelSelector, boundarySelector, indicator = null, rovingTabindex = true, sync, onActivate } = config;

  // A descendant belongs to this container only if no nested tab container
  // sits between it and `container` — i.e. its nearest `boundarySelector`
  // ancestor is `container` itself. Without a boundary selector, every
  // match counts (nesting unsupported).
  const owned = (el: HTMLElement) => !boundarySelector || el.closest(boundarySelector) === container;
  const tabs = Array.from(container.querySelectorAll<HTMLElement>(tabSelector)).filter(owned);
  const panels = Array.from(container.querySelectorAll<HTMLElement>(panelSelector)).filter(owned);
  const tablist = container.querySelector("[role=tablist]") ?? container;

  let currentIndex = -1;
  let isInitialActivation = true;

  function getStorage(kind: "local" | "session"): Storage | null {
    try {
      return kind === "session" ? sessionStorage : localStorage;
    } catch {
      return null;
    }
  }

  function getLabel(tab: HTMLElement): string {
    return sync?.getLabel?.(tab) ?? tab.textContent?.trim() ?? "";
  }

  function updateIndicator(index: number) {
    if (!indicator || !tabs[index]) return;
    indicator.style.left = `${tabs[index].offsetLeft}px`;
    indicator.style.width = `${tabs[index].offsetWidth}px`;
  }

  function activate(index: number, options?: { emitSync?: boolean }) {
    const emitSync = options?.emitSync ?? true;
    if (index === currentIndex) return;

    // Capture scroll position before DOM changes to prevent layout jump
    const rect = container.getBoundingClientRect();
    const scrollBefore = rect.top;

    currentIndex = index;

    tabs.forEach((tab, i) => {
      const active = i === index;
      tab.setAttribute("aria-selected", String(active));
      if (rovingTabindex) {
        tab.setAttribute("tabindex", active ? "0" : "-1");
      }
    });

    panels.forEach((panel, i) => {
      const visible = i === index;
      panel.hidden = !visible;
      // Panels with no focusable children need tabindex="0" so keyboard
      // users can Tab into the content (WAI-ARIA Tabs pattern).
      if (visible) {
        const hasFocusable = panel.querySelector(FOCUSABLE) !== null;
        if (!hasFocusable) {
          panel.setAttribute("tabindex", "0");
        } else {
          panel.removeAttribute("tabindex");
        }
      }
    });

    updateIndicator(index);
    onActivate?.(index);

    // Compensate scroll position after panel height change (skip on first paint)
    if (emitSync && !isInitialActivation) {
      const scrollAfter = container.getBoundingClientRect().top;
      const delta = scrollAfter - scrollBefore;
      if (Math.abs(delta) > 1) {
        window.scrollTo({
          top: window.scrollY + delta,
          behavior: "instant",
        });
      }
    }
    isInitialActivation = false;

    if (sync && emitSync) {
      // `tabs[index]!`: `activate(index)` is only called with validated indices.
      const label = getLabel(tabs[index]!);
      const store = getStorage(sync.storage === "session" ? "session" : "local");
      store?.setItem(sync.key, label);
      window.dispatchEvent(
        new CustomEvent("ui-tab-sync", {
          detail: { key: sync.key, label, origin: container },
        }),
      );
    }
  }

  // Resolve initial index from sync storage
  let initialIndex = 0;
  if (sync) {
    const store = getStorage(sync.storage === "session" ? "session" : "local");
    const saved = store?.getItem(sync.key);
    if (saved) {
      const idx = tabs.findIndex((t) => getLabel(t) === saved);
      if (idx >= 0) initialIndex = idx;
    }
  }

  // Click delegation on tablist
  function handleClick(e: Event) {
    const target = (e.target as HTMLElement).closest(tabSelector);
    if (!target) return;
    const idx = tabs.indexOf(target as HTMLElement);
    if (idx >= 0) {
      activate(idx);
      if (rovingTabindex) (target as HTMLElement).focus();
    }
  }

  // Keyboard navigation (roving tabindex)
  function handleKeydown(e: KeyboardEvent) {
    if (!rovingTabindex) return;
    const ci = tabs.indexOf(e.target as HTMLElement);
    if (ci < 0) return;

    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = ci + 1;
        break;
      case "ArrowLeft":
        next = ci - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    // No-wrap: ignore if out of bounds
    if (!tabs[next]) return;
    e.preventDefault();
    activate(next);
    // `tabs[next]!`: guard above proves the assertion.
    tabs[next]!.focus();
  }

  // Cross-instance sync via CustomEvent
  function handleSync(e: Event) {
    const detail = (e as CustomEvent).detail;
    if (detail.key === sync?.key && detail.origin !== container) {
      const idx = tabs.findIndex((t) => getLabel(t) === detail.label);
      if (idx >= 0) activate(idx, { emitSync: false });
    }
  }

  // Wire events
  tablist.addEventListener("click", handleClick);
  tablist.addEventListener("keydown", handleKeydown as EventListener);
  if (sync) window.addEventListener("ui-tab-sync", handleSync);

  // Initial activation — skip indicator transition for first paint
  if (indicator) indicator.style.transition = "none";
  activate(initialIndex);
  if (indicator) {
    void indicator.offsetHeight; // force reflow
    indicator.style.transition = "";
  }

  return {
    activate,
    get currentIndex() {
      return currentIndex;
    },
    destroy() {
      tablist.removeEventListener("click", handleClick);
      tablist.removeEventListener("keydown", handleKeydown as EventListener);
      if (sync) window.removeEventListener("ui-tab-sync", handleSync);
    },
  };
}
