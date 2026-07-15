/**
 * Decorates external links (absolute `http(s)`/protocol-relative): sets
 * `target`/`rel` and appends an arrow affordance after the link text, unless
 * the link wraps an image. Defaults mirror the common `rehype-external-links`
 * setup, so `externalLinks()` is a drop-in.
 *
 *   nimbus(config, { markdown: { hastPlugins: [externalLinks()] } })
 *
 * This runs before Sätteri's built-in heading-ids, whose text collection
 * re-includes the arrow and cannot be told to strip it. So an external link
 * inside a heading would pollute that heading's slug unless the consumer owns
 * heading slugging and strips `EXTERNAL_LINK_ARROW` before slugging.
 */
import type { HastChild, HastElement, HastPluginDefinition } from "./types";
import { isElement } from "./types";

/** Default arrow affordance (space + U+2197). Exported so a consumer's
 * heading-slug plugin can strip it before computing ids. */
export const EXTERNAL_LINK_ARROW = " ↗";

export interface ExternalLinksOptions {
  /** `target` attribute set on external links. Default `"_blank"`. */
  target?: string;
  /** `rel` tokens set on external links. Default `["noopener"]`. */
  rel?: string[];
  /**
   * Arrow affordance appended after the link text (inside the anchor), unless
   * the link wraps an image. `null` disables it. Default `" ↗"`.
   */
  arrow?: string | null;
  /** Class on the arrow `<span>`. Default `"external-link"`. */
  arrowClass?: string;
  /**
   * Hosts considered internal (left undecorated). Default: none — any absolute
   * `http(s)`/protocol-relative link is external (rehype-external-links default).
   */
  internalHosts?: string[];
}

// Absolute http(s) or protocol-relative `//host`.
const EXTERNAL = /^(?:https?:)?\/\//i;

function hasImgChild(node: HastElement): boolean {
  return (node.children ?? []).some((c) => isElement(c, "img"));
}

function hostOf(href: string): string | null {
  try {
    return new URL(href.startsWith("//") ? `https:${href}` : href).host;
  } catch {
    return null;
  }
}

export function externalLinks(
  options: ExternalLinksOptions = {},
): HastPluginDefinition {
  const target = options.target ?? "_blank";
  const rel = options.rel ?? ["noopener"];
  const arrow = options.arrow === undefined ? EXTERNAL_LINK_ARROW : options.arrow;
  const arrowClass = options.arrowClass ?? "external-link";
  const internalHosts = options.internalHosts;

  const plugin = {
    name: "nimbus:external-links",
    element: {
      filter: ["a"],
      visit(node: HastElement) {
        const href = node.properties?.href;
        if (typeof href !== "string" || !EXTERNAL.test(href)) return;
        if (internalHosts && internalHosts.length > 0) {
          const host = hostOf(href);
          if (host && internalHosts.includes(host)) return;
        }

        const children: HastChild[] = [...(node.children ?? [])];
        if (arrow !== null && !hasImgChild(node)) {
          children.push({
            type: "element",
            tagName: "span",
            properties: { className: [arrowClass] },
            children: [{ type: "text", value: arrow }],
          });
        }

        return {
          type: "element",
          tagName: "a",
          properties: { ...node.properties, target, rel },
          children,
        } as HastElement;
      },
    },
  };

  return plugin as unknown as HastPluginDefinition;
}
