/**
 * A reader's choice among server-rendered panels, shown before the page paints
 * by `choiceStateScript` (`@cloudflare/nimbus-docs/runtime`). The component's
 * own client handles changes, saving the chosen panel's kind under the group's
 * key.
 *
 *   <div data-nb-choice="<storage key>" data-nb-choice-param="lang">
 *     <select data-nb-choice-select autocomplete="off">…</select>
 *     <div data-nb-choice-panel="python" data-nb-choice-kind="python">…</div>
 *     <div data-nb-choice-panel="python-2" data-nb-choice-kind="python" hidden>…</div>
 *   </div>
 *
 * The URL param (optional) opens an exact panel, else the first of its kind;
 * otherwise the saved kind (localStorage) opens its first panel; otherwise the
 * server's choice stands. Kinds match case-insensitively and default to the
 * panel's value. A panel or select belongs to its nearest group. The select
 * needs `autocomplete="off"`, so the browser's form restore can't contradict
 * the panels.
 *
 * `restoreChoice` is serialized, so it may reference only browser globals and
 * its argument.
 */
export function restoreChoice(readParam: (name: string) => string | null): void {
  const restoredAttr = "data-nb-choice-restored";
  const script = document.currentScript;
  const restoreGroup = (group: Element) => {
    const own = (el: Element) => el.closest("[data-nb-choice]") === group;
    const panels = [...group.querySelectorAll<HTMLElement>("[data-nb-choice-panel]")].filter(own);
    const valueOf = (p: Element) => p.getAttribute("data-nb-choice-panel") ?? "";
    const kindOf = (p: Element) => (p.getAttribute("data-nb-choice-kind") ?? valueOf(p)).toLowerCase();
    const ofKind = (kind: string) => panels.find((p) => kindOf(p) === kind.toLowerCase());
    const paramName = group.getAttribute("data-nb-choice-param");
    const param = paramName ? readParam(paramName) : null;
    const key = group.getAttribute("data-nb-choice");
    let saved: string | null = null;
    try {
      if (key) saved = localStorage.getItem(key);
    } catch {}
    const panel =
      (param ? (panels.find((p) => valueOf(p) === param) ?? ofKind(param)) : undefined) ??
      (saved ? ofKind(saved) : undefined);
    if (!panel) return;
    for (const p of panels) p.hidden = p !== panel;
    const select = [...group.querySelectorAll<HTMLSelectElement>("[data-nb-choice-select]")].find(own);
    if (select) select.value = valueOf(panel);
  };
  // Once per group, and only once it's fully parsed: a group still holding
  // the running script waits for its own.
  const restore = () =>
    document.querySelectorAll("[data-nb-choice]").forEach((group) => {
      if (group.hasAttribute(restoredAttr) || (script && group.contains(script))) return;
      group.setAttribute(restoredAttr, "");
      restoreGroup(group);
    });
  restore();
  const flag = "__nbChoiceBound";
  const w = window as unknown as Record<string, boolean>;
  if (!w[flag]) {
    w[flag] = true;
    document.addEventListener("astro:after-swap", restore);
  }
}
