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
 * The choice follows the reader: on a page reached without the param, a saved
 * choice is written to the address. So the address names the panel shown, and
 * links between pages need not carry the param. Storage is left to the
 * component: a site may keep some kinds out of it.
 *
 * `restoreChoice` is serialized, so it may reference only browser globals and
 * its arguments.
 */
export function restoreChoice(
  readParam: (name: string) => string | null,
  writeParam?: (name: string, value: string) => void,
): void {
  const restoredAttr = "data-nb-choice-restored";
  const script = document.currentScript;
  const w = window as unknown as Record<string, boolean>;
  const valueOf = (p: Element) => p.getAttribute("data-nb-choice-panel") ?? "";
  // A group's own panels, and the one to show: the param's, else the saved kind's.
  const pick = (group: Element, param: string | null) => {
    const panels = [...group.querySelectorAll<HTMLElement>("[data-nb-choice-panel]")].filter(
      (p) => p.closest("[data-nb-choice]") === group,
    );
    const kindOf = (p: Element) => (p.getAttribute("data-nb-choice-kind") ?? valueOf(p)).toLowerCase();
    const ofKind = (kind: string) => panels.find((p) => kindOf(p) === kind.toLowerCase());
    const key = group.getAttribute("data-nb-choice");
    let saved: string | null = null;
    try {
      if (key) saved = localStorage.getItem(key);
    } catch {}
    const panel =
      (param ? (panels.find((p) => valueOf(p) === param) ?? ofKind(param)) : undefined) ??
      (saved ? ofKind(saved) : undefined);
    return { panels, panel };
  };
  const restoreGroup = (group: Element, write: boolean) => {
    const paramName = group.getAttribute("data-nb-choice-param");
    const param = paramName ? readParam(paramName) : null;
    const { panels, panel } = pick(group, param);
    if (!panel) return;
    // A param this page can't show is left alone: the next page may have it.
    if (write && paramName && !param) writeParam?.(paramName, valueOf(panel));
    for (const p of panels) p.hidden = p !== panel;
    const select = [...group.querySelectorAll<HTMLSelectElement>("[data-nb-choice-select]")].find(
      (el) => el.closest("[data-nb-choice]") === group,
    );
    if (select) select.value = valueOf(panel);
  };
  // Once per group, and only once it's fully parsed: a group still holding
  // the running script waits for its own.
  const restore = (write: boolean) =>
    document.querySelectorAll("[data-nb-choice]").forEach((group) => {
      if (group.hasAttribute(restoredAttr) || (script && group.contains(script))) return;
      group.setAttribute(restoredAttr, "");
      restoreGroup(group, write);
    });
  // Astro's client router compares each link with the address it navigated
  // to, so the address is rewritten in place only while the first page is
  // parsing, before the router reads it. After that, the param goes into
  // each navigation's own address before the swap.
  restore(document.readyState === "loading");
  const flag = "__nbChoiceBound";
  if (!w[flag]) {
    w[flag] = true;
    document.addEventListener("astro:after-swap", () => restore(false));
    document.addEventListener("astro:before-swap", (event) => {
      const swap = event as Event & { to?: URL; newDocument?: Document; navigationType?: string };
      if (!swap.to || !swap.newDocument || swap.navigationType === "traverse") return;
      const to = new URL(swap.to.href);
      swap.newDocument.querySelectorAll("[data-nb-choice][data-nb-choice-param]").forEach((group) => {
        const name = group.getAttribute("data-nb-choice-param");
        // A link's own param stands, in the query or stranded in the fragment.
        const stranded = to.hash.indexOf("?");
        if (!name || to.searchParams.get(name)) return;
        if (stranded !== -1 && new URLSearchParams(to.hash.slice(stranded + 1)).get(name)) return;
        const { panel } = pick(group, null);
        if (panel) to.searchParams.set(name, valueOf(panel));
      });
      if (to.href !== swap.to.href) swap.to = to;
    });
  }
}
