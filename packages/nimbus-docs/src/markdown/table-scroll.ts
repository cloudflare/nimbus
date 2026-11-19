/**
 * Wraps prose tables in a scroll container so wide tables scroll within their
 * own box instead of overflowing the page. A `<table>` can't do this alone:
 * `overflow` is ignored on `display: table`, so it fills *or* scrolls, never
 * both — the wrapper owns the overflow, the table keeps `display: table`.
 *
 *   nimbus(config, { markdown: { hastPlugins: [tableScroll()] } })
 *
 * Only class-less tables are wrapped, matching the prose stylesheet's
 * `table:not([class])`; the wrapper is a `<div>` so that selector still hits.
 * The wrapper is a Tab stop so keyboard users can scroll it; Safari doesn't
 * make scrolling boxes focusable on its own. Being focusable, it is a named
 * region: named by the table's caption, else its column headings.
 */
import type { HastElement, HastPluginDefinition } from "./types";
import { classNames } from "./types";

export interface TableScrollOptions {
  /** Class on the generated scroll container. Default `"nb-table-scroll"`. */
  wrapperClass?: string;
}

export function tableScroll(
  options: TableScrollOptions = {},
): HastPluginDefinition {
  const wrapperClass = options.wrapperClass ?? "nb-table-scroll";

  const plugin = {
    name: "nimbus:table-scroll",
    element: {
      filter: ["table"],
      visit(node: HastElement) {
        if (classNames(node).length > 0) return;
        const label = tableLabel(node);

        return {
          type: "element",
          tagName: "div",
          properties: { className: [wrapperClass], tabIndex: 0, role: "region", ariaLabel: label },
          children: [
            {
              type: "element",
              tagName: "table",
              properties: { ...node.properties },
              children: node.children ?? [],
            },
          ],
        } as HastElement;
      },
    },
  };

  return plugin as unknown as HastPluginDefinition;
}

/** The table's caption, else "Table: " and its first row's headings. */
function tableLabel(table: HastElement): string {
  const elements = (node: HastElement, tag: string): HastElement[] =>
    (node.children ?? []).flatMap((child) => {
      if (child.type !== "element") return [];
      const element = child as HastElement;
      return element.tagName === tag ? [element] : elements(element, tag);
    });
  const clean = (value: string) => value.trim().replace(/\s+/g, " ");
  const caption = elements(table, "caption")[0];
  if (caption && clean(textOf(caption))) return clean(textOf(caption));
  const [row] = elements(table, "tr");
  const headings = row ? elements(row, "th").map((th) => clean(textOf(th))).filter(Boolean) : [];
  return headings.length > 0 ? `Table: ${headings.join(", ")}` : "Table";
}

function textOf(node: { type: string; value?: unknown; children?: unknown[] }): string {
  if (node.type === "text") return String(node.value ?? "");
  return (node.children ?? []).map((child) => textOf(child as typeof node)).join("");
}
