/**
 * disclosure.ts — Open/close state with ARIA wiring.
 *
 * The shared module for any "click trigger, reveals content" pattern.
 * Owns:
 *   - open/closed state (in-memory + reflected as `data-nb-state` on both
 *     trigger and content)
 *   - ARIA: `aria-expanded` on trigger, `aria-controls` linking to content
 *   - Click handler on the trigger
 *
 * Animation is intentionally out of scope — CSS targets the `data-nb-state`
 * attribute and runs whatever transition the component wants. Returning
 * a teardown means the caller can clean up on unmount.
 *
 * Used by: Collapsible, and any future Accordion / Sidebar group /
 * dismissable Banner that wants the standard disclosure semantics.
 */

import { generateId } from "./ids";

export interface DisclosureOptions {
  /** The element users click to toggle. Usually a `<button>`. */
  trigger: HTMLElement;
  /** The element that's shown/hidden. Gets `id` + `data-nb-state`. */
  content: HTMLElement;
  /** Initial open state. Default `false`. */
  defaultOpen?: boolean;
  /** Called whenever open changes. */
  onOpenChange?: (open: boolean) => void;
}

export interface DisclosureInstance {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function makeDisclosure(opts: DisclosureOptions): DisclosureInstance {
  const { trigger, content, defaultOpen = false, onOpenChange } = opts;

  let open = defaultOpen;

  // Ensure ARIA relationship exists.
  if (!content.id) {
    content.id = generateId("nb-disclosure");
  }
  trigger.setAttribute("aria-controls", content.id);

  function syncState() {
    const state = open ? "open" : "closed";
    trigger.setAttribute("data-nb-state", state);
    content.setAttribute("data-nb-state", state);
    trigger.setAttribute("aria-expanded", String(open));
  }

  function setOpen(value: boolean) {
    if (open === value) return;
    open = value;
    syncState();
    onOpenChange?.(value);
  }

  function handleClick(e: MouseEvent) {
    e.preventDefault();
    setOpen(!open);
  }

  syncState();
  trigger.addEventListener("click", handleClick);

  return {
    open() {
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    toggle() {
      setOpen(!open);
    },
    isOpen() {
      return open;
    },
    destroy() {
      trigger.removeEventListener("click", handleClick);
    },
  };
}
