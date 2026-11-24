/**
 * The injected per-mount `llms.txt` route, `/<mount>/[...section]/llms.txt`.
 * Injected by the integration when the rendering policy is set and the
 * project has no route file at the mount, with `prerender` following the
 * collection's rendering mode. It serves the mount's own index (empty rest)
 * and, when the bake nests sections, every section under the mount. A
 * prebuilt mount with no discoverable pages emits nothing. The mount comes
 * from the route pattern, so one module serves every mount under any base.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { getLlmsPayload, getLlmsStaticPaths } from "../agent-endpoints.js";
import { notModified } from "./conditional-request.js";

/** "/blog/[...section]/llms.txt" → "blog". */
function mountOf(routePattern: string): string {
  return routePattern.split("/").filter(Boolean).slice(0, -2).join("/");
}

export const getStaticPaths: GetStaticPaths = async ({ routePattern }) => {
  const mount = mountOf(routePattern);
  return (await getLlmsStaticPaths())
    .filter(({ params }) => params.section === mount || params.section.startsWith(`${mount}/`))
    .map(({ params, props }) => ({
      params: { section: params.section === mount ? undefined : params.section.slice(mount.length + 1) },
      props,
    }));
};

export const GET: APIRoute = async (context) => {
  const mount = mountOf(context.routePattern);
  const rest = context.params.section;
  try {
    const payload = mount
      ? await getLlmsPayload(
          { scope: "section", surface: "index", section: rest ? `${mount}/${rest}` : mount },
          { request: context.request },
        )
      : null;
    if (!payload) return new Response("Not found", { status: 404 });
    const etag = `"${payload.digest}"`;
    if (!context.isPrerendered) {
      const unchanged = notModified(context.request, etag);
      if (unchanged) return unchanged;
    }
    return new Response(payload.body, { headers: { "Content-Type": payload.mediaType, ETag: etag } });
  } catch (error) {
    if (context.isPrerendered) throw error;
    console.error(error);
    return new Response("Internal Server Error", { status: 500 });
  }
};
