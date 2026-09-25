/**
 * Build-end check that every baked Markdown page and every `llms.txt` index
 * has a prerendered file. The route factories can't see the route file's
 * `prerender` flag when they are re-exported from another module, so the
 * build reads the result instead: an expected URL with no file, served by an
 * endpoint route, is reported with that route.
 */

import type { LlmsEndpointReference } from "../agent-endpoints.js";

export interface EndpointRouteRecord {
  pattern: string;
  entrypoint: string;
  regex: RegExp;
  prerendered: boolean;
}

export interface UngeneratedAgentPage {
  url: string;
  owner: EndpointRouteRecord;
}

const LISTED_PER_ROUTE = 10;

export function llmsAssetUrl(reference: LlmsEndpointReference): string {
  if (reference.scope === "section") return `/${reference.section}/llms.txt`;
  return reference.surface === "full" ? "/llms-full.txt" : "/llms.txt";
}

/**
 * Expected URLs with no generated file, each with the endpoint route that
 * serves it: the first in Astro's priority order whose pattern matches. A URL
 * no endpoint matches is one the site chose not to serve and is skipped.
 */
export function findUngeneratedAgentPages(
  routes: readonly EndpointRouteRecord[],
  urls: Iterable<string>,
  generated: Pick<ReadonlySet<string>, "has">,
): UngeneratedAgentPage[] {
  const missing = new Map<string, UngeneratedAgentPage>();
  for (const url of urls) {
    if (missing.has(url) || generated.has(url)) continue;
    const owner = routes.find((route) => route.regex.test(url));
    if (owner) missing.set(url, { url, owner });
  }
  return [...missing.values()].sort((a, b) => a.url.localeCompare(b.url));
}

export function formatUngeneratedAgentPages(
  missing: readonly UngeneratedAgentPage[],
): string {
  const byOwner = new Map<EndpointRouteRecord, string[]>();
  for (const { owner, url } of missing) {
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), url]);
  }
  const lines = [...byOwner].map(([owner, urls]) => {
    const listed = urls.slice(0, LISTED_PER_ROUTE).join(", ");
    const more =
      urls.length > LISTED_PER_ROUTE
        ? ` and ${urls.length - LISTED_PER_ROUTE} more`
        : "";
    const state = owner.prerendered
      ? "is prerendered but did not generate"
      : "is rendered on request, so the build has no file for";
    return `  - ${owner.entrypoint} (${owner.pattern}) ${state}: ${listed}${more}`;
  });
  return (
    `nimbus-docs: ${missing.length} Markdown or llms.txt page${missing.length === 1 ? " was" : "s were"} ` +
    "not prerendered:\n" +
    `${lines.join("\n")}\n` +
    "If the site serves these on request, ignore this warning. Otherwise add " +
    "`export const prerender = true;` to the route file itself (Astro reads it only " +
    "from the route file, not from a module the route re-exports), or generate these " +
    "paths from the route's getStaticPaths."
  );
}
