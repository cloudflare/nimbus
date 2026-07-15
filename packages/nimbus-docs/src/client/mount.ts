/**
 * mount.ts — Discover, mount, and unmount component instances.
 *
 * The single entry point used by every `*.client.ts` to wire its component.
 * Handles three concerns:
 *
 *   1. Initial discovery — finds elements matching `selector` and calls `init`
 *      on each, storing the returned teardown.
 *   2. View transitions — on `astro:before-swap`, runs every teardown so
 *      document/window listeners come down before the DOM is replaced.
 *   3. Re-mount — on `astro:page-load`, re-runs discovery against the new DOM.
 *
 * The init function receives the root element and returns a `destroy()`
 * function. The root element is the keying mechanism — calling mount again
 * against an already-tracked element is a no-op.
 *
 * Usage:
 *
 *   mount("[data-nb-collapsible]", (root) => {
 *     const disclosure = makeDisclosure({ ... });
 *     return () => disclosure.destroy();
 *   });
 */

type Init = (root: HTMLElement) => () => void;

export function mount(selector: string, init: Init): void {
  const instances = new Map<HTMLElement, () => void>();

  function setup() {
    document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      if (instances.has(el)) return;
      instances.set(el, init(el));
    });
  }

  function teardown() {
    instances.forEach((destroy) => destroy());
    instances.clear();
  }

  // Module scripts are deferred, so DOM is parsed by the time this runs.
  // Belt-and-braces check anyway.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup, { once: true });
  } else {
    setup();
  }

  document.addEventListener("astro:before-swap", teardown);
  document.addEventListener("astro:page-load", setup);
}
