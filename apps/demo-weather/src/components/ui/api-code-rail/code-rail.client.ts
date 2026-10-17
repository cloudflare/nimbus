/**
 * Wires the code rail's sample <select>. The samples are all server-rendered
 * (no-JS shows the first, the rest ship hidden-but-crawlable); this only swaps
 * which panel is visible on change.
 *
 * Two kinds of choice. Picking a sample is local to this page: options and
 * panels are keyed by the sample's id (`python`, `python-2`). The choice that
 * follows the reader to other operations, and to other tabs via localStorage,
 * is the sample's language: picking `python-2` saves `python`, and another
 * operation opens its first Python sample. A ?lang= query param deep-links a
 * sample: an exact id wins, otherwise the language's first sample; each change
 * writes the chosen id back, so a shared link opens that exact sample.
 */
import { initTabs, mount, readUrlParam, writeUrlParam } from "@cloudflare/nimbus-docs/client";

// Distinct from the initTabs `ui-tab-sync` mechanism — this stores the chosen
// language and syncs via the `storage` event, so it uses its own key.
const SYNC_KEY = "nb-api-code-rail__lang";
const LANG_PARAM = "lang";
const rails = new Set<(lang: string) => void>();

function initCodeRail(container: HTMLElement): () => void {
  const select = container.querySelector<HTMLSelectElement>("[data-nb-lang-select]");
  const panels = Array.from(container.querySelectorAll<HTMLElement>("[data-nb-lang-panel]"));
  if (!select || panels.length === 0) return () => {};

  const panelFor = (id: string) => panels.find((p) => p.dataset.nbLangValue === id);
  // A rail without per-panel languages (older markup) treats the id as the language.
  const langOf = (panel: HTMLElement) =>
    (panel.dataset.nbSampleLang ?? panel.dataset.nbLangValue ?? "").toLowerCase();
  const firstFor = (lang: string) => panels.find((p) => langOf(p) === lang.toLowerCase());

  const show = (panel: HTMLElement | undefined) => {
    if (!panel) return;
    for (const p of panels) p.hidden = p !== panel;
    const id = panel.dataset.nbLangValue ?? "";
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
      localStorage.setItem(SYNC_KEY, lang);
    } catch {}
    writeUrlParam(LANG_PARAM, select.value);
  };
  select.addEventListener("change", onChange);

  const onStorage = (e: StorageEvent) => {
    if (e.key === SYNC_KEY && e.newValue) showLanguage(e.newValue);
  };
  window.addEventListener("storage", onStorage);

  // SSR renders the first sample; restore a different choice post-hydration (a
  // brief flash of the default is acceptable). A ?lang= deep link that matches
  // a sample id or language wins; otherwise the saved language, else the
  // server default.
  const param = readUrlParam(LANG_PARAM);
  const linked = param ? (panelFor(param) ?? firstFor(param)) : undefined;
  if (linked) {
    show(linked);
  } else {
    try {
      const saved = localStorage.getItem(SYNC_KEY);
      if (saved) showLanguage(saved);
    } catch {}
  }

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
