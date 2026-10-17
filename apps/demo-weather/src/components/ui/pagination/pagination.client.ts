import { mount } from "@cloudflare/nimbus-docs/client";

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

  // [ and ] press the matching key, then go: only while focus is in this bar,
  // so single-key shortcuts never fire from elsewhere on the page (WCAG
  // 2.1.4), and never with a modifier held.
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented) return;
    const item = items.find((i) => i.dataset.nbPaginationKey === e.key);
    if (!item) return;
    e.preventDefault();
    warm(item.href);
    item.querySelector("[data-slot='pagination-key']")?.setAttribute("data-down", "");
    show(item);
    window.setTimeout(() => item.click(), 140);
  };
  const listens = root.dataset.keys !== "false";
  if (listens) {
    for (const item of items) item.setAttribute("aria-keyshortcuts", item.dataset.nbPaginationKey ?? "");
    root.addEventListener("keydown", onKey);
  }

  return () => {
    cleanups.forEach((fn) => fn());
    root.removeEventListener("pointerleave", onLeave);
    root.removeEventListener("focusout", onFocusOut);
    resize.disconnect();
    if (listens) root.removeEventListener("keydown", onKey);
  };
}

mount("[data-nb-pagination]", initPagination);
