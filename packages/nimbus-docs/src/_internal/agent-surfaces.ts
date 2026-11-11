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
export type AgentSurfaceRoute = Pick<MarkdownRouteRecord, "pattern" | "regex" | "shared" | "prerendered"> & { entrypoint?: string };

export interface AgentSurfaces {
  /** Every recorded `.md`, `.mdx`, `llms.txt` and `llms-full.txt` endpoint route. */
  markdownRoutes: readonly AgentSurfaceRoute[];
  /** A route serves `/llms.txt`. */
  llms: boolean;
  /** A route serves section indexes (`/<section>/llms.txt`). */
  llmsSections: boolean;
  /** A route serves `/llms-full.txt`. */
  llmsFull: boolean;
  /**
   * Which of those routes render on request. Such a document is not baked:
   * the Worker makes it from the page list when asked.
   */
  onRequest: { llms: boolean; llmsSections: boolean; llmsFull: boolean };
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
  const site = routes.find((route) => route.pattern === "/llms.txt");
  const full = routes.find((route) => route.pattern === "/llms-full.txt");
  const sections = routes.filter((route) => isSectionLlmsPattern(route.pattern));
  // A mount's own llms-full route (a split file) reads the baked part.
  const fullParts = routes.filter(
    (route) => route.pattern !== "/llms-full.txt" && /\/llms-full\.txt$|\/\[llms\]\.txt$/u.test(route.pattern),
  );
  const onRequest = (candidates: readonly { prerendered: boolean }[]) =>
    candidates.length > 0 && candidates.every((route) => route.prerendered === false);
  return {
    markdownRoutes: routes,
    llms: site !== undefined,
    llmsSections: sections.length > 0,
    llmsFull: full !== undefined,
    // A document is made on request only when every route that serves it
    // or one of its parts renders on request; a prerendered mount route
    // reads a baked file, so the whole surface is then baked.
    onRequest: {
      llms: site?.prerendered === false,
      llmsSections: onRequest(sections),
      llmsFull: full !== undefined && onRequest([full, ...fullParts]),
    },
  };
}

/** The surfaces a site with every starter route serves: the default when none are recorded. */
export const ALL_AGENT_SURFACES: Readonly<Omit<AgentSurfaces, "markdownRoutes">> = {
  llms: true,
  llmsSections: true,
  llmsFull: true,
  onRequest: { llms: false, llmsSections: false, llmsFull: false },
};

/** One line per surface, for the build log and `check`. */
export function describeAgentSurfaces(surfaces: {
  pageMarkdown: boolean;
  source: boolean;
  llms: boolean;
  llmsSections: boolean;
  llmsFull: boolean;
  mcpBodies: boolean;
  /** Documents whose routes render on request, made from the page list when asked. */
  onRequest?: { llms: boolean; llmsSections: boolean; llmsFull: boolean };
  /** API pages whose Markdown renders on request. */
  renderedPages?: number;
  /** The route files serving each surface, where known; the starter's names otherwise. */
  files?: Partial<Record<"pageMarkdown" | "source" | "llms" | "llmsSections" | "llmsFull", string>>;
}): string[] {
  const line = (on: boolean, what: string, file: string, onRequest = false) =>
    on ? `${what}: ${onRequest ? "made on request" : "served"} (${file})` : `${what}: off (no ${file})`;
  const file = (key: keyof NonNullable<typeof surfaces.files>, starter: string) => surfaces.files?.[key] ?? starter;
  const rendered = surfaces.renderedPages ? `; ${surfaces.renderedPages} API pages made on request` : "";
  return [
    surfaces.pageMarkdown
      ? `${line(true, "Page Markdown", file("pageMarkdown", "src/pages/[...slug]/index.md.ts"))}${rendered}`
      : `Page Markdown: off (no src/pages/[...slug]/index.md.ts)${surfaces.mcpBodies ? "; bodies kept for agents.mcp" : ""}`,
    line(surfaces.source, "Page source (.mdx)", file("source", "src/pages/[...slug]/index.mdx.ts")),
    line(surfaces.llms, "llms.txt", file("llms", "src/pages/llms.txt.ts"), surfaces.onRequest?.llms),
    line(surfaces.llmsSections, "Section llms.txt", file("llmsSections", "src/pages/[...section]/llms.txt.ts"), surfaces.onRequest?.llmsSections),
    line(surfaces.llmsFull, "llms-full.txt", file("llmsFull", "src/pages/llms-full.txt.ts"), surfaces.onRequest?.llmsFull),
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
