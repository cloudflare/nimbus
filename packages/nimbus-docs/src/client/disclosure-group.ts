/**
 * disclosure-group.ts — Behavior for a group of native `<details>` sharing one
 * "expand/collapse all" control and, optionally, hash deep-linking.
 *
 * Two mechanisms, both with exactly one correct answer (hence framework, not
 * taste):
 *   1. Expand/collapse all — a trigger flips every `<details>` in the group; its
 *      `data-nb-expanded` attribute tracks whether all are open (CSS swaps the
 *      label/icon off that attribute). Manual toggles keep the trigger in sync.
 *   2. Deep-link — on load and `hashchange`, if the location hash targets an
 *      element inside this group, its ancestor (and own) `<details>` open and it
 *      is focused + scrolled into view, honoring `prefers-reduced-motion`.
 *
 * Scoped by `root`: the deep-link only acts when the target lives inside this
 * root, so multiple groups on a page don't fight over one hash. Re-mounting
 * across view transitions is the caller's concern (via `mount`).
 *
 * Used by: the API field explorer (`api-field-row.client.ts`).
 */

export interface DisclosureGroupConfig {
  /** Container holding the `<details>` tree. */
  root: HTMLElement;
  /** Expand/collapse-all trigger; its `data-nb-expanded` reflects group state. */
  toggleAll?: HTMLElement | null;
  /** Open + reveal the hash target on load and `hashchange`. Default `false`. */
  deepLink?: boolean;
}

export interface DisclosureGroupInstance {
  destroy(): void;
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function initDisclosureGroup(config: DisclosureGroupConfig): DisclosureGroupInstance {
  const { root, toggleAll = null, deepLink = false } = config;
  let destroyed = false;

  const allDetails = (): HTMLDetailsElement[] =>
    Array.from(root.querySelectorAll<HTMLDetailsElement>("details"));

  const syncToggle = (): void => {
    if (!toggleAll) return;
    const details = allDetails();
    const allOpen = details.length > 0 && details.every((d) => d.open);
    toggleAll.dataset.nbExpanded = String(allOpen);
  };

  const onToggleClick = (): void => {
    const open = toggleAll!.dataset.nbExpanded !== "true";
    allDetails().forEach((d) => (d.open = open));
    syncToggle();
  };

  // `toggle` doesn't bubble, so listen in the capture phase to observe every
  // descendant <details> flipping.
  const onDescendantToggle = (): void => syncToggle();

  const openHashTarget = (): void => {
    let id: string;
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      return;
    }
    if (!id) return;
    const el = document.getElementById(id);
    if (!el || !root.contains(el)) return;

    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = true;
    }
    const own = el.querySelector<HTMLDetailsElement>(":scope > details");
    if (own) own.open = true;

    el.setAttribute("tabindex", "-1");
    el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
    requestAnimationFrame(() => {
      if (destroyed) return;
      (el as HTMLElement).focus({ preventScroll: true });
      el.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
  };

  if (toggleAll) {
    toggleAll.addEventListener("click", onToggleClick);
    root.addEventListener("toggle", onDescendantToggle, true);
    syncToggle();
  }

  const onHashChange = (): void => openHashTarget();
  if (deepLink) {
    window.addEventListener("hashchange", onHashChange);
    openHashTarget();
  }

  return {
    destroy() {
      destroyed = true;
      if (toggleAll) {
        toggleAll.removeEventListener("click", onToggleClick);
        root.removeEventListener("toggle", onDescendantToggle, true);
      }
      if (deepLink) window.removeEventListener("hashchange", onHashChange);
    },
  };
}
