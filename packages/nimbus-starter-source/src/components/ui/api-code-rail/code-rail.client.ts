/**
 * Wires the code rail's language <select>. The samples are all server-rendered
 * (no-JS shows the first, the rest ship hidden-but-crawlable); this only swaps
 * which panel is visible on change and keeps every rail on the page — and other
 * tabs — in sync on the chosen language via localStorage.
 */
import { initTabs, mount } from "@cloudflare/nimbus-docs/client";

// Distinct from the initTabs `ui-tab-sync` mechanism — this stores the chosen
// option *value* and syncs via the `storage` event, so it uses its own key.
const SYNC_KEY = "nb-api-code-rail__lang";
const rails = new Set<(value: string) => void>();

function initCodeRail(container: HTMLElement): () => void {
  const select = container.querySelector<HTMLSelectElement>("[data-nb-lang-select]");
  const panels = Array.from(container.querySelectorAll<HTMLElement>("[data-nb-lang-panel]"));
  if (!select || panels.length === 0) return () => {};

  const show = (value: string) => {
    if (!panels.some((p) => p.dataset.nbLangValue === value)) return;
    for (const panel of panels) panel.hidden = panel.dataset.nbLangValue !== value;
    if (select.value !== value) select.value = value;
  };
  rails.add(show);

  const onChange = () => {
    const { value } = select;
    for (const apply of rails) apply(value);
    try {
      localStorage.setItem(SYNC_KEY, value);
    } catch {}
  };
  select.addEventListener("change", onChange);

  const onStorage = (e: StorageEvent) => {
    if (e.key === SYNC_KEY && e.newValue) show(e.newValue);
  };
  window.addEventListener("storage", onStorage);

  // SSR renders the first sample; if a different language was saved, this
  // restores it post-hydration (a brief flash of the default is acceptable —
  // avoiding it would need a blocking inline script, overkill for a picker).
  try {
    const saved = localStorage.getItem(SYNC_KEY);
    if (saved) show(saved);
  } catch {}

  return () => {
    rails.delete(show);
    select.removeEventListener("change", onChange);
    window.removeEventListener("storage", onStorage);
  };
}

mount("[data-nb-lang-picker]", initCodeRail);

// Response status toggle — a per-rail segmented control (role=tablist) that swaps
// which response panel is visible. Server-rendered (first status shown, rest
// hidden); reuses the shared tab primitive for aria-selected, roving tabindex,
// and arrow/Home/End keyboard nav. Panels pair to triggers by DOM order. No
// cross-instance sync — a rail's chosen status is local to that rail.
function initRespToggle(container: HTMLElement): () => void {
  const instance = initTabs({
    container,
    tabSelector: "[data-nb-resp-trigger]",
    panelSelector: "[data-nb-resp-panel]",
  });
  return () => instance.destroy();
}

mount("[data-nb-resp-toggle]", initRespToggle);
