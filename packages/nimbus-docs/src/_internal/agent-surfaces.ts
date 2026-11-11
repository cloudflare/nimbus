/**
 * Which agent surfaces the site serves, decided by its routes. A page's
 * Markdown URL is published only when a recorded Markdown route serves it;
 * `llms.txt`, the section indexes and `llms-full.txt` exist only when a route
 * serves them. The build reads the records Astro resolved; the runtime reads
 * the same records from `virtual:nimbus/markdown-routes`. Runtime-safe: no
 * Node imports.
 */

import type { MarkdownRouteRecord } from "./markdown-routes.js";

/** A recorded route as the surfaces need it; the entrypoint names it in the log. */
export type AgentSurfaceRoute = Pick<MarkdownRouteRecord, "pattern" | "regex" | "shared"> & { entrypoint?: string };

export interface AgentSurfaces {
  /** Every recorded `.md`, `.mdx`, `llms.txt` and `llms-full.txt` endpoint route. */
  markdownRoutes: readonly AgentSurfaceRoute[];
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
export function agentSurfacesFromRoutes(routes: readonly AgentSurfaceRoute[]): AgentSurfaces {
  return {
    markdownRoutes: routes,
    llms: routes.some((route) => route.pattern === "/llms.txt"),
    llmsSections: routes.some((route) => isSectionLlmsPattern(route.pattern)),
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
  /** The route files serving each surface, where known; the starter's names otherwise. */
  files?: Partial<Record<"pageMarkdown" | "source" | "llms" | "llmsSections" | "llmsFull", string>>;
}): string[] {
  const line = (on: boolean, what: string, file: string) =>
    on ? `${what}: served (${file})` : `${what}: off (no ${file})`;
  const file = (key: keyof NonNullable<typeof surfaces.files>, starter: string) => surfaces.files?.[key] ?? starter;
  return [
    surfaces.pageMarkdown
      ? line(true, "Page Markdown", file("pageMarkdown", "src/pages/[...slug]/index.md.ts"))
      : `Page Markdown: off (no src/pages/[...slug]/index.md.ts)${surfaces.mcpBodies ? "; bodies kept for agents.mcp" : ""}`,
    line(surfaces.source, "Page source (.mdx)", file("source", "src/pages/[...slug]/index.mdx.ts")),
    line(surfaces.llms, "llms.txt", file("llms", "src/pages/llms.txt.ts")),
    line(surfaces.llmsSections, "Section llms.txt", file("llmsSections", "src/pages/[...section]/llms.txt.ts")),
    line(surfaces.llmsFull, "llms-full.txt", file("llmsFull", "src/pages/llms-full.txt.ts")),
  ];
}

/** Whether a route pattern is a section index (`/<section>/llms.txt`), not the site's. */
export function isSectionLlmsPattern(pattern: string): boolean {
  return pattern !== "/llms.txt" && /\/llms\.txt$|\/\[llms\]\.txt$/u.test(pattern);
}

/**
 * The project's own route files among `routes` that `test` picks, named for
 * the log; routes injected from module paths outside `src/` are left out.
 */
export function agentRouteFiles(
  routes: readonly { pattern: string; entrypoint?: string }[],
  test: (route: { pattern: string }) => boolean,
): string | undefined {
  const files = [
    ...new Set(
      routes
        .filter(test)
        .map((route) => route.entrypoint)
        .filter((file): file is string => typeof file === "string" && file.startsWith("src/")),
    ),
  ];
  return files.length > 0 ? files.join(", ") : undefined;
}
