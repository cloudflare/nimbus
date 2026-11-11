import { collectionMountPrefix } from "./collection-mount.js";
import { isSearchable } from "./discoverability.js";
import {
  contentInventoryEntryUrl,
  requestInventoryVersionStatusKey,
  type RequestRouteInventoryEntry,
} from "./request-route-url.js";
import {
  loadApiCollections,
  loadMountContext,
  loadRequestRenderingCollections,
  loadNimbusConfig,
} from "./runtime-config.js";
import { getIndexedEntries, getVersionStatus } from "../runtime.js";
import {
  readConfiguredMarkdownEndpointPayload,
  readConfiguredRenderedMarkdownPage,
} from "./agent-endpoint-asset-reader.js";

export const prerender = true;

export async function GET() {
  const projectRoot: unknown = import.meta.env.NIMBUS_PROJECT_ROOT;
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error(
      "nimbus-docs: request route inventory requires the Nimbus Astro integration.",
    );
  }
  const config = await loadNimbusConfig();
  // Only Pagefind reads page text from here; another provider, or none,
  // leaves the build with no body to read.
  const pagefind = config.search !== false && config.search?.provider !== "custom";
  const requestCollections = new Set(await loadRequestRenderingCollections());
  const apiCollections = new Set(await loadApiCollections());
  const entries = await getIndexedEntries();
  const mountContext = await loadMountContext();
  const routes: RequestRouteInventoryEntry[] = [];

  for (const item of entries) {
    const collection = item.collection;
    const prefix = collectionMountPrefix(collection, mountContext);
    const data = (item.entry.data ?? {}) as Record<string, unknown>;
    const request = requestCollections.has(collection);
    const versionStatus = await getVersionStatus(
      requestInventoryVersionStatusKey(
        collection,
        apiCollections.has(collection),
        item.version,
      ),
    );
    const discoverable = data.noindex !== true && !versionStatus?.isHidden;
    const searchable = !versionStatus?.isHidden && isSearchable(item.entry);
    const route: RequestRouteInventoryEntry = {
      collection,
      url: contentInventoryEntryUrl(
        prefix,
        item.entry.id,
        request,
      ),
      request,
      discoverable,
      searchable,
      title: item.title,
      language: (config.locale ?? "en").split("-")[0]!,
    };
    if (item.description) route.description = item.description;
    if (item.version) route.version = item.version;
    if (versionStatus?.isDeprecated) route.deprecated = true;
    if (route.request && searchable && pagefind) {
      // Pagefind's text for a page rendered on request: the build keeps a
      // body for every such page while Pagefind is on, route or no route,
      // except an API page the Worker renders, whose text is made the same way.
      route.content = await pageText(projectRoot, collection, item);
    }
    routes.push(route);
  }

  return new Response(JSON.stringify(routes), {
    headers: { "Content-Type": "application/json" },
  });
}

async function pageText(
  projectRoot: string,
  collection: string,
  item: Awaited<ReturnType<typeof getIndexedEntries>>[number],
): Promise<string> {
  const baked = await readConfiguredMarkdownEndpointPayload(projectRoot, {
    collection,
    id: item.entry.id,
    surface: "markdown",
  }).catch(() => undefined);
  if (baked) return baked.content;
  // Not baked: an API page that renders on request takes the serialization
  // the route uses, so the search text is the content the `.md` carries.
  const page = await readConfiguredRenderedMarkdownPage(projectRoot, { collection, id: item.entry.id });
  if (page) return (await (await import("./api/markdown-record.js")).renderMarkdownDocument(page)).content;
  throw new Error(`nimbus-docs: no Markdown body for "${collection}:${item.entry.id}" to index; the build should have kept one.`);
}
