/**
 * Wires the code rail's sample <select>. The samples are all server-rendered
 * (no-JS shows the first, the rest ship hidden-but-crawlable); this only swaps
 * which panel is visible on change.
 *
 * Two kinds of choice. Picking a sample is local to this page: options and
 * panels are keyed by the sample's id (`python`, `python-2`). The choice that
 * follows the reader to other operations, and to other tabs via localStorage,
 * is the sample's language: picking `python-2` saves `python`, and another
 * operation opens its first Python sample. `choiceStateScript` shows the
 * reader's sample before paint (a ?lang= link, else the saved language); each
 * change writes the chosen id back to ?lang=, so a shared link opens that
 * exact sample. The storage key and param are the rail's `data-nb-choice`
 * attributes.
 */
import { initTabs, mount, writeUrlParam } from "@cloudflare/nimbus-docs/client";

const rails = new Set<(lang: string) => void>();

function initCodeRail(container: HTMLElement): () => void {
  const select = container.querySelector<HTMLSelectElement>("[data-nb-choice-select]");
  const panels = Array.from(container.querySelectorAll<HTMLElement>("[data-nb-choice-panel]"));
  const key = container.dataset.nbChoice;
  const param = container.dataset.nbChoiceParam;
  if (!select || panels.length === 0 || !key) return () => {};

  const panelFor = (id: string) => panels.find((p) => p.dataset.nbChoicePanel === id);
  const langOf = (panel: HTMLElement) =>
    (panel.dataset.nbChoiceKind ?? panel.dataset.nbChoicePanel ?? "").toLowerCase();
  const firstFor = (lang: string) => panels.find((p) => langOf(p) === lang.toLowerCase());

  const show = (panel: HTMLElement | undefined) => {
    if (!panel) return;
    for (const p of panels) p.hidden = p !== panel;
    const id = panel.dataset.nbChoicePanel ?? "";
    if (select.value !== id) select.value = id;
  };
  // Another rail or tab chose a language: keep the current sample if it's in
  // that language, else open the language's first sample.
  const showLanguage = (lang: string) => {
    const current = panelFor(select.value);
    if (current && langOf(current) === lang.toLowerCase()) return;
    show(firstFor(lang));
  };
  rails.add(showLanguage);

  const onChange = () => {
    const panel = panelFor(select.value);
    if (!panel) return;
    show(panel);
    const lang = langOf(panel);
    for (const apply of rails) if (apply !== showLanguage) apply(lang);
    try {
      localStorage.setItem(key, lang);
    } catch {}
    if (param) writeUrlParam(param, select.value);
  };
  select.addEventListener("change", onChange);

  const onStorage = (e: StorageEvent) => {
    if (e.key === key && e.newValue) showLanguage(e.newValue);
  };
  window.addEventListener("storage", onStorage);

  return () => {
    rails.delete(showLanguage);
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
