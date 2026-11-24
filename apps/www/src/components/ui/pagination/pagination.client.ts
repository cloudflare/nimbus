import { mount, onShortcut, syncShortcutHints } from "@cloudflare/nimbus-docs/client";

// Warm the next page the moment its key goes down, so it's ready when the
// press finishes. A plain prefetch link, so sites that turn off Astro's
// prefetch still build.
function warm(href: string) {
  if (document.head.querySelector(`link[rel="prefetch"][href="${CSS.escape(href)}"]`)) return;
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = href;
  document.head.append(link);
}

function initPagination(root: HTMLElement): () => void {
  const highlight = root.querySelector<HTMLElement>("[data-slot='pagination-highlight']");
  const items = Array.from(root.querySelectorAll<HTMLAnchorElement>("[data-nb-pagination-item]"));
  const cleanups: Array<() => void> = [];
  let current: HTMLElement | null = null;

  // The highlight takes the box of the half being pointed at or focused.
  const show = (item: HTMLElement) => {
    current = item;
    if (!highlight) return;
    highlight.style.left = `${item.offsetLeft}px`;
    highlight.style.width = `${item.offsetWidth}px`;
    highlight.dataset.state = "visible";
  };
  const hide = () => {
    current = null;
    if (highlight) highlight.dataset.state = "hidden";
  };

  for (const item of items) {
    const onShow = () => {
      show(item);
      // A cut-off title shows in full on hover.
      const title = item.querySelector<HTMLElement>("[data-slot='pagination-title']");
      if (title) {
        const cut = title.scrollWidth > title.clientWidth || title.scrollHeight > title.clientHeight;
        if (cut) item.title = title.textContent?.trim() ?? "";
        else item.removeAttribute("title");
      }
    };
    item.addEventListener("pointerenter", onShow);
    item.addEventListener("focus", onShow);
    cleanups.push(() => {
      item.removeEventListener("pointerenter", onShow);
      item.removeEventListener("focus", onShow);
    });
  }
  const onLeave = () => hide();
  const onFocusOut = (e: FocusEvent) => {
    if (!root.contains(e.relatedTarget as Node)) hide();
  };
  root.addEventListener("pointerleave", onLeave);
  root.addEventListener("focusout", onFocusOut);

  // The highlight follows its half when the layout shifts under it.
  const resize = new ResizeObserver(() => {
    if (current) show(current);
  });
  resize.observe(root);

  // The previous/next keys (src/lib/shortcuts.ts) press the matching cap, then
  // go. A bar built from `prevNext` (`data-nb-page-nav`, the first one on the
  // page) answers them anywhere while the reader has single keys on and the
  // page offers the switch to turn them off (WCAG 2.1.4); any bar answers them
  // while focus is in it.
  const press = (item: HTMLAnchorElement) => {
    warm(item.href);
    item.querySelector("[data-slot='pagination-key']")?.setAttribute("data-down", "");
    show(item);
    window.setTimeout(() => item.click(), 140);
  };
  const keyed = items.filter((item) => item.dataset.nbShortcutFor);
  if (root.dataset.keys === "false") {
    // A bar with `keys={false}` names no key.
    for (const item of keyed) {
      item.removeAttribute("data-nb-shortcut-for");
      item.removeAttribute("aria-keyshortcuts");
    }
  } else {
    // Its keys work while focus is in it, so they're announced whenever single
    // keys are on.
    root.setAttribute("data-nb-shortcut-scope", "");
    const pageWide = root === document.querySelector("[data-nb-page-nav]");
    for (const item of keyed) {
      const go = (e: KeyboardEvent) => {
        e.preventDefault();
        press(item);
      };
      cleanups.push(onShortcut(item.dataset.nbShortcutFor!, go, { within: root }));
      if (pageWide) cleanups.push(onShortcut(item.dataset.nbShortcutFor!, go));
    }
    syncShortcutHints(root);
  }

  return () => {
    cleanups.forEach((fn) => fn());
    root.removeEventListener("pointerleave", onLeave);
    root.removeEventListener("focusout", onFocusOut);
    resize.disconnect();
  };
}

mount("[data-nb-pagination]", initPagination);
