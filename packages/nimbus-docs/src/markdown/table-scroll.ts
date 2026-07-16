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

        return {
          type: "element",
          tagName: "div",
          properties: { className: [wrapperClass] },
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
