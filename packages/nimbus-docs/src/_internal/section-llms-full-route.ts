/**
 * The injected `/[...section]/llms-full.txt` route, at the root and at each
 * request-rendered mount (`/<mount>/[...section]/llms-full.txt`). It serves
 * the per-section files of an `llms-full.txt` split for size, so it emits
 * nothing on a site under the limit. Injected only beside a root
 * `llms-full.txt` route.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { getLlmsPayload } from "../agent-endpoints.js";
import { loadAgentEndpointManifest } from "./agent-endpoint-manifest.js";
import { findOwnMarkdownRoute, higherMarkdownRouteOwner } from "./markdown-routes.js";

// Spelled as a constant: the build tells a route that serves `/llms-full.txt`
// by its source, and this one must not count.
const FULL = "full" as const;

/** "/blog/[...section]/llms-full.txt" → "blog"; the root route → "". */
function mountOf(routePattern: string): string {
  const segments = routePattern.split("/").filter(Boolean);
  return segments.slice(0, -2).join("/");
}

export const getStaticPaths: GetStaticPaths = async ({ routePattern }) => {
  const [{ llmsAssets }, { routes }] = await Promise.all([
    loadAgentEndpointManifest(),
    import("virtual:nimbus/markdown-routes"),
  ]);
  const mount = mountOf(routePattern);
  let ownIndex = -1;
  try {
    ownIndex = findOwnMarkdownRoute(routes, routePattern, "llms");
  } catch {
    ownIndex = -1;
  }
  return llmsAssets
    .flatMap((asset) => (asset.scope === "section" && asset.surface === FULL ? [asset.section] : []))
    .filter((section) => !mount || section === mount || section.startsWith(`${mount}/`))
    .filter(
      (section) =>
        ownIndex < 0 || !higherMarkdownRouteOwner(routes, ownIndex, `/${section}/llms-full.txt`),
    )
    .map((section) => ({
      params: { section: mount ? section.slice(mount.length + 1) || undefined : section },
    }));
};

export const GET: APIRoute = async (context) => {
  const mount = mountOf(context.routePattern);
  const rest = context.params.section;
  const section = mount ? (rest ? `${mount}/${rest}` : mount) : rest;
  try {
    const payload = section
      ? await getLlmsPayload({ scope: "section", surface: FULL, section }, { request: context.request })
      : null;
    if (!payload) return new Response("Not found", { status: 404 });
    return new Response(payload.body, {
      headers: { "Content-Type": payload.mediaType },
    });
  } catch (error) {
    if (context.isPrerendered) throw error;
    console.error(error);
    return new Response("Internal Server Error", { status: 500 });
  }
};
