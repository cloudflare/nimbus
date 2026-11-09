/**
 * Which agent surfaces the site serves, decided by its routes. A page's
 * Markdown URL is published only when a recorded Markdown route serves it;
 * `llms.txt`, the section indexes and `llms-full.txt` exist only when a route
 * serves them. The build reads the records Astro resolved; the runtime reads
 * the same records from `virtual:nimbus/markdown-routes`. Runtime-safe: no
 * Node imports.
 */

import type { MarkdownRouteRecord } from "./markdown-routes.js";

export interface AgentSurfaces {
  /** Every recorded `.md`, `.mdx`, `llms.txt` and `llms-full.txt` endpoint route. */
  markdownRoutes: readonly Pick<MarkdownRouteRecord, "pattern" | "regex" | "shared">[];
  /** A route serves `/llms.txt`. */
  llms: boolean;
  /** A route serves section indexes (`/<section>/llms.txt`). */
  llmsSections: boolean;
  /** A route serves `/llms-full.txt`. */
  llmsFull: boolean;
}

/**
 * Whether a recorded route would serve `url` (a site-relative, base-free
 * path). The site index is the one URL a pattern alone decides: the section
 * route's regex matches `/llms.txt` with an empty section, which
 * `llmsSectionRoute()` refuses, so only a route at `/llms.txt` serves it.
 */
export function publishesAgentUrl(
  routes: readonly Pick<MarkdownRouteRecord, "pattern" | "regex">[],
  url: string,
): boolean {
  if (url === "/llms.txt") return routes.some((route) => route.pattern === "/llms.txt");
  return routes.some((route) => route.regex.test(url));
}

/** The surfaces a set of recorded routes serves. */
export function agentSurfacesFromRoutes(
  routes: readonly Pick<MarkdownRouteRecord, "pattern" | "regex" | "shared">[],
): AgentSurfaces {
  return {
    markdownRoutes: routes,
    llms: routes.some((route) => route.pattern === "/llms.txt"),
    llmsSections: routes.some(
      (route) => route.pattern !== "/llms.txt" && /\/llms\.txt$|\/\[llms\]\.txt$/u.test(route.pattern),
    ),
    llmsFull: routes.some((route) => route.pattern === "/llms-full.txt"),
  };
}

/** The surfaces a site with every starter route serves: the default when none are recorded. */
export const ALL_AGENT_SURFACES: Readonly<Omit<AgentSurfaces, "markdownRoutes">> = {
  llms: true,
  llmsSections: true,
  llmsFull: true,
};

/** One line per surface, for the build log and `check`. */
export function describeAgentSurfaces(surfaces: {
  pageMarkdown: boolean;
  source: boolean;
  llms: boolean;
  llmsSections: boolean;
  llmsFull: boolean;
  mcpBodies: boolean;
}): string[] {
  const line = (on: boolean, what: string, file: string) =>
    on ? `${what}: served (${file})` : `${what}: off (no ${file})`;
  return [
    surfaces.pageMarkdown
      ? line(true, "Page Markdown", "src/pages/[...slug]/index.md.ts")
      : `Page Markdown: off (no src/pages/[...slug]/index.md.ts)${surfaces.mcpBodies ? "; bodies kept for agents.mcp" : ""}`,
    line(surfaces.source, "Page source (.mdx)", "src/pages/[...slug]/index.mdx.ts"),
    line(surfaces.llms, "llms.txt", "src/pages/llms.txt.ts"),
    line(surfaces.llmsSections, "Section llms.txt", "src/pages/[...section]/llms.txt.ts"),
    line(surfaces.llmsFull, "llms-full.txt", "src/pages/llms-full.txt.ts"),
  ];
}
