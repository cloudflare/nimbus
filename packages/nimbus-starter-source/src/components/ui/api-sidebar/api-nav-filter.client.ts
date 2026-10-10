/** The sidebar filter on an on-demand API sidebar, which holds only part of
 *  its tree. Focusing or typing loads the version's page list once; matches
 *  replace the tree until the filter is cleared. */

import {
  loadNavList,
  matchNavList,
  mount,
  type NavListRow,
} from "@cloudflare/nimbus-docs/client";
import { methodLabel, methodVariant } from "./method";

const MAX_RESULTS = 100;
const base = import.meta.env.BASE_URL.replace(/\/$/, "");

mount("[data-nb-nav-list]", (filter) => {
  const input = filter.querySelector<HTMLInputElement>("input");
  const scope = filter.parentElement;
  const tree = scope?.querySelector<HTMLElement>("[data-nb-api-nav]");
  const results = scope?.querySelector<HTMLElement>("[data-nb-nav-results]");
  const status = scope?.querySelector<HTMLElement>("[data-nb-nav-status]");
  const template = scope?.querySelector<HTMLTemplateElement>(
    "template[data-nb-nav-result]",
  );
  const url = filter.dataset.nbNavList;
  if (!input || !tree || !results || !status || !template || !url)
    return () => {};

  // The status region stays in the page so screen readers announce changes.
  const say = (message: string) => {
    status.textContent = message;
  };

  const row = ({ title, method, url }: NavListRow): Node => {
    const item = template.content.cloneNode(true) as DocumentFragment;
    const link = item.querySelector("a");
    if (link) link.href = base + url;
    // The template's SidebarLink and ApiMethodChip are the site's own; a
    // customised one without these classes still gets its title.
    const label = item.querySelector(".break-words") ?? link;
    if (label) label.textContent = title;
    const chip = item.querySelector<HTMLElement>(".nb-api-chip");
    if (!chip) return item;
    const variant = methodVariant(method);
    if (variant) {
      chip.className = chip.className.replace(
        /nb-api-chip--\w+/,
        `nb-api-chip--${variant}`,
      );
      chip.textContent = methodLabel(method)!;
    } else chip.remove();
    return item;
  };

  const show = (rows: NavListRow[]) => {
    tree.hidden = true;
    results.hidden = false;
    results.replaceChildren(...rows.slice(0, MAX_RESULTS).map(row));
    say(
      rows.length === 0
        ? "No matching pages"
        : rows.length > MAX_RESULTS
          ? `Showing ${MAX_RESULTS} of ${rows.length}. Keep typing to narrow.`
          : `${rows.length} ${rows.length === 1 ? "page" : "pages"}`,
    );
  };

  const reset = () => {
    tree.hidden = false;
    results.hidden = true;
    results.replaceChildren();
    say("");
  };

  const update = async () => {
    const query = input.value.trim();
    if (!query) return reset();
    let rows: NavListRow[];
    try {
      rows = await loadNavList(url);
    } catch {
      reset();
      return say("Filter unavailable");
    }
    // A later keystroke has already drawn its own results.
    if (input.value.trim() === query) show(matchNavList(rows, query));
  };

  const load = () =>
    void loadNavList(url).catch(() => say("Filter unavailable"));
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    input.value = "";
    reset();
    input.blur();
  };

  input.addEventListener("focus", load);
  input.addEventListener("input", update);
  input.addEventListener("keydown", onKeydown);
  return () => {
    input.removeEventListener("focus", load);
    input.removeEventListener("input", update);
    input.removeEventListener("keydown", onKeydown);
    reset();
  };
});
